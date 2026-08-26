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
import { type ToolCall, parseToolRecord } from "./toolComposition";

/**
 * Reads Claude Code's local session transcripts and turns them into billable
 * usage entries.
 *
 * There is no public API for Claude Code subscription usage, so the transcripts
 * under ~/.claude/projects are the only local source of truth. Two properties
 * of that format drive the design here:
 *
 *  1. The same assistant message is frequently written more than once (resumed
 *     sessions, sidechain replay, snapshot rewrites, and one line per content
 *     block within a single turn). Every duplicate carries an identical
 *     `message.id` + `requestId` pair, so that pair is the dedupe key. Summing
 *     without it roughly doubles reported usage. The duplicates are not all
 *     identical, though — see the resolution rule at the dedupe site, which is
 *     why it keeps the record with the most output rather than the first.
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
  /**
   * The API request this turn answered, or `""` when the record carried none.
   *
   * Half of `key` already, and exposed on its own because it is the only
   * identifier shared with anything outside these files: winnow's intake filter
   * writes one ledger line per request it rewrote, keyed on exactly this, and
   * `intakeFilter.ts` joins on it to learn when a filtered request ran, what
   * model answered it and how many turns followed. Splitting `key` on a colon
   * at the join would work until a message id contained one.
   */
  requestId: string;
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
   * The composition reading's own records, retained for `entries`' reason.
   *
   * A second array rather than a field on `UsageEntry`, which is the invariant
   * `parseCompactionBoundary` states and this one is bound by: every consumer
   * of that array treats a member as a billable turn, and a `tool_result` is
   * not one. They are held here because the offset cache means a later scan
   * re-parses only the appended bytes, so a call parsed three passes ago has to
   * survive to be counted — and because the cross-file dedupe that makes the
   * total honest needs the call's own id, which only the record carries.
   */
  toolCalls: ToolCall[];
  /**
   * `tool_use.id` → index in `toolCalls`, for calls whose result has not
   * arrived yet.
   *
   * Only the *unanswered* ones, which is what keeps this from being a second
   * 60,000-entry map beside the array: a result is always written after the
   * call it answers, so within a pass this drains as it goes and what survives
   * to the next one is the tail of a live session plus whatever a kill left
   * unanswered. An entry is deleted the moment it is filled in, so a session
   * that ends cleanly leaves nothing here at all.
   */
  pendingToolCalls: Map<string, number>;
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
//
// A **new key** rather than the former `__ufTranscriptCache`, because the shape
// at that key changed: `??=` only initialises when the key is absent, so a
// pre-upgrade entry would survive a dev hot reload and every pass over it would
// throw on a `toolCalls` array that is not there. That is `__ufInterrupts`'
// rule, and the cost of obeying it is one full re-read of the tree after an
// upgrade — the same cost every container restart already pays.
const globalCache = globalThis as unknown as {
  __ufTranscriptCacheV2?: Map<string, FileCacheEntry>;
  __ufTranscriptCacheStats?: { evictions: number };
};
const cache: Map<string, FileCacheEntry> =
  globalCache.__ufTranscriptCacheV2 ??
  (globalCache.__ufTranscriptCacheV2 = new Map());
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

/**
 * Something under the projects directory could not be read.
 *
 * Carried rather than swallowed because every one of these shortens the entry
 * list a scan answers with, and a short entry list understates every window —
 * which is the direction that lets `evaluateBudget` admit a run it should have
 * refused. A file with nothing new in it and a file that could not be opened
 * both used to look like the same `null`.
 */
export interface ScanReadFailure {
  /** Absolute path of the file or directory. */
  path: string;
  message: string;
}

function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One directory of the walk, holding its children in `readdir` order.
 *
 * A `.jsonl` file is its own path and a subdirectory is a node whose entries a
 * later level fills in, so walking this structure in order reproduces exactly
 * the sequence the depth-first walk emitted — see `listTranscriptFiles`.
 */
interface WalkNode {
  dir: string;
  entries: Array<string | WalkNode>;
  /** Set when this directory's own `readdir` failed; it then has no entries. */
  failure?: ScanReadFailure;
}

