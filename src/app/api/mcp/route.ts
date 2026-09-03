import { NextResponse } from "next/server";
import {
  appendMessage,
  chatOwnsRun,
  createProposal,
  createQuestions,
  listProposals,
  MAX_OPEN_QUESTIONS,
  MAX_PENDING_PROPOSALS,
  MAX_QUESTION_CHOICES,
  normalizeChoices,
  pendingProposals,
  pendingQuestions,
  proposalDeps,
  subjectForCapability,
  type CapabilitySubject,
  type ProposalDependency,
  type QuestionInput,
} from "@/lib/chat";
import {
  currentKnowledge,
  emitBlockRuns,
  folderRefusal,
  instanceOwnsRun,
  lastRunAt,
  listWorkflows,
  liveBlocksOf,
  liveRunsOf,
  normalizeWorkflowInput,
} from "@/lib/workflows";
import {
  createTemplate,
  getTemplate,
  listTemplates,
  normalizeTemplateInput,
  updateTemplate,
} from "@/lib/templates";
import {
  agentRefusal,
  currentAgentKnowledge,
  listAgents,
  listAmbientAgents,
} from "@/lib/agents";
import {
  activeRuns,
  currentSnapshot,
  DEPENDENCY_EDGES,
  describeFolder,
  getRun,
  listRuns,
  resolveWorkspaceFolder,
  runEvents,
  type DependencyEdge,
} from "@/lib/orchestrator";
import { diffAsText, runDiff } from "@/lib/diff";
import { chatGuards } from "@/lib/settings";
import { githubRemotes, scanWorkspace } from "@/lib/workspace";
import { mountById } from "@/lib/config";
import { fmtUSD } from "@/lib/format";
import { auditMutation, sourceAddress } from "../../../lib/requestLog";
import { opsLog } from "../../../lib/ops";

/**
 * What one `get_run_diff` may return.
 *
 * Smaller than the reviewer's budget on purpose: a review is one call about one
 * diff, where this is a turn that may look at several runs and still has to
 * think afterwards — and `settings.chatTurnBudgetUSD` is what pays for it.
 */
const MAX_DIFF_TEXT_BYTES = 60_000;

/**
 * What a chat may call a proposal, so another one can point at it.
 *
 * The same shape a workflow node id and an emitted spec id take, and for the
 * same reason: it travels in messages and in refusals a person reads.
 */
const SPEC_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The tool surface the orchestrator chat calls back into.
 *
 * MCP over streamable HTTP, spoken by hand rather than through the SDK: the
 * subset a `-p` child actually uses is `initialize`, `tools/list` and
 * `tools/call`, and adding a dependency to the image — which pins the CLI for
 * exactly this kind of reverse-engineered contract — buys less than it costs.
 * Responses are plain JSON rather than SSE, which the transport permits for a
 * single reply and which is all a request/response tool call needs.
 *
 * **Why these tools live in this process.** `createRun`'s folder claim is a
 * synchronous check-then-insert, atomic only because one Node event-loop turn
 * runs to completion; a stdio MCP server would be a second process doing
 * check-then-insert against the same SQLite file, which silently permits the
 * two-agents-in-one-directory collision the claim exists to prevent. See the
 * note at the top of `db.ts`.
 *
 * **Why this route authenticates itself.** `middleware.ts` runs in the edge
 * runtime and cannot reach SQLite or module state, so it cannot check a
 * per-chat credential — the path is exempted there and the check happens here.
 * The credential is *not* `UF_AUTH_TOKEN`: it is a capability minted for one
 * chat turn and revoked when that turn's child exits, so a copy of it recovered
 * afterwards opens nothing. Every tool below is scoped to the chat it names.
 *
 * **The tool list depends on who is asking.** A capability speaks for a chat or
 * for one orchestrator block of one workflow instance, and the two are offered
 * different tools rather than one list with guards inside it: a chat proposes
 * and saves templates and cannot emit, a block emits and cannot do either. The
 * split is in `toolsFor` and the check is repeated in `callTool`, because a tool
 * absent from a list is not a tool absent from the wire.
 *
 * Note what is absent from both: nothing here stops, resumes or reopens a run,
 * nothing here presses Run on a workflow, nothing here writes to a folder, and
 * nothing here sets a budget, a permission mode or an isolation choice. A chat's
 * most is a `chat_proposals` row, inert until a person approves it — of a run,
 * of a run ordered behind another one, or of a whole workflow, and approving
 * that last one *saves* a graph rather than starting it, so the press of Run
 * stays the operator's. A block's most is a list of run specs, which start —
 * under the guards the block's *saved* template supplies, in the mount that
 * block was pointed at, up to the number a person agreed to when they saved the
 * graph.
 */

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Tools both kinds of caller get: everything that only reads.
 *
 * `list_agents` is deliberately in here rather than in `CHAT_TOOLS`, and the
 * placement *is* the decision: both subjects can name an agent — a chat on a
 * proposal the operator then approves, a block on a run it emits — so both have
 * to be able to see what exists before they name one, and the alternative is a
 * block guessing at names out of its system prompt. It grants neither of them
 * anything: an agent holds no tool list and no permission mode, so what this
 * list can move is who a run *is* and never what a run may do. Being here is
 * also what makes the two guards in `callTool` say the right
 * thing about it — they refuse the tools of the *other* subject, and a shared
 * tool is in neither list.
 */
