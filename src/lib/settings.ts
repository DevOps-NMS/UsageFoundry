import { getJSON, setJSON } from "./db";
import { normalizePolicy, type BudgetPolicy } from "./budget";
import type { LimitConfig, WeeklyAnchor } from "./windows";

/**
 * User-editable preferences.
 *
 * Deliberately ships with **no default numeric ceilings**. Anthropic does not
 * publish the token value of a Pro/Max limit and there is no endpoint to read
 * it, so any number baked in here would be a guess wearing the costume of a
 * fact — and a budget guard built on a wrong ceiling fails in the expensive
 * direction. Instead the ceilings start null (windows still render, just
 * without a percentage) and `/api/calibrate` proposes values derived from the
 * user's own observed history.
 */

export interface Settings {
  /**
   * Primary ceilings, denominated in equivalent API cost.
   *
   * Cost rather than raw tokens because a Claude Code workload is ~95% cache
   * reads, which bill at 0.1x. A raw-token ceiling therefore tracks
   * conversation length more than it tracks work done, and its ratio to any
   * real limit moves around with context size.
   */
  sessionCostLimit: number | null;
  weeklyCostLimit: number | null;
  /** Secondary raw-token ceilings. Used only when no cost ceiling is set. */
  sessionTokenLimit: number | null;
  weeklyTokenLimit: number | null;
  weeklyAnchor: WeeklyAnchor | null;
  /**
   * Epoch ms at which the provider's current 5-hour window resets, when the
   * transcripts cannot show it.
   *
   * The window normally opens at the first turn after a gap, which is why it is
   * derived rather than configured. But Anthropic restarts it on a subscription
   * change, and that event appears nowhere in a transcript: the entries still
   * describe one continuous block while the limit is being enforced against a
   * window that started later. Setting the reset instant printed by `/usage`
   * splits the block there, so the meter and the guard measure the window that
   * is actually in force.
   *
   * Not a ceiling and not an estimate — it is an observed fact the local data
   * happens not to contain, so it is exempt from the no-default-numbers rule
   * above. It still defaults to null: a wrong value here is worse than none.
   */
  sessionResetOverrideAt: number | null;
  /**
   * Fraction of each window (0–1) held back for usage this tool cannot see.
   *
   * The 5-hour and weekly limits are shared across Claude Code, Cowork, Claude
   * Desktop, web, and mobile — but only Claude Code writes local transcripts.
   * Everything else is structurally invisible: the Desktop app stores an
   * Electron profile with no usage ledger, and Cowork's scheduled tasks run in
   * the cloud with the device offline.
   *
   * Without a reserve, a guard fails *unsafe*: the dashboard reads 20% while
   * Cowork has quietly consumed another 50%, and an 80% guard permits a run
   * that overruns the real limit. Reserving headroom shrinks the effective
   * ceiling so the guard trips early instead.
   */
  reservedHeadroomFraction: number | null;
  /**
   * Ask Anthropic what this account has actually used, instead of deriving it.
   *
   * On by default, which is the opposite of `telemetryForRuns` below, and the
   * difference is worth stating. That one turns telemetry on inside a child
   * process and points it at this server — a new side effect, so it is opted
   * into. This one makes an authenticated read of the signed-in account's own
   * usage with the credential Claude Code already keeps on this disk, to the
   * host every agent this app spawns already talks to. Nothing leaves that was
   * not already there, and what comes back is the only figure on the dashboard
   * that is not a guess: the ceiling behind every derived percentage is a
   * number the user typed, and on the machine this was written against that
   * guess was out by a factor of four.
   *
   * Off falls back to the derived reading, which is what shipped before it —
   * so this is a switch between "measured" and "estimated", never between
   * "shown" and "hidden".
   */
  planUsageFromApi: boolean;
  /** Default permission mode for new runs. */
  defaultPermissionMode: PermissionMode;
  /** Default model passed to Claude Code, or null to use its own default. */
  defaultModel: string | null;
  /**
   * The saved agent the new-run form starts on, or null for none.
   *
   * `defaultModel`'s precedent and its shape: one place for a default the run
   * form then pre-fills, rather than one per surface. What it is **not** is a
   * route to anything — an agent carries a description and a prompt, the
   * registry refuses a tool list at the door and has no column for a permission
   * mode, so this cannot widen what a run may do any more than `defaultModel`
   * can. There are still exactly two routes to `--permission-mode`.
   *
   * An **id**, `run_templates.agent_id`'s rule and its reason: an operator who
   * fixes their reviewer's prompt expects the next run to use the fixed one. The
   * frozen copy is taken where it always is, by `createRun`.
   *
   * Deliberately a *seed for a form* rather than something a run door reads, and
   * that is the whole of why it does not reproduce the CLI's silent drop. It is
   * refused at **save** when it names no usable agent, which is
   * `normalizeTemplateInput`'s rule — refuse where the person is. If the agent
   * is deleted afterwards the form says so and starts with none, because the
   * alternative is a new-run page nobody can use until they visit Settings. That
   * is not the "never fall back to none" rule bending: that rule is about a run
   * whose operator *named* an agent, and a pre-filled field nobody has looked
   * at is not a naming. Everything downstream is unchanged — the run door
   * still refuses a deleted agent by name through `agentRefusal`.
   */
  defaultAgentId: string | null;
  /** Prompt used for iterations after the first in a multi-step run. */
  continuationPrompt: string;
  /** Whether to include sub-agent (sidechain) turns in usage totals. */
  includeSidechains: boolean;
  /**
   * Put a sub-agent's own words in the run log.
   *
   * `--forward-subagent-text`, verified present on the pin (2.1.226) and gated
   * there on `--print` and `--output-format=stream-json`, which is exactly how
   * `buildArgs` spawns a work cycle. Without it a delegation is a `Task` tool
   * call followed by silence for however long the sub-agent takes, and the run
   * that spent the money has nothing to show for the part of it that was handed
   * on — which is the half of "make agent work visible" a cost breakdown cannot
   * cover.
   *
   * On by default, and the risk is worth stating rather than absorbing: this
   * app's `stream-json` parser was captured from one CLI build, and the flag
   * puts a *new shape* into that stream. So the shape is handled by name rather
   * than left to fall through — `handleStreamLine` routes a message carrying
   * `parent_tool_use_id` to its own event kind, which never becomes the cycle's
   * `finalText`, never latches an API refusal, and is never read by
   * `cycleOutputs`. The failure this prevents is precise: `finalText` is what
   * the `DONE` test runs against, matched per *line*, so a sub-agent reporting
   * "DONE" on a line of its own would end a run whose main thread had not
   * finished — and the cycle report would quote the wrong voice.
   *
   * Off is the escape hatch, and it is a real one: the CLI rejects a flag it
   * does not know, so if the pin ever moves past this flag every run fails at
   * the spawn. That is loud rather than quiet, which is the direction to fail
   * in, but it wants a switch that does not need a rebuild.
   */
  forwardSubAgentText: boolean;
  /**
   * How many **work cycles** may be running at once. Null means no limit.
   *
   * A concurrency knob, not a usage ceiling — the no-default-ceilings rule
   * above does not apply, because unlike a limit this number is not a guess at
   * something Anthropic knows and we do not. It does move the spend bound
   * though: each run carries its own `maxRunCostUSD`, so N runs can overshoot
   * by N work cycles rather than one.
   *
   * It ships as a **number**, and that is the difference between this and every
   * ceiling in this file. A ceiling is left null because we would be guessing at
   * a figure Anthropic publishes nowhere; there is no guess in a *host* limit —
   * how many Node processes a container can carry is a property of the machine,
   * and `null` meant a fresh install had no bound on the fleet at all. 4 is
   * chosen against the memory limit `docker-compose.yml` now ships (10 GiB) at
   * roughly 1.5 GiB for a work cycle — the CLI child plus the builds, test
   * suites and dev servers the agent starts inside it — leaving room for the
   * server and for `maxConcurrentAssists` below. That per-child figure is
   * reasoned rather than measured, and README's sizing table carries the
   * arithmetic for raising it. `null` is still available and is now what it
   * always read as: an explicit opt-out.
   *
   * What it does **not** cover is the other three kinds of `claude` child, which
   * are `maxConcurrentAssists`. Splitting them rather than sharing one number is
   * what keeps a chat turn from eating a run's slot, and it is why the ceiling
   * on this container is the *sum* of the two.
   */
  maxConcurrentRuns: number | null;
  /**
   * How many `claude` children that are **not** work cycles may run at once.
   * Null means no limit.
   *
   * Four callers, one budget: a review, a merge-conflict resolution, an
   * orchestrator-chat turn and a workflow orchestrator block's deciding turn.
   * They already share one door — `assistRefusal()` in `review.ts`, which every
   * one of them passes through — so the count is read there rather than in four
   * places that would drift.
   *
   * A cap that covered work cycles alone did not bound the host: a fleet of 25
   * runs can carry an orchestrator turn per `thinking` block and a turn per open
   * chat on top of it, each a full Node process. 2 is chosen against the same
   * 10 GiB compose limit at roughly 0.5 GiB each — cheaper than a work cycle
   * because none of the four builds anything (a review runs `--permission-mode
   * plan` and cannot write at all).
   *
   * The three kinds with a person in front of them are **refused** when it is
   * full, because they have an error channel and a sentence is what a person
   * needs. A block's deciding turn is instead left `waiting` for the next
   * advance, because failing it ends the branch of the graph behind it — and a
   * transient shortage of memory is not a decision about the work. Whatever
   * frees a slot wakes it: `settleBlock` already advances, and `review.ts` and
   * `chat.ts` advance when their own children settle.
   */
  maxConcurrentAssists: number | null;
  /**
   * Gitignored files copied into a fresh checkout, newest-wins glob order.
   *
   * A worktree contains committed work only, so an isolated agent would
   * otherwise start with no environment file and fail its first command. Kept
   * narrow on purpose: build output and dependency trees are rebuilt by the
   * agent, and copying them would be slow and stale.
   */
  isolationCopyGlobs: string[];
  /**
   * Per-repository overrides for the list above, keyed by folder.
   *
   * One list is correct for one repository and cannot be correct for fifteen: a
   * Next.js app's `.env.local`, an Azure Functions app's `local.settings.json`
   * and a Rails app's `config/master.key` would all have to be in it, and every
   * repository would then be seeded from every pattern. A key here *replaces*
   * the global list for the folders it covers rather than adding to it, which
   * is also the only way to say "this repository copies nothing".
   *
   * The key is a folder written absolute (`/workspace/acme/web`) or relative to
   * any mount (`acme/web`); the longest match wins, so a key on a parent is a
   * default for the tree under it. Empty by default, which is what keeps an
   * existing install's behaviour exactly what it was.
   */
  isolationCopyGlobsByRepo: Record<string, string[]>;
  /** Prepended to the first prompt of an isolated run. */
  isolationPreamble: string;
  /**
   * What an agent is told when it picks up a branch another run was working on.
   *
   * Its own text rather than a reuse of `isolationPreamble`, because the
   * situation is the opposite of a restart: the conversation is not gone, it
   * never existed, and the commits under the agent's feet are someone else's.
   * An agent handed a bare task does the first thing the task says, which on a
   * continued branch is work that has already been done.
   *
   * The branch, the predecessor and the two commands that show what changed are
   * generated beside this rather than written into it — a placeholder an
   * operator can delete is a notice that can silently stop naming the branch.
   */
  continuedWorkPrompt: string;
  /**
   * Ask agents this app spawns to report their own per-request cost over OTLP.
   *
   * Off by default. It turns on telemetry inside a child process and points it
   * at this server, which is a side effect a user should opt into rather than
   * discover. When on, a run gets a first-party cost figure per API request
   * — including requests belonging to an iteration that died before the CLI
   * emitted its `result` event, which is the one number the run row cannot
   * otherwise recover.
   */
  telemetryForRuns: boolean;
  /**
   * Sent when an agent reports DONE and the run is set to carry on regardless.
   *
   * Cannot be `continuationPrompt`: that one says "if it is fully complete,
   * reply with exactly DONE", so feeding it back after a DONE produces an
   * immediate second DONE and a tight, billed spin loop.
   */
  donePushbackPrompt: string;
  /**
   * How often a live-enforced run re-reads usage during a work cycle.
   *
   * A cadence, not a ceiling, so the no-default-numbers rule above does not
   * apply. 60s because each check is a transcript scan, and because the
   * underlying data only moves when Claude Code flushes a completed turn — a
   * 5-second interval would re-walk ~/.claude twelve times a minute to learn
   * nothing new. It does not make enforcement precise: the real resolution is
   * one model turn, and the UI says so.
   */
  liveGuardIntervalSeconds: number;
  /**
   * How long a work cycle may produce nothing before it is ended.
   *
   * A deadline rather than a budget rule, so the "blank disables a guard" rule
   * does not apply and there is deliberately no way to switch it off: the
   * absence of one is the defect it exists to fix. `runIteration` settles only
   * when its child says so, and a `claude` wedged on a socket read never does —
   * which leaves the run `running` for ever, holding its folder, its checkout
   * slot and one of `maxConcurrentRuns`, recoverable only by restarting the
   * container. It is floored rather than allowed to reach zero, and read
   * defensively at the spawn, for `chatGuards`' reason: this blob is JSON in a
   * settings row and can be hand-edited.
   *
   * **Silence, not wall clock.** The clock is the time since the last line the
   * child printed, and every stdout line and stderr chunk resets it — a cycle
   * that is still reporting is working, however long it takes, and killing one
   * for its duration is what `enforcement: "live"` is for. A cadence-shaped
   * number rather than a ceiling, so the no-default-numbers rule does not apply
   * either.
   *
   * Two hours by default, which is deliberately generous. The stream falls
   * silent for the whole of a single model turn and for the whole of one tool
   * call, so a run whose test suite takes an hour is silent for an hour and is
   * perfectly healthy; the cost of being wrong is asymmetric, since a killed
   * working cycle loses paid work while a slot recovered in two hours instead
   * of one is still recovered the same day.
   */
  maxCycleSilenceMinutes: number;
  /**
   * How stale a parked run's pause may be and still survive a restart.
   *
   * A run waiting on the 5-hour window is preserved across a restart, unlike a
   * queued one, because the operator explicitly chose "carry on into the next
   * window" — that is informed consent a bare queued row does not carry. The
   * grace period is what keeps it from becoming "auto-start a days-old prompt".
   */
  resumeGraceHours: number;
  /**
   * How an isolated run's branch is brought into the branch it started from.
   *
   * `merge` keeps what the run actually did — its commits, in order, which is
   * what makes the run page's `<base>...<branch>` diff still mean something
   * afterwards. `squash` collapses it to one commit and loses that, in exchange
   * for a history with one entry per run. Neither is right for everyone, which
   * is why it is a setting rather than a decision baked into the button.
   */
  landStrategy: "merge" | "squash";
  /**
   * Spawn each agent in its own process group, so a kill also reaps the builds,
   * test runners and servers it started.
   *
   * On by default: those grandchildren hold the working tree, and a signal
   * aimed at the CLI alone leaves them running and writing into a directory the
   * orchestrator is about to resume into or hand off. Off restores the older
   * behaviour of signalling only the `claude` process.
   */
  killProcessGroup: boolean;
  /**
   * Hard ceiling on what one orchestrator-chat turn may spend. Null removes it.
   *
   * Not a window ceiling, so the no-default-numbers rule above does not apply:
   * it is not a guess at a limit Anthropic knows and we do not, it is a cap on
   * this app's own behaviour, and unlike every other guard here it is enforced
   * *inside* the CLI (`--max-budget-usd`) rather than between cycles. It needs a
   * default because a chat turn passes through no `evaluateBudget` at all — the
   * only other thing bounding it is the wall-clock timeout, and "read every
   * issue in the repository" can spend a lot inside ten minutes.
   */
  chatTurnBudgetUSD: number | null;
  /**
   * How long a finished run's event log is kept, in days. Null keeps it always.
   *
   * The first of the three retention horizons, and the one furthest from the
   * operator: `run_events` holds every assistant block, every tool call with
   * its whole input, and every stderr chunk, so it grows at roughly the byte
   * volume of the agents' own traffic — measured at ~13 MB per thousand tool
   * events with a 4 KB payload — into a named volume with no size limit. What
   * is discarded is the *evidence*; the run's own row, with its spend, its
   * cycle count and its stop reason, is never touched. A run that has not
   * settled keeps all of it however old the rows are, because a log the page is
   * showing must not lose lines under the reader.
   *
   * Not a window ceiling, so the no-default-numbers rule does not apply: it
   * bounds this app's own storage rather than guessing at a limit Anthropic
   * knows and we do not. It needs a default because the failure it prevents is
   * a full volume, at which point every SQLite write fails at once and runs
   * simply stop being admitted with nothing on any page saying why.
   */
  eventRetentionDays: number | null;
  /**
   * How long an idle isolated checkout is kept, in days. Null keeps it always.
   *
   * The second horizon, and the one on the operator's *own* disk: checkouts
   * accumulate in `<mount>/.uf-worktrees`, the slot cap is 64 per repository
   * and the store is shared per mount, so fifteen repositories have a ceiling
   * of 960 full checkouts in one directory — with their `node_modules`, which
   * `git status` cannot see and which is most of the bytes. Nothing removed one
   * except an operator pressing Delete or Purge on a branch, so "recoverable"
   * and "leaked" were the same state.
   *
   * Shorter than the other two because a checkout is the cheapest of the three
   * to lose: `worktree add` rebuilds it in seconds from commits that are still
   * in the repository. What it costs is the dependency tree the next run in
   * that slot would have reused, which is why this is a week rather than a day
   * — slot reuse is what makes isolation practical, and a horizon short enough
   * to break it would trade disk for a re-install per run.
   */
  checkoutRetentionDays: number | null;
  /**
   * How long a session transcript is kept, in days. Null keeps it always.
   *
   * The third horizon, on the mount that also holds `.credentials.json`.
   * Claude Code writes one `.jsonl` per session into `~/.claude/projects` and
   * nothing in this app, its Dockerfile or its compose file ever pruned them or
   * configured the CLI to — 233 MB in four days was measured well under the
   * concurrency this is judged at. A full disk there does not announce itself:
   * a work cycle fails inside the CLI with a non-zero exit, and a credential
   * rewrite that runs out of space presents as an authentication failure.
   *
   * Two things follow from pruning, and both are handled rather than absorbed.
   * A removed transcript takes its session with it, so the sweep clears
   * `runs.session_id` on the terminal runs it belonged to — `--resume` against
   * a file that is gone fails a pick-up outright, where a null session id is
   * already this app's documented restart. And it shortens the dashboard's own
   * calendar history, which `PeriodSeries.completeFrom` carries onto the card
   * rather than letting the buckets quietly understate.
   *
   * 30 days rather than longer because the store is the operator's home
   * directory; longer than the checkout horizon because a transcript is the
   * only thing `--resume` can continue and it cannot be rebuilt.
   */
  transcriptRetentionDays: number | null;
  /**
   * Hard ceiling on what this whole installation may spend in 24 hours. Null
   * removes it, which is the shipped default.
   *
   * The one limit here that is not about a single spender. `maxRunCostUSD`
   * bounds a run, `maxInstanceCostUSD` one press of Run, `chatTurnBudgetUSD` one
   * chat turn — and nothing bounded the total, or the rate at which new spenders
   * are created: `promoteQueued` starts the next queued run the instant a slot
   * frees, a schedule presses Run with nobody present, and an orchestrator block
   * starts runs with no approval. Twenty-five concurrent runs under a $35 run
   * limit reads as $875 on this page and is $875 *per wave*, with the number of
   * waves unbounded.
   *
   * Not a window ceiling, so the no-default-numbers rule above does not apply
   * for the usual reason — it is not a guess at a limit Anthropic knows and we
   * do not, it is a cap on this app's own behaviour. It still ships `null`,
   * because unlike `chatTurnBudgetUSD` there is no single figure that is right
   * for both a laptop and a fleet, and a default that refused work on somebody's
   * first evening would be worse than the absence.
   *
   * Measured over a **rolling** 24 hours (`INSTALL_WINDOW_MS`) rather than a
   * calendar day: the container runs in UTC and the operator does not, and a
   * calendar boundary would also be a cliff every run in the install crosses at
   * the same instant.
   */
  installDailyCostLimitUSD: number | null;
  /**
   * What an agent may do when a chat proposal names no template.
   *
   * The chat used to be able to propose only against a saved template, which
   * made it useless on an install that has none — and made "propose a run for
   * this issue" fail on a rule about form input rather than about the work. So
   * a proposal may now name no template, and this is what it runs under
   * instead.
   *
   * It is emphatically **not** a widening of what the chat decides. The
   * division of labour is unchanged — the proposal says what work to do, and
   * something a *person* wrote says what an agent may do — this is just the
   * second place a person can write it. Nothing off a proposal reaches these
   * fields, exactly as nothing off one reaches a template's.
   *
   * Unlike a window ceiling these numbers are not a guess at something
   * Anthropic knows and we do not, so the no-default-numbers rule does not
   * apply: they bound this app's own behaviour, and a default of "no limit"
   * would be the unsafe reading. Kept small on purpose — an untemplated
   * proposal is the least considered kind, so it gets the least rope.
   */
  chatDefaultGuards: RunGuards;
}