/** Read one directory, returning the subdirectories the next level must read. */
async function readWalkLevel(node: WalkNode): Promise<WalkNode[]> {
  let dirents;
  try {
    dirents = await fs.readdir(node.dir, { withFileTypes: true });
  } catch (err) {
    // A missing projects directory is the ordinary state of a fresh install
    // and says nothing; an unreadable one hides however many transcripts are
    // under it. Reported apart because only the second is a short history.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      node.failure = { path: node.dir, message: failureMessage(err) };
    }
    return [];
  }

  const children: WalkNode[] = [];
  for (const d of dirents) {
    const full = path.join(node.dir, d.name);
    if (d.isDirectory()) {
      const child: WalkNode = { dir: full, entries: [] };
      node.entries.push(child);
      children.push(child);
    } else if (d.isFile() && d.name.endsWith(".jsonl")) {
      node.entries.push(full);
    }
  }
  return children;
}

/** Depth-first over a walked tree, which is the order the serial walk emitted. */
function flattenWalk(
  node: WalkNode,
  files: string[],
  failures: ScanReadFailure[],
): void {
  // Before the entries, because the serial walk pushed a directory's failure at
  // the point it descended into it — where that subtree's files would have been.
  if (node.failure) failures.push(node.failure);
  for (const entry of node.entries) {
    if (typeof entry === "string") files.push(entry);
    else flattenWalk(entry, files, failures);
  }
}

/**
 * Collect *.jsonl paths under the projects directory, one directory level at a
 * time.
 *
 * This walk costs more than everything it feeds. Measured in the container
 * against this install's tree — 505 directories, 2,185 files, 1,174 transcripts
 * — recursing serially took 105-121 ms, where the 1,174 `fs.stat` it enables
 * take 9 ms, the cross-file dedupe 8 ms and the final sort 3 ms. It is on no
 * rare path: it is the bulk of `GET /api/usage` at 164-186 ms, the bulk of a
 * warm `/api/status` answering 950 bytes in 157-195 ms, and the live budget
 * guard walks it too. Running each level through `mapWithLimit` measured 49 ms.
 * `fs.readdir(recursive: true)` measured 103-106 ms — no better, because it
 * recurses serially inside libuv as well.
 *
 * **The order it answers with is the depth-first one, unchanged.** Only the
 * scheduling moved. `runScan` maps over this list and resolves a shared dedupe
 * key by keeping the record with the most output, so file order decides which
 * record survives a tie, and `Array.prototype.sort` is stable, so it also
 * decides where two turns sharing a millisecond land. None of that is a property
 * anybody chose — `readdir` order is the filesystem's — but it is one this
 * module's numbers move with, so the level walk keeps each directory's children
 * in `readdir` order and `flattenWalk` reassembles them rather than the walk
 * emitting files in whatever order the levels happen to finish.
 *
 * Exported for `transcripts.test.ts`, which has no other way to see that order.
 */
export async function listTranscriptFiles(
  root: string,
): Promise<{ files: string[]; failures: ScanReadFailure[] }> {
  const rootNode: WalkNode = { dir: root, entries: [] };
  let level: WalkNode[] = [rootNode];
  while (level.length > 0) {
    level = (await mapWithLimit(level, WALK_CONCURRENCY, readWalkLevel)).flat();
  }

  const files: string[] = [];
  const failures: ScanReadFailure[] = [];
  flattenWalk(rootNode, files, failures);
  return { files, failures };
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
    requestId,
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
      : {
          offset: 0,
          size: 0,
          cwd: "",
          entries: [],
          toolCalls: [],
          pendingToolCalls: new Map(),
          lastTs: 0,
        };

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

    // Two parsers over one line, reading it for different questions and
    // sharing nothing but the bytes — `parseCompactionBoundary`'s rule, and the
    // reason the tool reader takes the raw line rather than a record `parseLine`
    // already produced: its own substring test skips the parse entirely on the
    // three quarters of lines that carry no tool block, which is cheaper than
    // threading a parsed record through a function whose whole contract is that
    // what it returns is billable.
    const tools = parseToolRecord(line);
    if (tools) {
      for (const call of tools.calls) {
        base.pendingToolCalls.set(call.id, base.toolCalls.length);
        base.toolCalls.push(call);
      }
      for (const result of tools.results) {
        const at = base.pendingToolCalls.get(result.toolUseId);
        if (at === undefined) continue; // a result whose call is in another file
        base.toolCalls[at].resultChars = result.chars;
        base.pendingToolCalls.delete(result.toolUseId);
      }
    }

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
  /**
   * The composition reading's records, deduplicated the same way `entries` are
   * and never mixed with them.
   *
   * These are not turns and carry no usage, no model and no price — see
   * `toolComposition.ts`. Nothing that consumes `entries` may consume these, and
   * `buildSnapshot` keeps them on their own field of the snapshot for the same
   * reason.
   */
  toolCalls: ToolCall[];
  fileCount: number;
  /** Distinct model strings seen that we have no price for. */
  unpricedModels: string[];
  scannedAt: number;
  /**
   * What this scan could not read. Empty is the normal case; anything in it
   * means `entries` is short by an unknown amount and every figure derived from
   * it is a floor.
   */
  readFailures: ScanReadFailure[];
}

