/**
 * Wire shapes shared between the API routes and the client.
 *
 * Declared here rather than imported from the server modules so that a client
 * component never transitively pulls `node:fs` into the browser bundle.
 */

export interface TokenCountsDTO {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface AggregateDTO {
  tokens: TokenCountsDTO;
  costUSD: number;
  /** Guard-only cost: unpriced models charged a fallback rate. Never rendered. */
  costGuardUSD: number;
  entryCount: number;
}

export interface WindowStateDTO {
  label: string;
  startsAt: number;
  endsAt: number;
  agg: AggregateDTO;
  tokens: number;
  costUSD: number;
  fraction: number | null;
  fractionMetric: "plan" | "cost" | "tokens" | null;
  /**
   * What Anthropic itself reports for this window, 0–1.
   *
   * Present whenever the provider answered, and then it *is* `fraction` — a
   * measured percentage outranks one derived from a typed ceiling. Null falls
   * back to the derived readings below.
   */
  planFraction: number | null;
  costFraction: number | null;
  tokenFraction: number | null;
  /**
   * What the budget guard compares. Equals `fraction` unless the window holds
   * a model with no known price, in which case it is higher — the dashboard
   * draws the gap so the guard's stricter view is visible rather than
   * surprising.
   */
  guardFraction: number | null;
  limit: number | null;
  limitMetric: "plan" | "tokens" | "cost" | null;
}

/** Mirror of `PlanWindow` in `windows.ts`. */
export interface PlanWindowDTO {
  utilization: number;
  resetsAt: number | null;
}

/** Mirror of `PlanUsage` in `windows.ts`. */
export interface PlanUsageDTO {
  session: PlanWindowDTO | null;
  weekly: PlanWindowDTO | null;
  scopedWeekly: Array<{ label: string; window: PlanWindowDTO }>;
  fetchedAt: number;
}

/**
 * Mirror of `AgentOrigin` in `windows.ts` — where the definition behind an
 * agent bucket lives, as far as this install can see.
 *
 * It annotates a transcript-derived bucket and never moves one: the rollup is
 * the CLI's own `attributionAgent` through the same `groupBy` as every other
 * column, so the rows still reconcile to the window total whatever this says.
 */
export type AgentOriginDTO =
  | "main"
  | "registry"
  | "ambient"
  | "both"
  | "unknown";

export interface SessionBlockDTO {
  startsAt: number;
  endsAt: number;
  lastActivityAt: number;
  isActive: boolean;
  agg: AggregateDTO;
  models: string[];
  projects: string[];
}

export interface SnapshotDTO {
  now: number;
  session: WindowStateDTO;
  weekly: WindowStateDTO;
  blocks: SessionBlockDTO[];
  burnTokensPerHour: number;
  burnCostPerHour: number;
  projectedExhaustionAt: number | null;
  byModel: Array<{ model: string; agg: AggregateDTO }>;
  byProject: Array<{ project: string; agg: AggregateDTO }>;
  byAgent: Array<{
    agent: string;
    agg: AggregateDTO;
    /** Null when nothing looked the names up — not the same as `unknown`. */
    origin: AgentOriginDTO | null;
  }>;
  bySkill: Array<{ skill: string; agg: AggregateDTO }>;
  byEffort: Array<{ effort: string; agg: AggregateDTO }>;
  totalCostUSD: number;
  /** The provider's own reading, when it answered. Never a cost. */
  plan: PlanUsageDTO | null;
}

export type PeriodGranularityDTO = "day" | "week" | "month";

/**
 * One calendar period's spend.
 *
 * Leaner than `WindowStateDTO` on purpose: three series ship on every poll of a
 * page that already re-reads the whole snapshot on every poll, and the
 * per-bucket token *breakdown* is the half of an `AggregateDTO` nothing on this
 * card renders.
 */
export interface PeriodBucketDTO {
  key: string;
  startsAt: number;
  /** Exclusive, and always the next bucket's `startsAt`. */
  endsAt: number;
  costUSD: number;
  tokens: number;
  entryCount: number;
  /** Share of the ceiling for a period this long. Null when none is configured. */
  fraction: number | null;
  fractionMetric: "cost" | "tokens" | null;
  guardFraction: number | null;
  limit: number | null;
  /** The bucket `now` falls in. It is still filling, so its share is partial. */
  isCurrent: boolean;
}

export interface PeriodSeriesDTO {
  granularity: PeriodGranularityDTO;
  /** IANA zone the boundaries were cut in — the browser's, echoed back. */
  timeZone: string;
  /**
   * Where a bucket's ceiling came from. `weekly` is the configured weekly
   * ceiling used as it stands; `prorated` is that ceiling spread evenly over a
   * period Anthropic publishes no allowance for, which the card has to say out
   * loud. Null when no weekly ceiling is set at all.
   */
  limitBasis: "weekly" | "prorated" | null;
  /**
   * Epoch ms before which this history may be incomplete — the transcript
   * retention horizon, when a bucket on screen starts before it. Null when
   * nothing shown is affected, which includes retention being switched off.
   */
  completeFrom: number | null;
  /** Newest first. Shorter than the granularity's span when history is. */
  buckets: PeriodBucketDTO[];
}

/**
 * One thing the boot found wrong with the environment this process was given.
 *
 * The client mirror of `ConfigProblem` in `configCheck.ts`, which imports
 * `node:fs` and so cannot be reached from a `"use client"` file.
 */
export interface ConfigProblemDTO {
  severity: "refuse" | "warn";
  variable: string;
  message: string;
}

/**
 * What confines a tool call below the uid it runs as.
 *
 * Four readings rather than a boolean, because two of them are the ways a
 * sandbox lies about itself and both must be sayable on the page: `empty` is a
 * policy that is switched on and names nothing, which runs every command
 * unwrapped, and `unknown` is a policy file that could not be read, which is not
 * evidence of absence. `none` is the stock install and is the honest word for
 * it. The client mirror of `sandbox.ts`, which imports `node:fs`.
 */
export type SandboxStateDTO = "none" | "on" | "empty" | "unknown";

/**
 * What a `sandbox` run event's matched text says happened.
 *
 * Here rather than beside the matcher because the log renders it and
 * `sandbox.ts` imports `node:fs`. Every one is a sandbox that is not working;
 * `sandbox.ts` says why a policy *denial* is not in the list.
 */
export type SandboxRefusalKindDTO =
  | "seccomp-unavailable"
  | "sandbox-unavailable"
  | "dependency-missing"
  | "sandbox-message";

export interface SandboxDTO {
  state: SandboxStateDTO;
  /** The whole sentence, in words an operator can check against the file. */
  detail: string;
  /**
   * Whether the CLI refuses to start rather than running unsandboxed. Null when
   * nothing asked for a sandbox, since there is then no such promise to report.
   */
  failIfUnavailable: boolean | null;
}

export interface UsageResponse {
  snapshot: SnapshotDTO;
  /**
   * Spend cut into calendar buckets, all three granularities at once so the
   * toggle switches without a refetch.
   *
   * A history, never a guard input: `evaluateBudget` is passed windows, and a
   * day and a month have no published allowance to guard against — see the
   * `limitBasis` note above.
   */
  periods: Record<PeriodGranularityDTO, PeriodSeriesDTO>;
  meta: {
    transcriptDir: string;
    fileCount: number;
    entryCount: number;
    unpricedModels: string[];
    scannedAt: number;
    /**
     * Paths the last scan could not read, capped — `readFailureCount` is the
     * whole set. Anything here means every cost, token and percentage on this
     * response is short by an unknown amount.
     */
    readFailures: { path: string; message: string }[];
    readFailureCount: number;
    /**
     * This process's own footprint, so the heap is readable without attaching a
     * debugger to a container that has usually already died by then.
     */
    memory: {
      cache: {
        /** Transcript files with a cached byte offset. */
        files: number;
        /** Parsed turns held across those files. */
        entries: number;
        /** The bound `entries` is kept at or below. */
        maxEntries: number;
        /**
         * Files dropped to stay under that bound since boot. Non-zero means the
         * history on disk no longer fits, and the excess is re-parsed from disk
         * on every scan — correct, and slower every time.
         */
        evictions: number;
      };
      heapUsedBytes: number;
      /** V8's own ceiling for this process, which it derives from system memory. */
      heapLimitBytes: number;
    };
    /**
     * Whether the window can show a percentage at all — true when the provider
     * answered, whatever is or is not configured.
     */
    hasSessionCeiling: boolean;
    hasWeeklyCeiling: boolean;
    /** Whether the provider's own reading was asked for at all. */
    planUsageFromApi: boolean;
    /**
     * New work is held across the install: nothing starts, nothing in flight is
     * touched. Said on the dashboard in words, because a held fleet and an idle
     * one look identical — the meters are the same and the queue simply never
     * moves.
     */
    newWorkPaused: boolean;
    /** Headroom reserved for surfaces this tool cannot observe (0–1). */
    reservedHeadroomFraction: number;
    /**
     * The ceilings as *typed in Settings*, before reserved headroom.
     *
     * `WindowState.limit` is the effective ceiling — `limitConfig()` has already
     * taken the reserve off it — so it is the wrong number to describe as the
     * one the user set. Carried separately rather than reconstructed by
     * dividing `limit` by `1 - reserve`: that reproduces $650 as
     * $650.0000000001, and it silently invents a ceiling whenever the reserve
     * is later applied somewhere else too.
     */
    configuredCeilings: {
      sessionCost: number | null;
      weeklyCost: number | null;
      sessionTokens: number | null;
      weeklyTokens: number | null;
    };
    /**
     * Manual 5-hour reset instant, when one is configured. Present so the
     * session card can say the window was anchored by hand rather than derived
     * — a meter that silently disagrees with the transcripts is worse than no
     * override at all.
     */
    sessionResetOverrideAt: number | null;
    /** Which Claude Code entrypoints the parsed transcripts came from. */
    entrypoints: string[];
    /** Whether sub-agent turns are in these totals — the by-agent table depends on it. */
    includeSidechains: boolean;
    /**
     * The subscription the scanned transcripts belong to, when Claude Code's
     * own state files can be read. All fields null means "plan unknown", which
     * is a normal state — never an error, and never a ceiling.
     */
    account: AccountProfileDTO;
    /**
     * What the boot made of this process's own configuration — a mount that is
     * not a directory, a `CLAUDE_HOME` with no transcripts under it, a variable
     * set to the empty string.
     *
     * Only ever warnings in practice: a refusal exits the process before it
     * serves, so nothing that reads this can be looking at one. It rides on the
     * usage payload because that is the page an operator is on when the figures
     * are zero, and "the mount is empty" is the answer to the question they are
     * about to ask. Computed once at boot, not per request.
     */
    configProblems: ConfigProblemDTO[];
  };
  /**
   * What runs have reported over their own telemetry inside the same 5-hour
   * window as `snapshot.session`. `null` when agent self-reporting is off or
   * nothing has reported — a normal state, not an error.
   *
   * A third reading on a page whose meters are transcript-derived, and kept
   * apart from them: it moves while a work cycle is still going, which neither
   * `runs.spent_usd` nor the guard can. Never add it to `snapshot` figures.
   */
  telemetry: TelemetryWindowDTO | null;
  /**
   * What this whole installation has spent inside the rolling window the
   * install-wide ceiling covers, and that ceiling.
   *
   * A **fourth** reading on this page and, like the third, never added to the
   * others: the meters above it are our price table over every transcript on the
   * machine, and this is the money *this app* recorded spending — one run row,
   * one block row and one chat row at a time — over a different span. Summing
   * the two would count the same work twice.
   *
   * `limitUSD` is null when no ceiling is configured, and the meter must be the
   * hatched indeterminate one rather than an empty 0% bar: an install whose
   * share of a limit is unknown and one that has spent nothing must not look
   * alike.
   */
  install: InstallSpendDTO;
}

/**
 * The install-wide ceiling and what has been spent against it.
 *
 * `spentUSD` is the measured floor — every figure a CLI itself reported — and
 * `spentGuardUSD` adds killed cycles' reconciled estimates and what telemetry
 * says the cycles in flight have cost so far. The same display-versus-guard
 * split a window, a run and a workflow instance already make, and drawn the same
 * way: solid fill to the measured figure, hatched band out to the guard's.
 */
export interface InstallSpendDTO {
  spentUSD: number;
  spentGuardUSD: number;
  limitUSD: number | null;
  /** The span the two figures cover. Rolling, not a calendar day. */
  windowHours: number;
}

/** One run's first-party total inside the window. */
export interface TelemetryRunDTO {
  runId: string;
  /** `null` only if the run row has gone — runs are not deleted, so in practice set. */
  status: RunDTO["status"] | null;
  requests: number;
  costUSD: number;
  tokens: number;
  lastAt: number;
}

export interface TelemetryWindowDTO {
  requests: number;
  costUSD: number;
  tokens: number;
  lastAt: number;
  runCount: number;
  workingRunCount: number;
  /** Heaviest first, and shorter than `runCount` when there were more. */
  runs: TelemetryRunDTO[];
}

/**
 * First-party per-request totals for one run, from Claude Code's own OTLP
 * export. Shown beside `spent_usd`, never merged into it: the two are
 * independent measurements and their disagreement is the useful part.
 */
export interface RunTelemetryDTO {
  requests: number;
  costUSD: number;
  tokens: number;
  firstAt: number | null;
  lastAt: number | null;
}

/**
 * Whether the container's own Claude Code has a credential, and whose.
 *
 * Next to `AccountProfileDTO` and not merged into it because they answer
 * different questions from different sources. That one reads the credential
 * file to name a *plan*, and reports `UNKNOWN_ACCOUNT` for every failure — it
 * cannot tell a missing file from an unparsable one, and it is not meant to.
 * This one asks the CLI who it would authenticate as, which is the question a
 * run ending on `Not logged in` actually raises.
 */
export interface ClaudeAuthDTO {
  loggedIn: boolean;
  /** `claude.ai` for a subscription, `none` when signed out. */
  method: string | null;
  email: string | null;
  organization: string | null;
  plan: string | null;
  /**
   * The variable an API key was found in. Non-null means that key, not the
   * subscription below it, is what a work cycle will bill against.
   */
  apiKeySource: string | null;
}

/** `GET /api/claude-auth`. */
export interface ClaudeAuthStateDTO {
  /** Null exactly when the CLI could not be asked; `error` then says why. */
  auth: ClaudeAuthDTO | null;
  error: string | null;
  /**
   * A sign-in that has printed its link and is waiting for the code.
   *
   * Reported so the flow survives a page reload: the child holding the PKCE
   * verifier outlives the tab that started it, and without this the operator
   * would be shown a fresh Sign in button while the code in their clipboard
   * still belonged to the old one.
   */
  pending: { url: string; startedAt: number } | null;
}

/** Names a plan. Carries no ceiling, no email, no account UUID. */
export interface AccountProfileDTO {
  subscriptionType: string | null;
  rateLimitTier: string | null;
  label: string | null;
  fingerprint: string | null;
  source: "credentials" | "profile" | null;
}

/** One top-level directory tree the agent may be pointed at. */
export interface WorkspaceMountDTO {
  id: string;
  label: string;
  path: string;
  /** False when the configured path is missing — a bad mount, not an empty one. */
  available: boolean;
  error: string | null;
  folderCount: number;
  /** True when the listing hit its per-mount cap and is incomplete. */
  truncated: boolean;
  /** Run currently working here or in anything under it. */
  busyRunId?: string | null;
  /** Parked run that will want this folder back. Does not block a new run. */
  parkedRunId?: string | null;
  /** Runs waiting on this folder. */
  queuedCount?: number;
}

export interface WorkspaceFolderDTO {
  mountId: string;
  /** Path relative to the mount root. */
  path: string;
  name: string;
  isGitRepo: boolean;
  /** Run currently working here, in a parent of it, or in a child of it. */
  busyRunId?: string | null;
  /** Parked run that will want this folder back. Does not block a new run. */
  parkedRunId?: string | null;
  queuedCount?: number;
}

export interface FoldersResponse {
  /** First mount's path. Predates multiple mounts. */
  root: string;
  mounts: WorkspaceMountDTO[];
  folders: WorkspaceFolderDTO[];
}

/**
 * Duplicated from `budget.ts` rather than imported, exactly as
 * `RunDTO["status"]` duplicates `RunStatus`: this file is the client-safe
 * mirror and must not pull a server module into the browser bundle.
 */
export type EnforcementModeDTO = "between-cycles" | "live" | "live-resume";

export interface BudgetPolicyDTO {
  maxWeeklyFraction: number | null;
  maxSessionFraction: number | null;
  maxRunCostUSD: number | null;
  maxRunTokens: number | null;
  /** null = no cap on work cycles. Legal only alongside maxDurationMinutes. */
  maxIterations: number | null;
  maxDurationMinutes: number | null;
  enforcement: EnforcementModeDTO;
  continueAfterDone: boolean;
  permissionMode?: string;
}

/**
 * One "start after that run" edge, as a run reports it.
 *
 * `satisfied` is computed on the server so that what counts as a settled
 * dependency has one definition — `edgeSatisfied` in `orchestrator.ts` — rather
 * than one there and a second one in every page that renders a waiting run.
 */
export interface RunDependencyDTO {
  /** The run this one is waiting for. */
  runId: string;
  edge: "on-success" | "on-finish";
  /** That run's status right now. */
  status: RunDTO["status"];
  /** Whether it has settled in a way that lets this run start. */
  satisfied: boolean;
  /**
   * Whether this run takes that one's branch over instead of cutting its own.
   * At most one dependency of a run can, and it is what `continues_run` on the
   * run itself resolves to.
   */
  continueBranch?: boolean;
}

/**
 * The last time a restart closed runs out, as the runs list reads it.
 *
 * On the wire because the alternative was one `console.warn` at boot: twenty-
 * five runs terminated, each needing an operator to pick it up by hand, into a
 * stream nobody is tailing — and afterwards a screen full of `failed` runs with
 * nothing in this app saying they died together and why. `closed` is what the
 * boot ended; `kept` is the parked runs it deliberately spared.
 */
export interface BootReconcileDTO {
  at: number;
  closed: number;
  kept: number;
}

export interface RunDTO {
  id: string;
  /** Absolute, canonicalised folder the operator picked. */
  folder: string;
  /** Mount the folder belongs to, or null if that mount is gone. */
  mountId?: string | null;
  mountLabel?: string | null;
  /** `folder` relative to its mount; "" means the mount root itself. */
  relPath?: string;
  prompt: string;
  model: string | null;
  /**
   * Duplicated from `RunStatus` in `orchestrator.ts` rather than imported, for
   * this file's stated rule: it is the client-safe mirror and must not pull a
   * server module into the browser bundle. No compiler compares the two — the
   * three route handlers that build a run payload return anonymous objects into
   * `NextResponse.json` — so a member added on one side and not the other
   * typechecks clean and surfaces only where a client indexes a `Record` keyed
   * on this union.
   */
  status:
    | "waiting"
    | "queued"
    | "running"
    | "paused"
    | "completed"
    | "needs-review"
    | "stopped"
    | "failed"
    | "blocked";
  budget: BudgetPolicyDTO;
  /**
   * What this run was told to start after. Present on every run; empty for the
   * ordinary one. A `waiting` run has at least one entry with `satisfied:
   * false`, and that is what the row says it is waiting for.
   */
  dependsOn?: RunDependencyDTO[];
  /** Cap on work cycles. **0 means no cap** — see the note in db.ts. */
  max_iterations: number;
  /** Work cycles that have *finished*. A cycle in flight is not counted here. */
  iterations: number;
  /**
   * The work cycle open right now, or null when no child is running. Read
   * through `fmtCycleInFlight`, which also refuses to trust it on a row that is
   * no longer running.
   */
  active_iteration?: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  stop_reason: string | null;
  exit_code: number | null;
  spent_usd: number;
  spent_tokens: number;
  session_id?: string | null;
  /** Where the agent ran. Differs from `folder` only for an isolated run. */
  work_dir?: string | null;
  isolation?: "none" | "worktree" | null;
  worktree_branch?: string | null;
  worktree_base?: string | null;
  /** Branch this run's work lands into. Null on rows created before it was recorded. */
  worktree_base_branch?: string | null;
  /**
   * The run whose branch this one carries on, or null for a branch of its own.
   * Its `worktree_base` is the chain's, so the diff above covers every link.
   */
  continues_run?: string | null;
  /** When this tool merged the branch into its target. Null means never. */
  landed_at?: number | null;
  landed_into?: string | null;
  landed_strategy?: string | null;
  /** Paused runs only: epoch ms at which the run next tries again. */
  resume_at?: number | null;
  paused_at?: number | null;
  pause_count?: number;
  /** How many times the agent said DONE and was sent back in anyway. */
  done_retriggers?: number;
  /**
   * Whether the last work cycle replied DONE. Separates a run that finished
   * from one that used up its cycle cap — both are `completed`, and they are
   * picked up with different prompts.
   */
  reported_done?: number;
  /**
   * What the agent said when it reported it could not finish, clipped at the
   * write. Present only while the row records the `needs-review` ending —
   * picking the run up clears it, because it describes an ending rather than
   * the run.
   */
  needs_review_reason?: string | null;
  /**
   * 1 when this run ended because the server went down under it, rather than
   * for any reason of its own. Cleared when it is picked up again, so it says
   * "still waiting to be picked up" rather than "was interrupted once".
   */
  restart_closed?: number;
  /**
   * When an operator set this run aside, or null. Both bulk pick-ups skip it
   * while it is set; the run's own Resume clears it. Says nothing about how the
   * run ended — a set-aside run keeps the status and stop reason it had.
   */
  set_aside_at?: number | null;
  /**
   * Spend reconciled from transcripts for work cycles killed before Claude Code
   * reported theirs. Shown beside `spent_usd`, never folded into it.
   */
  spent_usd_est?: number;
  spent_tokens_est?: number;
  /** Queued runs only: how many are ahead of it. 0 means next up. */
  queuePosition?: number;
  /**
   * The workflow run this one was halted with, or null for every other run —
   * one started outside a workflow, or a member of an instance still going.
   *
   * On the DTO because the run page cannot work it out: a halted member is an
   * ordinary `blocked` or `stopped` row, and the only difference is a join the
   * page has no route for. `reopenRun` refuses one, so this is what keeps the
   * page from offering a button whose whole answer is a refusal.
   */
  haltedWorkflow?: string | null;
  /**
   * The specialised agent this run was started with, or null for the ordinary
   * run. The run's own frozen copy, so it still names the agent it was given
   * after that agent has been renamed or deleted.
   */
  agent?: RunAgentDTO | null;
  /**
   * Which gate created this run: the form, an approved chat proposal, a press
   * of Run on a workflow, an orchestrator block's own decision, or a schedule
   * firing with nobody present. Null on runs created before it was recorded.
   */
  origin?: RunOriginDTO | null;
  /** The record that authorised it — a proposal, an instance, a schedule. */
  origin_ref?: string | null;
  /** When an operator last picked this run up again. Never rewrites `origin`. */
  reopened_at?: number | null;
}

/** Mirrors `RunOrigin` in `orchestrator.ts`; see the column note in `db.ts`. */
export type RunOriginDTO =
  | "form"
  | "chat"
  | "workflow"
  | "orchestrator-block"
  | "schedule";

/**
 * What a run records about the agent it was started as.
 *
 * The agent's own `prompt` is deliberately absent: it is the run's own system
 * prompt, nothing on the run page acts on it, and this payload is polled every
 * three seconds. The name and the description are what a reader needs — the
 * description because it is what the operator read when they chose, so it is
 * what explains the run they are looking at.
 */
export interface RunAgentDTO {
  name: string;
  description: string;
  /** Null means the session ran on the run's own model. */
  model: string | null;
}

/** Mirror of `AgentSpendRow` in `windows.ts`. */
export interface AgentSpendRowDTO {
  agent: string;
  origin: AgentOriginDTO;
  costUSD: number;
  costGuardUSD: number;
  tokens: number;
  entryCount: number;
}

/**
 * What one run's turns cost, split by who produced them.
 *
 * A **fifth** reading of a run's spend and never a correction to any of the
 * other four. It is our price table over the transcripts this run's session
 * wrote — the same source, the same dedupe key and the same cache weighting the
 * dashboard meters use, and the same one `spent_usd_est` already comes from —
 * scoped to one session id and one time range. `runs.spent_usd` stays a floor of
 * what the CLI itself measured, telemetry stays Claude Code's own per-request
 * figure, and no two of the three are ever added: they measure the same work by
 * different routes, so a sum double-counts it.
 *
 * Null on the wire when there is nothing to read — a run with no session id yet,
 * or an unreadable transcript directory. That is "no reading", which the card
 * renders as the hatched indeterminate meter; a run whose agents spent nothing
 * and a run nobody could measure must not look alike.
 */
export interface RunAgentSpendDTO {
  costUSD: number;
  costGuardUSD: number;
  tokens: number;
  entryCount: number;
  /** Everything outside `(main thread)` — a historical name, see `AgentSpend`. */
  delegatedCostUSD: number;
  delegatedCostGuardUSD: number;
  rows: AgentSpendRowDTO[];
  /** The instants the session was read between, so the card can say what it covers. */
  from: number;
  to: number;
  /**
   * True when Settings excludes sub-agent turns from the dashboard totals.
   *
   * This card counts them regardless — it exists to say what the work outside
   * the main thread cost, and a card that silently answered $0 because of a
   * setting about the *meters* would be the worst of both. Carried so the card
   * can say so. That setting keys on the transcript's own `isSidechain`, which
   * is a genuinely delegated turn and is a different question from which agent
   * name a turn carries — so it is untouched by the move to `--agent`.
   */
  excludedFromTotals: boolean;
}

/**
 * Long enough for a sentence-shaped template name, short enough that the picker
 * stays one line. Here rather than in `templates.ts` so the form can bound the
 * input without a client component importing a module that opens SQLite.
 */
export const MAX_TEMPLATE_NAME = 80;

/**
 * A saved task prompt and the guards to run it under.
 *
 * `permissionMode` is top-level here rather than folded into `budget` the way
 * `RunDTO` folds it: on a run that key is a historical record of what was used,
 * on a template it is a setting the operator is choosing again every time they
 * apply it, and the UI has to warn about it separately.
 */
export interface RunTemplateDTO {
  id: string;
  name: string;
  prompt: string;
  /** Null means the template does not name a folder — the form asks for one. */
  mountId: string | null;
  /** Path within the mount. `""` is the mount root, and is not null. */
  folder: string | null;
  isolate: boolean;
  permissionMode: string;
  /**
   * The saved agent a run from this template is started as, by id.
   *
   * An id rather than a copy, unlike `RunDTO.agent`: a template is applied again
   * and again, so it should follow the agent as the operator edits it. A form
   * that cannot find this id in the registry must say so rather than start
   * without one — the run door refuses it by name either way.
   */
  agentId: string | null;
  budget: BudgetPolicyDTO;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Agents: a saved role a run is started as                            */
/* ------------------------------------------------------------------ */

/** Bounded for the reason a template name is: it is picked out of a list. */
export const MAX_AGENT_NAME = 80;

/**
 * How long an agent's description may be.
 *
 * Not a form-tidiness bound. A registered agent's description is carried in the
 * session's context for the whole run — it is paid for on every request the run
 * makes, and an unbounded one is a cost multiplier with no ceiling on a run
 * whose spend guards are all denominated in dollars.
 */
export const MAX_AGENT_DESCRIPTION = 1_000;

/**
 * A saved agent: a role a run is started as.
 *
 * There is deliberately no tool list, no permission mode and no budget here, and
 * the absence is the design: what a run may do comes from its own guard set and
 * never from the role it takes. The reasoning is in `agents.ts` beside the
 * refusal that enforces it.
 */
export interface AgentDTO {
  id: string;
  name: string;
  description: string;
  prompt: string;
  /** Null means the session keeps whatever model the run already had. */
  model: string | null;
  /**
   * Whether this row can actually be attached to a spawn.
   *
   * False for a row whose description or prompt is empty — the CLI will not
   * register such a member, so a run started as it fails at the spawn. On the
   * DTO because nothing on the page can work it out: the row looks complete
   * either way.
   */
  usable: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * An agent definition Claude Code finds on disk that this app did not write.
 *
 * The operator's `~/.claude/agents/` is bind-mounted into the container and a
 * repository's own `.claude/agents/` is in an isolated run's worktree, so both
 * reach every child this app spawns and always have. They are left in play
 * rather than excluded — see `agents.ts` — which makes the saved registry a
 * *part* of the set rather than the whole of it, and this is what a surface
 * reads to say so where an agent is chosen.
 */
export interface AmbientAgentDTO {
  name: string;
  description: string | null;
  /** `user` is `~/.claude/agents`; `project` is a repository's own. */
  scope: "user" | "project";
  path: string;
}

/* ------------------------------------------------------------------ */
/* Workflows: a saved graph of run blocks                              */
/* ------------------------------------------------------------------ */

/** Bounded for the reason a template name is: it is picked out of a list. */
export const MAX_WORKFLOW_NAME = 80;

/**
 * How many blocks one workflow may hold.
 *
 * Every block becomes a run in a single synchronous pass, each claiming a
 * folder, so this bounds what one click can put on the machine at once.
 */
export const MAX_WORKFLOW_NODES = 25;

/**
 * How many runs one orchestrator block may start.
 *
 * Tighter than `MAX_WORKFLOW_NODES` on purpose, and the difference is who wrote
 * them: those blocks are typed by a person one at a time, where these are chosen
 * by a model and start with no approval between the decision and the spawn. The
 * per-block cap an operator sets is what actually bounds a graph; this is the
 * ceiling on what they may set.
 */
export const MAX_FAN_OUT = 10;

/**
 * How many passes one loop block may take.
 *
 * The ceiling on the cap an operator sets, exactly as `MAX_FAN_OUT` is: a loop
 * unrolls into one fresh run per pass, so this bounds what one press of Run can
 * put on the machine over the life of a block whose repetitions nobody watches.
 */
export const MAX_LOOP_PASSES = 20;

/**
 * What a block *is*.
 *
 * `run` is the original and the default: a fixed task, decided when the graph
 * was written. `orchestrator` is a short agent turn that decides, at the moment
 * the workflow reaches it, which runs to create next — and those runs start
 * without an approval step, because the approval happened when a person saved a
 * graph naming this block's folder, its guard set and its fan-out cap. `merge`
 * spawns no agent of its own: it lands the branches the blocks in front of it
 * left behind, through the same queue the Branches page uses, and its one
 * optional expense is paying a model to reconcile a conflict. `loop` repeats one
 * task until the agent reports it done, a pass fails, or one of its two caps is
 * reached — a fresh run per pass, each carrying on the previous pass's branch.
 */
export type WorkflowNodeKind = "run" | "orchestrator" | "merge" | "loop";

/** How a branch is put onto its target. `settings.landStrategy`'s vocabulary. */
export type MergeStrategyDTO = "merge" | "squash";

/**
 * One block of work in a workflow.
 *
 * There is deliberately no budget, permission mode, isolation choice or model
 * here. Those come from `templateId`, or from `settings.chatDefaultGuards` when
 * it is null — always from something a person wrote. A block holds the *work*.
 * That holds for an orchestrator block too: the runs it emits take their guards
 * from the same two places, and nothing it emits can name a third.
 */
export interface WorkflowNodeDTO {
  id: string;
  name: string;
  kind: WorkflowNodeKind;
  /** Null means the block runs under the untemplated guards in Settings. */
  templateId: string | null;
  mountId: string;
  /** Path within the mount. `""` is the mount root, and is a real answer. */
  folder: string;
  /**
   * A run block's task; an orchestrator block's brief for what to decide.
   */
  task: string;
  /**
   * Standing instructions replacing the template's prompt. For a run block,
   * this block's own prompt; for an orchestrator block, the prompt every run it
   * emits is started with.
   */
  promptOverride: string | null;
  /**
   * A saved agent this block's own child is started as, by id.
   *
   * On the *work* side of the block, beside the mount, the folder and the task,
   * and never on the guard side: an agent holds no tool list and no permission
   * mode, so what it changes is who the child *is* and never what the block may
   * do. It is the block's own rather than its template's — the reason is in
   * `WorkflowNode.agentId`.
   *
   * Null on a merge block always, and naming one there is refused rather than
   * dropped: that block spawns no child, so there is nothing for the agent to
   * be.
   */
  agentId: string | null;
  /**
   * How many runs an orchestrator block may start. Null on a run block, and
   * **never** null on an orchestrator one — a block that starts agents with no
   * approval and no ceiling is an unbounded number of billed agents from one
   * press of Run, so it is refused at save the way the `no_terminus` pair is.
   */
  fanOut: number | null;
  /**
   * How a merge block lands each branch. Null on every other kind, and never
   * null on a merge one: it is recorded on the graph rather than read from
   * `settings.landStrategy` at Run, so a saved workflow cannot change what it
   * does to a repository because a setting moved underneath it.
   */
  mergeStrategy: MergeStrategyDTO | null;
  /**
   * Whether a merge block may pay a model to resolve a conflict. False on every
   * other kind. On the graph rather than in settings for `merge_queue`'s
   * reason: automatic spend has to be authorised where it can be read back, and
   * saving the workflow with this on *is* that authorisation.
   */
  mergeAutoResolve: boolean;
  /**
   * How many passes a loop block may take. Null on every other kind, and
   * **never** null on a loop one.
   *
   * The `maxIterations`/`maxDurationMinutes` argument applied one level up: a
   * loop manufactures its own next unit of work, so it needs a quantity that
   * moves one way and keeps moving, and this is the only one it has. Refused at
   * save rather than at Run.
   */
  maxPasses: number | null;
  /**
   * Everything this loop's passes may spend together, or null for no cap.
   *
   * Nullable because the pass cap is already the terminus. It is a *bound on
   * repetition*, not a guard on an agent — it can only end the loop earlier, it
   * never reaches a run's own budget, a permission mode or an isolation choice,
   * and it never widens the workflow-wide limit, which still halts the whole
   * instance at every member's cycle boundary.
   */
  maxLoopCostUSD: number | null;
}

export interface WorkflowEdgeDTO {
  /** The block that must settle first. */
  from: string;
  /** The block that starts once it has. */
  to: string;
  edge: "on-success" | "on-finish";
  /** Whether `to` carries on `from`'s branch instead of cutting its own. */
  continueBranch: boolean;
}

/**
 * Limits on a whole press of Run, as against one block's.
 *
 * Every field nullable and `null` means off, this app's standing rule for a
 * budget field. There is deliberately no cycle or time limit here: an instance
 * is a finite graph whose members each carry their own terminus, so it needs no
 * monotone quantity of its own to be sure of ending.
 */
export interface InstanceBudgetDTO {
  maxInstanceCostUSD: number | null;
  /** 0–1. The form asks for a percentage. */
  maxSessionFraction: number | null;
  maxWeeklyFraction: number | null;
}

/**
 * How often a workflow starts itself.
 *
 * Three plain choices rather than a cron expression, so that the page can render
 * the rule back in words *and* state the instant it next means — an operator who
 * cannot verify a schedule at a glance will not leave an unattended agent behind
 * it. The mirror of `ScheduleSpec` in `schedules.ts`.
 */
export type ScheduleSpecDTO =
  | { kind: "everyHours"; hours: number; anchorAt: number }
  | { kind: "daily"; minutes: number }
  | { kind: "weekly"; weekday: number; minutes: number };

/** What the last fire decision came to. See `ScheduleOutcomeCode`. */
export type ScheduleOutcomeCodeDTO =
  | "started"
  | "overlap"
  | "unbudgeted"
  | "refused"
  | "missed";

/**
 * A workflow's schedule, and the evidence an operator needs to trust it.
 *
 * `nextFireAt` is an absolute instant rather than "in about an hour", and
 * `lastCode`/`lastReason`/`streak` are what it last did — a schedule whose
 * skips are invisible is one that looks like it is working while it does
 * nothing.
 */
export interface WorkflowScheduleDTO {
  spec: ScheduleSpecDTO;
  /** The IANA zone the wall-clock times in `spec` are read in. */
  timeZone: string;
  paused: boolean;
  /** The recurrence in words, zone included. */
  description: string;
  /** Null when it cannot be worked out — never a plausible stand-in instant. */
  nextFireAt: number | null;
  lastCode: ScheduleOutcomeCodeDTO | null;
  lastReason: string | null;
  lastAt: number | null;
  /** The occurrence `lastCode` is about, which is not when it was recorded. */
  lastFireAt: number | null;
  lastInstanceId: string | null;
  /** Consecutive outcomes with the same code, collapsed into one state. */
  streak: number;
  streakSince: number | null;
  /** Why it cannot fire as things stand — a cleared budget — or null. */
  refusal: string | null;
}

export interface WorkflowDTO {
  id: string;
  name: string;
  nodes: WorkflowNodeDTO[];
  edges: WorkflowEdgeDTO[];
  instanceBudget: InstanceBudgetDTO;
  createdAt: number;
  updatedAt: number;
  /** Runs from this workflow that have not finished. Empty on most reads. */
  liveRunCount?: number;
  /** When it was last started, or null if it never has been. */
  lastRunAt?: number | null;
  /** Null when nothing starts this workflow but a person. */
  schedule?: WorkflowScheduleDTO | null;
}

/**
 * One block of an instance, and what became of its run.
 *
 * `run` is null when the run row has gone — the mapping is a historical record
 * and says so, rather than dropping the block out of the instance.
 *
 * `emittedBy` names the orchestrator block that created this run, for a row that
 * was not in the saved graph at all. Null for a block a person wrote.
 */
export interface WorkflowInstanceNodeDTO {
  nodeId: string;
  nodeName: string;
  position: number;
  runId: string;
  run: {
    status: RunDTO["status"];
    stopReason: string | null;
    iterations: number;
    maxIterations: number;
    /** The cycle open right now. See `fmtCycleInFlight` — never added to the count. */
    activeIteration: number | null;
    startedAt: number | null;
    /** Null for a mount that has since been removed; `relPath` is then absolute. */
    mountLabel: string | null;
    relPath: string;
    spentUSD: number;
  } | null;
  /** Node ids this block was told to start after, from the instance's graph. */
  waitsFor: string[];
  /**
   * The orchestrator block that decided on this run, or null for a block of the
   * saved graph. Nobody approved the runs this names — see the orchestrator
   * block invariant — so the page lists them apart from the graph's own.
   */
  emittedBy: string | null;
}

/**
 * One block of an instance that never became a run.
 *
 * An orchestrator turn — with its own spend, which is never a run's — a merge
 * block, a loop block, which is not a run either but creates one per pass, or a
 * block that was never created because the block in front of it had nothing to
 * hand it. All four are here for the same reason: a block that simply disappears
 * from the instance is indistinguishable from one still waiting.
 */
export interface WorkflowInstanceBlockDTO {
  nodeId: string;
  nodeName: string;
  position: number;
  kind: WorkflowNodeKind;
  status: "waiting" | "thinking" | "looping" | "emitted" | "failed" | "blocked";
  startedAt: number | null;
  finishedAt: number | null;
  /** The turn's own cost. Never added to a run's spend or to a meter. */
  costUSD: number;
  /**
   * How many runs this block started — passes, for a loop block. 0 is a real
   * answer, not "not yet".
   */
  emitted: number;
  /**
   * Whether the turn ever called `emit_runs`. The two ways a block starts
   * nothing read alike without it: one decided there was nothing worth doing,
   * the other never reached a decision.
   */
  decided: boolean;
  /**
   * What the turn replied, verbatim — the block's own account of what it
   * emitted and what it left out. Null on a turn that failed or said nothing.
   */
  reply: string | null;
  /**
   * What this app recorded about the turn: an `emit_runs` it refused, a tool
   * call the CLI declined, an instance guard it could not read. Separate from
   * `reply` because one is the model's voice and one is ours, and separate from
   * `error` because neither is the turn failing.
   */
  notes: string[];
  /** Branches a merge block put onto their target. 0 on every other kind. */
  branchesLanded: number;
  /**
   * Branches a merge block could not land — including the ones it never
   * attempted because the checkout stopped the whole repository. Counted apart
   * from `branchesLanded` rather than subtracted from it, because a block that
   * landed three of four is not the same fact as one that landed three of three.
   */
  branchesFailed: number;
  error: string | null;
  waitsFor: string[];
}

export interface WorkflowInstanceDTO {
  id: string;
  workflowId: string;
  /** The workflow's name when Run was pressed; it may have been renamed since. */
  workflowName: string;
  createdAt: number;
  /**
   * Four of the six are derived from the members rather than written, because
   * nothing would run the pass that wrote them: a signalled child takes seconds
   * to die, and a graph whose last member settles has nobody left to close it
   * out. `stopping` and `stopped` are one halted row either side of its last
   * live member; `started`, `finished` and `blocked` are one unhalted row —
   * still working, reached its end, or had part of it written off because
   * something in front of it satisfied nothing.
   *
   * `finished` is about the graph, not about the work: how a member ended is on
   * the member's own row.
   */
  status:
    | "started"
    | "finished"
    | "blocked"
    | "failed"
    | "stopping"
    | "stopped";
  error: string | null;
  /** When the halt closed the door — not when the last child died. */
  stoppedAt: number | null;
  /**
   * What halted it. The way a member can end that is *not* here — stopped on
   * its own run page — is not an instance-level event and reads null.
   *
   * `fleet` is an operator's stop that was not aimed at this workflow: one
   * install-wide stop took every run in flight, this one among them. Kept apart
   * from `operator` because afterwards that is the only difference an operator
   * can still see.
   */
  stopCause: "operator" | "guard" | "fleet" | null;
  /** A guard's verdict in full. Null for an operator's stop, which needs none. */
  stopReason: string | null;
  /** Members that have not finished. Non-zero for as long as `stopping` is. */
  liveRunCount: number;
  /**
   * Members that never ran, because something in front of them did not satisfy
   * its edge. What `blocked` is counted from, and what says how much of the
   * graph is missing rather than merely that some of it is.
   */
  blockedCount: number;
  /** The limits it was started under — a copy, not the live workflow's. */
  instanceBudget: InstanceBudgetDTO;
  /**
   * What its blocks have spent together.
   *
   * Two figures, never one. `spentUSD` is the sum of what each block's own CLI
   * measured and is a **floor** — a cycle in flight has reported nothing and
   * contributes zero for its whole duration. `spentGuardUSD` is what the guard
   * acts on: that, plus reconciled estimates for killed cycles, plus what
   * telemetry says the cycles in flight have cost so far. Neither is ever added
   * to a dashboard meter or to `runs.spent_usd`. Both include what this
   * instance's orchestrator blocks spent deciding, which is measured the same
   * way a run's is and belongs to the same press of Run.
   */
  spentUSD: number;
  spentGuardUSD: number;
  nodes: WorkflowInstanceNodeDTO[];
  /** Blocks that are not runs: orchestrator turns, and blocks never created. */
  blocks: WorkflowInstanceBlockDTO[];
}

export interface RunEventDTO {
  id?: number;
  runId: string;
  ts: number;
  kind:
    | "status"
    | "log"
    /** The main thread's own words. Never a delegated turn's — see `subagent`. */
    | "assistant"
    /**
     * What a sub-agent said, forwarded by `--forward-subagent-text`.
     *
     * Its own kind rather than an `assistant` event with a flag on it, because
     * three readers must not be able to disagree about which voice a line is:
     * `cycleOutputs` takes the last `assistant` text as the cycle's report, the
     * log sets the two differently, and the orchestrator's `DONE` test runs
     * against the main thread's text alone.
     */
    | "subagent"
    | "tool"
    /**
     * A tool call that came back an error, named with the command it failed on.
     *
     * Its own kind rather than a flag on `tool` for `subagent`'s reason: a call
     * and its outcome are two statements, the log sets them differently, and a
     * failure filed as a call is a row an operator reads as an attempt that
     * went fine. Errors only — a successful result is not recorded at all.
     */
    | "tool_error"
    /**
     * A tool call that failed for a sandbox reason, carrying the words that
     * said so.
     *
     * Its own kind rather than a flag on `tool_error`, and emitted *beside* one
     * rather than instead of it, because the two answer different questions and
     * an operator asks the second one about a whole run: `kind = 'sandbox'` is
     * "did the policy refuse anything here", where the failure itself stays
     * where every other failed call is. It is also the one class of tool failure
     * that reaches stdout, for the reason a tripped guard does — a fleet whose
     * allowlist is too narrow fails inside tool calls nobody is reading.
     */
    | "sandbox"
    | "iteration"
    | "budget"
    | "result"
    | "handoff"
    | "land"
    | "review"
    | "error"
    | "replay-complete";
  payload: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Reviewing and landing a run's work                                  */
/* ------------------------------------------------------------------ */

export type DiffFileStatusDTO =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "changed";

export interface DiffFileDTO {
  path: string;
  oldPath: string | null;
  status: DiffFileStatusDTO;
  /** Null for a binary file — git reports no line counts for one. */
  added: number | null;
  deleted: number | null;
  binary: boolean;
  /** Null when the patch was withheld to stay inside the size budget. */
  patch: string | null;
  patchTruncated: boolean;
}

export interface RunDiffDTO {
  /** `range` is exact; `worktree` includes the operator's own edits. */
  kind: "range" | "worktree" | "none";
  reason: string | null;
  base: string | null;
  branch: string | null;
  files: DiffFileDTO[];
  filesChanged: number;
  added: number;
  deleted: number;
  omittedPatches: number;
  uncommitted: string[];
  caveat: string | null;
}

/**
 * One billed Claude invocation about a run, outside its work cycles: a review
 * of what it changed, or a resolution of a merge conflict on its branch.
 */
export interface RunReviewDTO {
  id: string;
  kind: "review" | "resolve";
  createdAt: number;
  finishedAt: number | null;
  status: "running" | "completed" | "failed";
  model: string | null;
  /** Never added to `RunDTO.spent_usd` — a review is not a work cycle. */
  costUSD: number;
  tokens: number;
  text: string | null;
  error: string | null;
  diffFiles: number;
  diffShown: number;
  truncated: boolean;
  /** The files a resolution was handed. Empty for a review. */
  paths: string[];
  /**
   * What a completed resolution changed on the branch, against the branch as it
   * stood before the merge. Null while it is running, when it failed, and for a
   * review — and for resolutions made before this was recorded.
   */
  changed: ResolutionChangeDTO | null;
}

export interface ResolutionChangeDTO {
  commit: string;
  files: DiffFileDTO[];
  omittedPatches: number;
}

/** One `<<<<<<< … >>>>>>>` block, as the merge would leave it. */
export interface ConflictRegionDTO {
  text: string;
  truncated: boolean;
}

export interface ConflictFileDTO {
  path: string;
  /** git's own name for the conflict — `content`, `modify/delete`, … */
  type: string | null;
  message: string | null;
  regions: ConflictRegionDTO[];
  regionsOmitted: number;
  /** False when the merged content was not read, so `regions` says nothing. */
  regionsRead: boolean;
}

export type MergePreviewDTO =
  | { outcome: "already-merged" }
  | { outcome: "fast-forward" }
  | { outcome: "clean" }
  | { outcome: "conflict"; files: ConflictFileDTO[] }
  | { outcome: "unknown"; reason: string };

/** One changed, uncommitted path in a run's own checkout. */
export interface PendingChangeDTO {
  path: string;
  origPath: string | null;
  /** git's two status letters — `??` untracked, `" M"` edited, `"A "` staged. */
  code: string;
}

export interface PendingWorkDTO {
  path: string;
  /** Every changed path, including the ones `files` leaves out. */
  count: number;
  files: PendingChangeDTO[];
  /** False when `git status` failed, so `files` says nothing about this checkout. */
  readable: boolean;
  /** The run's task as a commit subject, offered as the default. */
  suggestedMessage: string;
}

export interface LandStateDTO {
  runId: string;
  runStatus: RunDTO["status"];
  branch: string;
  target: string | null;
  /** True when the target was deduced from the base commit, not recorded. */
  targetInferred: boolean;
  branchExists: boolean;
  ahead: number;
  behind: number;
  merged: boolean;
  /** Landed by this tool and unchanged since — how a squash reads as done. */
  landedUnchanged: boolean;
  preview: MergePreviewDTO;
  checkout: {
    path: string;
    headBranch: string | null;
    dirty: boolean;
    readable: boolean;
  } | null;
  /** Uncommitted work in the run's own checkout. Null when there is none to see. */
  pending: PendingWorkDTO | null;
  /** Why landing is refused right now. Null means it is offered. */
  blocked: string | null;
  landedAt: number | null;
  landedInto: string | null;
  landedStrategy: string | null;
}

/** One branch waiting to be landed, or already dealt with. */
export interface MergeQueueItemDTO {
  id: string;
  runId: string;
  branch: string | null;
  target: string | null;
  /**
   * The repository this branch belongs to.
   *
   * On the wire because the queue is drained one worker per repository, so what
   * a row is waiting behind is the unfinished rows *in its own* repository —
   * counting the rest would tell an operator their branch is sixth in line when
   * it is next.
   */
  repo: string | null;
  position: number;
  status:
    | "queued"
    | "landing"
    | "resolving"
    | "landed"
    | "failed"
    | "skipped"
    | "cancelled";
  strategy: string;
  autoResolve: boolean;
  message: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** What its conflict resolution cost. Never added to the run's spend. */
  resolveCostUSD: number;
}

/** One press of Land, and every branch it queued. */
export interface MergeQueueBatchDTO {
  batchId: string;
  createdAt: number;
  items: MergeQueueItemDTO[];
}

export interface MergeQueueDTO {
  /**
   * True while the worker is between or inside merges.
   *
   * It is the worker's own flag and says nothing about which batch is in flight
   * — which is why `batches` carries every outstanding one rather than the
   * newest: the row being worked is always one of these, so the distinction has
   * nothing left to hide.
   */
  working: boolean;
  /**
   * Every batch with something still to do, oldest first, then the last one
   * that finished. Drain order: what is at the top is what lands next.
   */
  batches: MergeQueueBatchDTO[];
  /**
   * How many finished batches are *not* in `batches` — what the closed history
   * disclosure is labelled with. Counted over every earlier batch rather than
   * over the ones read, so a history that stops at its own cap still says how
   * much it stopped short of.
   */
  historyCount: number;
  /**
   * Those earlier batches, newest first, and only when they were asked for.
   *
   * `null` is "not read yet" and `[]` is "there are none" — the card says
   * different things for the two, and collapsing them would make a queue whose
   * history had not loaded read as an install that has only ever pressed Land
   * once.
   */
  history: MergeQueueBatchDTO[] | null;
}

export interface BranchSummaryDTO {
  runId: string;
  runStatus: RunDTO["status"];
  branch: string;
  target: string | null;
  repoRoot: string;
  repoLabel: string;
  createdAt: number;
  ahead: number;
  merged: boolean;
  landedUnchanged: boolean;
  /**
   * Uncommitted paths in the checkout holding this branch. Null when nothing
   * holds it, its status was unreadable, or the probe cap was reached — never
   * a claim that it is clean.
   */
  uncommitted: number | null;
  exists: boolean;
  /** The producing run can still commit to it. */
  active: boolean;
  landedAt: number | null;
  prompt: string;
}

export interface DirtySlotDTO {
  /** Directory name inside the store — what the operator has to go and find. */
  name: string;
  /** Uncommitted paths in it, or null when its status could not be read. */
  uncommitted: number | null;
}

export interface CheckoutStoreDTO {
  repoRoot: string;
  repoLabel: string;
  store: string;
  ceiling: number;
  /** Slots a queued, running or paused run holds. */
  heldByRuns: number;
  /** Existing checkouts nothing holds that cannot be reused, lowest slot first. */
  dirty: DirtySlotDTO[];
  /** Slot numbers still allocatable, or null when the probe cap stopped the walk. */
  free: number | null;
}

/**
 * What one repository cost over a span.
 *
 * A rollup of `runs.spent_usd` and nothing else — reporting, never a guard, and
 * never summed with the transcript-derived meters or with telemetry: those three
 * describe overlapping work, so any sum double-counts.
 */
export interface RepoSpendRowDTO {
  key: string;
  label: string;
  /** False for the one bucket holding runs that were not in a repository. */
  isRepository: boolean;
  runCount: number;
  /**
   * A **floor**. A cycle in flight has emitted no `result` and contributes
   * nothing for its whole duration, so this only ever understates.
   */
  spentUSD: number;
  /**
   * Killed cycles reconciled from transcripts — carried beside the measured
   * figure and never inside it, the display-versus-guard split this codebase
   * makes everywhere else.
   */
  spentEstUSD: number;
  spentTokens: number;
  spentEstTokens: number;
}

export interface RepoSpendDTO {
  /** The span, in days, as the route resolved it. */
  days: number;
  since: number;
  until: number;
  rows: RepoSpendRowDTO[];
  /** The same figures over every row, so the columns can be checked against it. */
  totals: Omit<RepoSpendRowDTO, "key" | "label" | "isRepository">;
}

/** What the install is doing, and whether new work is held. */
export interface FleetStateDTO {
  /**
   * New work is held: nothing starts, nothing already started is touched.
   *
   * On the dashboard in words, because a held fleet and a quiet one look
   * identical — the meters read the same, the runs list is the same length, and
   * the only difference is that the queue never moves.
   */
  newWorkPaused: boolean;
  /** Runs not finished, by status. Every key present, including zeroes. */
  counts: Record<string, number>;
  /** Workflow instances a stop would still act on. */
  startedInstances: number;
}

/** What one install-wide stop did. */
export interface FleetStopReportDTO {
  signalled: string[];
  cancelled: string[];
  blocked: string[];
  untouched: string[];
  instances: Array<{ workflowName: string; acted: boolean; note: string | null }>;
}

/** What one bulk pick-up did, per run. */
export interface FleetReopenReportDTO {
  reopened: string[];
  refused: Array<{ id: string; reason: string }>;
}

/** One repository holding branches, for the filter. */
export interface BranchRepoDTO {
  repoRoot: string;
  repoLabel: string;
  branches: number;
}

export interface BranchInventoryDTO {
  branches: BranchSummaryDTO[];
  /**
   * Branches matching the filter that this page does not show. Counted over
   * every branch-bearing run, not over a window of the newest ones — a count
   * that is itself truncated cannot say a branch has fallen out of reach.
   */
  notShown: number;
  /** Branches matching the filter, in total. */
  total: number;
  /** Where this page starts in that list. */
  offset: number;
  /** The page size actually applied, after the per-request cap. */
  limit: number;
  /** The repository filter in force, or null for every repository. */
  repo: string | null;
  /** Every repository holding a branch, whatever the filter is set to. */
  repos: BranchRepoDTO[];
  /**
   * Checkout-slot pressure for the repositories on this page. An isolated run on
   * a repository with no slot left is refused rather than moved into the
   * operator's own checkout, so this is the reading that says a refusal is
   * coming.
   */
  checkouts: CheckoutStoreDTO[];
  /** `settings.landStrategy`, so the queue form can default to it. */
  defaultStrategy: "merge" | "squash";
}

export interface RateLimitEntryDTO {
  type: string;
  group_type: string;
  models: string[] | null;
  limits: Array<{ type: string; value: number }>;
}

export interface AccountResponse {
  configured: boolean;
  reason?: string;
  error?: string;
  rateLimits?: RateLimitEntryDTO[];
  cost?: { last30dUSD: number; daily: Array<{ date: string; usd: number }> };
  usage?: { buckets: Array<{ starting_at: string; results: Array<Record<string, unknown>> }> };
}

export interface SettingsDTO {
  sessionCostLimit: number | null;
  weeklyCostLimit: number | null;
  sessionTokenLimit: number | null;
  weeklyTokenLimit: number | null;
  weeklyAnchor: { weekday: number; hourUTC: number } | null;
  /** Epoch ms of a provider-side 5-hour reset the transcripts cannot show. */
  sessionResetOverrideAt: number | null;
  reservedHeadroomFraction: number | null;
  /** Read the account's own utilisation from Anthropic rather than deriving it. */
  planUsageFromApi: boolean;
  defaultPermissionMode: string;
  defaultModel: string | null;
  /**
   * The saved agent the new-run form starts on. An id, never a definition, and
   * it carries no capability — see `settings.defaultAgentId`.
   */
  defaultAgentId: string | null;
  continuationPrompt: string;
  includeSidechains: boolean;
  /** Put a delegated turn's own words in the run log. */
  forwardSubAgentText: boolean;
  /** Work cycles only. Null means no limit. */
  maxConcurrentRuns: number | null;
  /**
   * Every `claude` child that is not a work cycle — a review, a conflict
   * resolution, a chat turn, a workflow block's deciding turn. Null means no
   * limit.
   */
  maxConcurrentAssists: number | null;
  isolationCopyGlobs: string[];
  /** Folders whose seeding list replaces the one above. */
  isolationCopyGlobsByRepo: Record<string, string[]>;
  /**
   * `--allowedTools` patterns a conflict resolution may use to check its merge.
   * Empty means none, which is what it had before this existed.
   */
  resolveVerifyTools: string[];
  isolationPreamble: string;
  /** What a run is told when it picks up the branch the run before it had. */
  continuedWorkPrompt: string;
  telemetryForRuns: boolean;
  donePushbackPrompt: string;
  liveGuardIntervalSeconds: number;
  /** How long a work cycle may print nothing before it is ended. Never null. */
  maxCycleSilenceMinutes: number;
  resumeGraceHours: number;
  /** How an isolated run's branch is brought into the branch it started from. */
  landStrategy: "merge" | "squash";
  killProcessGroup: boolean;
  /** Hard ceiling on one orchestrator-chat turn. Null means no cap. */
  chatTurnBudgetUSD: number | null;
  /** How long a settled run's event log is kept. Null keeps it for ever. */
  eventRetentionDays: number | null;
  /** How long an idle isolated checkout is kept. Null keeps it for ever. */
  checkoutRetentionDays: number | null;
  /** How long a session transcript is kept. Null keeps it for ever. */
  transcriptRetentionDays: number | null;
  /**
   * Hard ceiling on what this whole install may spend in a rolling 24 hours,
   * across every run, workflow block and chat turn. Null means no cap, which is
   * the shipped default — every other limit here bounds one spender.
   */
  installDailyCostLimitUSD: number | null;
  /** What a chat proposal runs under when it names no template. */
  chatDefaultGuards: RunGuardsDTO;
}

/**
 * What each append-only store holds right now.
 *
 * A Claude Code plugin found in a workspace mount.
 *
 * Its own payload rather than a block on `SettingsDTO`, and its own row in the
 * database rather than a key of `Settings`, for one reason: the settings form
 * sends the whole object on Save, so a plugin switched on in one tab would be
 * switched back off by an unrelated save from a tab opened before it. That is a
 * nuisance for a preference and the wrong failure entirely for the list
 * deciding what code every unattended agent loads — the same reasoning that
 * keeps `newWorkPaused` out of the blob.
 */
export interface PluginDTO {
  /** Canonical absolute path as the server sees it, and the toggle's key. */
  path: string;
  /** Path relative to its mount root, which is what a person recognises. */
  relPath: string;
  mountId: string;
  mountLabel: string;
  name: string;
  version: string | null;
  description: string | null;
  /**
   * What the plugin ships — `hooks`, `skills`, `agents`, `commands`, `mcp`.
   *
   * Shown because the kinds differ in what switching one on costs. Skills,
   * agents and MCP servers put definitions into every session's context; hooks
   * and commands do not.
   */
  components: string[];
  enabled: boolean;
}

export interface PluginsReportDTO {
  plugins: PluginDTO[];
  /**
   * Malformed manifests, unavailable mounts, and enabled plugins that have
   * stopped resolving. Carried beside the list rather than dropped, because
   * every entry here is a plugin that is *absent* from it — and a list that
   * silently omits them cannot explain why what an operator is looking for is
   * not there.
   */
  problems: string[];
}

/**
 * Its own payload rather than a block on `SettingsDTO` because the two answer
 * different questions — the settings are the horizons, this is what is on disk
 * inside them — and because measuring it walks directories, which a form's own
 * read must not.
 */
export interface StorageReportDTO {
  database: {
    path: string;
    bytes: number;
    /** The write-ahead log and its index, which are the same store. */
    walBytes: number;
    runEvents: number;
    telemetryRows: number;
  };
  /** One entry per mount's `.uf-worktrees`. */
  checkouts: Array<{
    mountId: string;
    label: string;
    path: string;
    count: number;
    bytes: number;
    /** The walk hit its budget: `bytes` is a floor, never a total. */
    partial: boolean;
  }>;
  transcripts: {
    path: string;
    files: number;
    bytes: number;
    partial: boolean;
  };
  lastSweep: {
    at: number;
    events: number;
    telemetry: number;
    checkouts: number;
    transcripts: number;
    transcriptBytes: number;
  } | null;
}

/** What an agent may do, as against what it is asked to do. */
export interface RunGuardsDTO {
  permissionMode: string;
  isolate: boolean;
  budget: BudgetPolicyDTO;
}

/* ------------------------------------------------------------------ */
/* Orchestrator chat                                                   */
/* ------------------------------------------------------------------ */

export interface ChatMessageDTO {
  id: string;
  ts: number;
  role: "user" | "assistant" | "system";
  text: string;
}

/**
 * One block of a workflow the chat proposed, as the approval card reads it.
 *
 * Guard-shaped facts only. The graph itself is on the row and the canvas will
 * draw it after approval; what a card has to carry is what a person is
 * agreeing to — where each block runs, what it may do, how many agents a
 * deciding block may start, and whether a merge block may spend on a conflict.
 * An approval gate that does not show those is a gate that gets clicked
 * through, which is `defaultGuardsLabel`'s reasoning one level up.
 */
export interface ProposedBlockDTO {
  name: string;
  kind: WorkflowNodeKind;
  /** The template's name, or the untemplated guard set written out. */
  guardsLabel: string;
  /**
   * The agent this block's child is started as, or null for none.
   *
   * Beside the guards and never inside them: an agent holds no tool list and no
   * permission mode, so it says who the child is rather than what the block may
   * do. `"agent deleted"` for an id the registry no longer has, which approval
   * refuses by name.
   */
  agentLabel: string | null;
  /** Where it runs. Null on a merge block, which names no workspace. */
  folderLabel: string | null;
  /** How many runs a deciding block may start, with nobody looking. */
  fanOut: number | null;
  mergeAutoResolve: boolean;
  /** The blocks it starts after, by name. */
  after: string[];
}

export interface ChatProposalDTO {
  id: string;
  createdAt: number;
  /**
   * What approving this does. `run` queues a run; `workflow` **saves** a
   * workflow and starts nothing — the press of Run is still the operator's.
   */
  kind: "run" | "workflow";
  /** Null when the proposal runs under the operator's default guard set. */
  templateId: string | null;
  /** Null when there is no template, or when it has since been deleted. */
  templateName: string | null;
  /**
   * Where the guards come from. `missing` is a named template that has been
   * deleted since — approval will refuse it rather than fall back.
   */
  guardsSource: "template" | "defaults" | "missing";
  /** The template's name, or the default guards written out. */
  guardsLabel: string;
  /** The chat wrote this run's prompt instead of taking the template's. */
  promptRewritten: boolean;
  /**
   * The saved agent this run would be started as, by name, or null for none.
   *
   * Null when the id names nothing, because the row holds only an id — the card
   * then says the agent is gone from `agentMissing` rather than inventing a
   * name. The two are separate fields for the same reason `guardsSource` is
   * separate from `guardsLabel`: "no agent was asked for" and "the one that was
   * asked for is gone" are different facts, and approval refuses only the
   * second.
   */
  agentName: string | null;
  /**
   * This proposal names an agent that is gone, or one the CLI will not
   * register. Approval refuses it by name rather than starting the run as none.
   */
  agentMissing: boolean;
  title: string;
  task: string;
  /** Where it would run, as a person reads it. Null means "as the template says". */
  folderLabel: string | null;
  /**
   * What this run waits for, by the chat's own labels. Empty on nearly every
   * proposal. Shown rather than only acted on, because a dependency that
   * silently did not survive approval reads exactly like one that was never
   * asked for — and the runs then work in the same checkout in whatever order
   * the queue felt like.
   */
  dependsOn: Array<{ label: string; edge: "on-success" | "on-finish"; continueBranch: boolean }>;
  /** A workflow proposal's blocks. Empty on a run proposal. */
  blocks: ProposedBlockDTO[];
  status: "pending" | "approved" | "rejected" | "failed";
  runId: string | null;
  /** The workflow an approved workflow proposal saved. Never a run. */
  workflowId: string | null;
  error: string | null;
}

export interface ChatDTO {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string | null;
  status: "idle" | "thinking" | "failed";
  /** This chat's own spend. Never added to any run's, or to the meters. */
  costUSD: number;
  tokens: number;
  error: string | null;
  messages: ChatMessageDTO[];
  proposals: ChatProposalDTO[];
}

export interface ChatListEntryDTO {
  id: string;
  title: string | null;
  updatedAt: number;
  status: "idle" | "thinking" | "failed";
  costUSD: number;
  pendingCount: number;
}
