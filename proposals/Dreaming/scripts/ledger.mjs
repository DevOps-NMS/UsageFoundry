#!/usr/bin/env node
/**
 * What a deduplication ledger actually buys, and what a write policy costs.
 *
 *   node proposals/Dreaming/scripts/ledger.mjs ~/.claude/projects
 *
 * `recurrence.mjs` measures how much of a night's material a previous night
 * already covered. That is the size of the problem. This measures the three
 * write policies a nightly writer could adopt against it, because "dedupe"
 * is not one behaviour and the three differ by an order of magnitude in how
 * many notes they put in somebody's document store:
 *
 *   none    — write every distinct signature every night it appears
 *   first   — a ledger; write a signature the first night it is seen, once
 *   second  — write a signature the night it is seen on a *second* day
 *
 * The third is the interesting one and it is not obvious: it converts the
 * feature from "write what broke" to "write what keeps breaking", which is
 * the half `11-deduplication-and-retirement.md` §1 argues is worth writing.
 * The cost it pays is latency — a standing problem goes unwritten until it
 * recurs — and that latency is measured here rather than assumed.
 *
 * Signature normalisation is `recurrence.mjs`'s, deliberately, so the two
 * scripts are talking about the same objects. Its limits are that file's and
 * they carry: two failures with one cause produce two signatures, and one
 * signature can carry two causes.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] ?? ".";

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

/** day -> Set<signature> */
const byDay = new Map();

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
        typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content ?? "");
      const sig = signatureOf(text);
      if (!sig) continue;
      if (!byDay.has(day)) byDay.set(day, new Set());
      byDay.get(day).add(sig);
    }
  }
}

const days = [...byDay.keys()].sort();

/** signature -> the ordered list of day indices it appeared on */
const appearances = new Map();
days.forEach((day, i) => {
  for (const sig of byDay.get(day)) {
    if (!appearances.has(sig)) appearances.set(sig, []);
    appearances.get(sig).push(i);
  }
});

// ---------------------------------------------------------------- the policies

const seenEver = new Set();
let notesNone = 0;
let notesFirst = 0;
let notesSecond = 0;
const perDay = [];

for (const [i, day] of days.entries()) {
  const sigs = byDay.get(day);
  let none = 0;
  let first = 0;
  let second = 0;
  for (const sig of sigs) {
    none++;
    if (!seenEver.has(sig)) first++;
    // The second policy writes on the night a signature reaches its second
    // *day*, which is the first night on which recurrence is a fact rather
    // than a forecast.
    if (appearances.get(sig)[1] === i) second++;
  }
  for (const sig of sigs) seenEver.add(sig);
  notesNone += none;
  notesFirst += first;
  notesSecond += second;
  perDay.push({ day, none, first, second });
}

console.log("notes a night's writer would add to the vault, by policy\n");
console.log("day            none    first   second");
for (const r of perDay) {
  console.log(
    `${r.day} ${String(r.none).padStart(8)} ${String(r.first).padStart(8)} ${String(
      r.second,
    ).padStart(8)}`,
  );
}
console.log("-".repeat(38));
console.log(
  `total      ${String(notesNone).padStart(8)} ${String(notesFirst).padStart(8)} ${String(
    notesSecond,
  ).padStart(8)}`,
);

// ------------------------------------------------------- what each policy wrote

const oneOff = [...appearances.values()].filter((a) => a.length < 2).length;
const recurring = appearances.size - oneOff;

console.log("");
console.log(`distinct signatures over ${days.length} days: ${appearances.size}`);
console.log(
  `  seen on exactly one day: ${oneOff}` +
    ` (${((100 * oneOff) / appearances.size).toFixed(1)}%)`,
);
console.log(
  `  seen on two or more:     ${recurring}` +
    ` (${((100 * recurring) / appearances.size).toFixed(1)}%)`,
);
console.log("");
console.log(
  `policy "none":   ${notesNone} notes, of which ${notesNone - notesFirst} are` +
    ` exact re-writes of a note already in the vault`,
);
console.log(
  `policy "first":  ${notesFirst} notes, of which ${oneOff}` +
    ` (${((100 * oneOff) / notesFirst).toFixed(1)}%) are about something that never recurred`,
);
console.log(
  `policy "second": ${notesSecond} notes, all of which are about something that` +
    ` happened on at least two days`,
);

// ------------------------------------------------------ the latency it pays for

const gaps = [];
for (const a of appearances.values()) {
  if (a.length < 2) continue;
  gaps.push(a[1] - a[0]);
}
gaps.sort((x, y) => x - y);
const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
const mean = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;
const sameNext = gaps.filter((g) => g === 1).length;

console.log("");
console.log("what the \"second\" policy pays for it — days between 1st and 2nd sighting");
console.log(
  `  n=${gaps.length}  median ${median}  mean ${mean.toFixed(1)}` +
    `  min ${gaps[0] ?? 0}  max ${gaps[gaps.length - 1] ?? 0}`,
);
console.log(
  `  recurred on the very next day with material: ${sameNext} of ${gaps.length}` +
    ` (${((100 * sameNext) / (gaps.length || 1)).toFixed(0)}%)`,
);

// --------------------------------------------------------- the note's shelf life

const afterWrite = [];
for (const a of appearances.values()) {
  if (a.length < 2) continue;
  // Written on the second sighting; how many further days did it keep
  // occurring? This is the window in which the note was doing work.
  afterWrite.push(a.length - 2);
}
const stillRecurring = afterWrite.filter((n) => n > 0).length;
console.log("");
console.log(
  `of the ${notesSecond} notes the "second" policy writes, ${stillRecurring}` +
    ` (${((100 * stillRecurring) / (notesSecond || 1)).toFixed(0)}%) describe something that` +
    ` occurred again after the note existed`,
);
console.log(
  "  — which is the closest this corpus comes to measuring whether writing it down helped,",
);
console.log(
  "    and it is not that measurement: nothing here knows whether anybody read the note.",
);