/** Pinned across hot reloads for the reason the cache is. */
const globalScanHealth = globalThis as unknown as {
  __ufScanHealth?: { readFailures: ScanReadFailure[] };
};
const scanHealth =
  globalScanHealth.__ufScanHealth ??
  (globalScanHealth.__ufScanHealth = { readFailures: [] });

/**
 * What the most recently completed scan could not read.
 *
 * A second way to reach the same field `ScanResult` already carries, for the
 * callers that are handed a `UsageSnapshot` instead of a scan —
 * `currentSnapshot()`, and through it the pre-cycle budget guard, which is the
 * one caller that most needs to know its history was short. Threading a second
 * return value through that function and its eight call sites would be a wider
 * change than the fact deserves. Scans are coalesced, so what this answers with
 * is the scan the caller just awaited or a newer one.
 */
export function lastScanReadFailures(): ScanReadFailure[] {
  return scanHealth.readFailures;
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

/** Tool calls currently held across every cached file. */
function retainedToolCalls(): number {
  let n = 0;
  for (const e of cache.values()) n += e.toolCalls.length;
  return n;
}

/**
 * What the bound is actually applied to: turns **and** tool calls together.
 *
 * `TRANSCRIPT_CACHE_MAX_ENTRIES` exists to bound a heap, not to count a
 * particular kind of record, and the composition reading put a second array in
 * every cache entry — about 60% as many records as the first on this install's
 * corpus. Measuring only turns would have left the bound reading the same
 * number while the memory behind it grew, which is precisely the silent
 * loosening the bound was introduced to prevent. The two stats stay separate on
 * `TranscriptCacheStats` so an operator can still see which array is growing.
 */
function retainedRecords(): number {
  return retainedEntries() + retainedToolCalls();
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
  let retained = retainedRecords();
  if (retained <= TRANSCRIPT_CACHE_MAX_ENTRIES) return;

  const candidates = [...cache.entries()]
    .filter(
      ([file, e]) =>
        e.entries.length + e.toolCalls.length > 0 && !inflight.has(file),
    )
    .sort((a, b) => a[1].lastTs - b[1].lastTs);

  for (const [file, e] of candidates) {
    if (retained <= TRANSCRIPT_CACHE_MAX_ENTRIES) return;
    cache.delete(file);
    retained -= e.entries.length + e.toolCalls.length;
    cacheStats.evictions += 1;
  }
}

/** What the cache is holding, so an operator can read it off `/api/usage`. */
export interface TranscriptCacheStats {
  /** Transcript files with a cached byte offset. */
  files: number;
  /** Parsed turns held across those files. */
  entries: number;
  /** Tool calls held across those files — the composition reading's records. */
  toolCalls: number;
  /** The bound `entries` **plus** `toolCalls` is kept at or below. */
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
    toolCalls: retainedToolCalls(),
    maxEntries: TRANSCRIPT_CACHE_MAX_ENTRIES,
    evictions: cacheStats.evictions,
  };
}

