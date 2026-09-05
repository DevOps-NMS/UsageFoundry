import { getJSON, setJSON } from "./db";
import { normalizePolicy, type BudgetPolicy } from "./budget";
import type { LimitConfig, WeeklyAnchor } from "./windows";
import type { PruneTier } from "./apiTypes";

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
   * Refuse a `Read` this session has already made, and cap one whole read.
   *
   * Delivered as a generated hook plugin — `readGuard.ts` carries the argument
   * and the mechanism — and **off**, which is the honest position rather than a
   * cautious one. What is measured is that carrying context is 83% of this
   * fleet's bill and that `Read` places most of it; what is *not* measured is
   * that refusing a read makes a run cheaper. An agent that answers a denial
   * with four ranged reads of the same file has spent more, and nothing in this
   * app would see that happen. `readGuard.ts` names the experiment that would
   * settle it.
   *
   * On, it changes what the agent may do rather than what it is told, so the
   * two failure modes are worth stating apart: the guard being silently absent
   * costs money, and the guard being silently wrong costs work cycles. The
   * second is the worse one, which is why every refusal it makes leaves
   * `offset`/`limit` open — see the hook's own rules.
   */
  readGuard: boolean;
  /**
   * The most one whole `Read` may add, in tokens. Null caps nothing.
   *
   * Inert while `readGuard` is off, and that is the shape rather than a second
   * switch: one thing an operator turns on, one number under it they may leave
   * alone. Null leaves the repeat-read half running by itself, which is the
   * half that needs no figure from anybody.
   *
   * `metering.ts`'s no-numeric-ceilings rule does not reach it, for
   * `maxConcurrentRuns`' reason: that rule refuses guessing at a limit
   * *Anthropic* knows and we do not, and there is nothing to guess here — the
   * number is a preference about this install's own spending. It ships null all
   * the same, because the feature above it ships off.
   *
   * The useful range has a hard top the operator cannot see, so the settings
   * page states it: the CLI already refuses a whole read past
   * `CLI_MAX_READ_TOKENS`, so anything at or above that is a switch that reads
   * as on and does nothing.
   */
  readGuardMaxTokens: number | null;
  /**
   * Prune a work cycle's transcript at each cycle boundary, and end a cycle
   * early once its context passes `CYCLE_CONTEXT_CEILING_TOKENS`.
   *
   * **This is the only thing bounding a cycle's context.** It replaced
   * `--autocompact 200000`, which is no longer on any cycle's argv, so an
   * install with this off runs a long cycle to the model's whole window. That is
   * a deliberate swap and not an accident of defaults — `contextPruning.ts`
   * carries what it cost, and `docs/verification.md` records the measurement
   * that was given up.
   *
   * It ships **off** all the same, on the rule its two neighbours ship off
   * under: what is measured here is where the money goes, not that any of these
   * three moves it. The difference is that switching this one on also changes
   * what stops a runaway cycle, so the settings copy says so rather than
   * offering it as a third way of spending less.
   */
  contextPruning: boolean;
  /**
   * How much a prune takes out. Inert while `contextPruning` is off.
   *
   * Two positions, not winnow's three: `gentle` is excluded here because it
   * provably removes nothing under any configuration this app would accept.
   * `contextPruning.ts`'s `PRUNE_TIERS` carries the reason, which is a fact
   * about the tool rather than a preference.
   */
  contextPruningStrictness: PruneTier;
  /**
   * Which of winnow's two rule engines does the pruning.
   *
   * `"legacy"` is `winnow treat`, the inherited pruner: about twenty strategies
   * under `src/winnow/legacy/`, editing the transcript in place and keeping the
   * session id. It is what this app has always run and stays the default.
   *
   * `"winnow"` is `winnow fork`, SPEC section 4's six rules at tier CB. It does
   * not edit anything — it writes a **new** transcript under a new session id
   * and the run switches onto it, with the original left untouched as the
   * recovery path.
   *
   * **Off by default and meant to be switched on deliberately, for a while, to
   * find something out.** Three things are true of the fork path that are not
   * true of the pruner, and an operator turning it on should know all three.
   * Its 100-fork resume guardrail has not been run, so no fork has been proven
   * resumable against a real `claude --resume` — this app verifies each one and
   * rolls back, which contains the risk and is also how the evidence gets
   * collected. Its own cold-age guard cannot be satisfied at a cycle boundary
   * at all, so `contextPruningForkMinColdAge` ships at 0 and the reasoning for
   * that is on the setting itself.
   * And while both transcripts are on disk they carry the same message ids, so
   * session-scoped attribution downstream picks one of the two.
   */
  contextPruningEngine: "legacy" | "winnow";
  /**
   * Seconds of quiet a transcript needs before the fork engine will cut it.
   * **Zero, and that is the decision this docblock exists to record.**
   *
   * Winnow's own default is 3,600 and its reason is the whole economic argument
   * for the tool: a resume past the cache TTL pays a write it was going to pay
   * anyway, so the deletion is free in the only sense that matters.
   *
   * The proxy does not survive contact with an orchestrator. This app forks
   * seconds after a child exits — that is the *design*, not a race: the cut has
   * to land before the next `--resume` reads the file. So the transcript's last
   * request is always ~0s old at the only moment a fork can happen, the guard
   * can never be satisfied here however long anyone waits, and at 3,600 the
   * engine does not misfire — it never fires at all. A guard whose pass
   * condition is unreachable is not a safety property, it is an off switch.
   *
   * What the hour is a proxy *for* is the general claim in SPEC section 7: that
   * there is one moment where the edit is free, the work-cycle handover, where
   * the suffix is rewritten anyway. A boundary here is literally that moment.
   * This is the same reasoning that turns off the break-even gate at the same
   * two call sites (`BOUNDARY_BREAK_EVEN_BUDGET`), and it stands or falls with
   * it — one hypothesis, applied consistently, rather than armed in one guard
   * and disarmed in the other.
   *
   * **What would overturn it**, and it is measured rather than argued:
   * `resume_probes` and `classifyResume` are reading whether a *clean* boundary
   * resume — one with no prune before it — comes back warm. Warm means the
   * prefix was still cached, the handover is not free, and this number should go
   * back up along with every figure that prices a boundary invalidation at zero.
   * Until then the honest value is the one that lets the engine run, because an
   * engine that cannot fire collects no evidence either way.
   *
   * Set on purpose by an operator who disagrees; the effective value is recorded
   * on every fork attempt, so what was in force is always readable off the row.
   * Null defers to winnow's own default, which in this app means never firing.
   */
  contextPruningForkMinColdAge: number | null;
  /**
   * Start the next work cycle fresh, rather than resuming, once the last one's
   * context passed this many tokens. Null is off and is today's behaviour.
   *
   * Every cycle after the first opens with `--resume`, so cycle 2 pays for the
   * whole of cycle 1's context on every one of its own turns. The measurements
   * either side of that are real: runs that took two cycles averaged $19.19
   * against $10.05 for one, and a tool call costs 12.0c at turns 1-10 against
   * 20.4c past turn 200. A cycle that started fresh would price at the first
   * rate rather than the second.
   *
   * **This is the one in this file I would not switch on, and the reason is in
   * `docs/verification.md`.** It trades tokens for re-discovery: the agent has
   * to re-learn what it just did, from the branch and the files rather than
   * from a conversation, and the neighbouring question — compaction — is a
   * direct warning against assuming a smaller context is a cheaper one. The
   * handoff is `nextPrompt`'s existing cycle-1 path, so a fresh cycle is told
   * what a picked-up run is told; whether that is enough is exactly what is
   * unmeasured. `startsFresh` in `orchestrator.ts` names the experiment.
   */
  freshStartContextTokens: number | null;
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
   * Tool patterns a conflict resolution may run to check the merge it wrote.
   *
   * `resolveConflicts` pins `acceptEdits`, which auto-approves file edits and
   * read-only shell and holds everything else for a human — and a `-p` child has
   * nobody to ask. So the resolver could edit the conflicted files and could not
   * run a single command against the result. Measured across this install's
   * whole window: 19 of 58 completed resolutions, $109.94 of $233.85, say in
   * their own report text that they could not compile or test what they had
   * merged. The same door `ISOLATED_GIT_TOOLS` opens for a work cycle, and it is
   * `--allowedTools` here too — additive, so everything not named still follows
   * the mode.
   *
   * **Empty by default, and that is not timidity.** This app runs against
   * whatever repository is mounted, so there is no command it could ship that
   * is right for one — `npm run typecheck` is this repository's answer and means
   * nothing in a Go or Python tree. An operator naming the command is the only
   * form that is correct anywhere, and a blank list leaves the resolver exactly
   * as it is today rather than handing every install a grant nobody asked for.
   *
   * Granted only where a toolchain can exist: `resolveCheckout` reuses the run's
   * **own** worktree when that tree is clean and on the branch, and otherwise
   * cuts a fresh `git worktree add` with no dependency tree in it. A check run in
   * the second case fails for a reason that has nothing to do with the merge,
   * which is worse than not running it — an agent that reads a missing-module
   * error as a conflict it resolved badly will "fix" working code.
   */
  resolveVerifyTools: string[];
  /**
   * A command that must exit 0 before Land will merge a run's branch.
   *
   * Empty is off, and off is the default: an empty command is not a check that
   * passes, it is no check, and Land behaves exactly as it did before this
   * existed. Set, a non-zero exit REFUSES the land rather than warning about
   * it — the whole value of the field is that it is the thing an operator
   * cannot forget to read.
   *
   * argv, never a shell line. `landGate.parseVerifyCommand` refuses shell
   * metacharacters instead of escaping them, for the reason
   * `docs/agent/security.md` gives about spawn argv generally; an operator who
   * wants `a && b` names a script here instead.
   */
  landVerifyCommand: string;
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
  /**
   * Which configured mount holds the knowledge base, by `WorkspaceMount.id`.
   *
   * A **name**, not a source. Mounts come from `WORKSPACE_ROOTS` and are fixed
   * at boot, and this setting cannot add one — so a vault is always somewhere
   * an agent could already have been pointed at, and choosing one here widens
   * nothing about what this container may read. Null is off, which is shipped.
   *
   * Refused at **save** when it names no configured mount, which is
   * `defaultAgentId`'s rule and its reason: refuse where the person is. What it
   * cannot do is stay refused, because the mounts are the one thing that can
   * change under a stored value — a compose edit that drops a slot leaves this
   * naming nothing, and a settings page that would not load until somebody
   * fixed a value they cannot see is worse than one that says the mount is
   * gone. So the reader degrades to a stated reason rather than throwing, and
   * the figures beside it go blank rather than to zero.
   */
  knowledgeBaseMountId: string | null;
  /**
   * A directory inside that mount, relative to its root. `""` is the root.
   *
   * A vault is usually not a whole mount — the mount is a documents folder and
   * the vault is one directory in it — and walking the parent would index every
   * unrelated markdown file beside it into the same graph, where an operator
   * would read the extra orphans as a fault in their vault.
   *
   * Stored as the normalized form (`normalizeSubpath`), so what the save door
   * refuses and what the walk resolves are the same string. Containment is
   * still proved at use time against the mount, twice, because a stored path is
   * not evidence about the filesystem it is read back into.
   */
  knowledgeBaseSubpath: string;
  /**
   * Let a nightly run write recurring failures into the configured vault.
   *
   * **Off by default, and this is the one setting in this file that authorises
   * an unattended write into a store this app does not own.** Everything else
   * here bounds what an agent does inside a checkout; this points one at the
   * operator's document store. The readout on `/dreaming` needs none of it —
   * that reads the same corpus, writes nothing, and is always available.
   *
   * The write is licensed rather than assumed: the vault's own `AGENTS.md`
   * forbids a session that has not read its `CLAUDE.md` from writing notes, and
   * the run this creates is pointed at the vault as its folder precisely so
   * that it is a session that can read it. Nothing enforces that it does —
   * a `PreToolUse` deny-on-`Write` hook is the only mechanism that would, and
   * this app does not have one, which is why the default is off.
   */
  dreamingEnabled: boolean;
  /**
   * Minutes past local midnight to run, in `dreamingTimeZone`.
   *
   * Deliberately not a cron string, matching `ScheduleSpec`: three shapes with
   * a zone on the row is what an operator can reason about, and the one this
   * feature needs is the daily one.
   */
  dreamingMinutes: number;
  /**
   * The zone the day boundary and the fire time are both read in.
   *
   * One setting for both on purpose. A feature whose unit is "a day" and whose
   * clock is a different day is one where the night of the 3rd writes about the
   * 2nd and nobody can tell which.
   */
  dreamingTimeZone: string;
  /**
   * How many separate days a failure must span before it is written down.
   *
   * 2 by default, which is a measurement rather than a taste: writing every
   * signature on first sight produces 1,177 notes over 23 days of this corpus,
   * of which 1,100 (93.5%) are about something that never recurred. Waiting for
   * a second day produces 77, all about something that happened twice.
   * Raising it trades latency for certainty; 1 turns the policy off and is
   * allowed because refusing to express a setting is worse than letting
   * somebody choose badly on purpose.
   */
  dreamingMinDays: number;
  /**
   * Ceiling in USD on the run one night may create. Never null.
   *
   * `schedules.ts:529` refuses to schedule a workflow whose instance budget
   * sets nothing, with a reason that applies here word for word: "every other
   * press of Run is bounded by a person being there to see what it cost and
   * decide whether to press it again; a schedule removes the person and keeps
   * the press." This is that bound, and there is no way to express its absence.
   */
  dreamingMaxCostUSD: number;
  /**
   * Signatures one night may hand to a run.
   *
   * A cap on the *prompt*, not on the corpus: the policy above produces a
   * median of 3.3 a night, but a first run against an unscanned corpus of 23
   * days selects 77 at once, and the vault's own conventions make each one two
   * file writes plus an index regeneration. A first night that tried all 77
   * would be a long, expensive run against somebody's live document store.
   */
  dreamingMaxPerNight: number;
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
  "You reported the task complete, but this run has budget left and ends when " +
  "it reaches a limit, not when you report it done. Do not start new features " +
  "and do not refactor working code for its own sake. Instead: re-read the " +
  "original task and check every part of it is met; run the tests and fix what " +
  "fails; look for edge cases, error handling and missing tests; and correct " +
  "any documentation your changes made wrong. If you find nothing worth doing, " +
  "say so and make no changes.";

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
    // Off by default: a relative guard on an install with no history would
    // be a guard with nothing to say, and one that spoke anyway would be
    // speaking from an anecdote.
    maxRunCostFactor: null,
    maxRunTokens: null,
    maxWeeklyFraction: null,
    maxSessionFraction: null,
    enforcement: "between-cycles",
    continueAfterDone: false,
  },
};

