import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
} from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  CLAUDE_BIN,
  MCP_SELF_URL,
  WORKSPACE_MOUNTS,
  WORKSPACE_ROOT,
} from "./config";
import { db } from "./db";
import { chatGuards, getSettings, type RunGuards } from "./settings";
import { assistRefusal } from "./review";
import {
  createRun,
  dependencyCycle,
  githubEnv,
  signalTree,
  topologicalOrder,
  type CreateRunInput,
  type DependencyEdge,
  type RunDependencyInput,
} from "./orchestrator";
import { getTemplate, type RunTemplate } from "./templates";
import {
  agentDefinition,
  agentKnowledgeOf,
  agentRefusal,
  agentsArgs,
  getAgent,
  type AgentDefinition,
  type RegistryAgent,
} from "./agents";

/**
 * The orchestrator chat: a conversation that proposes runs.
 *
 * **This is the fourth kind of child process this app spawns**, after git, the
 * agent, and the one-shot review. `review.ts` says adding a third was a
 * decision rather than a detail; so is this, and it is worth saying what makes
 * it a separate kind rather than a fifth caller of `startAssist`:
 *
 *   - It is a *conversation*. It resumes, it accumulates a thread, and its
 *     spend is per turn rather than per invocation — which is why it has its
 *     own table with a running total instead of a row per call.
 *   - It has tools this app implements. No other child talks back to this
 *     server; see `/api/mcp` and the capability token below.
 *   - It is the only child that reaches GitHub *without* doing work. The
 *     invariant used to be "GitHub credentials reach a work cycle and nothing
 *     else"; this widens it to "a work cycle, and the chat that decides what
 *     the work should be", which is a real widening and is why it is written
 *     down here rather than absorbed quietly.
 *
 * What it is **not** allowed to be is a route to spend nobody authorised. It
 * cannot start a run: everything it writes *through this app* is form input — a
 * `chat_proposals` row, or a `run_templates` prompt — neither of which holds a
 * folder claim, consumes a concurrency slot, or does anything at all until a
 * person approves it. Every tool that could widen what an agent may do is
 * absent from that list rather than guarded inside it.
 *
 * Its *own* tool surface, by contrast, is now unrestricted: it runs
 * `bypassPermissions` with no allowlist, so it can read anything, run anything
 * and — with the GitHub token above in its environment — reach the network.
 * That is a deliberate trade, and the reasoning is in `runTurn` where the flag
 * is set. What keeps it an orchestrator is the system prompt, not the mode.
 *
 * Its own cost never reaches `runs.spent_usd`, exactly as a review's does not.
 */

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

export type ChatStatus = "idle" | "thinking" | "failed";
export type ChatRole = "user" | "assistant" | "system";
export type ProposalStatus = "pending" | "approved" | "rejected" | "failed";

/**
 * What a proposal is a proposal *of*.
 *
 * `run` is the original and the default, for the reason `WorkflowNode.kind`
 * defaults to `run`: every row written before this existed says nothing there,
 * and the other reading would turn a queued run into a graph nobody wrote.
 *
 * `workflow` is the second, and what approving one does is deliberately weaker:
 * it **saves a workflow** and starts nothing. That is what keeps a graph a
 * person's rather than a model's — a saved workflow is form input exactly as a
 * template is, and the press of Run that turns it into agents is still the
 * operator's, on a page that draws the whole graph. The card in the chat is the
 * first of those two gates and it has to spell out what a canvas would show:
 * which guard set each block runs under, how many runs a deciding block may
 * start, and whether a merge block may pay to reconcile a conflict.
 */
export type ProposalKind = "run" | "workflow";

/**
 * "Start this proposal's run after that one's."
 *
 * `specId` is the **chat's own label** rather than a proposal id, because the
 * model writes several proposals in one turn and has to be able to point one at
 * another before either has an id. It is resolved to a run id at approval —
 * against a sibling in the same batch, or against a proposal of this chat that
 * has already become a run — and a label that resolves to neither fails that
 * one proposal by name rather than starting it with no dependency at all, which
 * is a run told to wait that does not.
 */
export interface ProposalDependency {
  specId: string;
  edge: DependencyEdge;
  /** Carry on that run's branch rather than cutting a new one. */
  continueBranch: boolean;
}

export interface ChatRow {
  id: string;
  created_at: number;
  updated_at: number;
  title: string | null;
  session_id: string | null;
  status: ChatStatus;
  cost_usd: number;
  tokens: number;
  error: string | null;
  /**
   * When the turn in flight began, and null when none is. Deliberately not
   * `updated_at`: the chat's own `save_template` tool writes a system message
   * mid-turn, which moves that column and would push the timeout out by
   * however long the turn had already been running.
   */
  turn_started_at: number | null;
}

export interface ChatMessageRow {
  id: string;
  chat_id: string;
  ts: number;
  /** Insert order across every chat. What the thread is ordered by; see below. */
  seq: number;
  role: ChatRole;
  text: string;
}

export interface ChatProposalRow {
  id: string;
  chat_id: string;
  created_at: number;
  kind: ProposalKind;
  /** Null when the proposal runs under `settings.chatDefaultGuards` instead. */
  template_id: string | null;
  /**
   * The saved agent this run may hand a subtask to, by id, or null.
   *
   * An id rather than a copy — see the column note in `db.ts` — and on the
   * *work* side of the proposal beside the task and the folder, never on the
   * guard side: an agent holds no tool list and no permission mode, so naming
   * one decides who does a piece of the work and never what the run may do.
   */
  agent_id: string | null;
  title: string;
  task: string;
  /** The prompt the task is appended to, when the chat wrote one for this run. */
  prompt_override: string | null;
  mount_id: string | null;
  folder: string | null;
  /** The chat's own label for this proposal, or null when it named none. */
  spec_id: string | null;
  /** JSON `ProposalDependency[]`, or null. Read through `proposalDeps`. */
  depends_on: string | null;
  /**
   * A workflow proposal's graph, as `normalizeWorkflowInput` left it. Null on a
   * run proposal — the two kinds carry different things and neither should be
   * read off the other's column.
   */
  graph: string | null;
  status: ProposalStatus;
  run_id: string | null;
  /** What a workflow proposal became. Never a run; approving one starts nothing. */
  workflow_id: string | null;
  decided_at: number | null;
  error: string | null;
}

/**
 * The dependencies on a row, or none.
 *
 * Never throws: the column is written by this module and read back by it, but a
 * row hand-edited or written by an older build must not be able to make a chat
 * page 500. An unreadable list is no dependencies, which is the reading that
 * *fails safe* in only one direction — the proposal starts immediately instead
 * of waiting — so it is logged nowhere and shown everywhere: the card carries
 * what it is waiting for, so a list that silently emptied is visible before the
 * operator approves it rather than after.
 */
export function proposalDeps(
  row: Pick<ChatProposalRow, "depends_on">,
): ProposalDependency[] {
  if (!row.depends_on) return [];
  try {
    const parsed = JSON.parse(row.depends_on) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      const specId = String(e.specId ?? "");
      const edge = String(e.edge ?? "");
      if (!specId || (edge !== "on-success" && edge !== "on-finish")) return [];
      return [{ specId, edge, continueBranch: e.continueBranch === true }];
    });
  } catch {
    return [];
  }
}

/**
 * How many undecided proposals one chat may hold.
 *
 * The failure this bounds is specific and cheap to reach: "open a run for every
 * issue" against a repository with four hundred of them. Nothing downstream
 * would break — proposals are inert — but an approval list nobody can read is
 * an approval gate that gets clicked through, which is the same as not having
 * one. The tool refuses past this and says so, so the model asks for a filter
 * instead of silently proposing the first twenty-five.
 */
export const MAX_PENDING_PROPOSALS = 25;

/** How much of the thread is replayed when there is no session to resume. */
const THREAD_REPLAY_MESSAGES = 20;
const THREAD_REPLAY_BYTES = 20_000;

/** A chat turn that has not finished in this long is not going to. */
export const CHAT_TIMEOUT_MS = 10 * 60_000;

/**
 * How long past that bound the sweeper waits before failing a row out.
 *
 * The in-closure timer above fires at exactly `CHAT_TIMEOUT_MS` and then gives
 * the child five seconds to die, so a turn that is being stopped properly
 * settles well inside this margin. What is left over when the margin expires is
 * a turn whose `close` is not coming — the case this whole path exists for.
 */
export const STALE_TURN_MARGIN_MS = 60_000;

/** How often a `thinking` row is checked against that deadline. */
const CHAT_SWEEP_MS = 30_000;

/** How long `close` is given to deliver the last of stdout after the exit. */
const EXIT_DRAIN_MS = 2_000;

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export function createChat(): ChatRow {
  const id = randomUUID();
  const now = Date.now();
  db()
    .prepare(
      "INSERT INTO chat_sessions (id, created_at, updated_at, status) VALUES (?, ?, ?, 'idle')",
    )
    .run(id, now, now);
  return getChat(id)!;
}

export function getChat(id: string): ChatRow | null {
  return (
    (db().prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id) as
      | ChatRow
      | undefined) ?? null
  );
}

