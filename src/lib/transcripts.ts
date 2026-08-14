import fs from "node:fs/promises";
import path from "node:path";
import { PROJECTS_DIR, TRANSCRIPT_CACHE_MAX_ENTRIES } from "./config";
import {
  type TokenCounts,
  costOf,
  guardCostOf,
  resolvePrice,
  totalTokens,
} from "./pricing";

/**
 * Reads Claude Code's local session transcripts and turns them into billable
 * usage entries.
 *
 * There is no public API for Claude Code subscription usage, so the transcripts
 * under ~/.claude/projects are the only local source of truth. Two properties
 * of that format drive the design here:
 *
 *  1. The same assistant message is frequently written more than once (resumed
 *     sessions, sidechain replay, snapshot rewrites). Every duplicate carries
 *     an identical `message.id` + `requestId` pair, so that pair is the dedupe
 *     key. Summing without it roughly doubles reported usage.
 *
 *  2. Files are append-only, so we track a byte offset per file and parse only
 *     the newly written bytes on each refresh. A full re-parse of a busy
 *     ~/.claude is slow enough to be noticeable in a polling dashboard.
 *
 *  3. What (2) buys is paid for in memory, so the retention is bounded. Holding
 *     every record ever parsed is what made the offset cheap, and it is also a
 *     heap that only grows: at ~330 bytes a turn it reaches V8's default limit
 *     and aborts the process. Past `TRANSCRIPT_CACHE_MAX_ENTRIES` the coldest
 *     files are dropped whole — records *and* offset — so a later scan re-reads
 *     them and derives the same records again. Never the other way round:
 *     keeping the offset and discarding the records would be cheaper and would
 *     silently understate every window, which is the one direction a budget
 *     guard must not fail in.
 */

export interface UsageEntry {
  /** Dedupe key: `${messageId}:${requestId}`. */
  key: string;
  /** Epoch milliseconds. */
  ts: number;
  model: string;
  tokens: TokenCounts;
  costUSD: number;
  /**
   * Same cost, but an unpriced model is charged the fallback rate instead of
   * $0. Read only by the budget guard — never displayed. Identical to
   * `costUSD` whenever the model is priced, which is the normal case.
   */
  costGuardUSD: number;
  /** Absolute path of the project the session ran in. */
  project: string;
  sessionId: string;
  /** Sub-agent turns, which bill separately from the main thread. */
  isSidechain: boolean;
  speed?: string;
  serviceTier?: string;
  /**
   * Reasoning effort the turn ran at (`low` … `max`). Present on essentially
   * every turn, and a large cost lever — the same task at `xhigh` and at `low`
   * are different amounts of money.
   */
  effort?: string;
  /**
   * Sub-agent that produced the turn (`Explore`, `workflow-subagent`, …), or
   * undefined for main-thread work. Claude Code records this itself; it is a
   * finer split than `isSidechain`, which only says "not the main thread".
   */
  agent?: string;
  /** Skill in play when the turn ran (`claude-api`, `init`, …), if any. */
  skill?: string;
  /**
   * Which Claude Code surface produced the turn (`cli`, `sdk-cli`, …).
   *
   * Reported so the UI can state exactly what is covered. Only Claude Code
   * writes these transcripts — Cowork, Claude Desktop, web, and mobile consume
   * the same shared limits but leave nothing local to read.
   */
  entrypoint?: string;
  /** True when the model string had no known price — cost is a floor, not exact. */
  unpriced: boolean;
}

interface FileCacheEntry {
  /** Byte offset up to which we have parsed complete lines. */
  offset: number;
  /** Size at last read, used to detect truncation/rotation. */
  size: number;
  cwd: string;
  entries: UsageEntry[];
  /**
   * Newest timestamp in `entries`, or 0 when it holds none.
   *
   * Only eviction reads it, and it is kept here rather than derived because the
   * array is the thing being measured: a scan that walked every entry of every
   * file to decide what to drop would be paying the cost the cache exists to
   * avoid.
   */
  lastTs: number;
}