/**
 * What this build ships, and therefore the only thing "unset" can be compared
 * against.
 *
 * Exported because `saveSettings` is no longer the only reader: the settings
 * route answers with which keys an install has moved off these values, so its
 * page can open a fold over a setting that is not what was shipped rather than
 * hide one. That answer has to be computed from the same table the Save writes
 * against, or the page would fold on one definition of "default" and the blob
 * would be written against another.
 */
export const DEFAULTS: Settings = {
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
  readGuard: false,
  readGuardMaxTokens: null,
  contextPruning: false,
  contextPruningStrictness: "standard",
  contextPruningEngine: "legacy",
  contextPruningForkMinColdAge: 0,
  freshStartContextTokens: null,
  maxConcurrentRuns: 4,
  maxConcurrentAssists: 2,
  resolveVerifyTools: [],
  landVerifyCommand: "",
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
  knowledgeBaseMountId: null,
  knowledgeBaseSubpath: "",
  dreamingEnabled: false,
  // 03:04 rather than 03:00: every other unattended thing on a host fires on
  // the hour, and this one reads a corpus a retention sweep also walks.
  dreamingMinutes: 3 * 60 + 4,
  dreamingTimeZone: "UTC",
  dreamingMinDays: 2,
  dreamingMaxCostUSD: 2,
  dreamingMaxPerNight: 5,
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

/**
 * Persist the effective object as **only what differs from `DEFAULTS`**.
 *
 * `getSettings()` is `{...DEFAULTS, ...stored}` and the settings page PUTs the
 * whole *effective* object on Save, so storing it verbatim materialised all
 * thirty-three keys into the blob the first time anybody pressed the button —
 * and from that moment every `DEFAULT_*` in this file was dead for that install.
 * There is no versioning and no migration, and nothing anywhere surfaces the
 * divergence, so a shipped default and a running install disagree silently and
 * permanently.
 *
 * Measured, not reasoned. `8651bcd` raised `maxConcurrentRuns` from `null` to 4
 * at 20:28 on 2026-08-14, to bound exactly the failure that happened two minutes
 * later: sixteen concurrent runs met the provider's 5-hour wall inside a
 * 44-second span, every one of them with its first cycle amputated. The stored
 * row carried an explicit `"maxConcurrentRuns": null`, the spread put it back
 * over the 4, and the fix was never in force on the install it was written for.
 * The four prompt strings are the same trap one door over, which is why
 * `COMPLETION_NOTICE` and `SHARED_CHECKOUT_NOTICE` are generated in
 * `orchestrator.ts` instead of living here.
 *
 * The trade is real and it is the one being chosen deliberately: a value an
 * operator set *to today's default* becomes indistinguishable from one they
 * never set, so a later change to that default moves it. That is precisely what
 * makes a shipped number reach an existing install, the effective object is
 * identical either way until the default changes, and the alternative has now
 * cost this install twice. An operator who wants a number pinned against a
 * future default has no way to say so, and if that turns out to matter the place
 * to answer it is a stored marker, never a return to writing the whole blob.
 *
 * Deep rather than `!==`, because five keys hold an object or an array
 * (`weeklyAnchor`, `isolationCopyGlobs`, `isolationCopyGlobsByRepo`,
 * `chatDefaultGuards`, and the nested `budget` inside it) and reference
 * inequality would keep every one of them forever, which is the bug this fixes
 * for the keys that matter most.
 */
export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  const stored: Partial<Settings> = {};
  for (const key of SETTINGS_KEYS) {
    if (!sameValue(next[key], DEFAULTS[key])) {
      // The cast is the price of a per-key loop over a heterogeneous record:
      // `next[key]` and `stored[key]` are the same member of the same union at
      // every iteration, and TypeScript cannot carry that through the index.
      (stored as Record<string, unknown>)[key] = next[key];
    }
  }
  setJSON(KEY, stored);
  return next;
}