export function listChats(limit = 30): ChatRow[] {
  return db()
    .prepare("SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as ChatRow[];
}

/** The newest chat, or a fresh one. The page opens on a thread, not a list. */
export function latestChat(): ChatRow {
  return listChats(1)[0] ?? createChat();
}

/**
 * A thread, in the order it was written.
 *
 * Ordered by `seq` alone rather than by `ts` and then something: the timestamp
 * is a tie for every message a turn writes — `finishTurn` appends the reply,
 * an error and a denial note in one synchronous block — and the tiebreak it
 * used to fall through to was `id`, which is a random UUID. A denial note is a
 * footnote about the reply above it, so half the time the operator was told
 * "the tool was refused, and separately here is an answer". `seq` is the order
 * the rows were written and nothing else can reorder them, including a clock
 * that steps backwards mid-conversation.
 */
export function listMessages(chatId: string): ChatMessageRow[] {
  return db()
    .prepare("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY seq")
    .all(chatId) as ChatMessageRow[];
}

export function appendMessage(
  chatId: string,
  role: ChatRole,
  text: string,
): ChatMessageRow {
  const id = randomUUID();
  const now = Date.now();
  db()
    .prepare(
      // `seq` is taken inside the INSERT rather than read first: better-sqlite3
      // is synchronous and this app is a single writer, so one statement is the
      // only shape in which "the next number" cannot be handed out twice.
      "INSERT INTO chat_messages (id, chat_id, ts, seq, role, text)" +
        " VALUES (?, ?, ?, (SELECT IFNULL(MAX(seq), 0) + 1 FROM chat_messages), ?, ?)",
    )
    .run(id, chatId, now, role, text);
  db()
    .prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?")
    .run(now, chatId);
  return db()
    .prepare("SELECT * FROM chat_messages WHERE id = ?")
    .get(id) as ChatMessageRow;
}

export function listProposals(chatId: string): ChatProposalRow[] {
  return db()
    .prepare(
      "SELECT * FROM chat_proposals WHERE chat_id = ? ORDER BY created_at, id",
    )
    .all(chatId) as ChatProposalRow[];
}

export function getProposal(id: string): ChatProposalRow | null {
  return (
    (db().prepare("SELECT * FROM chat_proposals WHERE id = ?").get(id) as
      | ChatProposalRow
      | undefined) ?? null
  );
}

export function pendingProposals(chatId: string): ChatProposalRow[] {
  return listProposals(chatId).filter((p) => p.status === "pending");
}

export interface ProposalInput {
  kind?: ProposalKind;
  /** Null runs it under the operator's untemplated guard set. */
  templateId: string | null;
  /** A saved agent the run may delegate to, by id. Null is the ordinary run. */
  agentId?: string | null;
  title: string;
  task: string;
  /** Replaces the template's prompt for this run only. Null keeps it. */
  promptOverride: string | null;
  mountId: string | null;
  folder: string | null;
  /** The chat's own label for this proposal. Null when nothing names it. */
  specId?: string | null;
  dependsOn?: readonly ProposalDependency[];
  /** A workflow proposal's normalized graph, as JSON. Null on a run one. */
  graph?: string | null;
}

export function createProposal(
  chatId: string,
  input: ProposalInput,
): ChatProposalRow {
  const id = randomUUID();
  const deps = input.dependsOn ?? [];
  db()
    .prepare(
      `INSERT INTO chat_proposals
         (id, chat_id, created_at, kind, template_id, agent_id, title, task,
          prompt_override, mount_id, folder, spec_id, depends_on, graph, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      id,
      chatId,
      Date.now(),
      input.kind ?? "run",
      input.templateId,
      input.agentId ?? null,
      input.title,
      input.task,
      input.promptOverride,
      input.mountId,
      input.folder,
      input.specId ?? null,
      deps.length > 0 ? JSON.stringify(deps) : null,
      input.graph ?? null,
    );
  return getProposal(id)!;
}

/* ------------------------------------------------------------------ */
/* The two pure decisions                                              */
/* ------------------------------------------------------------------ */

export type ProposalPlan =
  | { ok: true; input: CreateRunInput }
  | { ok: false; reason: string };

/**
 * Turn an approved proposal into the run it asks for, or say why not.
 *
 * Pure — it takes the proposal, the template and the untemplated guard set
 * rather than reading any of them — and unit-tested, for the reason `planItem`
 * and `landRefusal` are: it is the step where something a model wrote becomes a
 * process with write access to a directory, and every branch of it is a
 * decision an operator would want to have been made the same way twice.
 *
 * The division of labour it enforces is the whole design: **the proposal says
 * what work to do, and something a person wrote says what an agent may do**.
 * There are two of those now — a named template, or `settings.chatDefaultGuards`
 * when the proposal names none, which is what lets the chat be useful on an
 * install with no templates saved. What has not changed is the branch that is
 * *not* here: no value off a proposal sets a guard, a permission mode or an
 * isolation choice, because a proposal is text a model produced and
 * `--permission-mode` is not a thing a model should be able to reach for.
 *
 * The prompt is the exception, and it is an exception on purpose: prompt text
 * *is* the half of a run a model may write. A proposal can therefore replace
 * the template's prompt for one run, and the card says when it did.
 *
 * **The specialist is the second exception and is not one either.** A saved
 * agent is a description and a prompt: the registry refuses a tool list at the
 * door and has no column for a permission mode, so naming one is the same class
 * of act as writing the task text beside it — it decides *who* does a piece of
 * the work, and every guard below still comes from the template or from
 * settings. It is resolved by the caller for the reason the template is, so this
 * function stays pure, and a named agent that has gone is refused **by name**
 * rather than falling back to none: the operator approved the card that said
 * "and hand the review to the reviewer", and a run that silently has no
 * specialist is bit-for-bit a run that was never given one.
 */
export function planProposal(
  proposal: Pick<
    ChatProposalRow,
    | "task"
    | "mount_id"
    | "folder"
    | "status"
    | "title"
    | "template_id"
    | "agent_id"
    | "prompt_override"
  >,
  template: RunTemplate | null,
  defaults: RunGuards,
  // Required rather than defaulted: a caller that forgot it would take the
  // refusal below on every agent-bearing proposal, which is safe but is a
  // refusal for the wrong reason. `planNode` takes it the same way.
  agent: RegistryAgent | null,
): ProposalPlan {
  if (proposal.status !== "pending") {
    return {
      ok: false,
      reason: `This proposal was already ${proposal.status}.`,
    };
  }

  if (proposal.template_id !== null && !template) {
    // Reachable by ordinary use: the chat proposes against a template, the
    // operator tidies their templates, then approves. Failing by name is what
    // lets them re-propose rather than wonder which run did not start. Not
    // silently falling back to the untemplated guard set: the operator picked
    // that template, and a run starting under different rules than the card
    // said is the one outcome this gate exists to prevent.
    return {
      ok: false,
      reason:
        "The template this proposal was made against no longer exists, so " +
        "there are no guards to start it under. Ask the chat to propose it " +
        "again — against a template that does, or against no template, which " +
        "uses the guards in Settings.",
    };
  }

  // Read as truthy rather than against null, `planNode`'s rule one level over:
  // a proposal written before this column existed carries `undefined` here on
  // an install that has not restarted, and `undefined !== null` would refuse
  // every proposal already waiting for a decision.
  if (proposal.agent_id) {
    const refusal = agentRefusal(proposal.agent_id, agentKnowledgeOf(agent));
    if (refusal) return { ok: false, reason: refusal };
  }

  const task = proposal.task.trim();
  if (!task) {
    return { ok: false, reason: "This proposal has no task text." };
  }

  // Null on the proposal means "wherever the template says". The empty string
  // does not: on both a template and a proposal it is the mount root, the one
  // selection that blocks every other run in the tree, so collapsing the two
  // would silently promote "no folder named" into "the whole workspace".
  const mountId = proposal.mount_id ?? template?.mountId ?? null;
  const folder =
    proposal.mount_id !== null ? proposal.folder : (template?.folder ?? null);

  if (mountId === null) {
    return {
      ok: false,
      reason: template
        ? `Neither this proposal nor the “${template.name}” template names a ` +
          "folder to work in, so there is nothing to start it against."
        : "This proposal names no folder to work in, and it names no template " +
          "to take one from.",
    };
  }

  const guards: RunGuards = template
    ? {
        permissionMode: template.permissionMode,
        isolate: template.isolate,
        budget: template.budget,
      }
    : defaults;

  return {
    ok: true,
    input: {
      folder: folder ?? "",
      mountId,
      prompt: composeTask(basePrompt(proposal, template), task),
      // Every one of these comes from the template or from settings, and none
      // of them from the proposal. See the note above.
      permissionMode: guards.permissionMode,
      isolate: guards.isolate,
      budget: guards.budget,
      // And this one comes from the proposal and from nowhere else, because it
      // is work rather than permission. `createRun` freezes the definition onto
      // the row, so an agent deleted after the click cannot reach a later cycle
      // of the run this starts.
      agent: proposal.agent_id && agent ? agentDefinition(agent) : null,
    },
  };
}

/**
 * The standing instructions the task is appended to, or null for none.
 *
 * An override written by the chat wins over the template's own prompt, which
 * reads backwards until you notice what a template is: a saved *form*, and the
 * prompt field is the one field on it a person expects to edit before pressing
 * start. The chat doing that for a run it is proposing is the same edit, and
 * the alternative — restating the standing instructions inside the task — puts
 * the same text in the run either way with nothing recording that it happened.
 */
function basePrompt(
  proposal: Pick<ChatProposalRow, "prompt_override">,
  template: RunTemplate | null,
): string | null {
  const override = proposal.prompt_override?.trim();
  if (override) return override;
  return template?.prompt ?? null;
}

/**
 * The prompt a proposed run is started with.
 *
 * The standing instructions lead, because that is the part written to hold for
 * every run; the chat's task follows as the specific instance. Kept in this
 * order and separated by a heading rather than interleaved, so an operator
 * reading the run afterwards can see which half came from a model. With no
 * template and no override there is nothing to lead with, and the task is the
 * whole prompt rather than a heading with nothing above it.
 */
export function composeTask(base: string | null, task: string): string {
  const lead = base?.trim();
  return lead
    ? `${lead}\n\n## This run specifically\n\n${task.trim()}`
    : task.trim();
}

/**
 * What the child is asked, given what it can and cannot remember.
 *
 * With a session to resume, the thread is already in the conversation and
 * restating it is spend for no information — the same reasoning
 * `DEFAULT_CONTINUATION_PROMPT` follows. With no session, the turn is a fresh
 * conversation: a turn that failed before the CLI reported a session id leaves
 * the chat looking continuous on screen while the model has never seen a word
 * of it, and answering the next message with no idea what was already agreed is
 * worse than paying to re-read a few short messages.
 *
 * Pure and unit-tested, because both branches are billed and the wrong one is
 * invisible — a model that silently lost the thread still answers confidently.
 */
export function chatPrompt(
  o: { sessionId: string | null; history: Array<{ role: ChatRole; text: string }> },
  message: string,
): string {
  if (o.sessionId) return message;

  const recent = o.history.slice(-THREAD_REPLAY_MESSAGES);
  let budget = THREAD_REPLAY_BYTES;
  const kept: string[] = [];
  // Newest first while filling, so what survives a small budget is the part
  // nearest the question rather than the opening pleasantries.
  for (let i = recent.length - 1; i >= 0; i--) {
    const line = `${recent[i].role}: ${recent[i].text}`;
    if (line.length > budget) break;
    budget -= line.length;
    kept.unshift(line);
  }

  if (kept.length === 0) return message;

  return [
    "This conversation was interrupted and you do not have its history. Here is",
    "what was said before, oldest first:",
    "",
    "<thread>",
    ...kept,
    "</thread>",
    "",
    "Now answer this message:",
    "",
    message,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* The batch — pure                                                    */
/* ------------------------------------------------------------------ */

/** One proposal as the batch planner reads it. */
export interface BatchProposal {
  id: string;
  /** The chat's own label, or null when nothing can point at this one. */
  specId: string | null;
  title: string;
  dependsOn: readonly ProposalDependency[];
}

/** What a proposal in this chat that is *not* in the batch already became. */
export interface SettledProposal {
  status: ProposalStatus;
  /** The run it became, or null — pending, rejected, or failed to start. */
  runId: string | null;
}

/**
 * One resolved edge: a run that exists, or one this same pass will create.
 *
 * A discriminated union rather than two nullable ids, because the caller has to
 * do something different with each — substitute a run id it has just minted, or
 * pass one straight through — and a shape where both can be absent is a shape
 * where it can forget to check which it has.
 */
export type BatchDependency = { edge: DependencyEdge; continueBranch: boolean } & (
  | { on: "run"; runId: string }
  | { on: "proposal"; proposalId: string }
);

export type BatchStep =
  | { ok: true; id: string; title: string; dependsOn: BatchDependency[] }
  | { ok: false; id: string; title: string; reason: string };

/**
 * The order one click on Approve creates its runs in, and what each waits for.
 *
 * Pure and unit-tested, for the reason `planProposal` and `releasableRuns` are,
 * and it inherits both of their failure modes at once. A batch created in the
 * wrong order is a proposal naming a run that does not exist yet — `createRun`
 * refuses it as a missing run rather than as the ordering mistake it is, which
 * puts an artefact of what the page happened to display in front of the
 * operator as a fact about their work. A dependency silently *dropped* is
 * worse and is the one this exists for: a run told to wait for another and
 * started with no dependency at all looks exactly like a run that was never
 * told, and the two agents then work in the same checkout in the order the
 * queue felt like.
 *
 * So an unresolvable label fails its proposal **by name**, and everything
 * behind it fails too — the cascade `releasableRuns` runs one level down, for
 * the same reason: every proposal in a chain gets its own sentence naming the
 * one in front of it rather than one shared verdict about a label at the head
 * it never heard of. The rest of the batch still starts; a chain that cannot be
 * wired is not a reason to refuse unrelated work in the same click.
 *
 * What it deliberately does **not** re-decide is anything `admitDependencies`
 * already decides — at most one branch handed over, both ends isolated, no
 * rival continuation, no loop against the *live* graph. Those need rows, they
 * are checked where the edge is actually created, and a second copy here would
 * be a second set of rules to keep in step.
 */
export function planApprovalBatch(
  batch: readonly BatchProposal[],
  outside: ReadonlyMap<string, SettledProposal>,
): BatchStep[] {
  const bySpec = new Map<string, BatchProposal>();
  const duplicated = new Set<string>();
  for (const p of batch) {
    if (!p.specId) continue;
    if (bySpec.has(p.specId)) duplicated.add(p.specId);
    else bySpec.set(p.specId, p);
  }

  const failed = new Map<string, string>();
  const resolved = new Map<string, BatchDependency[]>();

  for (const p of batch) {
    if (p.specId && duplicated.has(p.specId)) {
      failed.set(
        p.id,
        `Two proposals in this batch are labelled “${p.specId}”, so a ` +
          "dependency naming it names both.",
      );
      continue;
    }

    const links: BatchDependency[] = [];
    let refusal: string | null = null;

    for (const dep of p.dependsOn) {
      if (dep.specId === p.specId) {
        refusal = `“${p.title}” is set to start after itself.`;
        break;
      }
      const sibling = bySpec.get(dep.specId);
      if (sibling) {
        links.push({
          on: "proposal",
          proposalId: sibling.id,
          edge: dep.edge,
          continueBranch: dep.continueBranch,
        });
        continue;
      }
      const settled = outside.get(dep.specId);
      if (settled?.runId) {
        links.push({
          on: "run",
          runId: settled.runId,
          edge: dep.edge,
          continueBranch: dep.continueBranch,
        });
        continue;
      }
      // Three different facts, and the operator can act on a different thing in
      // each: approve the other one too, look at why it did not start, or ask
      // the chat what it meant. Collapsing them into "unknown dependency" is
      // the sentence that sends someone to read the database.
      refusal =
        settled === undefined
          ? `“${p.title}” is set to start after “${dep.specId}”, which is not ` +
            "in this batch and is not a proposal in this chat."
          : settled.status === "pending"
            ? `“${p.title}” is set to start after “${dep.specId}”, which is ` +
              "still waiting for a decision. Approve them together."
            : `“${p.title}” is set to start after “${dep.specId}”, which was ` +
              `${settled.status} and never became a run.`;
      break;
    }

    if (refusal) failed.set(p.id, refusal);
    else resolved.set(p.id, links);
  }

  // A loop among the batch's own edges. `admitDependencies` re-runs the same
  // check against the live graph at every insert, but it would meet this one as
  // "no such run to depend on" — the first member names a sibling that has not
  // been created, because in a loop there is no first member to create.
  const byId = new Map(batch.map((p) => [p.id, p]));
  const loop = dependencyCycle(
    [...resolved].flatMap(([id, links]) =>
      links
        .filter((l) => l.on === "proposal")
        .map((l) => ({
          runId: id,
          dependsOn: (l as { proposalId: string }).proposalId,
          edge: l.edge,
        })),
    ),
  );
  if (loop) {
    const named = loop.map((id) => `“${byId.get(id)?.title ?? id}”`).join(" → ");
    for (const id of loop) {
      resolved.delete(id);
      failed.set(
        id,
        `These proposals wait for each other in a loop, so none of them could ` +
          `ever start: ${named}.`,
      );
    }
  }

  // The cascade: a proposal that cannot start is a dependency that will never
  // exist, so everything behind it cannot start either. A fixed point rather
  // than one pass, because the run behind the run behind a failure is as stuck
  // as the first one and deserves to be told so by name.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, links] of resolved) {
      const dead = links.find(
        (l) => l.on === "proposal" && failed.has(l.proposalId),
      );
      if (!dead) continue;
      const blocker = byId.get((dead as { proposalId: string }).proposalId);
      resolved.delete(id);
      failed.set(
        id,
        `“${byId.get(id)!.title}” is set to start after “${blocker?.title ?? "another proposal"}”, ` +
          "which is not being started.",
      );
      changed = true;
    }
  }

  // Every survivor after everything it waits for, so the run a dependency names
  // exists by the time the dependent is created.
  const survivors = batch.filter((p) => resolved.has(p.id));
  const { order } = topologicalOrder({
    nodes: survivors,
    edges: [...resolved].flatMap(([id, links]) =>
      links
        .filter((l) => l.on === "proposal")
        .map((l) => ({ from: (l as { proposalId: string }).proposalId, to: id })),
    ),
  });

  const steps: BatchStep[] = order.map((id) => ({
    ok: true as const,
    id,
    title: byId.get(id)!.title,
    dependsOn: resolved.get(id)!,
  }));
  // Failures last and in the order they were proposed: the caller only tallies
  // them, and a stable order is what keeps two identical clicks reporting the
  // same thing in the same sequence.
  for (const p of batch) {
    const reason = failed.get(p.id);
    if (reason) steps.push({ ok: false, id: p.id, title: p.title, reason });
  }
  return steps;
}

/* ------------------------------------------------------------------ */
/* Approval                                                            */
/* ------------------------------------------------------------------ */

export type ApprovalOutcome =
  | { ok: true; runId: string }
  | { ok: false; reason: string };

/**
 * Start the run a proposal asks for.
 *
 * Synchronous from the plan to the INSERT, which is not an accident: it calls
 * `createRun`, whose folder claim is only atomic because one event-loop turn
 * covers deciding a folder is free and recording that it was taken. Approving a
 * batch is this function in a loop for the same reason — one `await` between
 * two approvals of the same folder would let both decide it was free.
 */
export function approveProposal(
  id: string,
  dependsOn: readonly RunDependencyInput[] = [],
): ApprovalOutcome {
  const proposal = getProposal(id);
  if (!proposal) return { ok: false, reason: "No such proposal." };
  if (proposal.kind !== "run") {
    // Reachable only by calling this directly; the route partitions by kind.
    // Named rather than silently planned as a run, because a workflow proposal
    // has no task and would fail with "this proposal has no task text" — a
    // sentence about the wrong thing entirely.
    return {
      ok: false,
      reason: "This proposal is a workflow, not a run.",
    };
  }

  const plan = planProposal(
    proposal,
    proposal.template_id ? getTemplate(proposal.template_id) : null,
    chatGuards(),
    // Read at the click rather than at the proposal, which is what an id on the
    // row buys: an agent the operator has since fixed is used as it stands now,
    // and one they have since deleted is refused by name a line above.
    proposal.agent_id ? getAgent(proposal.agent_id) : null,
  );
  if (!plan.ok) {
    markProposal(id, "failed", { error: plan.reason });
    return { ok: false, reason: plan.reason };
  }

  try {
    const run = createRun({ ...plan.input, dependsOn: [...dependsOn] });
    markProposal(id, "approved", { runId: run.id });
    return { ok: true, runId: run.id };
  } catch (err) {
    // `createRun` refuses a folder outside every mount and a folder that does
    // not exist; a folder merely *busy* queues instead, which is why this is a
    // failure rather than a retry.
    const reason = err instanceof Error ? err.message : String(err);
    markProposal(id, "failed", { error: reason });
    return { ok: false, reason };
  }
}

/** What approving a batch of run proposals came to. */
export interface BatchOutcome {
  started: string[];
  failed: Array<{ title: string; reason: string }>;
}

/**
 * Approve several run proposals at once, wiring whatever depends on what.
 *
 * Synchronous end to end and with no `await` anywhere in it, for the reason the
 * route already documents: `createRun`'s folder claim is only atomic inside one
 * event-loop turn, so two proposals for the same folder must not both get to
 * decide it is free. That property is now load-bearing twice over — a
 * dependency also has to name a run that exists, and every one it can name is
 * created in this same pass.
 *
 * A proposal whose own `createRun` throws leaves its dependents naming nothing,
 * so they are failed here by name rather than left to `createRun` to refuse as
 * a missing run. That is the same cascade `planApprovalBatch` runs for a label
 * that never resolved, arriving from the other direction: there it is a
 * dependency that was never going to exist, here it is one that was going to
 * and did not.
 */
export function approveRunBatch(
  chatId: string,
  ids: readonly string[],
): BatchOutcome {
  const wanted = new Set(ids);
  const proposals = listProposals(chatId).filter(
    (p) => wanted.has(p.id) && p.kind === "run",
  );

  // Every labelled proposal of this chat that is *not* in the batch, so a
  // dependency on one approved in an earlier click resolves to its run.
  const outside = new Map<string, SettledProposal>();
  for (const p of listProposals(chatId)) {
    if (wanted.has(p.id) || !p.spec_id) continue;
    outside.set(p.spec_id, { status: p.status, runId: p.run_id });
  }

  const steps = planApprovalBatch(
    proposals.map((p) => ({
      id: p.id,
      specId: p.spec_id,
      title: p.title,
      dependsOn: proposalDeps(p),
    })),
    outside,
  );

  const started: string[] = [];
  const failed: Array<{ title: string; reason: string }> = [];
  /** What each proposal in this pass became, for the ones behind it. */
  const minted = new Map<string, string>();
  const stillborn = new Map<string, string>();

  for (const step of steps) {
    if (!step.ok) {
      markProposal(step.id, "failed", { error: step.reason });
      failed.push({ title: step.title, reason: step.reason });
      continue;
    }

    const dead = step.dependsOn.find(
      (d) => d.on === "proposal" && !minted.has(d.proposalId),
    );
    if (dead) {
      const reason =
        `“${step.title}” is set to start after “${stillborn.get((dead as { proposalId: string }).proposalId) ?? "another proposal"}”, ` +
        "which could not be started.";
      markProposal(step.id, "failed", { error: reason });
      stillborn.set(step.id, step.title);
      failed.push({ title: step.title, reason });
      continue;
    }

    const res = approveProposal(
      step.id,
      step.dependsOn.map((d) => ({
        runId: d.on === "run" ? d.runId : minted.get(d.proposalId)!,
        edge: d.edge,
        continueBranch: d.continueBranch,
      })),
    );
    if (res.ok) {
      minted.set(step.id, res.runId);
      started.push(res.runId);
    } else {
      stillborn.set(step.id, step.title);
      failed.push({ title: step.title, reason: res.reason });
    }
  }

  return { started, failed };
}

export function rejectProposal(id: string): boolean {
  const res = db()
    .prepare(
      "UPDATE chat_proposals SET status='rejected', decided_at=? WHERE id=? AND status='pending'",
    )
    .run(Date.now(), id);
  return res.changes > 0;
}

/** What one click on Approve or Reject did, in the terms the thread records it. */
export interface DecisionTally {
  action: "approve" | "reject";
  started: number;
  rejected: number;
  /**
   * `kind` is what the sentence's verb comes from: a run proposal could not be
   * *started* and a workflow proposal could not be *saved*, and telling an
   * operator a workflow "could not be started" describes an attempt this app
   * never makes.
   */
  failed: Array<{ title: string; reason: string; kind?: ProposalKind }>;
  /**
   * Workflow proposals approved, which **saved** a workflow and started
   * nothing. Counted apart from `started` rather than added to it: a sentence
   * that says "approved and queued 3 runs" about two runs and a saved graph is
   * a claim that agents are working, which is the one thing this note exists to
   * report honestly.
   */
  saved: number;
  /** Proposals of this chat that are no longer pending. */
  decided: number;
  /** Ids naming no proposal of this chat — another thread's, or gone. */
  foreign: number;
}

/**
 * The sentence a decision is recorded by — a note in the thread when something
 * happened, and the refusal when nothing did.
 *
 * Pure and unit-tested because it is the *only* account the operator gets of a
 * click that acted on nothing. The route's scoping to `pendingProposals(id)`
 * already stops a stale id being approved, so what is left to get wrong is a
 * true 200 carrying a false explanation: `decided` and `foreign` are two
 * different facts, and reporting the second as the first tells one thread that
 * proposals still waiting in another were "already decided". Nothing throws on
 * that and nothing typechecks it away — it is a permanent, wrong line in a
 * conversation the operator later reads back as a record of what they did.
 */
export function decisionNote(t: DecisionTally): string {
  const parts = [
    t.started > 0 ? `Approved and queued ${t.started} run(s).` : "",
    t.saved > 0
      ? `Saved ${t.saved} workflow(s). Nothing is running — open one and press ` +
        "Run when you want it to."
      : "",
    t.rejected > 0 ? `Rejected ${t.rejected} proposal(s).` : "",
    ...t.failed.map(
      (f) =>
        `Could not ${f.kind === "workflow" ? "save" : "start"} “${f.title}”: ${f.reason}`,
    ),
    t.decided > 0
      ? `${t.decided} proposal(s) had already been decided and were left alone.`
      : "",
    t.foreign > 0
      ? `${t.foreign} selected proposal(s) are not in this chat and were left alone.`
      : "",
  ].filter(Boolean);

  // Nothing moved, so the first thing said has to be that nothing moved. Left
  // to the clauses above, a batch that did nothing reads as a report of two
  // proposals it declined to touch, which is what "the button appears to have
  // done nothing" looks like from the thread.
  const acted =
    t.started > 0 || t.saved > 0 || t.rejected > 0 || t.failed.length > 0;
  if (!acted && parts.length > 0) {
    parts.unshift(
      t.action === "approve" ? "Nothing was approved." : "Nothing was rejected.",
    );
  }

  return parts.join(" ");
}

/**
 * Record what became of a proposal.
 *
 * Exported because a workflow proposal settles onto `workflow_id` and the
 * function that knows how to build a workflow lives in `workflows.ts`, which
 * imports this module. One writer either way — a second UPDATE over these
 * columns is a second place to forget `decided_at`, which is what stops a
 * decided proposal being offered for decision again.
 */
export function markProposal(
  id: string,
  status: ProposalStatus,
  o: { runId?: string; workflowId?: string; error?: string },
): void {
  db()
    .prepare(
      "UPDATE chat_proposals SET status=?, decided_at=?, run_id=?," +
        " workflow_id=?, error=? WHERE id=?",
    )
    .run(
      status,
      Date.now(),
      o.runId ?? null,
      o.workflowId ?? null,
      o.error ?? null,
      id,
    );
}

/* ------------------------------------------------------------------ */
/* The capability token                                                */
/* ------------------------------------------------------------------ */

/**
 * Who a bearer token speaks for.
 *
 * Two kinds now, and they are deliberately a discriminated union rather than a
 * pair of optional ids: `/api/mcp` publishes a *different tool list* to each —
 * a chat may propose and save templates, an orchestrator block may emit runs
 * and neither may do the other's — and a shape where both ids can be absent is
 * a shape where the route can forget to check which it has.
 */
export type CapabilitySubject =
  | { kind: "chat"; chatId: string }
  | { kind: "block"; instanceId: string; nodeId: string };

/**
 * What lets an orchestrator child call back into this server, and nothing else.
 *
 * `/api/mcp` is exempt from `middleware.ts` because the middleware runs in the
 * edge runtime and cannot reach SQLite to check a per-turn credential — so the
 * route authenticates itself, and this is the thing it checks. Deliberately
 * **not** `UF_AUTH_TOKEN`: that one opens every route in the app, and handing it
 * to a child would undo the reason `gitEnv`/`reviewEnv`/`childEnv` all strip
 * `UF_*` in the first place.
 *
 * In memory only, and revoked the moment the turn's child exits. It never
 * outlives the process that minted it, which is the property that makes it
 * cheap: a token recovered from a `ps` listing after the fact opens nothing.
 * On `globalThis` for the reason every other long-lived singleton here is —
 * `next dev` would otherwise re-evaluate the module and invalidate a live
 * child's credential mid-turn.
 */
interface Capability {
  subject: CapabilitySubject;
  expiresAt: number;
}

const caps = ((globalThis as unknown as { __ufChatCaps?: Map<string, Capability> })
  .__ufChatCaps ??= new Map<string, Capability>());

export function mintCapability(subject: CapabilitySubject): string {
  const token = randomBytes(32).toString("base64url");
  caps.set(token, { subject, expiresAt: Date.now() + CHAT_TIMEOUT_MS + 60_000 });
  return token;
}

export function revokeCapability(token: string): void {
  caps.delete(token);
}

/**
 * What a bearer token speaks for, or null.
 *
 * Compared in constant time against every live token rather than looked up by
 * key: a `Map.get` on a secret leaks its prefix through timing, and the number
 * of live tokens here is the number of orchestrator turns in flight — one chat
 * turn, plus whatever blocks of a workflow are deciding right now.
 */
export function subjectForCapability(token: string): CapabilitySubject | null {
  if (!token) return null;
  const offered = Buffer.from(token);
  const now = Date.now();
  let found: CapabilitySubject | null = null;

  for (const [candidate, cap] of caps) {
    if (cap.expiresAt < now) {
      caps.delete(candidate);
      continue;
    }
    const known = Buffer.from(candidate);
    if (
      known.length === offered.length &&
      timingSafeEqual(known, offered)
    ) {
      found = cap.subject;
    }
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* The turn                                                            */
/* ------------------------------------------------------------------ */

export type ChatOutcome = { ok: true } | { ok: false; reason: string };

const ALREADY_THINKING: ChatOutcome = {
  ok: false,
  reason: "This chat is still working on the last message.",
};

/**
 * Take the turn, or return null because this chat is already in one.
 *
 * A conditional UPDATE whose `changes` count decides, exactly as `startRun`
 * claims a queued run. Reading the status and then writing it is the
 * check-then-act shape `createRun`'s folder claim is built to avoid, and here
 * the two halves were separated by `await assistRefusal()` — a full transcript
 * scan, seconds long on a large `~/.claude`. Every message that arrived inside
 * that window read `idle` and started a second billed child on the same
 * conversation, with a second capability token live beside the first and
 * `status` left last-write-wins between them.
 *
 * `<> 'thinking'` rather than `= 'idle'`: a turn that failed leaves the row
 * `failed`, and the next message is how an operator retries it.
 *
 * `turn_started_at` is written by this same statement rather than beside it,
 * for the same reason the claim is a single statement at all: it is what
 * `staleTurn` reads, and a turn that became unstoppable between two writes is
 * exactly the turn that has to have a deadline on it.
 *
 * Returns the row as it stood at the claim, because a read taken before that
 * await is stale by definition — `session_id` above all, which decides whether
 * the turn resumes the conversation or pays to replay the thread.
 */
function claimTurn(chatId: string): ChatRow | null {
  const now = Date.now();
  const claim = db()
    .prepare(
      `UPDATE chat_sessions
          SET status='thinking', error=NULL, updated_at=?, turn_started_at=?
        WHERE id=? AND status<>'thinking'`,
    )
    .run(now, now, chatId);
  return claim.changes === 1 ? getChat(chatId) : null;
}

/** stdin is "ignore", so the child has readable stdout/stderr and no stdin. */
export type ChatProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * The chats with a child this process can still signal.
 *
 * The row says a turn is in flight; this says whether anything is still there
 * to stop. The two disagree exactly when a turn is stranded — which is the
 * state this map exists to make recoverable rather than to prevent. On
 * `globalThis` for the reason every other long-lived singleton here is: a dev
 * hot reload would otherwise re-evaluate the module and lose the handle on a
 * live child, leaving the operator with an unstoppable turn and a billed agent.
 */
const turns = ((globalThis as unknown as {
  __ufChatTurns?: Map<string, ChatProcess>;
}).__ufChatTurns ??= new Map<string, ChatProcess>());

const sweeper = ((globalThis as unknown as {
  __ufChatSweep?: { timer: NodeJS.Timeout | null };
}).__ufChatSweep ??= { timer: null });

/** What the row says afterwards. The two causes must not read alike. */
const CANCELLED_REASON =
  "You stopped this message while it was being answered.";
const TIMED_OUT_REASON =
  `The chat did not answer within ${CHAT_TIMEOUT_MS / 60_000} minutes and was stopped.`;

/**
 * Whether a turn has outlived the bound on one, given the row and the clock.
 *
 * Pure and unit-tested, for the reason `landRefusal` and `planItem` are: every
 * way of getting it wrong is silent. Too eager and a legitimate three-minute
 * turn is failed out from under a live child; never true and the ten-minute
 * bound quietly stops existing, which is the state this issue started from —
 * a thread that says "Thinking…" for ever with nothing in the process able to
 * move it.
 */
export function staleTurn(
  chat: Pick<ChatRow, "status" | "turn_started_at" | "updated_at">,
  now: number,
): boolean {
  if (chat.status !== "thinking") return false;
  // A row that was already `thinking` when this column was added has no start
  // instant. `updated_at` is the conservative stand-in — mid-turn writes only
  // ever move it forward, so the fallback waits longer than the real deadline
  // rather than ending a turn early.
  const startedAt = chat.turn_started_at ?? chat.updated_at;
  return now - startedAt >= CHAT_TIMEOUT_MS + STALE_TURN_MARGIN_MS;
}

/**
 * End a turn now, and signal whatever is still running it.
 *
 * The row is settled *here* rather than when the child closes, which is the
 * whole point: the turns that need ending are the ones whose `close` is not
 * coming. `finishTurn` latches on `status='thinking'`, so a `close` that does
 * arrive afterwards cannot move the row back or overwrite what this said.
 *
 * The signal ladder is `interruptRun`'s, and SIGINT leads for the same reason:
 * it is the signal a CLI is most likely to handle deliberately, and a chat turn
 * is spawned `detached` under the same `killProcessGroup` setting an agent is,
 * so what has to die is the group rather than the wrapper.
 *
 * Each step re-checks that *this* child is still running rather than that it is
 * still the registered one, which is where this diverges from `interruptRun`:
 * the row is usable the instant this returns, so the operator can send a new
 * message — and register a new child under the same id — while the old one is
 * still working through the ladder. Not `child.killed`, which records only that
 * a signal was sent and is already true by the second step.
 */
function endTurn(chatId: string, error: string): boolean {
  const changed =
    db()
      .prepare(
        "UPDATE chat_sessions SET status='failed', error=?, updated_at=?," +
          " turn_started_at=NULL WHERE id=? AND status='thinking'",
      )
      .run(error, Date.now(), chatId).changes > 0;
  // In the thread as well as on the row: the conversation should read as what
  // happened to it, and a turn that stops without a word looks like an answer
  // that never came.
  if (changed) appendMessage(chatId, "system", error);

  const child = turns.get(chatId);
  if (!child) return false;

  const running = () => child.exitCode === null && child.signalCode === null;
  signalTree(child, "SIGINT");
  setTimeout(() => {
    if (running()) signalTree(child, "SIGTERM");
  }, 3_000).unref?.();
  setTimeout(() => {
    if (running()) signalTree(child, "SIGKILL");
  }, 8_000).unref?.();
  return true;
}

export type CancelOutcome =
  | { ok: true; outcome: "signalled" | "cleared" }
  | { ok: false; reason: string };

/**
 * Stop the turn a chat is waiting on, from the page.
 *
 * The counterpart to `stopRun`, and it reports the same distinction for the
 * same reason: `signalled` means a child was told to stop, `cleared` means
 * there was nothing left to stop and only the row needed clearing. Both are
 * successes — reporting the second as a failure (which a bare boolean would)
 * makes a working button look broken in precisely the case it was added for.
 *
 * It does not send anything, and it deliberately leaves the `thinking` guard in
 * `sendChatMessage` alone: that guard is what stops two billed children on one
 * conversation, and the recovery is a way to *end* the turn, not around it.
 */
export function cancelChatTurn(chatId: string): CancelOutcome {
  const chat = getChat(chatId);
  if (!chat) return { ok: false, reason: "No such chat." };
  if (chat.status !== "thinking") {
    return { ok: false, reason: "This chat is not working on a message." };
  }
  return {
    ok: true,
    outcome: endTurn(chatId, CANCELLED_REASON) ? "signalled" : "cleared",
  };
}

/**
 * Fail out every turn that has outlived the bound.
 *
 * The backstop under the in-closure timer in `runTurn`, which cannot be one:
 * that timer signals the child and then waits for `close`, so it rescues
 * nothing when `close` is what went missing, and it does not exist at all for a
 * turn whose child was never spawned. This reads the row instead, so the
 * ten-minute bound holds however the turn was lost.
 *
 * Nothing is resumed or re-asked — same rule `reconcileChatsOnBoot` follows,
 * and for the same reason: a chat turn is a question somebody put minutes ago,
 * and re-asking it unattended is spend nobody is present to want.
 */
function sweepStuckChats(): void {
  const thinking = db()
    .prepare("SELECT * FROM chat_sessions WHERE status='thinking'")
    .all() as ChatRow[];
  if (thinking.length === 0) {
    stopChatSweeper();
    return;
  }
  const now = Date.now();
  for (const chat of thinking) {
    if (staleTurn(chat, now)) endTurn(chat.id, TIMED_OUT_REASON);
  }
}

/** Lazily started when a turn begins, stopped when none is left to watch. */
function startChatSweeper(): void {
  if (sweeper.timer) return;
  sweeper.timer = setInterval(sweepStuckChats, CHAT_SWEEP_MS);
  sweeper.timer.unref?.();
}

function stopChatSweeper(): void {
  if (!sweeper.timer) return;
  clearInterval(sweeper.timer);
  sweeper.timer = null;
}

/**
 * Send a message and return as soon as the child is on its way.
 *
 * The child outlives the request for the reason a review's does: it runs for
 * minutes and holding an HTTP connection open for it fails behind any proxy.
 * The row is the handle, and the page polls it.
 */
export async function sendChatMessage(
  chatId: string,
  message: string,
): Promise<ChatOutcome> {
  const chat = getChat(chatId);
  if (!chat) return { ok: false, reason: "No such chat." };
  // Answers the common case without paying for a transcript scan first. It
  // decides nothing — `claimTurn` below is the check that holds.
  if (chat.status === "thinking") return ALREADY_THINKING;

  const text = message.trim();
  if (!text) return { ok: false, reason: "Nothing to send." };

  // The same gate a review passes: the operator's own configured ceiling is
  // already spent. A chat turn spends against the same window as everything
  // else, and unlike a run it goes through no `evaluateBudget` — there is no
  // per-chat fraction and inventing one would be a threshold nobody set.
  const refusal = await assistRefusal();
  if (refusal) return { ok: false, reason: refusal };

  // From here to the spawn there is deliberately no `await`: one event-loop
  // turn covers claiming the chat, recording the message and starting the
  // child, so a request that loses the claim adds nothing to the thread.
  const claimed = claimTurn(chatId);
  if (!claimed) return ALREADY_THINKING;

  appendMessage(chatId, "user", text);
  const history = listMessages(chatId)
    .slice(0, -1)
    .map((m) => ({ role: m.role, text: m.text }));

  // The sweeper watches `thinking` rows, and this row became one at the claim
  // above — which is also where `turn_started_at` was written, in that same
  // statement, so the deadline exists from the instant the turn does.
  startChatSweeper();

  const prompt = chatPrompt({ sessionId: claimed.session_id, history }, text);

  // The child outlives this call: it runs for minutes and the row is what
  // reports on it, so nothing here waits for it.
  //
  // Wrapped, because `runTurn` is not `async`: it mints the capability and
  // writes the MCP config synchronously, so a throw from either happens right
  // here. Unhandled, it would propagate out of this function with the row
  // already claimed as `thinking` — a state nothing but a restart clears, and
  // one this function refuses to send into.
  try {
    runTurn(claimed, prompt);
  } catch (err) {
    const reason = `Could not start the turn: ${
      err instanceof Error ? err.message : String(err)
    }`;
    finishTurn(chatId, { status: "failed", error: reason });
    return { ok: false, reason };
  }

  return { ok: true };
}

export interface TurnResult {
  status: "idle" | "failed";
  text?: string;
  error?: string;
  costUSD?: number;
  tokens?: number;
  sessionId?: string | null;
  denials?: string[];
}

/** Everything one headless orchestrator turn differs from another by. */
export interface OrchestratorChildOptions {
  /** What its capability token speaks for, and so which tools it is offered. */
  subject: CapabilitySubject;
  prompt: string;
  /** The role, stated. This is the boundary — see `systemPrompt`. */
  appendSystemPrompt: string;
  /** A conversation to continue, or null for a one-shot turn. */
  resumeSessionId?: string | null;
  /**
   * Where the child runs. Defaults to the first mount, which is what a chat
   * wants; a workflow block passes its own folder so `Read` and `git log` land
   * on the repository it was pointed at. Every mount is `--add-dir`ed either
   * way, so this widens nothing — it only decides where a bare path resolves.
   */
  cwd?: string;
  /**
   * Specialised agents this turn may delegate to.
   *
   * Offered, never imposed — `buildArgs` says why `--agent` is not the flag
   * used. Nothing here widens the turn's boundary: its tool surface is still
   * whatever `/api/mcp` publishes for its subject, and a delegated turn's spend
   * still lands inside `--max-budget-usd` below.
   */
  agents?: AgentDefinition[];
  /** `--max-budget-usd`, the only thing bounding the spend inside the CLI. */
  maxBudgetUSD: number | null;
  timeoutMs: number;
  /** What the row says when the timeout is what ended it. */
  timedOutMessage: string;
  /** Called with the child the moment it exists, so a caller can signal it. */
  onSpawn?: (child: ChatProcess) => void;
  /** Called exactly once, whatever happened. */
  onSettle: (result: TurnResult) => void;
}

/**
 * Spawn one headless orchestrator turn.
 *
 * **The fourth kind of child process, invoked a second way — not a fifth kind.**
 * `review.ts` says adding a third was a decision rather than a detail, and the
 * chat says the same of the fourth. A workflow's orchestrator block is the same
 * child with the same argv, the same environment, the same capability token and
 * the same MCP config file; what differs is that there is no thread to resume
 * and nobody typing. That is why this function exists rather than a second
 * `spawn` call site: two of those would be two sets of flags to keep in step,
 * and the flags are what bound the child.
 *
 * Everything about *what* it may do is a caller's argument — the subject decides
 * its tool list, the system prompt states its role — and everything about how it
 * is contained is here and identical for both.
 */
export function runOrchestratorChild(o: OrchestratorChildOptions): void {
  const token = mintCapability(o.subject);
  let configPath: string;
  try {
    configPath = writeMcpConfig(token);
  } catch (err) {
    // `land` is the only thing that revokes, and it is inside the promise this
    // never reaches — so a token minted for a turn that cannot start would
    // stay live in memory until it expired, an hour later. The caller records
    // the failure on the row; this releases what the failed setup took.
    revokeCapability(token);
    throw err;
  }

  {
    const settings = getSettings();
    const args = [
      "-p",
      o.prompt,
      "--output-format",
      "json",
      // Every tool the CLI has, with the system prompt above as the boundary
      // rather than a list of names.
      //
      // This used to be `manual` plus an allowlist — this app's tools,
      // `Read`/`Glob`/`Grep`, read-only `gh` and three `git` subcommands — and
      // that allowlist was the whole guarantee, because `plan` (what
      // `review.ts` uses) refuses MCP tool calls outright ("Cannot call
      // mcp__uf__list_templates while in plan mode") and would leave the chat
      // able to see GitHub and not this app. Its cost was every question the
      // list did not anticipate: a build log, a test run, `gh api`, `git -C
      // <path> log`, anything compound. Each came back refused, and an
      // orchestrator that cannot look proposes work badly — which is the one
      // failure this feature has no other defence against, since a bad
      // proposal is approved by a person who is trusting it to have looked.
      //
      // `bypassPermissions` rather than `acceptEdits`: that mode holds every
      // mutating shell command for an approval a `-p` child has nobody to give
      // — measured, in the isolated-run failure that `ISOLATED_GIT_TOOLS`
      // exists to fix — so it would reproduce exactly the refusals this is
      // removing, only less predictably.
      //
      // What bounds this child is therefore not the mode. Its tool surface is
      // whatever `/api/mcp` publishes for its *subject* — a chat may propose,
      // an orchestrator block may emit, and neither can start a run under
      // guards it chose; `--strict-mcp-config` keeps the mounted `~/.claude`'s
      // own MCP servers out; the capability token dies with the turn; and
      // `chatTurnBudgetUSD` caps the spend. It can, however, write to the
      // mounts and reach GitHub with the token in its environment, and the
      // chat page says so.
      "--permission-mode",
      "bypassPermissions",
      "--mcp-config",
      configPath,
      // Without this, an MCP server configured in the mounted ~/.claude joins
      // this child — a tool surface the operator never granted this feature.
      "--strict-mcp-config",
      "--append-system-prompt",
      o.appendSystemPrompt,
    ];

    // Access to the mounts, so "look at what this repo is like" works. Under
    // `bypassPermissions` this is no longer read-only, which is the half of
    // the trade above that costs something: a chat told to leave the work
    // alone is now the only thing stopping it from editing a checkout.
    for (const mount of WORKSPACE_MOUNTS) {
      if (fs.existsSync(mount.path)) args.push("--add-dir", mount.path);
    }

    // One encoder for all four spawn sites — every way of getting this shape
    // wrong is silent, so there is one place that knows it.
    args.push(...agentsArgs(o.agents ?? []));

    if (o.resumeSessionId) args.push("--resume", o.resumeSessionId);
    if (settings.defaultModel) args.push("--model", settings.defaultModel);
    if (o.maxBudgetUSD !== null) {
      // A hard stop inside the CLI. Everything else here bounds a *run*; this
      // is the only thing bounding an orchestrator turn, which can otherwise
      // read issues and repositories for as long as it likes.
      args.push("--max-budget-usd", String(o.maxBudgetUSD));
    }

    // No shell, as everywhere else: the prompt is operator text and whatever a
    // GitHub issue body happens to contain.
    const child = spawn(CLAUDE_BIN, args, {
      cwd: o.cwd && fs.existsSync(o.cwd) ? o.cwd : chatCwd(),
      env: chatEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: settings.killProcessGroup && process.platform !== "win32",
    });

    // Registered before anything can go wrong with it, so an operator pressing
    // Stop reaches the child rather than orphaning it.
    o.onSpawn?.(child);

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c.slice(0, 4_096)));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      signalTree(child, "SIGTERM");
      setTimeout(() => signalTree(child, "SIGKILL"), 5_000).unref?.();
    }, o.timeoutMs);
    timer.unref?.();

    let settled = false;
    const land = (result: TurnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Both of these are why the token is worth having: the credential dies
      // with the turn, and the file that carried it does not outlive it either.
      revokeCapability(token);
      try {
        fs.unlinkSync(configPath);
      } catch {
        // Already gone, or a read-only tmp. Not worth failing a turn over.
      }
      o.onSettle(result);
    };

    child.on("error", (err) => {
      land({ status: "failed", error: `Could not launch ${CLAUDE_BIN}: ${err.message}` });
    });

    settleOnExit(child, (code) => {
      if (timedOut) {
        land({ status: "failed", error: o.timedOutMessage });
        return;
      }
      land(parseTurnOutput(stdout, stderr, code));
    });
  }
}

