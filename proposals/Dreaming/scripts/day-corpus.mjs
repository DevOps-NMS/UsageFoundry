#!/usr/bin/env node
/**
 * What one day of this install's sessions contains, and what reading it costs.
 *
 * Run from the transcript root:
 *
 *   node proposals/Dreaming/scripts/day-corpus.mjs ~/.claude/projects
 *   node proposals/Dreaming/scripts/day-corpus.mjs ~/.claude/projects --split
 *   node proposals/Dreaming/scripts/day-corpus.mjs ~/.claude/projects --split 2026-08-28
 *
 * Every figure in `00-problem.md` and `02-what-a-day-contains.md` comes from
 * here. Days are cut on the record's own `timestamp`, not on file mtime — a
 * session that spans midnight belongs to both days, which is the boundary a
 * nightly job would actually have to draw.
 *
 * Cost is counterfactual, in the sense `docs/agent/metering.md` uses: the list
 * price of the same tokens on the API, at the rates in `src/lib/pricing.ts`.
 * The subscription this install runs on is not billed this way.
 */
import fs from "node:fs";
import path from "node:path";

// `src/lib/pricing.ts:33`-`:58` and `:16`-`:18`. Unknown models take the
// UNKNOWN_MODEL_PRICE of `:84` rather than contributing zero.
const PRICES = {
  "claude-opus-5": { i: 5, o: 25 },
  "claude-opus-4-8": { i: 5, o: 25 },
  "claude-opus-4-5": { i: 5, o: 25 },
  "claude-sonnet-5": { i: 2, o: 10 },
  "claude-haiku-4-5": { i: 1, o: 5 },
  "claude-fable-5": { i: 10, o: 50 },
};
const UNKNOWN = { i: 10, o: 50 };
const CACHE_READ = 0.1;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.0;

/** `src/lib/fileCostNotice.ts:87`. The app's own bytes-to-tokens constant. */
const BYTES_PER_TOKEN = 3.6;

const root = process.argv[2] ?? ".";
const wantSplit = process.argv.includes("--split");
const onlyDay = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? null;

/**
 * Which corpus a session belongs to, from its project directory name alone.
 *
 * This is the split the survey turns on and it is a heuristic, not a fact the
 * transcript records: nothing in a `.jsonl` says "a run spawned me". The
 * directory is the CLI's slugified cwd, so a worktree under `/uf-worktrees/`
 * is a run's checkout, a `/Users/...` path is the operator's own machine, and
 * a bare `/workspace...` path is a container checkout — this app's own agents
 * plus anything else started inside the container.
 */
function classify(dir) {
  if (dir.startsWith("-workspace--uf-worktrees-")) return "run-worktree";
  if (dir.startsWith("-Users-")) return "operator-host";
  if (dir.startsWith("-workspace")) return "container-checkout";
  return "other";
}

function* jsonlFiles(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name.endsWith(".jsonl")) yield p;
    }
  }
}

function blankBucket() {
  return {
    files: 0,
    records: 0,
    sessions: new Set(),
    rawBytes: 0,
    proseBytes: 0,
    toolUseBytes: 0,
    toolResultBytes: 0,
    thinking: 0,
    thinkingNonEmpty: 0,
    usd: 0,
  };
}

function requestUSD(message) {
  const usage = message?.usage;
  if (!usage) return 0;
  const price = PRICES[message.model] ?? UNKNOWN;
  const perIn = price.i / 1e6;
  const perOut = price.o / 1e6;
  const w5 = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const w1 = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  // Older records carry one flat `cache_creation_input_tokens` instead of the
  // per-TTL breakdown. Charged at the 5m rate, which under-counts a 1h write.
  const legacy = w5 || w1 ? 0 : (usage.cache_creation_input_tokens ?? 0);
  return (
    (usage.input_tokens ?? 0) * perIn +
    (usage.output_tokens ?? 0) * perOut +
    (usage.cache_read_input_tokens ?? 0) * perIn * CACHE_READ +
    (w5 + legacy) * perIn * CACHE_WRITE_5M +
    w1 * perIn * CACHE_WRITE_1H
  );
}

const byDay = new Map();
const byClass = new Map();