const SHARED_TOOLS = [
  {
    name: "list_folders",
    description:
      "List every workspace mount and the project folders in it, with which " +
      "runs are already working there and, for git repositories, the GitHub " +
      "repo they point at. Folder paths for propose_run must come from here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_templates",
    description:
      "List saved run templates, with the guards each one supplies — budget, " +
      "work-cycle limit, permission mode, isolation — and the default guard " +
      "set a proposal that names no template runs under.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_runs",
    description:
      "List recent runs with their status, folder and spend, so work already " +
      "in flight is not proposed a second time. A run whose status is " +
      "needs-review is not in flight: it is finished, holds nothing, and is " +
      "waiting on a person, so proposing work that depends on it parks that " +
      "work on the same question.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many to return (default 20)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_run",
    description:
      "Everything known about one run: its task, how it ended, what it spent, " +
      "the tail of its log, and a summary of the files it changed. Read this " +
      "before proposing follow-up work on a run that already happened.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "id from list_runs." },
        events: {
          type: "number",
          description: "How many recent log entries to include (default 20).",
        },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_run_diff",
    description:
      "The patch a run produced, truncated at a file boundary if it is large " +
      "— the file list is always complete and the omitted files are named. " +
      "Available for your own runs: in a chat, the runs this conversation " +
      "proposed; in a workflow block, the runs of this instance. For any other " +
      "run, get_run reports what it changed as a file summary, and you can read " +
      "its folder directly.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "id from list_runs." },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_usage",
    description:
      "How much of the 5-hour and weekly windows is spent, the current burn " +
      "rate, and how many runs are working or queued. Use it to say whether " +
      "now is a good time to start work, not to decide any run's guards.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_workflows",
    description:
      "Saved workflows: re-runnable graphs of blocks the operator starts with " +
      "one press of Run. Read before proposing a new one — the work may " +
      "already be a workflow, and a graph running right now is worth " +
      "mentioning rather than duplicating.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_agents",
    description:
      "Saved agents: roles a run can be started AS. Naming one replaces the " +
      "run's own system prompt with the agent's, so the run does the work as " +
      "that agent rather than handing part of it to one. Read this before " +
      "naming any — the operator writes @name in their message and this is " +
      "what turns that into the agent to start the run as. An agent carries a " +
      "description and a prompt and nothing else: it changes who the run is, " +
      "never what the run is allowed to do, so naming one sets no budget, no " +
      "permission mode and no isolation choice. It also reports the agent " +
      "definitions on this machine that this app did not save, which reach " +
      "every run either way and cannot be named here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** Tools only the orchestrator chat gets. None of them starts anything. */
const CHAT_TOOLS = [
  {
    name: "list_proposals",
    description:
      "The proposals already made in this conversation and what became of " +
      "them, so the same work is not proposed twice.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "save_template",
    description:
      "Save a reusable task prompt as a template, or rewrite an existing " +
      "one's prompt. Prompt and name only: a new template takes the " +
      "operator's default guard set and an existing one keeps its own guards, " +
      "neither of which this tool can change.",
    inputSchema: {
      type: "object",
      properties: {
        templateId: {
          type: "string",
          description: "Omit to create. Given, rewrites that template.",
        },
        name: {
          type: "string",
          description: "Required when creating. Must be unique.",
        },
        prompt: {
          type: "string",
          description:
            "The standing instructions every run from this template starts " +
            "with. The per-run task is appended below it.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    // The description below is the whole of what the model is told about
    // asking, and it is long for `systemPrompt()`'s stated reason: the
    // tool-calling half of the orchestrator's instructions lives here, where it
    // cannot drift from the schema, and is deliberately not repeated in the
    // prompt. The sentence that must never be cut is the second one. A model
    // that reads this as "returns the operator's answer" calls it, gets a
    // receipt, calls it again, and spends the turn's whole budget asking the
    // same question in a loop — which is what a tool that *could* block would
    // do to the ten-minute timeout anyway.
    name: "ask_operator",
    description:
      "Ask the operator something you cannot find out by reading, and end " +
      "your turn. This does NOT return their answer: it records the question, " +
      "and whatever the operator says next in this conversation is the answer " +
      "— it reaches you as their next message, with each question quoted above " +
      "the answer to it. So call it once, say in your " +
      "reply what you asked and why, and stop — calling it again or waiting " +
      "spends this turn and tells you nothing. Ask only what the repository " +
      "cannot tell you: which of two jobs matters more, what \"done\" means " +
      "here, whether a risk is acceptable, which of several folders they meant. " +
      "Never ask what a file, `git log`, `gh` or `list_folders` would answer, " +
      "and never ask for permission to propose — the operator approves every " +
      "proposal by hand already, so asking first costs a turn and changes " +
      "nothing. Put everything you need in this one call and keep it to a " +
      `couple of questions (at most ${MAX_OPEN_QUESTIONS}); each one costs the ` +
      "operator a read and costs you a whole turn. Offer concrete choices " +
      "whenever the answer is a choice, and say in your reply what you would " +
      "propose under each one — an operator picking between proposals answers " +
      "in one click, where an operator answering a quiz has to imagine what " +
      "you would do with it.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description:
            "The questions, in the order the operator should read them.",
          items: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description:
                  "One question, in full. It is shown on its own, so it has " +
                  "to carry its own context: name the file, the run or the " +
                  "folder it is about rather than saying \"the second one\".",
              },
              choices: {
                type: "array",
                items: { type: "string" },
                description:
                  "Concrete answers to pick from, two or more, each short " +
                  "enough to read on a button. Omit for a question with no " +
                  "shortlist. Do not put \"something else\" in here — that is " +
                  "allowText.",
              },
              allowText: {
                type: "boolean",
                description:
                  "Whether the operator may type instead of picking. True by " +
                  "default. Set it false only when an answer outside the " +
                  "choices would be meaningless to you, because a question " +
                  "nobody can answer in their own words is one they will " +
                  "answer by ignoring.",
              },
            },
            required: ["question"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_run",
    description:
      "Propose one run for the operator to approve. This does NOT start " +
      "anything: it records a proposal that a person approves or rejects by " +
      "hand. Guards come from the template — or from the operator's default " +
      "guard set when no template is named — and cannot be set here.",
    inputSchema: {
      type: "object",
      properties: {
        templateId: {
          type: "string",
          description:
            "id from list_templates. Omit to use the operator's default " +
            "guard set, which is the right choice for one-off work.",
        },
        promptOverride: {
          type: "string",
          description:
            "Standing instructions replacing the template's own prompt, for " +
            "this run only. Use when the template nearly fits. It does not " +
            "replace the task, which is still required and is still appended " +
            "below it — and because it is standing text rather than this " +
            "run's brief, a batch of related proposals normally carries the " +
            "same override word for word.",
        },
        agentId: {
          type: "string",
          description:
            "id from list_agents: the saved agent this run is STARTED AS, so " +
            "the agent's prompt becomes the run's own. Name one when the " +
            "operator writes @something in their message, or when a saved " +
            "agent plainly fits the whole job. It changes who the run is and " +
            "never what the run may do — the guards are still the template's, " +
            "or the default set. Omit it for the ordinary run.",
        },
        title: {
          type: "string",
          description: "Short specific label, e.g. 'Fix #412 flaky auth test'.",
        },
        task: {
          type: "string",
          description:
            "The full brief for the agent: what to do, the issue number and " +
            "URL if there is one, and what done looks like.",
        },
        mountId: {
          type: "string",
          description:
            "Mount from list_folders. Omit to use the template's own folder.",
        },
        folder: {
          type: "string",
          description:
            "Path within the mount, exactly as list_folders gives it. Required " +
            "when mountId is given; \"\" means the mount root.",
        },
        id: {
          type: "string",
          description:
            "Your own label for this proposal, so another one can say it runs " +
            "after it. Only needed when something depends on this. Letters, " +
            "digits, hyphens, underscores; unique among this chat's undecided " +
            "proposals.",
        },
        dependsOn: {
          type: "array",
          description:
            "Proposals this one starts after — by the id you gave them, in " +
            "this chat. Use it when two runs would edit the same files, or " +
            "when one reviews or builds on another. Both must be approved in " +
            "the same click, or the earlier one must already have started.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "The id you gave another proposal in this chat.",
              },
              edge: {
                type: "string",
                enum: ["on-success", "on-finish"],
                description:
                  "There is no default: pick the one you mean. on-success " +
                  "starts only if that run completed — which ends a chain " +
                  "the operator meant to run regardless. on-finish starts " +
                  "once it is out of the way either way — including after " +
                  "it crashed, so anything it left half-done is what this " +
                  "run opens on. Use on-finish for work that is worth doing " +
                  "whether or not the first run got there, and on-success " +
                  "for work that reads, reviews or builds on what the first " +
                  "run produced.",
              },
              continueBranch: {
                type: "boolean",
                description:
                  "Carry on that run's branch instead of cutting a fresh one, " +
                  "so this agent starts with its commits already there. " +
                  "Prefer it with an on-success edge: on an on-finish edge " +
                  "the commits already there may be half of a run that " +
                  "crashed. It needs both runs in a checkout of their own, " +
                  "which is a guard you do not set — check the template's " +
                  "isolation, or the default guard set's, in list_templates " +
                  "before you set this. Only one proposal may continue any " +
                  "given run.",
              },
            },
            required: ["id", "edge"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_workflow",
    description:
      "Propose a saved workflow — a re-runnable graph of blocks — for the " +
      "operator to approve. This starts NOTHING and creates no run: approving " +
      "it saves the workflow, and a person then presses Run on it. Use it for " +
      "work that repeats or has a shape worth keeping; use propose_run for a " +
      "one-off. Guards come from each block's template, or the operator's " +
      "default guard set, and cannot be set here. The workflow is saved with " +
      "no workflow-wide budget, which the operator adds before scheduling it.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "What the workflow is called. Must be unique.",
        },
        summary: {
          type: "string",
          description:
            "One line on what the graph does, shown on the approval card.",
        },
        blocks: {
          type: "array",
          description: "The blocks, in the order they make sense to read.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description:
                  "Your own label, unique in this graph; dependsOn names it. " +
                  "Letters, digits, hyphens, underscores.",
              },
              name: { type: "string", description: "What this step is called." },
              kind: {
                type: "string",
                enum: ["run", "orchestrator", "merge"],
                description:
                  "run (default) is a fixed task. orchestrator is a short turn " +
                  "that decides, when the workflow gets there, which runs to " +
                  "start next — they start with no approval, so it needs " +
                  "fanOut. merge lands the branches the blocks in front of it " +
                  "left, and takes no task, folder or template.",
              },
              templateId: {
                type: "string",
                description:
                  "id from list_templates, supplying every guard. Omit for the " +
                  "operator's default guard set.",
              },
              mountId: {
                type: "string",
                description: "Mount from list_folders. Omit on a merge block.",
              },
              folder: {
                type: "string",
                description:
                  "Path within the mount, exactly as list_folders gives it. " +
                  "\"\" is the mount root. Omit on a merge block.",
              },
              task: {
                type: "string",
                description:
                  "A run block's brief, or an orchestrator block's brief for " +
                  "what to decide. Omit on a merge block.",
              },
              promptOverride: {
                type: "string",
                description:
                  "Standing instructions replacing the template's prompt for " +
                  "this block. The task is appended below it.",
              },
              agentId: {
                type: "string",
                description:
                  "id from list_agents: the saved agent this block's own child " +
                  "is STARTED AS. It changes who that child is and never what " +
                  "the block may do. Refused on a merge block, which starts no " +
                  "child at all, so there would be nothing for the agent to be.",
              },
              fanOut: {
                type: "number",
                description:
                  "Required on an orchestrator block: the most runs it may " +
                  "ever start. Its runs start with nobody looking, so this is " +
                  "the number the operator is agreeing to. Ignored on any " +
                  "other kind.",
              },
              mergeStrategy: {
                type: "string",
                enum: ["merge", "squash"],
                description: "Required on a merge block, ignored on any other.",
              },
              mergeAutoResolve: {
                type: "boolean",
                description:
                  "Let a merge block pay a model to reconcile a conflict. " +
                  "Costs money on its own, so leave it out unless asked.",
              },
              dependsOn: {
                type: "array",
                description: "Blocks in this graph that must settle first.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "An id from this graph." },
                    edge: {
                      type: "string",
                      enum: ["on-success", "on-finish"],
                      description:
                        "on-success starts only if that block completed; " +
                        "on-finish starts once it is out of the way.",
                    },
                    continueBranch: {
                      type: "boolean",
                      description:
                        "Carry on that block's branch rather than cutting a " +
                        "fresh one. Both ends must be run blocks whose guards " +
                        "give them a checkout of their own.",
                    },
                  },
                  required: ["id", "edge"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "name"],
            additionalProperties: false,
          },
        },
      },
      required: ["name", "blocks"],
      additionalProperties: false,
    },
  },
];

/**
 * The one tool an orchestrator block gets that writes anything.
 *
 * Five fields per run and no sixth. There is no template id, no budget, no
 * permission mode, no isolation choice and no model on this schema, and their
 * absence is the whole reason auto-start is defensible: the block's guards were
 * chosen by a person when the graph was saved, and a field here that could name
 * different ones would be a route to `--permission-mode` reached by a model with
 * nobody reading the result. The description says so outright, because a model
 * that believes it can set guards writes a task explaining what guards it wants.
 *
 * The fifth is `agent`, and it is on the other side of that line rather than an
 * exception to it: a saved agent is a description and a prompt, the registry
 * refuses a tool list at the door and has no column for a permission mode, so
 * naming one decides *who the run is* exactly as the task text beside it decides
 * what the work is. `planEmission` refuses a name this install does not have,
 * for the reason every other door refuses a deleted agent by name — and since
 * `--agent` takes a name, a misspelling let through here would be a run that
 * fails at the spawn rather than one that quietly starts as nobody.
 */
const BLOCK_TOOLS = [
  {
    name: "emit_runs",
    description:
      "Start these runs. This is NOT a proposal: what you emit is created and " +
      "queued as soon as this turn ends, with no approval step. Guards — " +
      "budget, work-cycle limit, permission mode, isolation — come from the " +
      "block's own template and cannot be set here. Call it once, with the " +
      "whole list; an empty list is a valid answer meaning there is nothing " +
      "worth doing.",
    inputSchema: {
      type: "object",
      properties: {
        runs: {
          type: "array",
          description: "The runs to start, at most this block's fan-out limit.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description:
                  "Your own label for this run, unique in this list. dependsOn " +
                  "entries name it. Letters, digits, hyphens, underscores.",
              },
              title: {
                type: "string",
                description: "Short specific label, e.g. 'Fix flaky auth test'.",
              },
              task: {
                type: "string",
                description:
                  "The full brief for the agent: what to do, where, and what " +
                  "done looks like. It cannot ask you a follow-up question.",
              },
              folder: {
                type: "string",
                description:
                  "Path within this block's own workspace, exactly as " +
                  "list_folders gives it. A folder outside it is refused. " +
                  "\"\" is the workspace root.",
              },
              agent: {
                type: "string",
                description:
                  "Optional: the name of a saved agent to START THIS RUN AS, " +
                  "exactly as your instructions list it — the agent's prompt " +
                  "becomes that run's own. It changes who the run is and never " +
                  "what the run may do; the guards are still the block's. A " +
                  "name this install does not have is refused; omit it for the " +
                  "ordinary run.",
              },
              dependsOn: {
                type: "array",
                description:
                  "Runs in THIS list that must settle first. Use it when two " +
                  "of them would edit the same files.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "An id from this list." },
                    edge: {
                      type: "string",
                      enum: ["on-success", "on-finish"],
                      description:
                        "on-success starts only if that run completed; " +
                        "on-finish starts once it is out of the way.",
                    },
                  },
                  required: ["id", "edge"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "title", "task", "folder"],
            additionalProperties: false,
          },
        },
      },
      required: ["runs"],
      additionalProperties: false,
    },
  },
];

