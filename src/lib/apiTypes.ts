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
  queuedCount?: number;
}

export interface FoldersResponse {
  /** First mount's path. Predates multiple mounts. */
  root: string;
  mounts: WorkspaceMountDTO[];
  folders: WorkspaceFolderDTO[];
}

export interface BudgetPolicyDTO {
  maxWeeklyFraction: number | null;
  maxSessionFraction: number | null;
  maxRunCostUSD: number | null;
  maxRunTokens: number | null;
  maxIterations: number;
  maxDurationMinutes: number | null;
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
  status: "queued" | "running" | "completed" | "stopped" | "failed" | "blocked";
  budget: BudgetPolicyDTO;
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
  /** Queued runs only: how many are ahead of it. 0 means next up. */
  queuePosition?: number;
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
    | "error"
    | "replay-complete";
  payload: Record<string, unknown>;
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
}