// Persist across hot reloads in dev; a fresh Map per module evaluation would
// silently re-parse every transcript on each request.
const globalCache = globalThis as unknown as {
  __ufTranscriptCache?: Map<string, FileCacheEntry>;
  __ufTranscriptCacheStats?: { evictions: number };
};
const cache: Map<string, FileCacheEntry> =
  globalCache.__ufTranscriptCache ?? (globalCache.__ufTranscriptCache = new Map());
/** Pinned beside the cache it counts, for that Map's reason. */
const cacheStats =
  globalCache.__ufTranscriptCacheStats ??
  (globalCache.__ufTranscriptCacheStats = { evictions: 0 });

/**
 * In-flight refreshes, keyed by file, so overlapping scans never parse the same
 * appended bytes twice.
 *
 * `readAppended` reads a file's byte offset and writes it back with four awaits
 * in between, pushing parsed records into the shared `entries` array. Two scans
 * that overlap — and they routinely do, since the run loop scans before every
 * work cycle while the dashboard polls every 10s — both read the same stale
 * offset, read the same bytes, and append the same records. Cross-file dedupe in
 * `scanUsage` hides that from the totals, so it is invisible in the UI, but the
 * cached array grows without bound and every later scan gets slower, which
 * widens the window that caused it.
 *
 * Sharing one promise makes the second caller reuse the first one's parse. Its
 * view is at most one refresh stale, which is well inside the lag transcripts
 * already have against a live session.
 */
const globalInflight = globalThis as unknown as {
  __ufTranscriptInflight?: Map<string, Promise<FileCacheEntry>>;
  __ufScanInflight?: Promise<ScanResult> | null;
};
const inflight: Map<string, Promise<FileCacheEntry>> =
  globalInflight.__ufTranscriptInflight ??
  (globalInflight.__ufTranscriptInflight = new Map());

/** Recursively collect *.jsonl paths under the projects directory. */
async function listTranscriptFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing or unreadable — treat as empty
    }
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) await walk(full);
      else if (d.isFile() && d.name.endsWith(".jsonl")) out.push(full);
    }
  }
  await walk(root);
  return out;
}

function readTokens(usage: Record<string, unknown>): TokenCounts {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cacheCreation = (usage.cache_creation ?? {}) as Record<string, unknown>;

  const declared5m = num(cacheCreation.ephemeral_5m_input_tokens);
  const declared1h = num(cacheCreation.ephemeral_1h_input_tokens);
  const totalCreate = num(usage.cache_creation_input_tokens);

  // Older records carry only the aggregate `cache_creation_input_tokens` with
  // no TTL split. Attribute those to the 5m bucket: it is the cheaper of the
  // two, so an unsplit record understates rather than overstates cost, and the
  // UI flags the ambiguity instead of inventing a distribution.
  const split = declared5m + declared1h;
  const unattributed = Math.max(0, totalCreate - split);

  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite5m: declared5m + unattributed,
    cacheWrite1h: declared1h,
  };
}

function parseLine(line: string, cwdRef: { value: string }): UsageEntry | null {
  if (!line.startsWith("{")) return null;

  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line);
  } catch {
    return null; // partially flushed or corrupt line — skip, do not abort the file
  }

  if (typeof rec.cwd === "string" && rec.cwd) cwdRef.value = rec.cwd;
  if (rec.type !== "assistant") return null;

  const message = rec.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!message || !usage) return null;

  const messageId = typeof message.id === "string" ? message.id : "";
  const requestId = typeof rec.requestId === "string" ? rec.requestId : "";
  // Without both identifiers we cannot prove this is not a duplicate, so fall
  // back to the record uuid, which is unique per written line.
  const key =
    messageId && requestId
      ? `${messageId}:${requestId}`
      : `uuid:${String(rec.uuid ?? Math.random())}`;

  const ts = Date.parse(String(rec.timestamp ?? ""));
  if (!Number.isFinite(ts)) return null;

  const model = typeof message.model === "string" ? message.model : "";
  const speed = typeof usage.speed === "string" ? usage.speed : undefined;
  const tokens = readTokens(usage);
  const price = resolvePrice(model, { at: ts, speed });

  return {
    key,
    ts,
    model: model || "unknown",
    tokens,
    costUSD: costOf(tokens, price),
    costGuardUSD: guardCostOf(tokens, price),
    project: cwdRef.value,
    sessionId: typeof rec.sessionId === "string" ? rec.sessionId : "",
    isSidechain: rec.isSidechain === true,
    speed,
    serviceTier:
      typeof usage.service_tier === "string" ? usage.service_tier : undefined,
    effort: typeof rec.effort === "string" ? rec.effort : undefined,
    agent:
      typeof rec.attributionAgent === "string" ? rec.attributionAgent : undefined,
    skill:
      typeof rec.attributionSkill === "string" ? rec.attributionSkill : undefined,
    entrypoint: typeof rec.entrypoint === "string" ? rec.entrypoint : undefined,
    // A record that consumed no tokens cannot have cost anything, so it is not
    // evidence that the price table is missing a model. Claude Code writes at
    // least one such record per machine — `<synthetic>`, with an all-zero usage
    // block — and counting it would leave the "unpriced models" warning
    // permanently lit for a model that never spent a cent, blunting the signal
    // exactly where the budget guard now relies on it.
    unpriced: price === null && totalTokens(tokens) > 0,
  };
}