/** What this caller may see and call. See the note at the top of the file. */
function toolsFor(subject: CapabilitySubject) {
  return subject.kind === "chat"
    ? [...SHARED_TOOLS, ...CHAT_TOOLS]
    : [...SHARED_TOOLS, ...BLOCK_TOOLS];
}

/**
 * The capability check, and why it stands outside the audited handler.
 *
 * `middleware.ts` exempts this path from the shared-secret gate, so a request
 * reaching here has passed nothing yet — this check *is* the authentication for
 * the whole tool surface, and every answer other than the 401 below is given
 * with a subject in hand. What it must not do is answer that 401 from inside
 * `auditMutation`: the wrapper records every request it wraps and then evicts
 * everything past the 20,000-row cap, so auditing a credential-free refusal
 * hands any caller who can reach this path a lever on the audit table itself —
 * twenty thousand correctly-refused requests, and every line naming a run that
 * was started, a setting that was changed or a sign-in that failed is gone.
 *
 * Only the handler that already has a subject is wrapped, which keeps the case
 * the table exists for: a real capability whose tool call is refused — a
 * deleted template, a folder it may not have — still leaves a line, because
 * that is the burst somebody comes looking for afterwards.
 */
export async function POST(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const subject = subjectForCapability(bearer);
  if (!subject) {
    // On stdout rather than in `request_log`, which is the whole point: the
    // table is capped and evicts its oldest line on every insert, so the one
    // record a credential-free caller may write must be the one they cannot
    // use to push anything out. Leaving no trace at all was not an option
    // either — this is the path an unauthenticated caller reaches, so somebody
    // hammering it is exactly what an operator needs to be able to see.
    opsLog("warn", "mcp.unauthorized", { address: sourceAddress(req.headers) });
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  return auditMutation((request: Request) => postHandler(request, subject))(req);
}

async function postHandler(req: Request, subject: CapabilitySubject) {
  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = (await req.json()) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  // A batch is legal on the wire even though the CLI does not send one.
  const batch = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const msg of batch) {
    const reply = await handle(msg, subject);
    if (reply) replies.push(reply);
  }

  // Every message was a notification. 202 with no body is what the transport
  // asks for, and answering `{}` instead makes some clients wait for a result
  // that is never coming.
  if (replies.length === 0) return new Response(null, { status: 202 });

  return NextResponse.json(Array.isArray(body) ? replies : replies[0]);
}