/**
 * One chat turn: the shared child, wired to this chat's row.
 *
 * Everything that decides what the child *is* now lives in
 * `runOrchestratorChild`; what is left here is what makes it a conversation —
 * the session to resume, the registry an operator's Stop reaches into, and the
 * row the answer lands on.
 *
 * **No `agents` is passed, and that is a decision rather than an omission.**
 * The plumbing is right there — `runOrchestratorChild` takes them, and a
 * workflow's orchestrator block hands it the one its node names — so what
 * follows is why the chat does not.
 *
 * This is the only child in the app whose boundary is *prose*. It runs
 * `bypassPermissions` with no allowlist, so the paragraph in `systemPrompt`
 * saying look-do-not-build is the whole of what stands between an orchestrator
 * and an agent that fixes the bug it was asked to write a proposal about. That
 * paragraph travels as `--append-system-prompt`, which is the *main thread's*
 * system prompt; a `--agents` member carries a system prompt of its own for the
 * turn it is delegated, and whether the appended text reaches that turn as well
 * is **not verified against the pin**. Every other child can absorb the
 * question, because what bounds it is a permission mode and two tool lists that
 * a delegated turn plainly does inherit — this one cannot, and the safe reading
 * of an unverified inheritance is that it does not hold.
 *
 * The second half is that there is no work here for a specialist to do. A chat
 * turn looks and proposes; it produces a `chat_proposals` row and a sentence.
 * What an agent would change is how the orchestrator *thinks*, which is the one
 * thing `systemPrompt` fixes deliberately — so the feature would be a second,
 * unreviewed system prompt inside the child that has no other boundary, bought
 * for no capability the turn is missing.
 *
 * A workflow's orchestrator block is not the counter-example it looks like: its
 * agent is one field on a graph a person saved and read as a whole, and what
 * that turn may *do* with it is bounded by `planEmission` and by guards off a
 * template rather than by prose. The `@`-mention in the composer is the answer
 * to what an operator actually wants here — it names the specialist the
 * proposed **run** carries, which is a fact about work that is approved before
 * it happens.
 */