for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const klass = classify(dir.name);
  for (const file of jsonlFiles(path.join(root, dir.name))) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const touchedDays = new Set();
    let touchedClass = false;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const day = (record.timestamp ?? "").slice(0, 10);
      if (!day) continue;
      if (onlyDay && day !== onlyDay) continue;

      const targets = [];
      if (!byDay.has(day)) byDay.set(day, blankBucket());
      targets.push(byDay.get(day));
      if (wantSplit) {
        if (!byClass.has(klass)) byClass.set(klass, blankBucket());
        targets.push(byClass.get(klass));
      }
      touchedDays.add(day);
      touchedClass = true;

      const message = record.message;
      const usd = requestUSD(message);
      for (const t of targets) {
        t.records++;
        t.rawBytes += Buffer.byteLength(line) + 1;
        t.usd += usd;
        if (record.sessionId) t.sessions.add(record.sessionId);
      }
      if (!message) continue;
      if (typeof message.content === "string") {
        for (const t of targets) t.proseBytes += Buffer.byteLength(message.content);
        continue;
      }
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type === "text") {
          const n = Buffer.byteLength(block.text ?? "");
          for (const t of targets) t.proseBytes += n;
        } else if (block.type === "tool_use") {
          const n = Buffer.byteLength(JSON.stringify(block.input ?? {}));
          for (const t of targets) t.toolUseBytes += n;
        } else if (block.type === "tool_result") {
          const c = block.content;
          const n = Buffer.byteLength(typeof c === "string" ? c : JSON.stringify(c ?? ""));
          for (const t of targets) t.toolResultBytes += n;
        } else if (block.type === "thinking") {
          const nonEmpty = (block.thinking ?? "").trim().length > 0;
          for (const t of targets) {
            t.thinking++;
            if (nonEmpty) t.thinkingNonEmpty++;
          }
        }
      }
    }
    for (const day of touchedDays) byDay.get(day).files++;
    if (wantSplit && touchedClass) byClass.get(klass).files++;
  }
}

const mb = (n) => (n / 1048576).toFixed(2);
const tok = (n) => n / BYTES_PER_TOKEN;

if (wantSplit) {
  console.log(`corpus split${onlyDay ? ` for ${onlyDay}` : ""}:`);
  for (const [klass, b] of [...byClass].sort()) {
    console.log(
      `  ${klass.padEnd(19)} sessions ${String(b.sessions.size).padStart(4)}` +
        `  prose ${mb(b.proseBytes).padStart(7)} MB` +
        `  $${b.usd.toFixed(2).padStart(10)}` +
        `  thinking ${b.thinking}/${b.thinkingNonEmpty} non-empty`,
    );
  }
  console.log("");
}

const days = [...byDay.keys()].sort();
console.log("day         sessions   rawMB  proseMB  proseTok  opus$  haiku$   dayBill$");
let totals = { raw: 0, prose: 0, usd: 0, sessions: 0 };
for (const day of days) {
  const b = byDay.get(day);
  const t = tok(b.proseBytes);
  console.log(
    `${day} ${String(b.sessions.size).padStart(9)} ${mb(b.rawBytes).padStart(7)}` +
      ` ${mb(b.proseBytes).padStart(8)} ${(t / 1000).toFixed(0).padStart(8)}k` +
      ` ${((t * 5) / 1e6).toFixed(2).padStart(6)} ${((t * 1) / 1e6).toFixed(2).padStart(7)}` +
      ` ${b.usd.toFixed(2).padStart(10)}`,
  );
  totals.raw += b.rawBytes;
  totals.prose += b.proseBytes;
  totals.usd += b.usd;
  totals.sessions += b.sessions.size;
}
const n = days.length || 1;
console.log("");
console.log(
  `mean over ${n} days: ${(totals.sessions / n).toFixed(1)} sessions,` +
    ` ${mb(totals.raw / n)} MB raw, ${mb(totals.prose / n)} MB prose` +
    ` = ${(tok(totals.prose / n) / 1000).toFixed(0)}k tokens`,
);
console.log(
  `reading the prose once at opus-5 input: mean $${((tok(totals.prose / n) * 5) / 1e6).toFixed(2)}/day` +
    `, whole raw corpus: $${((tok(totals.raw / n) * 5) / 1e6).toFixed(2)}/day`,
);
console.log(`day bill (counterfactual, list rates): mean $${(totals.usd / n).toFixed(2)}`);