/**
 * The transport's other verbs. Neither is needed: there is no server stream.
 *
 * Neither is audited, and DELETE is the one that used to be: a 405 answered
 * without reading the request mutates nothing, so it has nothing to tell an
 * audit — and since it is answered before any credential is looked at, the row
 * it wrote was a free line against the 20,000-row cap for anybody who could
 * reach this path.
 */
export async function GET() {
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code: -32601, message: "No server stream" } },
    { status: 405 },
  );
}

export async function DELETE() {
  return new Response(null, { status: 405 });
}

async function handle(
  msg: JsonRpcRequest,
  subject: CapabilitySubject,
): Promise<object | null> {
  const id = msg.id ?? null;
  const method = String(msg.method ?? "");

  // A notification has no id and takes no reply, whatever it asks for —
  // `notifications/initialized` is the one the CLI actually sends.
  if (msg.id === undefined || msg.id === null) return null;

  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  switch (method) {
    case "initialize": {
      // Echo a protocol version the client asked for when we recognise its
      // shape, rather than insisting on ours: this file speaks a subset that
      // has not changed across these revisions, and refusing a newer client
      // over a version string would break the feature on a CLI bump.
      const asked = String(msg.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "usagefoundry", version: "0.1.0" },
      });
    }

    case "ping":
      return ok({});

    case "tools/list":
      return ok({ tools: toolsFor(subject) });

    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return ok(await callTool(name, args, subject));
      } catch (err) {
        // A tool that throws is reported as tool output, not as a protocol
        // error: the model can read and act on the former and only sees a
        // dropped turn from the latter.
        return ok(text(`Error: ${err instanceof Error ? err.message : String(err)}`, true));
      }
    }

    default:
      return fail(-32601, `Unknown method: ${method}`);
  }
}

function text(body: string, isError = false) {
  return { content: [{ type: "text", text: body }], isError };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  subject: CapabilitySubject,
) {
  // Checked here as well as in `toolsFor`, because a list is what a caller is
  // *offered* and this is what it may *do*. A chat that has read a block's
  // schema from somewhere must still not be able to start runs, and a block
  // must not be able to write a proposal into a stranger's thread.
  const chatId = subject.kind === "chat" ? subject.chatId : null;
  if (chatId === null && (CHAT_TOOLS.some((t) => t.name === name))) {
    // `ask_operator` is the one of these with no alternative to name, and
    // pointing a block at `emit_runs` would be worse than saying nothing: a
    // block that wanted an answer would emit a run whose task is the question.
    // A block runs with nobody looking, which is the whole difference between
    // it and a chat — what it does with an unanswerable question is decide.
    return text(
      name === "ask_operator"
        ? "ask_operator is not available to an orchestrator block: there is " +
          "nobody watching this workflow to answer. Decide with what you can " +
          "read, and say what you assumed in your reply."
        : `${name} is not available to an orchestrator block. Use emit_runs.`,
      true,
    );
  }
  if (chatId !== null && BLOCK_TOOLS.some((t) => t.name === name)) {
    return text(
      `${name} is not available in a chat. Use propose_run, which the operator ` +
        "approves before anything starts.",
      true,
    );
  }

  switch (name) {
    case "list_folders": {
      const { mounts, folders } = await scanWorkspace();
      const { repos, notRead } = await githubRemotes(folders);
      return text(
        JSON.stringify(
          {
            mounts: mounts.map((m) => ({
              mountId: m.id,
              label: m.label,
              // The absolute path, because `Read`, `Grep` and `git log` all
              // need one to reach a mount that is not the child's cwd — and
              // every mount is already `--add-dir`ed into this child, so
              // naming it grants nothing that was not already granted.
              path: m.path,
              available: m.available,
              error: m.error,
              truncated: m.truncated,
            })),
            folders: folders.map((f) => ({
              mountId: f.mountId,
              folder: f.path,
              isGitRepo: f.isGitRepo,
              repo: repos[`${f.mountId}:${f.path}`] ?? null,
              busyRunId: f.busyRunId,
              parkedRunId: f.parkedRunId,
              queuedCount: f.queuedCount,
            })),
            // Said rather than left to be inferred, for the reason a shortened
            // diff says so: a missing `repo` that means "not looked at" and one
            // that means "not GitHub" are different sentences.
            repoLookupsSkipped: notRead,
          },
          null,
          1,
        ),
      );
    }

    case "list_templates": {
      // The default guard set is reported alongside, because it is what a
      // proposal naming no template runs under — a model shown only the
      // templates would read an empty list as "nothing can be proposed", which
      // is what this tool used to say and no longer true.
      return text(
        JSON.stringify(
          {
            templates: listTemplates().map((t) => ({
              templateId: t.id,
              name: t.name,
              prompt: t.prompt,
              mountId: t.mountId,
              folder: t.folder,
              isolate: t.isolate,
              permissionMode: t.permissionMode,
              budget: t.budget,
            })),
            guardsWhenNoTemplateNamed: chatGuards(),
          },
          null,
          1,
        ),
      );
    }

    case "list_agents": {
      // Both handles, each named for the caller that takes it: the chat's
      // proposal tools take an `agentId` like every other identifier they
      // speak in, and `emit_runs` takes the `name`, because a block's turn
      // names the agent a run it is creating will be started as — and a name is
      // both the key `--agents` uses and the word `--agent` takes. Reporting
      // only one would leave whichever caller wanted the other guessing at it.
      //
      // `usable: false` is reported rather than the row being hidden, because
      // the two failures read alike from here and only one of them is the
      // operator's to fix: an agent missing its description or its prompt is
      // one the CLI will not register, so a run started as it dies at the
      // spawn. Every door refuses it by name.
      return text(
        JSON.stringify(
          {
            agents: listAgents().map((a) => ({
              agentId: a.id,
              name: a.name,
              description: a.description,
              model: a.model,
              usable: a.usable,
            })),
            // Declared rather than merged into the list above: these reach
            // every child this app spawns whatever is named here, and they
            // cannot be named — they have no row and so no id. A model that
            // saw one list would offer the operator an agent nothing can
            // select.
            alsoOnThisMachine: listAmbientAgents().map((a) => ({
              name: a.name,
              description: a.description,
              scope: a.scope,
            })),
            note:
              "Naming an agent starts the run AS that agent — its prompt " +
              "becomes the run's own — and sets no guard. Budget, work-cycle " +
              "limit, permission mode and isolation all come from the template " +
              "a proposal or block names, or from the operator's default guard " +
              "set. The agents under alsoOnThisMachine are in play for every " +
              "run whether or not one is named, and cannot be named here.",
          },
          null,
          1,
        ),
      );
    }

    case "list_runs": {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      return text(
        JSON.stringify(
          listRuns(limit).map((r) => {
            const { mountId, relPath } = describeFolder(r.folder);
            return {
              runId: r.id,
              status: r.status,
              mountId,
              folder: relPath,
              branch: r.worktree_branch,
              iterations: r.iterations,
              spent: fmtUSD(r.spent_usd),
              stopReason: r.stop_reason,
              task: r.prompt.slice(0, 200),
            };
          }),
          null,
          1,
        ),
      );
    }

    case "get_run":
      return getRunDetail(args);

    case "get_run_diff":
      return getRunPatch(args, subject);

    case "get_usage":
      return usageReport();

    case "list_workflows":
      return workflowReport();

    case "list_proposals": {
      const proposals = listProposals(chatId!);
      if (proposals.length === 0) {
        return text("Nothing has been proposed in this conversation yet.");
      }
      return text(
        JSON.stringify(
          proposals.map((p) => ({
            proposalId: p.id,
            // The chat's own label, which is what a dependsOn names — reported
            // back because a turn that resumes a conversation has the thread
            // but not necessarily the labels it used two turns ago.
            id: p.spec_id,
            kind: p.kind,
            title: p.title,
            status: p.status,
            templateId: p.template_id,
            runId: p.run_id,
            workflowId: p.workflow_id,
            dependsOn: proposalDeps(p).map((d) => `${d.specId} (${d.edge})`),
            error: p.error,
            task: p.task.slice(0, 200),
          })),
          null,
          1,
        ),
      );
    }

    case "ask_operator":
      return askOperator(args, chatId!);

    case "save_template":
      return saveTemplate(args, chatId!);

    case "propose_run":
      return proposeRun(args, chatId!);

    case "propose_workflow":
      return proposeWorkflow(args, chatId!);

    case "emit_runs": {
      // Narrowed rather than asserted: `subject.kind` is what decides, and the
      // union is what makes the two ids unmixable.
      if (subject.kind !== "block") {
        return text("emit_runs is not available here.", true);
      }
      const outcome = emitBlockRuns(
        subject.instanceId,
        subject.nodeId,
        args.runs,
      );
      if (!outcome.ok) return text(outcome.reason, true);
      return text(
        outcome.accepted === 0
          ? "Recorded that there is nothing to start. No runs will be created, " +
            "and any block set to start after this one will be stopped rather " +
            "than run with nothing to work on."
          : `Accepted ${outcome.accepted} run(s). They are created and queued ` +
            "when this turn ends — there is no approval step. You cannot emit " +
            "again; say anything else you would have started in your reply.",
      );
    }

    default:
      return text(`Unknown tool: ${name}`, true);
  }
}