function runTurn(chat: ChatRow, prompt: string): void {
  const settings = getSettings();
  let spawned: ChatProcess | null = null;
  runOrchestratorChild({
    subject: { kind: "chat", chatId: chat.id },
    prompt,
    appendSystemPrompt: systemPrompt(),
    resumeSessionId: chat.session_id,
    maxBudgetUSD: settings.chatTurnBudgetUSD,
    timeoutMs: CHAT_TIMEOUT_MS,
    timedOutMessage: TIMED_OUT_REASON,
    onSpawn: (child) => {
      spawned = child;
      turns.set(chat.id, child);
    },
    onSettle: (result) => {
      // Only this child's own entry: a turn cancelled and re-sent while the old
      // child was still dying would otherwise have its live handle deleted by
      // the corpse of the previous one.
      if (spawned && turns.get(chat.id) === spawned) turns.delete(chat.id);
      finishTurn(chat.id, result);
    },
  });
}

/**
 * Settle a turn on the child's `exit`, giving `close` a grace period first.
 *
 * `close` is the better signal — it means stdout has been fully drained — but
 * it fires only once every inherited pipe has shut, and the CLI's own children
 * hold those. A `claude` that leaves a grandchild behind has *exited* and will
 * never *close*, so a turn wired to `close` alone sits at "Thinking…" until the
 * ten-minute timeout kills the group and throws the answer away — and for ever
 * when `killProcessGroup` is off, because then there is no group to kill and
 * nothing else reaps the grandchild.
 *
 * `runIteration` settles the identical hazard the identical way, and for the
 * same reason: `exit` is the guarantee, `close` is the fast path, and the grace
 * period exists only so a normal exit flushes its last chunk through `close`
 * before anything is parsed.
 *
 * Exported because the shape it exists for — a child that exits while a
 * grandchild holds its stdout — is only reachable from a test through this
 * seam; `runTurn` itself needs a database, a settings row and a spend gate.
 */
