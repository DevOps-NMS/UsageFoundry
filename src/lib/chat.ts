import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  githubEnv,
  signalTree,
  type CreateRunInput,
} from "./orchestrator";
import { getTemplate, type RunTemplate } from "./templates";

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
 * cannot start a run. Everything it writes is form input: a `chat_proposals`
 * row, or a `run_templates` prompt — neither holds a folder claim, neither
 * consumes a concurrency slot, and neither does anything at all until a person
 * approves it. Every tool that could widen what an agent may do is absent from
 * that list rather than guarded inside it.
 *
 * Its own cost never reaches `runs.spent_usd`, exactly as a review's does not.
 */

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

export type ChatStatus = "idle" | "thinking" | "failed";
export type ChatRole = "user" | "assistant" | "system";
export type ProposalStatus = "pending" | "approved" | "rejected" | "failed";

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
}

export interface ChatMessageRow {
  id: string;
  chat_id: string;
  ts: number;
  role: ChatRole;
  text: string;
}

export interface ChatProposalRow {
  id: string;
  chat_id: string;
  created_at: number;
  /** Null when the proposal runs under `settings.chatDefaultGuards` instead. */
  template_id: string | null;
  title: string;
  task: string;
  /** The prompt the task is appended to, when the chat wrote one for this run. */
  prompt_override: string | null;
  mount_id: string | null;
  folder: string | null;
  status: ProposalStatus;
  run_id: string | null;
  decided_at: number | null;
  error: string | null;
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
const CHAT_TIMEOUT_MS = 10 * 60_000;

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

export function listMessages(chatId: string): ChatMessageRow[] {
  return db()
    .prepare("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY ts, id")
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
      "INSERT INTO chat_messages (id, chat_id, ts, role, text) VALUES (?, ?, ?, ?, ?)",
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
  /** Null runs it under the operator's untemplated guard set. */
  templateId: string | null;
  title: string;
  task: string;
  /** Replaces the template's prompt for this run only. Null keeps it. */
  promptOverride: string | null;
  mountId: string | null;
  folder: string | null;
}

export function createProposal(
  chatId: string,
  input: ProposalInput,
): ChatProposalRow {
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO chat_proposals
         (id, chat_id, created_at, template_id, title, task, prompt_override,
          mount_id, folder, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      id,
      chatId,
      Date.now(),
      input.templateId,
      input.title,
      input.task,
      input.promptOverride,
      input.mountId,
      input.folder,
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
    | "prompt_override"
  >,
  template: RunTemplate | null,
  defaults: RunGuards,
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
export function approveProposal(id: string): ApprovalOutcome {
  const proposal = getProposal(id);
  if (!proposal) return { ok: false, reason: "No such proposal." };

  const plan = planProposal(
    proposal,
    proposal.template_id ? getTemplate(proposal.template_id) : null,
    chatGuards(),
  );
  if (!plan.ok) {
    markProposal(id, "failed", { error: plan.reason });
    return { ok: false, reason: plan.reason };
  }

  try {
    const run = createRun(plan.input);
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

export function rejectProposal(id: string): boolean {
  const res = db()
    .prepare(
      "UPDATE chat_proposals SET status='rejected', decided_at=? WHERE id=? AND status='pending'",
    )
    .run(Date.now(), id);
  return res.changes > 0;
}

function markProposal(
  id: string,
  status: ProposalStatus,
  o: { runId?: string; error?: string },
): void {
  db()
    .prepare(
      "UPDATE chat_proposals SET status=?, decided_at=?, run_id=?, error=? WHERE id=?",
    )
    .run(status, Date.now(), o.runId ?? null, o.error ?? null, id);
}

/* ------------------------------------------------------------------ */
/* The capability token                                                */
/* ------------------------------------------------------------------ */

/**
 * What lets the chat's child call back into this server, and nothing else.
 *
 * `/api/mcp` is exempt from `middleware.ts` because the middleware runs in the
 * edge runtime and cannot reach SQLite to check a per-chat credential — so the
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
  chatId: string;
  expiresAt: number;
}

const caps = ((globalThis as unknown as { __ufChatCaps?: Map<string, Capability> })
  .__ufChatCaps ??= new Map<string, Capability>());

export function mintCapability(chatId: string): string {
  const token = randomBytes(32).toString("base64url");
  caps.set(token, { chatId, expiresAt: Date.now() + CHAT_TIMEOUT_MS + 60_000 });
  return token;
}

export function revokeCapability(token: string): void {
  caps.delete(token);
}

/**
 * The chat a bearer token speaks for, or null.
 *
 * Compared in constant time against every live token rather than looked up by
 * key: a `Map.get` on a secret leaks its prefix through timing, and the number
 * of live tokens here is the number of chat turns in flight — one, in practice.
 */
export function chatForCapability(token: string): string | null {
  if (!token) return null;
  const offered = Buffer.from(token);
  const now = Date.now();
  let found: string | null = null;

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
      found = cap.chatId;
    }
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* The turn                                                            */
/* ------------------------------------------------------------------ */

export type ChatOutcome = { ok: true } | { ok: false; reason: string };

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
  if (chat.status === "thinking") {
    return { ok: false, reason: "This chat is still working on the last message." };
  }

  const text = message.trim();
  if (!text) return { ok: false, reason: "Nothing to send." };

  // The same gate a review passes: the operator's own configured ceiling is
  // already spent. A chat turn spends against the same window as everything
  // else, and unlike a run it goes through no `evaluateBudget` — there is no
  // per-chat fraction and inventing one would be a threshold nobody set.
  const refusal = await assistRefusal();
  if (refusal) return { ok: false, reason: refusal };

  appendMessage(chatId, "user", text);
  const history = listMessages(chatId)
    .slice(0, -1)
    .map((m) => ({ role: m.role, text: m.text }));

  db()
    .prepare("UPDATE chat_sessions SET status='thinking', error=NULL, updated_at=? WHERE id=?")
    .run(Date.now(), chatId);

  const prompt = chatPrompt({ sessionId: chat.session_id, history }, text);

  // Not awaited: it runs for minutes and the row is what reports on it.
  void runTurn(chat, prompt).catch((err) => {
    finishTurn(chatId, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return { ok: true };
}

interface TurnResult {
  status: "idle" | "failed";
  text?: string;
  error?: string;
  costUSD?: number;
  tokens?: number;
  sessionId?: string | null;
  denials?: string[];
}

function runTurn(chat: ChatRow, prompt: string): Promise<void> {
  const token = mintCapability(chat.id);
  const configPath = writeMcpConfig(token);

  return new Promise((resolve) => {
    const settings = getSettings();
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      // `manual` asks before every tool call, and a `-p` child has nobody to
      // ask — so the allowlist below decides and everything else is refused.
      //
      // Not `plan`, which is what `review.ts` uses and what this was written
      // against: plan mode refuses MCP tool calls outright ("Cannot call
      // mcp__uf__list_templates while in plan mode"), so the chat could see
      // GitHub and not this app. That leaves the allowlist as the whole
      // guarantee rather than the second half of one, which is why the deny
      // list below exists as well. A deny list fails open on the next write
      // tool the CLI ships and is worth nothing on its own — under an
      // allowlist that already excludes everything, it costs nothing and
      // catches the one case that would otherwise be silent: a future CLI
      // treating some write tool as always-permitted.
      "--permission-mode",
      "manual",
      "--allowedTools",
      ...ALLOWED_TOOLS,
      "--disallowedTools",
      ...DENIED_TOOLS,
      "--mcp-config",
      configPath,
      // Without this, an MCP server configured in the mounted ~/.claude joins
      // this child — a tool surface the operator never granted this feature.
      "--strict-mcp-config",
      "--append-system-prompt",
      systemPrompt(),
    ];

    // Read access to the mounts, so "look at what this repo is like" works.
    // Widening what can be *read* only: nothing in ALLOWED_TOOLS writes.
    for (const mount of WORKSPACE_MOUNTS) {
      if (fs.existsSync(mount.path)) args.push("--add-dir", mount.path);
    }

    if (chat.session_id) args.push("--resume", chat.session_id);
    if (settings.defaultModel) args.push("--model", settings.defaultModel);
    if (settings.chatTurnBudgetUSD !== null) {
      // A hard stop inside the CLI. Everything else here bounds a *run*; this
      // is the only thing bounding a chat turn, which can otherwise read
      // issues and repositories for as long as it likes.
      args.push("--max-budget-usd", String(settings.chatTurnBudgetUSD));
    }

    // No shell, as everywhere else: the prompt is operator text and whatever a
    // GitHub issue body happens to contain.
    const child = spawn(CLAUDE_BIN, args, {
      cwd: chatCwd(),
      env: chatEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: settings.killProcessGroup && process.platform !== "win32",
    });

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
    }, CHAT_TIMEOUT_MS);
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
      finishTurn(chat.id, result);
      resolve();
    };

    child.on("error", (err) => {
      land({ status: "failed", error: `Could not launch ${CLAUDE_BIN}: ${err.message}` });
    });

    child.on("close", (code) => {
      if (timedOut) {
        land({
          status: "failed",
          error: `The chat did not answer within ${CHAT_TIMEOUT_MS / 60_000} minutes and was stopped.`,
        });
        return;
      }
      land(parseTurnOutput(stdout, stderr, code));
    });
  });
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

  // Session id is adopted rather than compared, and a change is recorded rather
  // than treated as a failure — same posture the run loop takes. Which id the
  // CLI reports for a resumed conversation is its business; what must not
  // happen is continuing a conversation nobody chose without saying so.
  const prior = getChat(chatId)?.session_id ?? null;
  if (r.sessionId && prior && r.sessionId !== prior) {
    appendMessage(
      chatId,
      "system",
      `Claude Code answered under a different session id (${r.sessionId}) than ` +
        `the one this chat resumed (${prior}). Continuing with the new one.`,
    );
  }

  db()
    .prepare(
      `UPDATE chat_sessions
          SET status=?, error=?, updated_at=?,
              cost_usd = cost_usd + ?, tokens = tokens + ?,
              session_id = COALESCE(?, session_id)
        WHERE id=?`,
    )
    .run(
      r.status,
      r.error ?? null,
      now,
      r.costUSD ?? 0,
      r.tokens ?? 0,
      r.sessionId,
      chatId,
    );

  if (r.text) appendMessage(chatId, "assistant", r.text);
  if (r.error) appendMessage(chatId, "system", r.error);

  // A denial is the difference between "there are no open issues" and "I was
  // not allowed to look", and only one of those is worth acting on.
  if (r.denials && r.denials.length > 0) {
    appendMessage(
      chatId,
      "system",
      `Refused tool calls this turn: ${[...new Set(r.denials)].join(", ")}. ` +
        "The chat is allowed read-only tools and this app's own; anything else " +
        "is denied by design.",
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
}

/**
 * Fail out chat turns a restart left mid-flight.
 *
 * Same reasoning as `reconcileOnBoot` and `reconcileReviewsOnBoot`: the child
 * is gone with the process that started it, and a row left saying `thinking`
 * spins an indicator for ever. Nothing is resumed — a chat turn is a question
 * somebody asked minutes ago, and re-asking it unattended is spend nobody is
 * present to want.
 */
export function reconcileChatsOnBoot(): void {
  db()
    .prepare(
      "UPDATE chat_sessions SET status='failed'," +
        " error='The server restarted while this message was being answered.'" +
        " WHERE status='thinking'",
    )
    .run();
}

/* ------------------------------------------------------------------ */
/* What the child is allowed to be                                     */
/* ------------------------------------------------------------------ */

/**
 * Every tool this child may use.
 *
 * An allowlist rather than a deny list, which is the opposite of the choice
 * `review.ts` explains and for a reason that inverts cleanly: a review needs no
 * tools at all, so a named mode is the whole guarantee; this one needs `gh` and
 * this app's own tools, so something has to name what it may run. A deny list
 * fails open on the next tool the CLI ships — an allowlist fails closed, and
 * the failure is a refused call recorded in `permission_denials` and shown in
 * the thread rather than swallowed.
 *
 * `gh` entries are read-only subcommands, spelled out one at a time. `gh api`
 * is deliberately absent: it takes `--method POST` and would be a way to write
 * to a repository through a list that reads as read-only.
 */
const ALLOWED_TOOLS = [
  "mcp__uf__list_folders",
  "mcp__uf__list_templates",
  "mcp__uf__list_runs",
  "mcp__uf__get_run",
  "mcp__uf__get_run_diff",
  "mcp__uf__get_usage",
  "mcp__uf__list_proposals",
  "mcp__uf__save_template",
  "mcp__uf__propose_run",
  "Read",
  "Glob",
  "Grep",
  "Bash(gh issue list:*)",
  "Bash(gh issue view:*)",
  "Bash(gh pr list:*)",
  "Bash(gh pr view:*)",
  "Bash(gh pr diff:*)",
  "Bash(gh pr checks:*)",
  "Bash(gh run list:*)",
  "Bash(gh run view:*)",
  "Bash(gh search issues:*)",
  "Bash(gh search prs:*)",
  "Bash(gh label list:*)",
  "Bash(gh repo view:*)",
  // Enumerated one subcommand at a time for the reason `gh` is: `git` as a
  // prefix would admit `git commit` and `git push` into a list that reads as
  // read-only. These three answer "who has touched this lately", which is the
  // question that decides whether work is worth proposing at all.
  //
  // `git diff` and `git show` are deliberately absent: rendering a patch runs
  // `diff.external` and `.gitattributes` textconv drivers, which are commands
  // the repository configures and git obeys — the same execution every git call
  // in this app passes `--no-ext-diff --no-textconv` to avoid. The diff a
  // proposal is actually about is available scrubbed, as `get_run_diff`.
  //
  // This does not make the list airtight — `git log -p` renders patches too —
  // and that is worth stating rather than implying. What bounds it is that both
  // drivers have to be named in the local repository's config, which a clone
  // does not carry: reaching them needs a repository someone already edited on
  // this host.
  "Bash(git log:*)",
  "Bash(git status:*)",
  "Bash(git branch:*)",
  // Not decoration: the child's cwd is the first mount, and a `git` subcommand
  // is only allowed by the entries above under its own name — `git -C <path>
  // log` matches none of them. `cd <folder> && git log` is what is left, which
  // rests on the CLI matching each half of a compound command separately. That
  // is how it is documented and it has not been watched here; if it is wrong
  // the call is refused and named in the thread, which is the loud direction.
  "Bash(cd:*)",
];

/**
 * The second latch.
 *
 * Redundant by construction — none of these is on the allowlist, so `manual`
 * mode refuses them already — and kept anyway because the thing it guards
 * against is a CLI that stops consulting the allowlist for some tool it comes
 * to treat as always-available. That failure would be silent and would arrive
 * on a version bump, which is the same class of risk `ARG CLAUDE_CLI_VERSION`
 * exists to bound. It is not a substitute for the allowlist and must never be
 * allowed to become one: a deny list has to grow an entry for every new write
 * tool, and it fails open when it does not.
 */
const DENIED_TOOLS = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

function systemPrompt(): string {
  return [
    "You are the orchestrator for UsageFoundry, a tool that runs unattended",
    "Claude Code agents against folders on this machine. You are talking to its",
    "operator in a chat panel.",
    "",
    "You cannot start, stop or resume a run. The only thing you can do is call",
    "propose_run, which records a proposal the operator then approves or rejects",
    "by hand. Say so plainly rather than implying work has started.",
    "",
    "What decides what an agent may do — the budget, the work-cycle limit, the",
    "permission mode, whether it works in its own checkout — is never yours to",
    "set. It comes from the template a proposal names, or, when it names none,",
    "from the operator's default guard set in Settings. What is yours is the",
    "*work*: which folder, which task, and the prompt the agent is given.",
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
    "- list_proposals: what is already waiting for the operator in this chat.",
    "",
    "Proposing:",
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
    "- save_template writes a template's name and prompt back for reuse. It",
    "  cannot touch guards: creating one takes the default guard set, and",
    "  updating one keeps the guards it already has. Tell the operator to adjust",
    "  those on the new-run form if they matter.",
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
 * The same two exclusions every other child gets — this app's own `UF_*`
 * configuration and any inherited telemetry routing — plus `githubEnv()`, which
 * until now reached work cycles and nothing else. That widening is the point of
 * the feature: a chat asked to look at open issues cannot, otherwise, and it
 * would fail inside a tool call the way `git push` used to.
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
      key === "CLAUDE_CODE_ENABLE_TELEMETRY"
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
  return file;
}