/**
 * One run, as much as is worth reading in a tool result.
 *
 * The log is tailed rather than sent whole for the reason the run page tails
 * it: a run that worked for a day has tens of thousands of events, and a tool
 * result that large is spend with no information in it. `dropped` is reported
 * for the same reason a shortened diff says so.
 *
 * The diff is a *summary* here — file names and line counts — with the patch
 * itself behind `get_run_diff`. Splitting them is what keeps "what did this run
 * touch" cheap enough to ask about several runs in a row.
 */
async function getRunDetail(args: Record<string, unknown>) {
  const runId = String(args.runId ?? "").trim();
  const run = getRun(runId);
  if (!run) return text(`No run with id "${runId}". Call list_runs.`, true);

  const limit = Math.min(Math.max(Number(args.events) || 20, 1), 100);
  const { events, dropped } = runEvents(runId, 0, limit);
  const { mountId, relPath } = describeFolder(run.folder);
  const diff = await runDiff(runId);

  return text(
    JSON.stringify(
      {
        runId: run.id,
        status: run.status,
        mountId,
        folder: relPath,
        isolated: run.isolation === "worktree",
        branch: run.worktree_branch,
        baseBranch: run.worktree_base_branch,
        createdAt: new Date(run.created_at).toISOString(),
        iterations: run.iterations,
        spent: fmtUSD(run.spent_usd),
        stopReason: run.stop_reason,
        landedAt: run.landed_at ? new Date(run.landed_at).toISOString() : null,
        task: run.prompt,
        changed: {
          kind: diff.kind,
          reason: diff.reason,
          filesChanged: diff.filesChanged,
          added: diff.added,
          deleted: diff.deleted,
          files: diff.files
            .slice(0, 50)
            .map((f) => `${f.status} ${f.path} (+${f.added ?? "?"} −${f.deleted ?? "?"})`),
          filesOmittedFromThisList: Math.max(0, diff.files.length - 50),
          caveat: diff.caveat,
        },
        recentLog: events.map((e) => ({
          at: new Date(e.ts).toISOString(),
          kind: e.kind,
          detail: clip(JSON.stringify(e.payload)),
        })),
        logEntriesOlderThanThese: dropped,
      },
      null,
      1,
    ),
  );
}

/**
 * One log entry's payload, bounded.
 *
 * An `assistant` event carries a whole model turn and a `tool` event carries a
 * tool's entire input, so a hundred of them unbounded is a tool result larger
 * than the conversation asking for it — and this is the one tool a model is
 * told to call repeatedly. Truncated with the size named rather than silently:
 * the same rule the diff follows.
 */
function clip(s: string, max = 600): string {
  return s.length <= max
    ? s
    : `${s.slice(0, max)}… [${s.length - max} more characters]`;
}

/**
 * The patch, bounded — and saying so when it is, for `diffAsText`'s reason.
 *
 * Scoped to the caller's own runs, which is the one tool here that is. The
 * refusal names what to do instead rather than stopping at "no": a chat and a
 * block both have `--add-dir` on every mount, so the legitimate caller can read
 * the checkout itself, and a model told only that it may not is one that stops
 * looking. What the scope removes is the *stolen* token's reach — a work-cycle
 * agent is confined to the folder it was started in, and this was the one tool
 * that handed it source from every other repository. See `chatOwnsRun`.
 */
async function getRunPatch(
  args: Record<string, unknown>,
  subject: CapabilitySubject,
) {
  const runId = String(args.runId ?? "").trim();
  if (!getRun(runId)) return text(`No run with id "${runId}". Call list_runs.`, true);

  const mine =
    subject.kind === "chat"
      ? chatOwnsRun(subject.chatId, runId)
      : instanceOwnsRun(subject.instanceId, runId);
  if (!mine) {
    return text(
      `The patch for run ${runId} is not available here: ${
        subject.kind === "chat"
          ? "this conversation did not start that run"
          : "that run is not part of this workflow instance"
      }. get_run still reports its status, its spend, its log and the files it ` +
        "changed, and its folder is one you can read directly.",
      true,
    );
  }

  const diff = await runDiff(runId);
  if (diff.files.length === 0) {
    return text(diff.reason ?? "This run changed nothing.");
  }

  const { text: body, shown, truncated } = diffAsText(diff, MAX_DIFF_TEXT_BYTES);
  return text(
    `${shown} of ${diff.files.length} changed files, ` +
      `+${diff.added} −${diff.deleted}${truncated ? " (truncated)" : ""}` +
      `${diff.caveat ? `\n${diff.caveat}` : ""}\n${body}`,
  );
}

/**
 * The windows, as the dashboard reads them.
 *
 * `guardFraction` alongside `fraction` rather than instead of it: the guard
 * charges unpriced models a fallback rate and the display does not, so a chat
 * told only the displayed number would confidently say there is room in a
 * window that will refuse the next run. Both, named, is the honest answer.
 *
 * Every number here is for talking about *timing*. Nothing downstream reads it:
 * a proposal's guards come from a template or from settings, and `evaluateBudget`
 * re-reads the windows itself before every work cycle.
 */
