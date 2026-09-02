#!/usr/bin/env node
/**
 * The weighted score in `13-comparison.md`, so it can be re-run rather than
 * trusted.
 *
 *   node proposals/Dreaming/scripts/score.mjs
 *   node proposals/Dreaming/scripts/score.mjs --drop licensed,retirement
 *   node proposals/Dreaming/scripts/score.mjs --weight asked=10
 *
 * The `--drop` and `--weight` flags exist because a weighted score is an
 * argument about weights, and the honest way to publish one is to make
 * disagreeing with it cost one command. `13-comparison.md` §4 records what the
 * obvious disagreements do.
 */

const CRITERIA = [
  {
    key: "asked",
    weight: 4,
    label: "does what was asked",
    why: "reads a day's sessions and produces a learning. The brief's own words; weighted below the safety criteria because three proposals in this directory recommend against their own subject and were right to.",
  },
  {
    key: "licensed",
    weight: 5,
    label: "licensed by the destination",
    why: "src/lib/knowledge.ts:39 refuses the write; /workspace2/AGENTS.md:115 permits exactly one shape; _Meta/qc.py fails the operator's whole vault on a malformed note.",
  },
  {
    key: "authorised",
    weight: 4,
    label: "authorised spend",
    why: "src/lib/review.ts:34-35 — spend nobody asked for is spend nobody authorised. A press asks; a clock does not.",
  },
  {
    key: "retirement",
    weight: 5,
    label: "a wrong item can be found and retracted",
    why: "/workspace2 has no .git. Retrieval selects rather than averages, so the consequence of a wrong item does not scale with the rate it is produced at.",
  },
  {
    key: "dedup",
    weight: 4,
    label: "deduplicates across days",
    why: "measured: 13.5% of a night's distinct signatures were seen earlier, 30.3% of instances, 49.5% of all instances belong to a multi-day signature.",
  },
  {
    key: "corpus",
    weight: 4,
    label: "input is machine-established, output is not diagnosis",
    why: "48,978 thinking blocks with 13 non-empty bodies; unverified failing-step diagnosis measured at 14.2% on the nearest benchmark.",
  },
  {
    key: "visible",
    weight: 3,
    label: "an operator can watch it and stop it",
    why: "every view in this app is keyed on a runs row; anything outside the run loop is invisible until its output appears.",
  },
  {
    key: "cost",
    weight: 2,
    label: "cheap per week against a $956.09 day",
    why: "low weight on purpose: the cost limb of the ContinuousImprovement Option G refusal does not reach this feature, and pretending it does would be dishonest.",
  },
  {
    key: "build",
    weight: 2,
    label: "cheap to build",
    why: "low weight: this survey is about whether to build, not about what fits in a sprint.",
  },
  {
    key: "blast",
    weight: 5,
    label: "a mistake cannot damage the operator's own store",
    why: "the vault is a live document store a person edits in another application — knowledge.ts:39-44's stated reason for being read-only.",
  },
];

const OPTIONS = [
  {
    id: "A",
    name: "nightly transcript pass -> vault",
    scores: { asked: 5, licensed: 0, authorised: 0, retirement: 1, dedup: 1, corpus: 1, visible: 0, cost: 3, build: 1, blast: 0 },
  },
  {
    id: "B",
    name: "nightly rows pass -> vault",
    scores: { asked: 3, licensed: 0, authorised: 0, retirement: 1, dedup: 1, corpus: 4, visible: 0, cost: 4, build: 1, blast: 0 },
  },
  {
    id: "C",
    name: "failures-only pass -> vault",
    scores: { asked: 2, licensed: 0, authorised: 0, retirement: 1, dedup: 3, corpus: 4, visible: 0, cost: 5, build: 2, blast: 0 },
  },
  {
    id: "D",
    name: "question capture into the quarantine, on a press",
    scores: { asked: 2, licensed: 5, authorised: 5, retirement: 5, dedup: 4, corpus: 3, visible: 4, cost: 4, build: 2, blast: 3 },
  },
  {
    id: "E",
    name: "pressed day-read -> vault proper",
    scores: { asked: 4, licensed: 0, authorised: 5, retirement: 3, dedup: 3, corpus: 1, visible: 4, cost: 4, build: 1, blast: 1 },
  },
  {
    id: "F",
    name: "composed workflow on a daily schedule",
    scores: { asked: 5, licensed: 0, authorised: 3, retirement: 1, dedup: 0, corpus: 1, visible: 5, cost: 2, build: 5, blast: 0 },
  },
  {
    id: "G",
    name: "the recurrence readout — no model, no write",
    scores: { asked: 1, licensed: 5, authorised: 5, retirement: 5, dedup: 5, corpus: 5, visible: 5, cost: 5, build: 4, blast: 5 },
  },
];

const dropped = new Set(
  (process.argv.find((a) => a.startsWith("--drop="))?.slice(7) ??
    (process.argv.includes("--drop") ? process.argv[process.argv.indexOf("--drop") + 1] : "") ??
    "")
    .split(",")
    .filter(Boolean),
);

const overrides = new Map();
for (const arg of process.argv) {
  const m = /^--weight[= ]?(\w+)=(\d+(?:\.\d+)?)$/.exec(arg);
  if (m) overrides.set(m[1], Number(m[2]));
}
const weightIdx = process.argv.indexOf("--weight");
if (weightIdx !== -1 && process.argv[weightIdx + 1]?.includes("=")) {
  const [k, v] = process.argv[weightIdx + 1].split("=");
  overrides.set(k, Number(v));
}

const active = CRITERIA.filter((c) => !dropped.has(c.key)).map((c) => ({
  ...c,
  weight: overrides.get(c.key) ?? c.weight,
}));
const maxScore = active.reduce((s, c) => s + c.weight * 5, 0);

const scored = OPTIONS.map((o) => ({
  ...o,
  total: active.reduce((s, c) => s + c.weight * (o.scores[c.key] ?? 0), 0),
})).sort((a, b) => b.total - a.total);

if (dropped.size) console.log(`dropped: ${[...dropped].join(", ")}`);
if (overrides.size)
  console.log(`reweighted: ${[...overrides].map(([k, v]) => `${k}=${v}`).join(", ")}`);
console.log(`criteria: ${active.length}, total weight ${active.reduce((s, c) => s + c.weight, 0)}, max ${maxScore}\n`);

const header = ["opt", ...active.map((c) => c.key.slice(0, 5).padStart(6)), "  total"].join(" ");
console.log(header);
console.log("-".repeat(header.length));
for (const o of scored) {
  console.log(
    [
      ` ${o.id} `,
      ...active.map((c) => String(o.scores[c.key] ?? 0).padStart(6)),
      String(o.total).padStart(7),
    ].join(" ") + `  ${o.name}`,
  );
}
console.log("");
console.log(`winner: ${scored[0].id} at ${scored[0].total}/${maxScore}, ahead of ${scored[1].id} by ${scored[0].total - scored[1].total}`);