/**
 * Everything that decides what an agent may do, as against what it is asked to
 * do.
 *
 * The split is the whole approval gate: `CreateRunInput` is this plus a folder
 * and a prompt, and every route that builds one takes this half from something
 * a person wrote — a template, the run form, or the settings above — and the
 * other half from whatever asked for the work.
 */
export interface RunGuards {
  permissionMode: PermissionMode;
  isolate: boolean;
  budget: BudgetPolicy;
}

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

/**
 * The four literals `--permission-mode` accepts, as a value rather than a type.
 *
 * Every route that can put a value on that flag narrows against this list, and
 * there are now three of them — the run form, a saved template, and reading a
 * template back. One shared constant is what keeps a fourth from being written
 * against a list that has quietly drifted.
 */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
];

export const DEFAULT_CONTINUATION_PROMPT =
  "Continue working on the task. If it is fully complete and verified, reply " +
  "with exactly DONE on its own line and make no further changes.";

/**
 * Without this, the expected outcome of an isolated run is uncommitted edits in
 * a hidden directory the folder picker deliberately skips — the operator looks
 * at their repository, sees nothing changed, and concludes the run did nothing.
 */
/**
 * Biased hard toward verification rather than new work, and explicit that
 * saying DONE again will not end the run.
 *
 * An agent told only "carry on" against a task it believes finished will invent
 * features, refactor working code and churn dependencies — and on a run that is
 * not isolated, that lands in the operator's own checkout. An instruction it
 * cannot satisfy produces the same churn, hence the last sentence.
 */