async function usageReport() {
  const snapshot = await currentSnapshot();
  const active = activeRuns();

  const window = (w: typeof snapshot.session) => ({
    startsAt: new Date(w.startsAt).toISOString(),
    endsAt: new Date(w.endsAt).toISOString(),
    spent: fmtUSD(w.costUSD),
    ceiling: w.limit === null ? null : fmtUSD(w.limit),
    fraction: w.fraction,
    guardFraction: w.guardFraction,
  });

  return text(
    JSON.stringify(
      {
        now: new Date(snapshot.now).toISOString(),
        session: window(snapshot.session),
        weekly: window(snapshot.weekly),
        burnCostPerHour: fmtUSD(snapshot.burnCostPerHour),
        projectedExhaustionAt: snapshot.projectedExhaustionAt
          ? new Date(snapshot.projectedExhaustionAt).toISOString()
          : null,
        running: active.filter((r) => r.status === "running").length,
        queued: active.filter((r) => r.status === "queued").length,
        paused: active.filter((r) => r.status === "paused").length,
        // A null ceiling is not zero and not "unlimited" — it is a number
        // Anthropic does not publish and the operator has not supplied, so
        // every fraction above it is null too. Said outright, because a model
        // reading null as 0% would report a fresh window on a spent one.
        note:
          snapshot.session.limit === null || snapshot.weekly.limit === null
            ? "A null ceiling means the operator has set none for that window, " +
              "so its fraction is unknown rather than zero."
            : null,
      },
      null,
      1,
    ),
  );
}

/**
 * The saved workflows, as much of each as is worth reading before proposing.
 *
 * The blocks are summarised rather than dumped: a graph's node ids, prompt
 * overrides and edge conditions are what the editor needs and not what a
 * decision to propose a *new* one turns on. What that decision does turn on is
 * whether this work already has a workflow, whether one is running right now,
 * and — for a graph the chat is about to extend or imitate — which guard set
 * each step uses.
 *
 * `liveRuns`/`liveBlocks` are reported for `list_runs`' reason: work already in
 * flight is worth mentioning rather than duplicating.
 */
function workflowReport() {
  const workflows = listWorkflows();
  if (workflows.length === 0) {
    return text(
      "No workflows are saved. propose_workflow proposes one; the operator " +
        "approves it, which saves it, and then presses Run themselves.",
    );
  }
  return text(
    JSON.stringify(
      workflows.map((w) => {
        const last = lastRunAt(w.id);
        return {
          workflowId: w.id,
          name: w.name,
          lastRunAt: last === null ? null : new Date(last).toISOString(),
          liveRuns: liveRunsOf(w.id).length,
          liveBlocks: liveBlocksOf(w.id),
          instanceBudget: w.instanceBudget,
          blocks: w.graph.nodes.map((n) => ({
            id: n.id,
            name: n.name,
            kind: n.kind,
            templateId: n.templateId,
            mountId: n.mountId || null,
            folder: n.kind === "merge" ? null : n.folder,
            fanOut: n.fanOut,
            after: w.graph.edges
              .filter((e) => e.to === n.id)
              .map((e) => `${e.from} (${e.edge})`),
          })),
        };
      }),
      null,
      1,
    ),
  );
}

/**
 * Record one workflow proposal, refusing anything that could not be saved.
 *
 * The graph goes through the *same* `normalizeWorkflowInput` and the same
 * `folderRefusal` the save route and the editor's validate route call, with the
 * same `currentKnowledge()` — a second set of rules about what a workflow may
 * be would be a second set to keep in step, confidently wrong about what
 * approval would do the day one of them changed. It is checked here as well as
 * at approval for `proposeRun`'s reason: a proposal that cannot be approved is
 * otherwise discovered by a person clicking Approve, which is the wrong moment
 * and the wrong person.
 *
 * The normalized graph is what is stored, so what the card describes and what
 * approval saves are one object rather than two readings of the model's text.
 *
 * There is no `instanceBudget` argument and no column that could carry one:
 * that is a limit on billed spend, and this route has never let a model set
 * one. The workflow is saved without it and the card says what that costs —
 * it can be run by hand and cannot be scheduled until the operator sets one.
 */
function proposeWorkflow(args: Record<string, unknown>, chatId: string) {
  const name = String(args.name ?? "").trim();
  if (!name) return text("A workflow needs a name.", true);

  const blocks = Array.isArray(args.blocks) ? args.blocks : null;
  if (!blocks || blocks.length === 0) {
    return text("A workflow needs at least one block of work.", true);
  }

  // The tool takes each block's own `dependsOn`, which is the shape `emit_runs`
  // already uses; a graph is `{nodes, edges}`. Converted here rather than asked
  // for in edge form, so a model that has written one has written the other.
  const edges: Array<Record<string, unknown>> = [];
  for (const entry of blocks) {
    const b = (entry ?? {}) as Record<string, unknown>;
    const to = String(b.id ?? "");

    // `""` is the mount root, and `normalizeWorkflowInput` is right to treat it
    // as a real answer — the editor's picker offers it, and choosing it is a
    // decision. An *omitted* field is not that decision, and reading one as the
    // other would silently put a block on the whole workspace, which is the one
    // selection that blocks every other run in the tree. So it is required
    // here, exactly as `propose_run` requires a folder beside a mountId.
    if (String(b.kind ?? "run") !== "merge" && b.folder === undefined) {
      return text(
        `“${String(b.name ?? to)}” names no folder. Pass it exactly as ` +
          'list_folders gives it, or "" if you really mean the whole ' +
          "workspace, which blocks every other run under it.",
        true,
      );
    }

    for (const raw of Array.isArray(b.dependsOn) ? b.dependsOn : []) {
      const d = (raw ?? {}) as Record<string, unknown>;
      edges.push({
        from: String(d.id ?? ""),
        to,
        edge: String(d.edge ?? ""),
        continueBranch: d.continueBranch === true,
      });
    }
  }

  const known = currentKnowledge();
  const parsed = normalizeWorkflowInput(
    { name, graph: { nodes: blocks, edges }, instanceBudget: null },
    known,
  );
  if (!parsed.ok) return text(parsed.error, true);

  const missing = folderRefusal(parsed.value.graph);
  if (missing) return text(missing, true);

  const pending = pendingProposals(chatId);
  if (pending.length >= MAX_PENDING_PROPOSALS) {
    return text(pendingLimitMessage(pending.length), true);
  }

  const proposal = createProposal(chatId, {
    kind: "workflow",
    templateId: null,
    title: name,
    task: String(args.summary ?? "").trim() || `A workflow of ${parsed.value.graph.nodes.length} block(s).`,
    promptOverride: null,
    mountId: null,
    folder: null,
    graph: JSON.stringify(parsed.value.graph),
  });

  const deciding = parsed.value.graph.nodes.filter(
    (n) => n.kind === "orchestrator",
  );
  return text(
    `Proposed the workflow “${name}” (id ${proposal.id}) with ` +
      `${parsed.value.graph.nodes.length} block(s). Approving it **saves** the ` +
      "workflow; it starts nothing, and the operator presses Run on it " +
      "themselves." +
      (deciding.length > 0
        ? ` ${deciding.length} block(s) decide what to run and may start up to ` +
          `${deciding.reduce((n, d) => n + (d.fanOut ?? 0), 0)} run(s) between ` +
          "them with no approval, which the card says."
        : "") +
      " It is saved with no workflow-wide budget, so it can be run by hand and " +
      "cannot be scheduled until the operator sets one.",
  );
}

/**
 * Record what the chat wants to know, and tell it plainly that it is done.
 *
 * The tool result is the second place — after the description — where "this
 * turn is over" has to be unmissable, and it is the one the model reads
 * *after* deciding to call. It says what was recorded, that no answer is
 * coming here, and what to do instead, because a receipt that only confirms
 * the write reads as a step in a sequence rather than as the end of one.
 *
 * Nothing is appended to the thread. `save_template` does, because a template
 * write leaves nothing behind for the operator to act on; a question leaves a
 * row of its own that the chat payload carries, and the answer message quotes
 * the question back — so it survives even the replay a lost session falls back
 * to, without a system message saying twice what the row already says.
 */