export function settleOnExit(
  child: ChildProcess,
  settle: (code: number | null) => void,
): void {
  let done = false;
  const once = (code: number | null) => {
    if (done) return;
    done = true;
    settle(code);
  };

  child.on("exit", (code) => {
    setTimeout(() => once(code), EXIT_DRAIN_MS).unref?.();
  });
  child.on("close", (code) => once(code));
}

/**
 * Read the CLI's `--output-format json` object.
 *
 * Same contract `parseReviewOutput` reads, from the same pinned build:
 * `total_cost_usd` is authoritative per invocation and is never re-derived from
 * tokens. `permission_denials` is read as well and surfaced, because a chat
 * that quietly could not run `gh` reads as a chat that found no issues.
 */
export function parseTurnOutput(
  stdout: string,
  stderr: string,
  code: number | null,
): TurnResult {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (!parsed) {
    return {
      status: "failed",
      error:
        stderr.trim().split("\n").slice(-3).join(" ") ||
        `The chat produced no readable output (exit ${code ?? "?"}).`,
    };
  }

  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const usage = (parsed.usage ?? {}) as Record<string, unknown>;
  const tokens =
    n(usage.input_tokens) +
    n(usage.output_tokens) +
    n(usage.cache_creation_input_tokens) +
    n(usage.cache_read_input_tokens);
  const costUSD = n(parsed.total_cost_usd);
  const text = typeof parsed.result === "string" ? parsed.result : "";
  const sessionId =
    typeof parsed.session_id === "string" && parsed.session_id
      ? parsed.session_id
      : null;

  const denials = Array.isArray(parsed.permission_denials)
    ? (parsed.permission_denials as Array<Record<string, unknown>>)
        .map((d) => String(d.tool_name ?? ""))
        .filter(Boolean)
    : [];

  // Cost is recorded even for a failed turn: it was billed either way.
  if (parsed.is_error === true || (parsed.subtype && parsed.subtype !== "success")) {
    return {
      status: "failed",
      error: text || `The chat failed (${String(parsed.subtype ?? "unknown")}).`,
      costUSD,
      tokens,
      sessionId,
      denials,
    };
  }

  return { status: "idle", text, costUSD, tokens, sessionId, denials };
}