export const DEFAULT_DONE_PUSHBACK_PROMPT =
  "You reported the task complete, but this run still has budget left and is " +
  "set to spend it on the same task. Do not start new features and do not " +
  "refactor working code for its own sake. Instead: re-read the original task " +
  "and check every part of it is met; run the tests and fix what fails; look " +
  "for edge cases, error handling and missing tests; and correct any " +
  "documentation your changes made wrong. This run ends when it reaches a " +
  "limit, not when you report it done, so if you truly find nothing worth " +
  "doing, say so and make no changes.";

/**
 * Read first, then extend — and do not undo.
 *
 * The failure this guards against is not the agent being confused; it is the
 * agent being confident. A fresh session on a branch full of work it did not do
 * reads the task, sees the files half-changed, and either redoes the work or
 * reverts it as leftovers. Both are billed and both look like progress.
 */
export const DEFAULT_CONTINUED_WORK_PROMPT =
  "Read what is already on this branch before you change anything, and treat " +
  "it as deliberate: extend it, fix what is wrong with it, and finish what it " +
  "left unfinished. Do not restart the task from scratch and do not revert " +
  "that work because it is not what you would have written. If it contradicts " +
  "the task below, say so in your reply rather than quietly undoing it.";

export const DEFAULT_ISOLATION_PREAMBLE =
  "You are working in a dedicated git worktree on your own branch, not in the " +
  "user's checkout. Commit your work as you go, with clear messages; anything " +
  "left uncommitted will not be visible to the user.";

