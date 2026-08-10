import fs from "node:fs/promises";
import path from "node:path";
import { PROJECTS_DIR } from "./config";
import {
  type TokenCounts,
  costOf,
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
 */

export interface UsageEntry {
  /** Dedupe key: `${messageId}:${requestId}`. */
  key: string;
  /** Epoch milliseconds. */
  ts: number;
  model: string;
  tokens: TokenCounts;
  costUSD: number;
  /** Absolute path of the project the session ran in. */
  project: string;
  sessionId: string;
  /** Sub-agent turns, which bill separately from the main thread. */
  isSidechain: boolean;
  speed?: string;
  serviceTier?: string;
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
}

// Persist across hot reloads in dev; a fresh Map per module evaluation would
// silently re-parse every transcript on each request.
const globalCache = globalThis as unknown as {
  __ufTranscriptCache?: Map<string, FileCacheEntry>;
};
const cache: Map<string, FileCacheEntry> =
  globalCache.__ufTranscriptCache ?? (globalCache.__ufTranscriptCache = new Map());

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
    project: cwdRef.value,
    sessionId: typeof rec.sessionId === "string" ? rec.sessionId : "",
    isSidechain: rec.isSidechain === true,
    speed,
    serviceTier:
      typeof usage.service_tier === "string" ? usage.service_tier : undefined,
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

/** Parse only the bytes appended since the last scan of this file. */
async function refreshFile(file: string): Promise<FileCacheEntry> {
  const stat = await fs.stat(file);
  const prev = cache.get(file);

  // Truncated or replaced: the cached offset no longer refers to the same
  // content, so start over rather than reading from a meaningless position.
  const rotated = prev !== undefined && stat.size < prev.size;
  const start = prev && !rotated ? prev.offset : 0;
  const base: FileCacheEntry =
    prev && !rotated
      ? prev
      : { offset: 0, size: 0, cwd: "", entries: [] };

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
    if (entry) base.entries.push(entry);
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

export interface ScanResult {
  entries: UsageEntry[];
  fileCount: number;
  /** Distinct model strings seen that we have no price for. */
  unpricedModels: string[];
  scannedAt: number;
}

/**
 * Scan all transcripts and return deduplicated usage entries, sorted by time.
 */
export async function scanUsage(): Promise<ScanResult> {
  const files = await listTranscriptFiles(PROJECTS_DIR);

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

  return {
    entries,
    fileCount: files.length,
    unpricedModels: [...unpriced],
    scannedAt: Date.now(),
  };
}

/** Drop cached offsets so the next scan re-reads every file from byte 0. */
export function invalidateTranscriptCache(): void {
  cache.clear();
}
