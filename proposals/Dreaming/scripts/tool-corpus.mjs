#!/usr/bin/env node
/**
 * The shape of "tools and outputs" as a corpus, per day.
 *
 *   node proposals/Dreaming/scripts/tool-corpus.mjs ~/.claude/projects
 *
 * `slices.mjs` prices the slices as means. This asks the two questions a
 * writer over the *whole* tool corpus has to answer and a mean cannot:
 *
 *   1. Does one day fit in one context? Cross-session synthesis is the whole
 *      claim of a daily pass, and a reader that has to chunk a day is not
 *      doing it — it is doing several within-chunk syntheses and stapling
 *      them. The comparison is against a 1,000k-token window, the largest
 *      this install has.
 *   2. How much of the corpus carries a deduplication key at all? An error
 *      result has a message, so `recurrence.mjs` and `ledger.mjs` can treat
 *      it as an object with an identity across nights. A *successful* tool
 *      result has no such handle: two identical `Read`s of the same file on
 *      two nights are the same event with nothing to match on but the model's
 *      own judgement, which is the unverified step `01-constraints.md` C6
 *      is about.
 *
 * Bytes convert at BYTES_PER_TOKEN = 3.6 (`src/lib/fileCostNotice.ts:87`) and
 * price at claude-opus-5 input, $5/Mtok (`src/lib/pricing.ts:38`).
 */
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] ?? ".";
const BYTES_PER_TOKEN = 3.6;
const USD_PER_MTOK_IN = 5;
const CONTEXT = 1_000_000;

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

const blank = () => ({
  useBytes: 0,
  useCount: 0,
  okBytes: 0,
  okCount: 0,
  errBytes: 0,
  errCount: 0,
});

/** day -> counters */
const byDay = new Map();
/** tool name -> calls */
const byTool = new Map();

for (const file of jsonlFiles(root)) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const day = (record.timestamp ?? "").slice(0, 10);
    const content = record.message?.content;
    if (!day || !Array.isArray(content)) continue;
    if (!byDay.has(day)) byDay.set(day, blank());
    const d = byDay.get(day);
    for (const block of content) {
      if (block.type === "tool_use") {
        d.useCount++;
        d.useBytes += Buffer.byteLength(JSON.stringify(block.input ?? ""), "utf8");
        const name = block.name ?? "(unnamed)";
        byTool.set(name, (byTool.get(name) ?? 0) + 1);
      } else if (block.type === "tool_result") {
        const text =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");
        const bytes = Buffer.byteLength(text, "utf8");
        if (block.is_error) {
          d.errCount++;
          d.errBytes += bytes;
        } else {
          d.okCount++;
          d.okBytes += bytes;
        }
      }
    }
  }
}

const days = [...byDay.keys()].sort();
const tok = (b) => b / BYTES_PER_TOKEN;
const usd = (b) => (tok(b) / 1e6) * USD_PER_MTOK_IN;

console.log(
  "day          tool_use   results    errors   corpus tok    opus   fits 1M?",
);
let sumTok = 0;
let overflow = 0;
const totals = blank();
for (const day of days) {
  const d = byDay.get(day);
  const bytes = d.useBytes + d.okBytes + d.errBytes;
  const t = tok(bytes);
  sumTok += t;
  const fits = t <= CONTEXT;
  if (!fits) overflow++;
  for (const k of Object.keys(totals)) totals[k] += d[k];
  console.log(
    `${day} ${String(d.useCount).padStart(9)} ${String(d.okCount).padStart(9)} ` +
      `${String(d.errCount).padStart(9)} ${(t / 1000).toFixed(0).padStart(10)}k ` +
      `${("$" + usd(bytes).toFixed(2)).padStart(7)}   ${fits ? "yes" : `no  ×${(t / CONTEXT).toFixed(1)}`}`,
  );
}

const allBytes = totals.useBytes + totals.okBytes + totals.errBytes;
console.log("");
console.log(
  `mean day: ${(sumTok / days.length / 1000).toFixed(0)}k tokens,` +
    ` $${(usd(allBytes) / days.length).toFixed(2)} at opus input`,
);
console.log(
  `days that do not fit a 1,000k window: ${overflow} of ${days.length}` +
    ` (${((100 * overflow) / days.length).toFixed(0)}%)`,
);

console.log("");
console.log("the corpus, split on whether it carries a deduplication key");
const keyed = totals.errBytes;
const unkeyed = totals.useBytes + totals.okBytes;
console.log(
  `  error results  — a message, so a signature:   ${totals.errCount} blocks,` +
    ` ${(keyed / 1048576).toFixed(2)} MiB (${((100 * keyed) / allBytes).toFixed(1)}%)`,
);
console.log(
  `  ok results + inputs — no signature:           ${totals.okCount + totals.useCount} blocks,` +
    ` ${(unkeyed / 1048576).toFixed(2)} MiB (${((100 * unkeyed) / allBytes).toFixed(1)}%)`,
);

console.log("");
console.log("the 12 most-called tools:");
for (const [name, n] of [...byTool].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(7)}  ${name}`);
}
