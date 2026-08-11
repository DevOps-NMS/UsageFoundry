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
  fractionMetric: "cost" | "tokens" | null;
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
  limitMetric: "tokens" | "cost" | null;
}

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
  byAgent: Array<{ agent: string; agg: AggregateDTO }>;
  bySkill: Array<{ skill: string; agg: AggregateDTO }>;
  byEffort: Array<{ effort: string; agg: AggregateDTO }>;
  totalCostUSD: number;
}

export interface UsageResponse {
  snapshot: SnapshotDTO;
  meta: {
    transcriptDir: string;
    fileCount: number;
    entryCount: number;
    unpricedModels: string[];
    scannedAt: number;
    hasSessionCeiling: boolean;
    hasWeeklyCeiling: boolean;
    /** Headroom reserved for surfaces this tool cannot observe (0–1). */
    reservedHeadroomFraction: number;
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
  status:
    | "queued"
    | "running"
    | "paused"
    | "completed"
    | "stopped"
    | "failed"
    | "blocked";
  budget: BudgetPolicyDTO;
  /** Cap on work cycles. **0 means no cap** — see the note in db.ts. */
  max_iterations: number;
  iterations: number;
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
   * Spend reconciled from transcripts for work cycles killed before Claude Code
   * reported theirs. Shown beside `spent_usd`, never folded into it.
   */
  spent_usd_est?: number;
  spent_tokens_est?: number;
  /** Queued runs only: how many are ahead of it. 0 means next up. */
  queuePosition?: number;
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
  budget: BudgetPolicyDTO;
  createdAt: number;
  updatedAt: number;
}

export interface RunEventDTO {
  id?: number;
  runId: string;
  ts: number;
  kind:
    | "status"
    | "log"
    | "assistant"
    | "tool"
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

export interface MergeQueueDTO {
  batchId: string | null;
  /** True while the worker is between or inside merges. */
  working: boolean;
  items: MergeQueueItemDTO[];
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
  exists: boolean;
  /** The producing run can still commit to it. */
  active: boolean;
  landedAt: number | null;
  prompt: string;
}

export interface BranchInventoryDTO {
  branches: BranchSummaryDTO[];
  /** Runs with a branch that the per-request cap left out. */
  notShown: number;
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
  defaultPermissionMode: string;
  defaultModel: string | null;
  continuationPrompt: string;
  includeSidechains: boolean;
  /** Null means no limit. */
  maxConcurrentRuns: number | null;
  isolationCopyGlobs: string[];
  isolationPreamble: string;
  telemetryForRuns: boolean;
  donePushbackPrompt: string;
  liveGuardIntervalSeconds: number;
  resumeGraceHours: number;
  /** How an isolated run's branch is brought into the branch it started from. */
  landStrategy: "merge" | "squash";
  killProcessGroup: boolean;
  /** Hard ceiling on one orchestrator-chat turn. Null means no cap. */
  chatTurnBudgetUSD: number | null;
  /** What a chat proposal runs under when it names no template. */
  chatDefaultGuards: RunGuardsDTO;
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

export interface ChatProposalDTO {
  id: string;
  createdAt: number;
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
  title: string;
  task: string;
  /** Where it would run, as a person reads it. Null means "as the template says". */
  folderLabel: string | null;
  status: "pending" | "approved" | "rejected" | "failed";
  runId: string | null;
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