/**
 * Structural equality, for deciding whether a value is still the shipped one.
 *
 * `JSON.stringify` comparison would be shorter and wrong: it is key-order
 * sensitive, so a `chatDefaultGuards` that came back off the wire with its keys
 * in a different order than `DEFAULT_CHAT_GUARDS` declares them would read as a
 * change and be stored forever — the exact failure being fixed, arriving through
 * the fix.
 *
 * Exported so the settings route can ask the same question about one key that a
 * Save asks about all of them. A second definition beside it would be the usual
 * shape of this bug: the two would agree until the day one of them was made
 * order-sensitive again, and nothing would report the disagreement.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.hasOwn(b as object, k) &&
      sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
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
  return narrowGuards(s.chatDefaultGuards);
}

/**
 * The same narrowing, for a guard blob that came from somewhere else.
 *
 * Separate from `chatGuards` because a *proposal* freezes this set onto its own
 * row when it is written, so the card's values and the run's are one value —
 * and that row is JSON in SQLite exactly as the settings blob is JSON in a
 * settings row, with the same two ways of arriving unusable. Narrowing it here
 * rather than at the reader is what keeps the three rules above the only rules
 * there are; a second reader that trusted the shape would be a second answer to
 * "what may this run do", and the wrong one would be the permissive one.
 *
 * Every partial reading is narrower than what it is missing: an absent mode is
 * `plan`, an absent `isolate` is a checkout of its own, an absent terminus is
 * one work cycle. A snapshot this cannot read at all is not this function's
 * business — the caller falls back to the live set, which is the behaviour
 * that existed before any of them were frozen.
 */
export function narrowGuards(
  raw: Partial<RunGuards> | null | undefined,
): RunGuards {
  const g = raw ?? DEFAULT_CHAT_GUARDS;
  const permissionMode = (PERMISSION_MODES as readonly string[]).includes(
    String(g.permissionMode),
  )
    ? (g.permissionMode as PermissionMode)
    : "plan";

  const budget = normalizePolicy(g.budget ?? {});
  if (budget.maxIterations === null && budget.maxDurationMinutes === null) {
    budget.maxIterations = 1;
  }

  return { permissionMode, isolate: g.isolate !== false, budget };
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