/**
 * Transcript files read at once.
 *
 * `readAppended` holds one file descriptor and one `Buffer` sized to the file's
 * whole unread remainder for the duration of its read, and libuv services the
 * threadpool roughly FIFO — so every `open` in an unbounded fan-out completes
 * before the first `close` runs, and both the buffers and the descriptors
 * coexist. Peak memory was therefore the size of the tree and peak descriptors
 * its file count, which is what every restart pays: the cache is process-local,
 * so the first scan after one reads every file from byte 0. Twelve puts the
 * ceiling at roughly twelve times the largest single transcript and twelve
 * descriptors, neither of which is a function of how much history is on disk.
 *
 * Bounding this is also what stops the failure being silent. Past a 1024-fd
 * `nofile` — a common container default, and `docker-compose.yml` sets no
 * `ulimits:` — the opens past the limit simply failed, and the scan answered
 * with a short entry list that understated every window the guard reads.
 */
export const SCAN_CONCURRENCY = 12;

/**
 * Directories read at once by `listTranscriptFiles`.
 *
 * Its own number rather than `SCAN_CONCURRENCY`'s, because it bounds a different
 * resource. A `readdir` holds one directory handle for the length of one
 * `scandir` and nothing else — no descriptor per file under it, and no buffer
 * sized to anything on disk — where the bound one constant up exists because
 * each `readAppended` holds a file descriptor *and* a `Buffer` sized to a whole
 * transcript's unread remainder. Twelve is the answer to "how much of the tree
 * may be resident at once"; it is not the answer to a question about directory
 * handles, and reusing it would tie two unrelated ceilings together so that
 * moving either one silently moves the other's failure mode.
 *
 * The two must still be read together, because they can overlap: `runScan` walks
 * before it reads, so those never coincide, but `readCompactions` walks once per
 * work cycle while a scan is in flight. Sixteen plus twelve is 28 descriptors
 * for one of each, and a fleet is bounded by `maxConcurrentRuns` walks — at 25
 * runs, 400 — which stays well inside the 1024-fd `nofile` past which the opens
 * begin to fail and the scan silently understates every window the guard reads.
 * Raising it much further was not measured and is not expected to buy anything:
 * the tree is two levels deep, so there are only ever two levels to overlap, and
 * a `scandir` is libuv threadpool work whose default width is four.
 */
export const WALK_CONCURRENCY = 16;

/**
 * Run `fn` over `items` with at most `limit` in flight, results in input order.
 *
 * A worker pool rather than chunked `Promise.all` batches: a batch runs at the
 * speed of its slowest member and leaves the other eleven slots idle, and
 * transcript sizes vary by three orders of magnitude. Directory sizes vary the
 * same way, which is why `listTranscriptFiles` runs each of its levels through
 * this too, under its own limit — the results coming back in input order is what
 * lets that walk answer in the same order the serial one did.
 */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