function finishTurn(chatId: string, r: TurnResult): void {
  const now = Date.now();
  const prior = getChat(chatId)?.session_id ?? null;

  // `WHERE status='thinking'` makes the row itself the settle-once latch, which
  // is what lets `cancelChatTurn` and the sweeper end a turn without waiting
  // for a `close` that may never come: a late one lands here and changes
  // nothing, rather than reviving the thread or replacing "you stopped this"
  // with whatever the killed child left on stderr. Nothing is lost by that —
  // the CLI reports cost and session id only in the final JSON object, which a
  // child that was signalled never prints.
  const changed =
    db()
      .prepare(
        `UPDATE chat_sessions
            SET status=?, error=?, updated_at=?, turn_started_at=NULL,
                cost_usd = cost_usd + ?, tokens = tokens + ?,
                session_id = COALESCE(?, session_id)
          WHERE id=? AND status='thinking'`,
      )
      .run(
        r.status,
        r.error ?? null,
        now,
        r.costUSD ?? 0,
        r.tokens ?? 0,
        r.sessionId,
        chatId,
      ).changes > 0;
  if (!changed) return;

  // Session id is adopted rather than compared, and a change is recorded rather
  // than treated as a failure — same posture the run loop takes. Which id the
  // CLI reports for a resumed conversation is its business; what must not
  // happen is continuing a conversation nobody chose without saying so.
  if (r.sessionId && prior && r.sessionId !== prior) {
    appendMessage(
      chatId,
      "system",
      `Claude Code answered under a different session id (${r.sessionId}) than ` +
        `the one this chat resumed (${prior}). Continuing with the new one.`,
    );
  }

  if (r.text) appendMessage(chatId, "assistant", r.text);
  if (r.error) appendMessage(chatId, "system", r.error);

  // A denial is the difference between "there are no open issues" and "I was
  // not allowed to look", and only one of those is worth acting on. Kept now
  // that the chat runs unrestricted precisely because it should be empty: a
  // refusal here is the CLI declining something on its own, which is worth
  // seeing rather than reading as a chat that looked and found nothing.
  if (r.denials && r.denials.length > 0) {
    appendMessage(
      chatId,
      "system",
      `Refused tool calls this turn: ${[...new Set(r.denials)].join(", ")}. ` +
        "The chat runs with no tool allowlist, so this is the CLI itself " +
        "declining the call.",
    );
  }

  // The first thing said names the thread, so the list reads as a list of
  // subjects rather than of timestamps.
  const chat = getChat(chatId);
  if (chat && !chat.title) {
    const first = listMessages(chatId).find((m) => m.role === "user");
    if (first) {
      db()
        .prepare("UPDATE chat_sessions SET title=? WHERE id=?")
        .run(first.text.replace(/\s+/g, " ").slice(0, 80), chatId);
    }
  }

  // This turn just gave a slot back to the process budget, and a block's
  // deciding turn deferred by that budget is left `waiting` rather than failed —
  // so whatever frees a slot has to wake it. `review.ts` carries the same four
  // lines for the same reason, and for the same reason imports dynamically:
  // `workflows.ts` imports this module.
  void import("./workflows")
    .then((m) => m.advanceInstances())
    .catch(() => {
      /* a workflow that cannot be advanced is not a reason to fail a turn */
    });
}

