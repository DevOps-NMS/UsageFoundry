import { NextResponse } from "next/server";
import {
  appendMessage,
  createProposal,
  listProposals,
  MAX_PENDING_PROPOSALS,
  pendingProposals,
  subjectForCapability,
  type CapabilitySubject,
} from "@/lib/chat";
import { emitBlockRuns } from "@/lib/workflows";
import {
  createTemplate,
  getTemplate,
  listTemplates,
  normalizeTemplateInput,
  updateTemplate,
} from "@/lib/templates";
import {
  activeRuns,
  currentSnapshot,
  describeFolder,
  getRun,
  listRuns,
  resolveWorkspaceFolder,
  runEvents,
} from "@/lib/orchestrator";
import { diffAsText, runDiff } from "@/lib/diff";
import { chatGuards } from "@/lib/settings";
import { githubRemotes, scanWorkspace } from "@/lib/workspace";
import { mountById } from "@/lib/config";
import { fmtUSD } from "@/lib/format";

/**
 * What one `get_run_diff` may return.
 *
 * Smaller than the reviewer's budget on purpose: a review is one call about one
 * diff, where this is a turn that may look at several runs and still has to
 * think afterwards — and `settings.chatTurnBudgetUSD` is what pays for it.
 */
const MAX_DIFF_TEXT_BYTES = 60_000;

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
 * nothing here writes to a folder, and nothing here sets a budget, a permission
 * mode or an isolation choice. A chat's most is a `chat_proposals` row, inert
 * until a person approves it. A block's most is a list of run specs, which start
 * — under the guards the block's *saved* template supplies, in the mount that
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

/** Tools both kinds of caller get: everything that only reads. */
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
      "in flight is not proposed a second time.",
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
      "— the file list is always complete and the omitted files are named.",
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
            "Replaces the template's own prompt for this run only. Use when " +
            "the template nearly fits; the task is still appended below it.",
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
      },
      required: ["title", "task"],
      additionalProperties: false,
    },
  },
];

/**
 * The one tool an orchestrator block gets that writes anything.
 *
 * Four fields per run and no fifth. There is no template id, no budget, no
 * permission mode, no isolation choice and no model on this schema, and their
 * absence is the whole reason auto-start is defensible: the block's guards were
 * chosen by a person when the graph was saved, and a field here that could name
 * different ones would be a route to `--permission-mode` reached by a model with
 * nobody reading the result. The description says so outright, because a model
 * that believes it can set guards writes a task explaining what guards it wants.
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

export async function POST(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const subject = subjectForCapability(bearer);
  if (!subject) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

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

/** The transport's other verbs. Neither is needed: there is no server stream. */
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
    return text(
      `${name} is not available to an orchestrator block. Use emit_runs.`,
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
      return getRunPatch(args);

    case "get_usage":
      return usageReport();

    case "list_proposals": {
      const proposals = listProposals(chatId!);
      if (proposals.length === 0) {
        return text("Nothing has been proposed in this conversation yet.");
      }
      return text(
        JSON.stringify(
          proposals.map((p) => ({
            proposalId: p.id,
            title: p.title,
            status: p.status,
            templateId: p.template_id,
            runId: p.run_id,
            error: p.error,
            task: p.task.slice(0, 200),
          })),
          null,
          1,
        ),
      );
    }

    case "save_template":
      return saveTemplate(args, chatId!);

    case "propose_run":
      return proposeRun(args, chatId!);

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

/** The patch, bounded — and saying so when it is, for `diffAsText`'s reason. */
async function getRunPatch(args: Record<string, unknown>) {
  const runId = String(args.runId ?? "").trim();
  if (!getRun(runId)) return text(`No run with id "${runId}". Call list_runs.`, true);

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
    budget: guards.budget,
  };

  // Re-read through the same normaliser the form uses, so a prompt or name this
  // tool accepts is exactly one the operator could have typed.
  const normalized = normalizeTemplateInput(input);
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
    return text(
      `This chat already has ${pending.length} proposals waiting for approval, ` +
        `which is the limit (${MAX_PENDING_PROPOSALS}). A list that long stops ` +
        "getting read before it gets approved. Tell the operator what you would " +
        "propose next and ask them to approve or reject these first, or narrow " +
        "what you are proposing.",
      true,
    );
  }

  const promptOverride = String(args.promptOverride ?? "").trim() || null;

  const proposal = createProposal(chatId, {
    templateId: template ? template.id : null,
    title,
    task,
    promptOverride,
    mountId,
    folder,
  });

  const guards = template
    ? `template "${template.name}"${promptOverride ? ", with a prompt you rewrote" : ""}`
    : "the operator's default guard set";
  return text(
    `Proposed "${title}" (id ${proposal.id}) under ${guards}. It is waiting ` +
      "for the operator to approve it; nothing is running.",
  );
}