async function runScan(): Promise<ScanResult> {
  const { files, failures: walkFailures } = await listTranscriptFiles(PROJECTS_DIR);

  // A transcript that is no longer on disk will never be read again, so its
  // records are retention with nothing behind them. Dropped here rather than in
  // `evictToBound`, which is about the bound: this one is free whatever the
  // cache is holding.
  //
  // Only when the walk itself was clean, though: a directory that could not be
  // read is not an empty directory, and pruning against a partial listing would
  // throw away the records of every file under it — costing a full re-read of
  // the tree the moment the directory came back.
  if (walkFailures.length === 0) {
    const present = new Set(files);
    for (const file of cache.keys()) if (!present.has(file)) cache.delete(file);
  }

  const readFailures: ScanReadFailure[] = [...walkFailures];
  const results = await mapWithLimit(files, SCAN_CONCURRENCY, (f) =>
    refreshFile(f).catch((err) => {
      readFailures.push({ path: f, message: failureMessage(err) });
      return null;
    }),
  );

  // Dedupe across files: a resumed session copies earlier turns into the new
  // transcript, so the same key legitimately appears in more than one file.
  //
  // Highest `output` wins rather than first-seen, because the records sharing a
  // key are not all complete. Claude Code writes one line per content block and
  // repeats the whole usage object on each, but every line before the last
  // carries a streaming placeholder in the output field alone — a turn that
  // emitted 40,199 output tokens is written three times, twice as
  // `output_tokens: 4`. Input, cache read and cache creation are identical on
  // every line of the turn, so the record with the most output is the finished
  // one. Taking the first understated corpus output by 16% on CLI 2.1.226 and
  // 75% on 2.1.238 — silently, and worse with each release.
  const indexOfKey = new Map<string, number>();
  const entries: UsageEntry[] = [];
  /** Which file each kept entry came from — `toolCallFile`'s reason, verbatim. */
  const entryFile: number[] = [];
  const unpriced = new Set<string>();

  // The composition reading's own dedupe, over its own key and in its own
  // array. Same problem as above — a resumed session copies the conversation
  // forward, so the same call is written into more than one file — and the
  // resolution rule is the same shape for the same kind of reason: the copy
  // that was written before the tool answered carries a null `resultChars`, so
  // the record that saw the most is the complete one. Taking the first would
  // report a call with no result whenever a session was resumed across it.
  const indexOfToolId = new Map<string, number>();
  const toolCalls: ToolCall[] = [];
  // Which file each kept tool call came from, so the recency rule above can
  // compare them. A parallel array rather than a field on `ToolCall`, because
  // this is scan-local bookkeeping and every consumer of that type would
  // otherwise carry an index into an array it cannot see.
  const toolCallFile: number[] = [];
  const lastTsOfFile: number[] = results.map((r) =>
    r ? r.entries.reduce((m, e) => (e.ts > m ? e.ts : m), 0) : 0,
  );

  for (let fileIndex = 0; fileIndex < results.length; fileIndex++) {
    const r = results[fileIndex];
    if (!r) continue;
    const fileLastTs = lastTsOfFile[fileIndex];
    for (const e of r.entries) {
      const kept = indexOfKey.get(e.key);
      if (kept !== undefined) {
        if (e.tokens.output > entries[kept].tokens.output) {
          entries[kept] = e;
          entryFile[kept] = fileIndex;
        } else if (
          e.tokens.output === entries[kept].tokens.output &&
          fileLastTs > (lastTsOfFile[entryFile[kept]] ?? 0)
        ) {
          // A tie used to keep whichever file the filesystem listed first, and
          // for a resumed session that is harmless — both copies carry the same
          // numbers *and* the same `sessionId`. A **fork** breaks the second
          // half of that: `winnow fork` rewrites `sessionId` on every copied
          // line, so the two records are identical except for the one field
          // every session-scoped reader keys on. Measured on this operator's
          // corpus: 6,657 keys appear in more than one file, all 6,657 carry
          // more than one session id, and all 6,657 tie on output — so readdir
          // order alone decided which half of a forked run the agent-cost card
          // counted, and which turns the intake filter could see following a
          // request.
          //
          // Recency breaks the tie the same way it does for tool calls below:
          // the transcript still being appended to is the conversation the run
          // is carrying. Cost is identical either way — the copies are verbatim
          // — so this moves attribution and never a total.
          entries[kept] = e;
          entryFile[kept] = fileIndex;
        }
        continue;
      }
      indexOfKey.set(e.key, entries.length);
      entryFile.push(fileIndex);
      entries.push(e);
      if (e.unpriced) unpriced.add(e.model);
    }
    for (const c of r.toolCalls) {
      const kept = indexOfToolId.get(c.id);
      if (kept !== undefined) {
        // Which copy is the *live* one, before which copy saw the most.
        //
        // The rule below — most characters wins — reads two copies of a call as
        // one complete and one unfinished, which is what a streaming write
        // produces. A **fork** produces something else: `winnow fork` writes a
        // second transcript whose tool results are deliberately replaced by
        // short pointers, and there the shorter record is the newer truth. Most
        // characters would always pick the original's full result and report the
        // fork as having removed nothing, for as long as the original is on
        // disk — which is for ever, since winnow never deletes it. Measured on
        // one real fork: 92,498 characters against the fork's own 69,773, a gap
        // of exactly the 22,725 bytes it removed.
        //
        // A transcript that is still being appended to is the conversation the
        // run is actually carrying. That is true after a fork is adopted (new
        // turns land in the fork), true after a fork is rolled back (they land
        // back in the original), and true of an ordinary resume — where both
        // copies hold the same full result anyway, so this changes nothing.
        // Equal recency falls through to the rule below, which is the state
        // before a fork has done any work: nothing has happened yet, and the
        // original is the honest answer.
        const keptAt = lastTsOfFile[toolCallFile[kept]] ?? 0;
        if (fileLastTs > keptAt) {
          toolCalls[kept] = c;
          toolCallFile[kept] = fileIndex;
        } else if (
          fileLastTs === keptAt &&
          (c.resultChars ?? -1) > (toolCalls[kept].resultChars ?? -1)
        ) {
          toolCalls[kept] = c;
          toolCallFile[kept] = fileIndex;
        }
        continue;
      }
      indexOfToolId.set(c.id, toolCalls.length);
      toolCallFile.push(fileIndex);
      toolCalls.push(c);
    }
  }

  entries.sort((a, b) => a.ts - b.ts);

  // After the result is built, never before it: this scan answers with
  // everything it read, and what eviction decides is only how much of that is
  // still in memory when the next one starts.
  evictToBound();

  scanHealth.readFailures = readFailures;

  return {
    entries,
    toolCalls,
    fileCount: files.length,
    unpricedModels: [...unpriced],
    scannedAt: Date.now(),
    readFailures,
  };
}