/**
 * Fail out chat turns a restart left mid-flight.
 *
 * Same reasoning as `reconcileOnBoot` and `reconcileReviewsOnBoot`: the child
 * is gone with the process that started it, and a row left saying `thinking`
 * spins an indicator for ever. Nothing is resumed — a chat turn is a question
 * somebody asked minutes ago, and re-asking it unattended is spend nobody is
 * present to want.
 *
 * Still the cheapest way out of a stranded turn, and no longer the only one:
 * `cancelChatTurn` clears one on request and the sweeper clears one that has
 * run past its deadline, so recovering a thread no longer means restarting the
 * server for everything else running in it.
 */
export function reconcileChatsOnBoot(): void {
  db()
    .prepare(
      "UPDATE chat_sessions SET status='failed', turn_started_at=NULL," +
        " error='The server restarted while this message was being answered.'" +
        " WHERE status='thinking'",
    )
    .run();
}

/* ------------------------------------------------------------------ */
/* What the child is told to be                                        */
/* ------------------------------------------------------------------ */

/**
 * What the child is, in the absence of a mechanism that makes it so.
 *
 * This carried the *role* when the allowlist carried the *limits*. It now
 * carries both, because the child runs `bypassPermissions` — so the paragraph
 * below about not doing the work is the only thing between an orchestrator and
 * an agent that fixes the bug it was asked to write a proposal about. It is
 * stated as a job description rather than a list of forbidden tools on purpose:
 * a model told "you may not edit" reaches for the nearest thing that is not
 * editing, where one told "your job is to look and propose" has nowhere to go
 * but the proposal.
 */
