#!/usr/bin/env node
/**
 * How much of a night's material a previous night already covered.
 *
 *   node proposals/Dreaming/scripts/recurrence.mjs ~/.claude/projects
 *   node proposals/Dreaming/scripts/recurrence.mjs ~/.claude/projects --top 12
 *
 * Deduplication is the failure mode a *daily* cadence has and a per-run one
 * does not, so it needs a number rather than an intuition. The proxy is the
 * only machine-established fact a day's sessions carry in quantity: a tool
 * result marked `is_error`. It is a proxy and its limits are stated in
 * `10-deduplication-and-retirement.md` — two failures with one cause produce
 * two signatures, and one signature can carry two causes.
 *
 * Signatures are normalised so that the same failure at a different path, pid
 * or hash collapses to one: numbers to `N`, hex runs to `HASH`, path interiors
 * to `/PATH/`, whitespace flattened, first 400 bytes only. That is deliberately
 * aggressive — it is the *upper* bound on how well a nightly writer could
 * dedupe, because it dedupes strings it can see rather than lessons it cannot.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] ?? ".";
const topN = Number(process.argv[process.argv.indexOf("--top") + 1]) || 8;

const signatureOf = (text) =>
  text
    .slice(0, 400)
    .replace(/0x[0-9a-f]+/gi, "0xH")
    .replace(/\b[0-9a-f]{7,40}\b/gi, "HASH")
    .replace(/\d+/g, "N")
    .replace(/\/[^\s:]*\//g, "/PATH/")
    .replace(/\s+/g, " ")
    .trim();

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

/** day -> signature -> instances */
const byDay = new Map();
const totalInstances = new Map();

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
    for (const block of content) {
      if (block.type !== "tool_result" || !block.is_error) continue;
      const text =
        typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      const sig = signatureOf(text);
      if (!sig) continue;
      if (!byDay.has(day)) byDay.set(day, new Map());
      const m = byDay.get(day);
      m.set(sig, (m.get(sig) ?? 0) + 1);
      totalInstances.set(sig, (totalInstances.get(sig) ?? 0) + 1);
    }
  }
}

const days = [...byDay.keys()].sort();
const seen = new Set();
let repeatDistinct = 0;
let allDistinct = 0;
let repeatInstances = 0;
let allInstances = 0;

console.log("day         distinct  seen-before   %   instances  from-seen-before   %");
for (const day of days) {
  const m = byDay.get(day);
  let rd = 0;
  let ri = 0;
  let ti = 0;
  for (const [sig, n] of m) {
    ti += n;
    if (seen.has(sig)) {
      rd++;
      ri += n;
    }
  }
  console.log(
    `${day} ${String(m.size).padStart(9)} ${String(rd).padStart(12)} ${((100 * rd) / m.size)
      .toFixed(0)
      .padStart(4)}% ${String(ti).padStart(11)} ${String(ri).padStart(17)} ${((100 * ri) / ti)
      .toFixed(0)
      .padStart(4)}%`,
  );
  repeatDistinct += rd;
  allDistinct += m.size;
  repeatInstances += ri;
  allInstances += ti;
  for (const sig of m.keys()) seen.add(sig);
}

const daySpan = new Map();
for (const day of days) {
  for (const sig of byDay.get(day).keys()) daySpan.set(sig, (daySpan.get(sig) ?? 0) + 1);
}
let multiDaySignatures = 0;
let multiDayInstances = 0;
for (const [sig, span] of daySpan) {
  if (span < 2) continue;
  multiDaySignatures++;
  multiDayInstances += totalInstances.get(sig);
}

console.log("");
console.log(
  `distinct signatures: ${daySpan.size}; instances: ${allInstances}` +
    ` over ${days.length} days`,
);
console.log(
  `a day's distinct signatures already seen on an earlier day:` +
    ` ${repeatDistinct} of ${allDistinct} (${((100 * repeatDistinct) / allDistinct).toFixed(1)}%)`,
);
console.log(
  `a day's instances whose signature was seen earlier:` +
    ` ${repeatInstances} of ${allInstances} (${((100 * repeatInstances) / allInstances).toFixed(1)}%)`,
);
console.log(
  `signatures spanning >=2 days: ${multiDaySignatures}` +
    ` (${((100 * multiDaySignatures) / daySpan.size).toFixed(1)}% of distinct),` +
    ` carrying ${multiDayInstances} of ${allInstances} instances` +
    ` (${((100 * multiDayInstances) / allInstances).toFixed(1)}%)`,
);
console.log("");
console.log(`the ${topN} signatures spanning the most days:`);
for (const [sig, span] of [...daySpan].sort((a, b) => b[1] - a[1]).slice(0, topN)) {
  console.log(`  ${String(span).padStart(3)} days  ${sig.slice(0, 110)}`);
}