function askOperator(args: Record<string, unknown>, chatId: string) {
  const raw = Array.isArray(args.questions) ? args.questions : [];
  if (raw.length === 0) {
    return text(
      "ask_operator needs at least one question. If you know what to do, " +
        "propose it instead — the operator approves every proposal by hand.",
      true,
    );
  }

  // Bounded against what is *already* open as well as against this call: a
  // turn may call this twice, and a chat whose last turn asked five questions
  // the operator has not read yet does not need five more.
  const open = pendingQuestions(chatId);
  if (open.length + raw.length > MAX_OPEN_QUESTIONS) {
    return text(
      `That would leave ${open.length + raw.length} questions waiting, and the ` +
        `limit is ${MAX_OPEN_QUESTIONS}${
          open.length > 0 ? ` (${open.length} of them already asked)` : ""
        }. A list that long is a form rather than a question, and a form gets ` +
        "skimmed. Ask the ones that change what you would propose, and say the " +
        "rest in your reply.",
      true,
    );
  }

  const questions: QuestionInput[] = [];
  for (const entry of raw) {
    const q = (entry ?? {}) as Record<string, unknown>;
    const question = String(q.question ?? "").trim();
    if (!question) return text("Every question needs its text.", true);

    // Normalized first, so every refusal below counts what would actually be
    // rendered rather than what arrived: twenty distinct choices and twenty
    // copies of one are different mistakes and get different sentences.
    const choices = normalizeChoices(q.choices);
    const allowText = q.allowText !== false;

    if (choices.length > MAX_QUESTION_CHOICES) {
      return text(
        `"${question}" offers ${choices.length} choices, and the most that can ` +
          `be shown is ${MAX_QUESTION_CHOICES}. Past that it is a search rather ` +
          "than a decision — narrow it, or ask it in the open.",
        true,
      );
    }
    // One choice is not a choice, and the operator has no way to say so — it
    // reads as a decision already taken. Refused rather than quietly turned
    // into free text, because which of the two the model meant is not
    // something this route can know.
    if (choices.length === 1) {
      return text(
        `"${question}" offers one choice, which is not a choice. Offer at ` +
          "least two, or omit choices and let the operator answer in their " +
          "own words.",
        true,
      );
    }
    // The unanswerable question, and the one this route exists to catch: no
    // choices and no typing is a card with nothing on it to press, holding one
    // of the operator's five slots until some later message supersedes it. It
    // is reachable without the model meaning any of it — `choices` sent as a
    // bare string normalizes to none, which is exactly the arrival shape
    // `normalizeChoices` is built to survive — so it is refused by name rather
    // than by turning `allowText` back on, which would answer a different
    // question from the one that was asked.
    if (choices.length === 0 && !allowText) {
      return text(
        `"${question}" offers no choices and does not allow a typed answer, so ` +
          "there is no way to answer it. Offer at least two choices, or leave " +
          "allowText true.",
        true,
      );
    }

    questions.push({
      question,
      choices,
      // True unless the model says otherwise, including when it offers
      // choices: a question the operator cannot answer in their own words is
      // one they answer by ignoring, and a superseded question teaches the
      // model nothing about what it got wrong.
      allowText,
    });
  }

  createQuestions(chatId, questions);

  return text(
    `Recorded ${questions.length} question${questions.length === 1 ? "" : "s"} ` +
      "for the operator. Your turn ends here. Nothing returns their answer to " +
      "you: it arrives as their next message in this conversation, with each " +
      "question quoted above the answer to it. Finish your reply now — say " +
      "what you asked, why it changes what you would propose, and what you " +
      "would propose under each answer — and do NOT call this again.",
  );
}

/** One sentence, shared by both proposal tools, because the limit is shared. */
function pendingLimitMessage(count: number): string {
  return (
    `This chat already has ${count} proposals waiting for approval, which is ` +
    `the limit (${MAX_PENDING_PROPOSALS}). A list that long stops getting read ` +
    "before it gets approved. Tell the operator what you would propose next " +
    "and ask them to approve or reject these first, or narrow what you are " +
    "proposing."
  );
}

/**
 * Write a template's name and prompt, and nothing else.
 *
 * The guards are read off the existing row or off `chatGuards()` and written
 * straight back, so there is no argument on this tool that could move one. That
 * is the same division `planProposal` enforces at approval time, applied here
 * because a template the chat could arm would be a route to `--permission-mode`
 * that outlives the conversation — worse than a proposal, which at least gets
 * looked at once before it runs.
 *
 * The write is recorded in the thread rather than left to the model to mention.
 * A proposal has a card; this has nothing, and rewriting a prompt the operator
 * wrote and tested is not something they should find out about by reading a
 * template weeks later and wondering when it changed.
 */
function saveTemplate(args: Record<string, unknown>, chatId: string) {
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) return text("A template needs a prompt.", true);

  const templateId = String(args.templateId ?? "").trim();
  const existing = templateId ? getTemplate(templateId) : null;
  if (templateId && !existing) {
    return text(
      `No template with id "${templateId}". Call list_templates, or omit ` +
        "templateId to create a new one.",
      true,
    );
  }

  const name = String(args.name ?? "").trim() || existing?.name || "";
  const guards = existing ?? chatGuards();
  const input = {
    name,
    prompt,
    mountId: existing?.mountId ?? null,
    folder: existing?.folder ?? null,
    isolate: guards.isolate,
    permissionMode: guards.permissionMode,
    // Carried from the row rather than taken from an argument, and named here
    // for the reason every other field on this object is: the update replaces
    // the template wholesale, so a field this list forgets is a field the chat
    // silently deletes. There is deliberately no argument for it — which agent
    // a template names is one of the facts a person chose, and this tool may
    // write a prompt and nothing else.
    agentId: existing?.agentId ?? null,
    budget: guards.budget,
  };

  // Re-read through the same normaliser the form uses, so a prompt or name this
  // tool accepts is exactly one the operator could have typed.
  const normalized = normalizeTemplateInput(input, {
    agents: currentAgentKnowledge(),
  });
  if (!normalized.ok) return text(normalized.error, true);

  try {
    const saved = existing
      ? updateTemplate(existing.id, normalized.value)
      : createTemplate(normalized.value);
    if (!saved) return text("That template was deleted while saving.", true);
    appendMessage(
      chatId,
      "system",
      existing
        ? `The chat rewrote the prompt of the “${saved.name}” template. Its ` +
          "guards are unchanged."
        : `The chat saved a new template, “${saved.name}”, under your default ` +
          "guard set.",
    );
    return text(
      `${existing ? "Rewrote" : "Saved"} template “${saved.name}” (id ${saved.id}). ` +
        `Its guards are unchanged: ${saved.permissionMode}, ` +
        `${saved.isolate ? "own checkout" : "the operator's own folder"}, ` +
        `${saved.budget.maxIterations ?? "no"} work-cycle limit.`,
    );
  } catch (err) {
    // A duplicate name arrives here as the sentence the form would show.
    return text(err instanceof Error ? err.message : String(err), true);
  }
}

/**
 * Record one proposal, refusing anything that could not later be approved.
 *
 * Deliberately stricter than it has to be. `planProposal` and `createRun` both
 * check these again at approval time and only those checks guard anything —
 * but a proposal that cannot be approved is discovered by a person clicking
 * Approve on a list of twenty, which is the wrong moment and the wrong person.
 * The same reasoning `normalizeTemplateInput` gives for validating at the form.
 */