/**
 * Parse only the bytes appended since the last scan of this file.
 *
 * Never call this directly — go through `refreshFile`, which serialises
 * concurrent callers. Running two of these against one file double-appends.
 */
async function readAppended(file: string): Promise<FileCacheEntry> {
  const stat = await fs.stat(file);
  const prev = cache.get(file);

  // Truncated or replaced: the cached offset no longer refers to the same
  // content, so start over rather than reading from a meaningless position.
  const rotated = prev !== undefined && stat.size < prev.size;
  const start = prev && !rotated ? prev.offset : 0;
  const base: FileCacheEntry =
    prev && !rotated
      ? prev
      : { offset: 0, size: 0, cwd: "", entries: [], lastTs: 0 };

  if (stat.size === start) {
    base.size = stat.size;
    cache.set(file, base);
    return base;
  }

  const handle = await fs.open(file, "r");
  let chunk: Buffer;
  try {
    const length = stat.size - start;
    chunk = Buffer.allocUnsafe(length);
    await handle.read(chunk, 0, length, start);
  } finally {
    await handle.close();
  }

  // The final newline marks the last complete record. Anything after it is a
  // partially written line; leave it unconsumed so the next pass re-reads it.
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    base.size = stat.size;
    cache.set(file, base);
    return base;
  }

  const complete = chunk.subarray(0, lastNewline).toString("utf8");
  const cwdRef = { value: base.cwd };

  for (const line of complete.split("\n")) {
    if (!line) continue;
    const entry = parseLine(line, cwdRef);
    if (!entry) continue;
    base.entries.push(entry);
    if (entry.ts > base.lastTs) base.lastTs = entry.ts;
  }

  // Backfill cwd onto entries parsed before the first record that carried it.
  if (cwdRef.value && !base.cwd) {
    for (const e of base.entries) if (!e.project) e.project = cwdRef.value;
  }

  base.cwd = cwdRef.value;
  base.offset = start + lastNewline + 1;
  base.size = stat.size;
  cache.set(file, base);
  return base;
}

/** Refresh one file, joining an already-running refresh of the same file. */
function refreshFile(file: string): Promise<FileCacheEntry> {
  const running = inflight.get(file);
  if (running) return running;

  const started = readAppended(file).finally(() => {
    // Guard the identity check: a refresh queued after this one settled owns
    // the slot now, and clearing it blindly would let a third caller start a
    // parallel parse of the same file.
    if (inflight.get(file) === started) inflight.delete(file);
  });

  inflight.set(file, started);
  return started;
}

export interface ScanResult {
  entries: UsageEntry[];
  fileCount: number;
  /** Distinct model strings seen that we have no price for. */
  unpricedModels: string[];
  scannedAt: number;
}

/**
 * Scan all transcripts and return deduplicated usage entries, sorted by time.
 *
 * Concurrent callers share one scan. Per-file locking already makes overlapping
 * scans correct; coalescing here also makes them cheap, which matters because
 * every concurrent run evaluates its budget against a fresh scan and they tend
 * to arrive together.
 */
