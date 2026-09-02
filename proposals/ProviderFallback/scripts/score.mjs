#!/usr/bin/env node
// Recomputes 12-comparison.md's weighted table and its sensitivity runs.
//
// Dependency-free, read-only, Node >= 20.  Run from anywhere:
//   node proposals/ProviderFallback/scripts/score.mjs
//
// Scores are 1-5, higher is better.  Each one is argued in the option file
// named in OPTIONS; this script only does the arithmetic, so that a reader who
// disagrees with a weight can change one number here and see the ranking move
// rather than take the table's word for it.

const OPTIONS = {
  A: "03-option-a-park-as-today.md",
  B: "04-option-b-fallback-at-the-refusal.md",
  C: "05-option-c-provider-at-spawn.md",
  D: "06-option-d-per-template-opt-in.md",
  E: "07-option-e-workflow-retry-block.md",
};

const CRITERIA = [
  // key, label, weight, {A,B,C,D,E}
  ["throughput", "Throughput when the allowance is gone", 4, { A: 1, B: 5, C: 3, D: 3, E: 2 }],
  ["disclosure", "The operator is told the truth", 5, { A: 5, B: 2, C: 4, D: 4, E: 5 }],
  ["money", "Money stays bounded", 5, { A: 5, B: 1, C: 2, D: 3, E: 3 }],
  ["containment", "Containment parity", 5, { A: 5, B: 1, C: 2, D: 1, E: 2 }],
  ["continuity", "Continuity preserved", 4, { A: 5, B: 1, C: 4, D: 4, E: 5 }],
  ["radius", "Blast radius controlled at a wall", 4, { A: 5, B: 1, C: 4, D: 2, E: 4 }],
  ["build", "Cost to build (inverse)", 4, { A: 5, B: 2, C: 1, D: 1, E: 1 }],
  ["unknowns", "Independence from unresolved Codex unknowns", 4, { A: 5, B: 1, C: 2, D: 2, E: 2 }],
  ["loud", "Failures are loud", 4, { A: 5, B: 1, C: 3, D: 2, E: 4 }],
  ["fit", "Fit with docs/agent/ invariants", 3, { A: 5, B: 2, C: 4, D: 3, E: 3 }],
];

const KEYS = Object.keys(OPTIONS);

function score(overrideWeights = {}, overrideScores = {}) {
  const totals = Object.fromEntries(KEYS.map((k) => [k, 0]));
  for (const [key, , weight, scores] of CRITERIA) {
    const w = overrideWeights[key] ?? weight;
    for (const opt of KEYS) {
      const s = overrideScores[key]?.[opt] ?? scores[opt];
      totals[opt] += w * s;
    }
  }
  return totals;
}

function winner(totals) {
  const best = Math.max(...Object.values(totals));
  return KEYS.filter((k) => totals[k] === best).join("/");
}

function row(label, totals) {
  const cells = KEYS.map((k) => String(totals[k]).padStart(4)).join(" ");
  return `${label.padEnd(56)} ${cells}   → ${winner(totals)}`;
}

const weightSum = CRITERIA.reduce((a, [, , w]) => a + w, 0);

console.log("Criteria and weights");
console.log("--------------------");
for (const [, label, weight, scores] of CRITERIA) {
  const cells = KEYS.map((k) => String(scores[k]).padStart(4)).join(" ");
  console.log(`w${String(weight).padStart(2)}  ${label.padEnd(50)} ${cells}`);
}
console.log(`      ${"weight sum".padEnd(50)} ${String(weightSum).padStart(4)}`);
console.log();

const base = score();
console.log("Totals" + " ".repeat(51) + KEYS.map((k) => k.padStart(4)).join(" "));
console.log("-".repeat(76));
console.log(row("base", base));

// --- Sensitivity -----------------------------------------------------------
//
// Each run answers "what would have to be believed for the ranking to change".

console.log(
  row(
    "throughput weighted 12 (a wall is the whole problem)",
    score({ throughput: 12 }),
  ),
);
console.log(
  row(
    "containment + money weighted 2 (the container is enough)",
    score({ containment: 2, money: 2 }),
  ),
);
console.log(
  row(
    "every Codex unknown resolved favourably",
    score({}, { unknowns: { A: 5, B: 5, C: 5, D: 5, E: 5 } }),
  ),
);
console.log(
  row(
    "build cost weighted 1 (time is free)",
    score({ build: 1 }),
  ),
);
console.log(
  row(
    "all four of the above, together",
    score(
      { throughput: 12, containment: 2, money: 2, build: 1 },
      { unknowns: { A: 5, B: 5, C: 5, D: 5, E: 5 } },
    ),
  ),
);

// --- What it would take for A to lose --------------------------------------
//
// A's only low score is throughput.  Solve for the weight at which each rival
// ties it, holding everything else at base.

console.log();
console.log("Weight on 'throughput' at which each option ties A");
console.log("--------------------------------------------------");
const throughputScores = CRITERIA.find(([k]) => k === "throughput")[3];
const baseWeight = CRITERIA.find(([k]) => k === "throughput")[2];
for (const opt of KEYS.filter((k) => k !== "A")) {
  const restA = base.A - baseWeight * throughputScores.A;
  const restX = base[opt] - baseWeight * throughputScores[opt];
  const delta = throughputScores[opt] - throughputScores.A;
  if (delta <= 0) {
    console.log(`  ${opt}: never — it scores no higher than A on throughput`);
    continue;
  }
  const w = (restA - restX) / delta;
  console.log(
    `  ${opt}: ${w.toFixed(1)}  (against a highest weight anywhere else of 5)`,
  );
}