/**
 * The guard set an untemplated proposal starts under until an operator changes
 * it.
 *
 * `isolate` is true and the permission mode is the same `acceptEdits` the run
 * form defaults to, so the worst case is commits on a branch nobody has landed.
 * The three limits are all present rather than only the terminus pair, because
 * this is the path with no form behind it: four cycles is enough to fix a small
 * issue and not enough to rewrite a project, and an hour and $5 stop a run that
 * misunderstood the task from spending all afternoon proving it.
 */
export const DEFAULT_CHAT_GUARDS: RunGuards = {
  permissionMode: "acceptEdits",
  isolate: true,
  budget: {
    maxIterations: 4,
    maxDurationMinutes: 60,
    maxRunCostUSD: 5,
    maxRunTokens: null,
    maxWeeklyFraction: null,
    maxSessionFraction: null,
    enforcement: "between-cycles",
    continueAfterDone: false,
  },
};

const DEFAULTS: Settings = {
  sessionCostLimit: null,
  weeklyCostLimit: null,
  sessionTokenLimit: null,
  weeklyTokenLimit: null,
  weeklyAnchor: null,
  sessionResetOverrideAt: null,
  reservedHeadroomFraction: null,
  planUsageFromApi: true,
  defaultPermissionMode: "acceptEdits",
  defaultModel: null,
  defaultAgentId: null,
  continuationPrompt: DEFAULT_CONTINUATION_PROMPT,
  includeSidechains: true,
  forwardSubAgentText: true,
  maxConcurrentRuns: 4,
  maxConcurrentAssists: 2,
  isolationCopyGlobs: [".env", ".env.*", "!.env.example"],
  isolationCopyGlobsByRepo: {},
  isolationPreamble: DEFAULT_ISOLATION_PREAMBLE,
  continuedWorkPrompt: DEFAULT_CONTINUED_WORK_PROMPT,
  telemetryForRuns: false,
  donePushbackPrompt: DEFAULT_DONE_PUSHBACK_PROMPT,
  liveGuardIntervalSeconds: 60,
  maxCycleSilenceMinutes: 120,
  resumeGraceHours: 24,
  landStrategy: "merge",
  killProcessGroup: true,
  chatTurnBudgetUSD: 2,
  eventRetentionDays: 30,
  checkoutRetentionDays: 7,
  transcriptRetentionDays: 30,
  installDailyCostLimitUSD: null,
  chatDefaultGuards: DEFAULT_CHAT_GUARDS,
};