function systemPrompt(): string {
  return [
    "You are the orchestrator for UsageFoundry, a tool that runs unattended",
    "Claude Code agents against folders on this machine. You are talking to its",
    "operator in a chat panel.",
    "",
    "You cannot start, stop or resume a run, and you cannot press Run on a",
    "workflow. The two things you can do are propose_run and propose_workflow,",
    "and both only record a proposal the operator approves or rejects by hand.",
    "Say so plainly rather than implying work has started.",
    "",
    "You have every tool the CLI offers, and you are trusted with them because",
    "your job is to look, not to build. Use them to gather whatever you need to",
    "propose good work: read files, grep, run read-only commands, read issues,",
    "pull requests and CI logs with `gh`, read history with `git log`, run a",
    "build or a test suite when knowing whether something is broken changes what",
    "you would propose.",
    "",
    "Do not do the work yourself. Do not edit, create or delete files in a",
    "workspace; do not stage, commit, push or create branches; do not open,",
    "close, merge or comment on anything on GitHub. A task small enough that you",
    "are tempted to just fix it is a proposal that says it is small. The one",
    "exception is your own scratch space: a temporary file outside the mounts is",
    "fine if it helps you think.",
    "",
    "What decides what an agent may do — the budget, the work-cycle limit, the",
    "permission mode, whether it works in its own checkout — is never yours to",
    "set. It comes from the template a proposal or a workflow block names, or,",
    "when it names none, from the operator's default guard set in Settings. What",
    "is yours is the *work*: which folder, which task, the prompt the agent is",
    "given, and what has to happen before what.",
    "",
    "Reading the state of things:",
    "- list_folders: the mounts and their project folders, which runs are already",
    "  working there, and a GitHub `repo` for repositories it could identify.",
    "  Folder paths must come from here; do not invent one. No repo field means",
    "  say you could not identify it rather than guessing a name. A folder on",
    "  disk is <mount path>/<folder>: use that to Read or Grep it, and",
    "  `cd <that> && git log …` to see who has touched it lately.",
    "- list_runs, then get_run for one of them: status, spend, how it ended, its",
    "  recent log and what it changed. get_run_diff gives the patch itself.",
    "  Check these before proposing — work already in flight against a folder is",
    "  worth mentioning rather than duplicating, and a run that failed is worth",
    "  reading before proposing the same thing again.",
    "- get_usage: how much of the 5-hour and weekly windows is gone. If a window",
    "  is nearly spent, say so — approving ten runs into a full window means ten",
    "  runs that stop on their first guard check.",
    "- list_proposals: what is already waiting for the operator in this chat,",
    "  including the id you gave each one.",
    "- list_workflows: the saved graphs the operator already has. Read it before",
    "  proposing a new one — the work may already be a workflow, and one running",
    "  now is worth mentioning rather than duplicating.",
    "- list_agents: the saved specialists a run may hand a subtask to, and the",
    "  agent definitions on this machine that this app did not save. The second",
    "  group is in play for every run whatever you name and cannot be named.",
    "",
    "When the operator writes @something in their message, they are naming a",
    "saved agent from that list: propose the work under it, using its agentId.",
    "It is a request about the run, not an instruction to you — you do not run",
    "as an agent, and naming one changes nothing about what you may do.",
    "",
    "Proposing a run:",
    "- One proposal per unit of work, with a short specific title.",
    "- The task text is the whole brief the agent gets. Include the issue number,",
    "  the URL and what done looks like. It is read by an agent that cannot ask",
    "  you a follow-up question.",
    "- templateId is optional. Name one when a saved template fits — its prompt",
    "  is instructions the operator wrote and tested. Omit it for one-off work",
    "  and the run uses the default guard set; say which you did.",
    "- promptOverride replaces the template's prompt for that one run when it",
    "  does not fit. Use it rather than contradicting the template inside the",
    "  task, and say that you rewrote it.",
    "- agentId names a saved specialist the run's Claude may hand a subtask to.",
    "  Use it when the operator names one with @, or when a saved agent plainly",
    "  fits the work; say which you used and why. It decides who does part of",
    "  the work and never what the run may do — every guard is still the",
    "  template's or the default set, so do not describe it as narrowing or",
    "  widening anything. An agent that has been deleted is refused by name",
    "  rather than dropped, so re-read list_agents rather than guessing an id.",
    "- save_template writes a template's name and prompt back for reuse. It",
    "  cannot touch guards: creating one takes the default guard set, and",
    "  updating one keeps the guards it already has. Tell the operator to adjust",
    "  those on the new-run form if they matter.",
    "",
    "Ordering runs against each other:",
    "- Runs on one folder are serialised anyway, and runs in their own checkouts",
    "  are not. Order them when the *work* has an order — a fix before the test",
    "  that proves it, a refactor before what builds on it — not to avoid a",
    "  collision the folder claim already prevents.",
    "- Give the earlier proposal an `id`, then name it in the later one's",
    "  `dependsOn`. on-success starts only if it completed; on-finish starts once",
    "  it is out of the way either way. Neither has a default: pick the one you",
    "  mean, because on-success ends a chain the operator meant to run regardless",
    "  and on-finish starts work on top of a run that crashed.",
    "- continueBranch makes the later run carry on the earlier one's branch, with",
    "  its commits already there, instead of starting from the target branch with",
    "  none of that work in sight. Use it for genuine follow-on work; both runs",
    "  need guards that give them a checkout of their own, and only one run may",
    "  continue any given run.",
    "- Say in your reply that they have to be approved in the same click. A",
    "  dependent approved on its own is failed by name rather than started.",
    "",
    "Proposing a workflow:",
    "- A workflow is a saved graph the operator re-runs with one press of Run.",
    "  Propose one when the shape is worth keeping — a nightly sweep, a",
    "  fix/review/land chain, a per-repository routine. A one-off is propose_run.",
    "- Approving a workflow proposal SAVES it and starts nothing. The operator",
    "  presses Run themselves. Never say a workflow you proposed is running.",
    "- Blocks are `run` by default. An `orchestrator` block is a short turn that",
    "  decides, when the workflow reaches it, which runs to start — and those",
    "  start with no approval at all, which is why it needs a fanOut cap and why",
    "  you should propose one only when the work genuinely cannot be written out",
    "  in advance. A `merge` block lands what the blocks in front of it built.",
    "- Guards come from each block's template, or the default guard set. You",
    "  cannot set a budget, a permission mode or an isolation choice anywhere in",
    "  a graph, and the workflow is saved with no workflow-wide budget — tell the",
    "  operator to set one in the editor, because a workflow cannot be put on a",
    "  schedule without it.",
    "- A block may name an agentId, the same specialist a proposed run may name",
    "  and with the same effect: who does part of the work, never what the block",
    "  may do. A merge block starts no agent, so naming one there is refused.",
    "- Say what each block does and, for any orchestrator block, how many runs it",
    "  may start. That is the number the operator is agreeing to.",
    "",
    "Be brief. When you have proposed, reply with a short list of what you",
    "proposed and what you deliberately left out. The proposals appear in the",
    "panel beside this conversation, so do not repeat their full text.",
  ].join("\n");
}

/**
 * Where the chat's child runs.
 *
 * The first mount, so `Read`/`Grep` land somewhere useful, falling back to a
 * temporary directory when nothing is mounted — a spawn with a cwd that does
 * not exist fails with an ENOENT that reads like a missing `claude` binary.
 */
function chatCwd(): string {
  return fs.existsSync(WORKSPACE_ROOT) ? WORKSPACE_ROOT : os.tmpdir();
}

/**
 * Environment for the chat.
 *
 * The same three exclusions every other child gets — this app's own `UF_*`
 * configuration, any inherited telemetry routing, and `DATA_DIR` (written out
 * in full over `childEnv` in `orchestrator.ts`; this child runs
 * `bypassPermissions` with no allowlist, so of the four it is the one most able
 * to start a second server against the database) — plus `githubEnv()`, which
 * until now reached work cycles and nothing else. That widening is the point of
 * the feature: a chat asked to look at open issues cannot, otherwise, and it
 * would fail inside a tool call the way `git push` used to. With no allowlist
 * above it, that token now authenticates *writes* as well; the system prompt is
 * what says not to make them, and `UF_*` still leaves by namespace, so nothing
 * hands this child the app's own credentials.
 *
 * No telemetry, for the reason a review gets none: `otlp_requests.run_id` is
 * compared against a run's own spend, and a chat's requests in that comparison
 * would make an accounted-for run look unaccounted-for.
 */
function chatEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("UF_") ||
      key.startsWith("OTEL_") ||
      key === "ANTHROPIC_ADMIN_KEY" ||
      key === "CLAUDE_CODE_ENABLE_TELEMETRY" ||
      key === "DATA_DIR"
    ) {
      delete env[key];
    }
  }
  return { ...env, ...githubEnv() };
}

/**
 * The MCP config, as a file rather than an argv string.
 *
 * `--mcp-config` takes either, and a string would put the capability token in
 * the child's command line — readable by every process on the host for as long
 * as the turn lasts. The file is written 0600 and unlinked when the turn ends.
 */
function writeMcpConfig(token: string): string {
  const file = path.join(
    os.tmpdir(),
    `uf-mcp-${randomBytes(9).toString("hex")}.json`,
  );
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          uf: {
            type: "http",
            url: MCP_SELF_URL,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      }),
      { mode: 0o600 },
    );
  } catch (err) {
    // A write that fails part-way — ENOSPC, the likeliest of these — leaves the
    // file behind with whatever reached the disk, and what it carries is the
    // capability token. Nothing else would ever remove it: the unlink in `land`
    // is inside a promise this failure never reaches.
    try {
      fs.unlinkSync(file);
    } catch {
      // Never created, or the same condition that failed the write. The
      // original error is the one worth reporting.
    }
    throw err;
  }
  return file;
}