export function scanUsage(): Promise<ScanResult> {
  const running = globalInflight.__ufScanInflight;
  if (running) return running;

  const started = runScan().finally(() => {
    if (globalInflight.__ufScanInflight === started) {
      globalInflight.__ufScanInflight = null;
    }
  });

  globalInflight.__ufScanInflight = started;
  return started;
}

/** Parsed turns currently held across every cached file. */
function retainedEntries(): number {
  let n = 0;
  for (const e of cache.values()) n += e.entries.length;
  return n;
}

/**
 * Drop whole files until the retained turn count is back under the bound.
 *
 * Coldest first, where cold is "newest turn is oldest": a transcript is written
 * while its session is live and never touched again, so the file whose last turn
 * is furthest back is both the least likely to gain bytes and the least likely
 * to be inside the 5-hour or weekly window a guard reads. A file with nothing
 * parsed out of it frees nothing and is skipped, and one with a refresh in
 * flight is left alone — that refresh is holding the offset it read and would
 * write the record straight back.
 *
 * A dropped file loses its byte offset along with its records, which is what
 * makes this lossless: the next scan reads it from byte 0 and parses exactly the
 * same turns out of it. The cost is a re-read, so an install whose live history
 * sits permanently over the bound re-parses the excess on every scan — slow, and
 * the answer to it is a larger bound or fewer transcripts on disk, not a cache
 * that quietly reports less than it was asked about.
 *
 * Called after a scan has taken its result, never during one: what it evicts is
 * retention, and the entries the caller is holding are unaffected.
 */
function evictToBound(): void {
  let retained = retainedEntries();
  if (retained <= TRANSCRIPT_CACHE_MAX_ENTRIES) return;

  const candidates = [...cache.entries()]
    .filter(([file, e]) => e.entries.length > 0 && !inflight.has(file))
    .sort((a, b) => a[1].lastTs - b[1].lastTs);

  for (const [file, e] of candidates) {
    if (retained <= TRANSCRIPT_CACHE_MAX_ENTRIES) return;
    cache.delete(file);
    retained -= e.entries.length;
    cacheStats.evictions += 1;
  }
}

/** What the cache is holding, so an operator can read it off `/api/usage`. */
export interface TranscriptCacheStats {
  /** Transcript files with a cached byte offset. */
  files: number;
  /** Parsed turns held across those files. */
  entries: number;
  /** The bound `entries` is kept at or below. */
  maxEntries: number;
  /** Files dropped to stay under that bound since this process started. */
  evictions: number;
}

/**
 * A reading of the retention this module holds.
 *
 * Exported because the heap it bounds is otherwise only visible by attaching a
 * debugger to a container, which is not a thing an operator does before the
 * process has already died.
 */
export function transcriptCacheStats(): TranscriptCacheStats {
  return {
    files: cache.size,
    entries: retainedEntries(),
    maxEntries: TRANSCRIPT_CACHE_MAX_ENTRIES,
    evictions: cacheStats.evictions,
  };
}

async function runScan(): Promise<ScanResult> {
  const files = await listTranscriptFiles(PROJECTS_DIR);

  // A transcript that is no longer on disk will never be read again, so its
  // records are retention with nothing behind them. Dropped here rather than in
  // `evictToBound`, which is about the bound: this one is free whatever the
  // cache is holding.
  const present = new Set(files);
  for (const file of cache.keys()) if (!present.has(file)) cache.delete(file);

  const results = await Promise.all(
    files.map((f) => refreshFile(f).catch(() => null)),
  );

  // Dedupe across files: a resumed session copies earlier turns into the new
  // transcript, so the same key legitimately appears in more than one file.
  const seen = new Set<string>();
  const entries: UsageEntry[] = [];
  const unpriced = new Set<string>();

  for (const r of results) {
    if (!r) continue;
    for (const e of r.entries) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      entries.push(e);
      if (e.unpriced) unpriced.add(e.model);
    }
  }

  entries.sort((a, b) => a.ts - b.ts);

  // After the result is built, never before it: this scan answers with
  // everything it read, and what eviction decides is only how much of that is
  // still in memory when the next one starts.
  evictToBound();

  return {
    entries,
    fileCount: files.length,
    unpricedModels: [...unpriced],
    scannedAt: Date.now(),
  };
}