/**
 * Every key of `Settings`, as a value rather than a type.
 *
 * `DEFAULTS` is the only complete enumeration of the interface there is — it is
 * typed `Settings`, so a field added above cannot be left out of it — which
 * makes it the one list a test can walk to check that `PUT /api/settings` still
 * accepts all of them. It is a route built from an explicit branch per key
 * precisely so it can narrow each one, and the cost of that shape is that a new
 * field is dropped in silence: the page sends it, the route answers 200 without
 * it, and the form reverts under a "Saved" confirmation.
 */
export const SETTINGS_KEYS = Object.keys(DEFAULTS) as (keyof Settings)[];

const KEY = "settings";

export function getSettings(): Settings {
  return { ...DEFAULTS, ...getJSON<Partial<Settings>>(KEY, {}) };
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  setJSON(KEY, next);
  return next;
}

/**
 * Whether new work is held: nothing starts, nothing already started is touched.
 *
 * Persisted rather than a process variable, because the usual reason it gets set
 * is the restart it has to survive — an operator who stems the flow at 02:00 and
 * then bounces the container must not find twenty-five agents back at work.
 *
 * A settings row of its **own**, deliberately not a key of `Settings`. The
 * settings page sends the whole object on Save, so a field in that blob is one
 * an unrelated edit from a tab opened before the pause would silently clear —
 * which for a preference is a nuisance and for the fleet's kill switch is the
 * failure it exists to prevent. `SETTINGS_KEYS` and the route's per-key
 * narrowing therefore do not cover it, and the only doors to it are the fleet
 * route and this pair.
 *
 * What it suppresses is *starting*, not recording: rows may still be created —
 * a press of Run on a workflow still writes its graph out — they simply never
 * leave the queue. Four call sites read it and each is separate: `promoteQueued`
 * through `selectPromotable`, `releaseDependents` through `releasableRuns`,
 * `tickSchedules` through `decideSchedule`, and `emitBlockRuns` at its door. A
 * fix that misses one is silent, which is why there is a test per site.
 */