/* ------------------------------------------------------------------ */
/* Compaction boundaries — a reading of composition, never of cost      */
/* ------------------------------------------------------------------ */

/**
 * One compaction the CLI performed on a conversation.
 *
 * **Not a cost source and never summed with one.** `01-constraints.md` names
 * three cost sources and this is a fourth *reading* of one of them: the same
 * files `scanUsage` walks, read for what happened to the conversation rather
 * than for what it billed. Nothing here reaches `buildSnapshot`,
 * `runs.spent_usd` or a `BudgetVerdict`, and `preTokens`/`postTokens` are the
 * summariser's own accounting of a window rather than tokens anybody was
 * charged for — adding them to a bill would double-count the turns
 * `scanUsage` has already priced.
 *
 * `cliVersion` is carried because it is the only thing that makes the survival
 * classification honest. Anthropic's table of what survives a compaction pins
 * itself at one CLI version, and every row of it is documentation rather than
 * measurement; a record that says which version compacted *this* conversation
 * is what lets the copy read as a hypothesis where the two disagree instead of
 * as a fact about this install.
 */
export interface CompactionBoundary {
  sessionId: string;
  /** Epoch milliseconds, from the record's own timestamp. */
  ts: number;
  /** `auto` on every one of the 21 records this install has produced. */
  trigger: string;
  /** What the window held going in, per the summariser. */
  preTokens: number;
  /** What it held coming out. */
  postTokens: number;
  /** Wall-clock the compaction itself took, which a duration guard is counting. */
  durationMs: number;
  /** CLI version that wrote the record, verbatim. */
  cliVersion: string;
}

/**
 * A `compact_boundary` record, or null for every other line.
 *
 * Separate from `parseLine` rather than folded into it, and the reason is the
 * shape of `UsageEntry`: every consumer of that array treats a member as a
 * billable turn, so a `type: "system"` record reaching it would be counted as
 * one by `buildSnapshot`, by `agentSpend` and by the guard. The two parsers read
 * the same lines for different questions and share nothing but the file.
 *
 * Every field is read defensively and defaults to zero or the empty string,
 * because a partially-flushed or renamed record must not throw inside a scan.
 * That makes a field rename **silent** — the log line would read "180,694
 * tokens down to 0" — which is what `compaction.test.ts` pins against a real
 * captured record, and what `docs/verification.md` records as unverified on any
 * CLI other than the pinned one.
 */