function proposeRun(args: Record<string, unknown>, chatId: string) {
  const templateId = String(args.templateId ?? "").trim();
  const template = templateId ? getTemplate(templateId) : null;
  if (templateId && !template) {
    return text(
      `No template with id "${templateId}". Call list_templates and use an id ` +
        "from it, or omit templateId to use the operator's default guard set.",
      true,
    );
  }

  // The agent, refused here as well as at approval for the reason the template
  // above it is: a proposal that cannot be approved is otherwise discovered by
  // a person clicking Approve on a list of twenty. It is the same
  // `agentRefusal` the run door, the template door and every workflow door use,
  // so an agent that has gone is one sentence wherever it is named — and it is
  // a refusal rather than a silent drop, because a run proposed "as the
  // reviewer" and started as nobody is bit-for-bit a run that was never given
  // one.
  const agentId = String(args.agentId ?? "").trim() || null;
  if (agentId !== null) {
    const refusal = agentRefusal(agentId, currentAgentKnowledge());
    if (refusal) return text(`${refusal} Call list_agents for the ids.`, true);
  }

  const title = String(args.title ?? "").trim();
  if (!title) return text("A proposal needs a title.", true);

  const task = String(args.task ?? "").trim();
  if (!task) {
    return text(
      "A proposal needs a task. It is the whole brief the agent gets besides " +
        "the template's own prompt.",
      true,
    );
  }

  // Null means "whatever the template says". "" is a real answer — the mount
  // root — so the two are never collapsed. See the same note in planProposal.
  const hasMount = args.mountId !== undefined && args.mountId !== null && args.mountId !== "";
  let mountId: string | null = null;
  let folder: string | null = null;

  if (hasMount) {
    mountId = String(args.mountId);
    if (!mountById(mountId)) {
      return text(
        `No workspace mount called "${mountId}". Call list_folders for the ids.`,
        true,
      );
    }
    folder = String(args.folder ?? "");
    try {
      resolveWorkspaceFolder(folder, mountId);
    } catch (err) {
      return text(
        `That folder cannot be used: ${err instanceof Error ? err.message : String(err)}. ` +
          "Use a folder exactly as list_folders gives it.",
        true,
      );
    }
  } else if (!template) {
    return text(
      "A proposal with no template has to name where it runs. Pass mountId " +
        "and folder from list_folders.",
      true,
    );
  } else if (template.mountId === null) {
    return text(
      `The "${template.name}" template does not name a folder, so this ` +
        "proposal has to. Pass mountId and folder from list_folders.",
      true,
    );
  }

  const pending = pendingProposals(chatId);
  if (pending.length >= MAX_PENDING_PROPOSALS) {
    return text(pendingLimitMessage(pending.length), true);
  }

  // The chat's own label, and what it says this run starts after. Checked here
  // rather than only at approval for the reason everything else in this
  // function is: a chain that cannot be wired is otherwise discovered by a
  // person clicking Approve on a list of twenty, and what they are shown then
  // is one proposal failing over a label they never saw.
  const labels = new Map(
    listProposals(chatId)
      .filter((p) => p.spec_id)
      .map((p) => [p.spec_id!, p]),
  );

  const specId = String(args.id ?? "").trim() || null;
  if (specId !== null) {
    if (!SPEC_ID.test(specId)) {
      return text(
        `"${specId}" is not a usable id. An id is 1–64 letters, digits, ` +
          "hyphens or underscores.",
        true,
      );
    }
    // Only against what is still undecided: a label reused after the first one
    // has become a run is unambiguous, because a dependency resolves against
    // the batch first and only then against what already started.
    if (labels.get(specId)?.status === "pending") {
      return text(
        "Another proposal waiting for approval in this chat is already " +
          `labelled "${specId}". Give this one a different id.`,
        true,
      );
    }
  }

  const dependsOn: ProposalDependency[] = [];
  for (const raw of Array.isArray(args.dependsOn) ? args.dependsOn : []) {
    const d = (raw ?? {}) as Record<string, unknown>;
    const on = String(d.id ?? "").trim();
    if (specId !== null && on === specId) {
      return text("A proposal cannot start after itself.", true);
    }
    const target = labels.get(on);
    if (!target) {
      return text(
        `This is set to start after "${on}", which is not a proposal in this ` +
          "chat. Give the earlier proposal an id and name that one, or call " +
          "list_proposals for the ids already used.",
        true,
      );
    }
    if (target.status === "rejected" || target.status === "failed") {
      return text(
        `"${on}" was ${target.status} and never became a run, so nothing can ` +
          "start after it.",
        true,
      );
    }
    if (dependsOn.some((existing) => existing.specId === on)) {
      return text(
        `"${on}" is named twice, so it is unclear which condition applies.`,
        true,
      );
    }
    const edge = String(d.edge ?? "");
    if (!(DEPENDENCY_EDGES as readonly string[]).includes(edge)) {
      return text(
        `Starting after "${on}" needs a condition: ${DEPENDENCY_EDGES.join(" or ")}.`,
        true,
      );
    }
    dependsOn.push({
      specId: on,
      edge: edge as DependencyEdge,
      // `=== true` for the reason `POST /api/runs` reads it that way: it
      // decides which branch a billed agent commits to, so anything else off
      // the wire must fail safe.
      continueBranch: d.continueBranch === true,
    });
  }

  // Carrying a branch on needs a checkout at both ends, and at most one of
  // them. `admitDependencies` refuses both of these as well, but it does so
  // when the operator clicks and in terms of run ids they have never seen —
  // and the second one is not even a mistake the model can see it made, since
  // isolation is on a guard set it never chose.
  const continuing = dependsOn.filter((d) => d.continueBranch);
  if (continuing.length > 1) {
    return text(
      `This is set to carry on the branch of both "${continuing[0].specId}" and ` +
        `"${continuing[1].specId}". A run can only continue one branch.`,
      true,
    );
  }
  if (continuing.length === 1) {
    const predecessor = labels.get(continuing[0].specId)!;
    const flat = [
      { label: "This proposal", guards: template ?? chatGuards() },
      {
        label: `"${continuing[0].specId}"`,
        guards: predecessor.template_id
          ? (getTemplate(predecessor.template_id) ?? chatGuards())
          : chatGuards(),
      },
    ].find((end) => !end.guards.isolate);
    if (flat) {
      return text(
        `${flat.label} works directly in the folder rather than in a checkout ` +
          "of its own, so there is no branch to carry on. Both runs need guards " +
          "that isolate — a template that does, or ask the operator to change " +
          "the default guard set.",
        true,
      );
    }
  }

  const promptOverride = String(args.promptOverride ?? "").trim() || null;

  const proposal = createProposal(chatId, {
    templateId: template ? template.id : null,
    agentId,
    title,
    task,
    promptOverride,
    mountId,
    folder,
    specId,
    dependsOn,
  });

  const guards = template
    ? `template "${template.name}"${promptOverride ? ", with a prompt you rewrote" : ""}`
    : "the operator's default guard set";
  // Said outside the guard clause, because an agent bounds nothing — the same
  // separation the run page and the workflow canvas make, so this app never
  // words it as though naming one narrowed anything.
  const asAgent = agentId
    ? ` It runs as ${currentAgentKnowledge().get(agentId)?.name ?? "the agent you named"}.`
    : "";
  const after =
    dependsOn.length === 0
      ? ""
      : ` It starts after ${dependsOn
          .map(
            (d) =>
              `"${d.specId}" (${d.edge}${d.continueBranch ? ", on its branch" : ""})`,
          )
          .join(" and ")} — say so, because both have to be approved in the ` +
        "same click unless the earlier one has already started.";
  return text(
    `Proposed "${title}" (id ${proposal.id}) under ${guards}.${asAgent}${after} ` +
      "It is waiting for the operator to approve it; nothing is running.",
  );
}