const PAUSE_KEY = "fleet.newWorkPaused";

export function newWorkPaused(): boolean {
  return getJSON<boolean>(PAUSE_KEY, false) === true;
}

export function setNewWorkPaused(paused: boolean): void {
  setJSON(PAUSE_KEY, paused === true);
}

/**
 * Ceilings as the rest of the app should see them — reserved headroom already
 * subtracted.
 *
 * Applied here rather than at each call site so meters, budget guards, and the
 * exhaustion projection all agree on one effective number. The raw configured
 * values stay on Settings for display.
 */
/**
 * The untemplated guard set, narrowed the way a stored template is.
 *
 * Read-time narrowing, for the reason `rowToTemplate` does it: this blob is
 * JSON in a settings row, so it can outlive the build that wrote it and it can
 * be edited by hand. The rules are the same three — an unrecognised permission
 * mode degrades to `plan`, the only one of the four that cannot write, never to
 * something more permissive; the budget goes through `normalizePolicy`; and a
 * policy with neither terminus is read as one work cycle rather than as an
 * uncapped loop, since the alternative is a proposal that can be approved and
 * then refused by `evaluateBudget` a second later with nothing said about why.
 * `PUT /api/settings` refuses that pair at the door, so reaching this is
 * already a hand-edited row.
 */
export function chatGuards(s: Settings = getSettings()): RunGuards {
  const raw = s.chatDefaultGuards ?? DEFAULT_CHAT_GUARDS;
  const permissionMode = (PERMISSION_MODES as readonly string[]).includes(
    String(raw.permissionMode),
  )
    ? (raw.permissionMode as PermissionMode)
    : "plan";

  const budget = normalizePolicy(raw.budget ?? {});
  if (budget.maxIterations === null && budget.maxDurationMinutes === null) {
    budget.maxIterations = 1;
  }

  return { permissionMode, isolate: raw.isolate !== false, budget };
}

export function limitConfig(s: Settings = getSettings()): LimitConfig {
  const reserve = Math.min(Math.max(s.reservedHeadroomFraction ?? 0, 0), 0.95);
  const usable = (v: number | null) => (v === null ? null : v * (1 - reserve));

  return {
    sessionCostLimit: usable(s.sessionCostLimit),
    weeklyCostLimit: usable(s.weeklyCostLimit),
    sessionTokenLimit: usable(s.sessionTokenLimit),
    weeklyTokenLimit: usable(s.weeklyTokenLimit),
    weeklyAnchor: s.weeklyAnchor,
  };
}