export function parseCompactionBoundary(line: string): CompactionBoundary | null {
  // The substring test before the parse, not after: a scan reads whole
  // transcripts and JSON-parsing every line of one to find the few system
  // records in it is the cost this reader exists inside a run loop to avoid.
  if (!line.startsWith("{") || !line.includes('"compact_boundary"')) return null;

  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }

  if (rec.type !== "system" || rec.subtype !== "compact_boundary") return null;

  const ts = Date.parse(String(rec.timestamp ?? ""));
  if (!Number.isFinite(ts)) return null;

  const meta = (rec.compactMetadata ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  return {
    sessionId: typeof rec.sessionId === "string" ? rec.sessionId : "",
    ts,
    trigger: typeof meta.trigger === "string" ? meta.trigger : "",
    preTokens: num(meta.preTokens),
    postTokens: num(meta.postTokens),
    durationMs: num(meta.durationMs),
    cliVersion: typeof rec.version === "string" ? rec.version : "",
  };
}

/**
 * Compactions inside one session and one time window.
 *
 * Bounded by session id **and** by time, for `reconcileKilledCycle`'s reason: a
 * resumed session copies earlier records forward into the new transcript
 * carrying their original timestamps, so the id alone would re-report every
 * boundary of every earlier cycle at the end of each new one.
 *
 * The transcript is read whole rather than from a cached offset. The offset
 * cache is `scanUsage`'s and holds only assistant entries, and a second offset
 * over the same file would be a second thing to keep honest across truncation
 * and rotation for a read that happens once per work cycle, beside a full
 * `currentSnapshot()` scan of every transcript on the machine.
 */
export async function readCompactions(
  sessionId: string | null,
  window: { from: number; to: number },
): Promise<CompactionBoundary[]> {
  if (!sessionId) return [];

  const { files } = await listTranscriptFiles(PROJECTS_DIR);
  const name = `${sessionId}.jsonl`;
  const mine = files.filter((f) => path.basename(f) === name);

  const found: CompactionBoundary[] = [];
  for (const file of mine) {
    // Read failures propagate. This is not the metering path, where a short
    // history understates a window a guard reads and so is carried rather than
    // thrown — here the caller has one run's log to say so on, and a reader
    // that silently answered "no compactions" would be indistinguishable from a
    // conversation that was never compacted.
    const text = await fs.readFile(file, "utf8");
    for (const line of text.split("\n")) {
      const boundary = parseCompactionBoundary(line);
      if (!boundary) continue;
      if (boundary.sessionId !== sessionId) continue;
      if (boundary.ts < window.from || boundary.ts > window.to) continue;
      found.push(boundary);
    }
  }

  found.sort((a, b) => a.ts - b.ts);
  return found;
}

/**
 * Where a session's transcript is, or null.
 *
 * Resolved by walking the projects tree rather than by building
 * `<PROJECTS_DIR>/<slug>/<id>.jsonl` from the working directory, because the
 * slug is the CLI's encoding of a path and this app does not own the rule that
 * produces it — an isolated run's checkout, a worktree and a plain folder each
 * slugify differently, and a mapping that was wrong would silently prune
 * nothing rather than fail.
 *
 * A session id is a uuid and a basename match on it is exact, so the ambiguity
 * `readCompactions` handles by filtering entries does not arise: if two projects
 * somehow hold the same id, neither is safe to rewrite and this answers null.
 */
export async function resolveSessionTranscript(
  sessionId: string,
): Promise<string | null> {
  const { files } = await listTranscriptFiles(PROJECTS_DIR);
  const name = `${sessionId}.jsonl`;
  const mine = files.filter((f) => path.basename(f) === name);
  return mine.length === 1 ? mine[0] : null;
}

/**
 * Forget files that are no longer on disk, without touching the rest.
 *
 * The retention sweep's counterpart, and deliberately not a whole-cache clear:
 * dropping every offset makes the next scan re-read the whole tree from byte 0,
 * which is the expensive pass this cache exists to avoid. A removed file would
 * otherwise keep its parsed entries for the life of the process — `runScan`
 * re-derives the file list every time, so nothing would ever revisit them — and
 * the dashboard would go on showing spend from transcripts that are gone until
 * the next restart, disagreeing with the very cutoff the period card had just
 * been told about.
 *
 * In-flight refreshes are dropped alongside the cached entry, rather than left
 * to write a pre-removal offset back over it.
 */
export function forgetTranscriptFiles(files: readonly string[]): void {
  for (const file of files) {
    cache.delete(file);
    inflight.delete(file);
  }
}
