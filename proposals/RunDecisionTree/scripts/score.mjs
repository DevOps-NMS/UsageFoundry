// Recompute 09-comparison.md's weighted table and its sensitivity runs.
//
// Here so the scores are checkable rather than asserted — the weights are a
// judgement call, the arithmetic is not.
//
//   node scripts/score.mjs

const W = {
  faith: 5, // faithfulness of the `why`
  density: 4, // density of the `why`
  rejected: 3, // answers "what was rejected"
  retro: 4, // retroactive coverage
  retention: 4, // survives retention
  subagent: 3, // sub-agent visibility
  resume: 3, // resume / seam correctness
  build: 4, // cost to build (inverse)
  cost: 2, // cost per run (inverse)
  risk: 5, // risk of misleading the operator (inverse)
};

const S = {
  A: { faith: 4, density: 2, rejected: 1, retro: 5, retention: 1, subagent: 2, resume: 2, build: 4, cost: 5, risk: 5 },
  B: { faith: 4, density: 2, rejected: 1, retro: 4, retention: 5, subagent: 2, resume: 4, build: 3, cost: 5, risk: 5 },
  C: { faith: 2, density: 5, rejected: 4, retro: 4, retention: 5, subagent: 2, resume: 4, build: 1, cost: 4, risk: 2 },
  D: { faith: 5, density: 4, rejected: 5, retro: 1, retention: 5, subagent: 5, resume: 3, build: 3, cost: 5, risk: 4 },
  E: { faith: 4, density: 2, rejected: 1, retro: 5, retention: 5, subagent: 5, resume: 4, build: 5, cost: 5, risk: 5 },
};

const total = (s, w) => Object.keys(w).reduce((n, k) => n + s[k] * w[k], 0);
const row = (label, scores, w) => {
  const t = Object.fromEntries(Object.entries(scores).map(([k, s]) => [k, total(s, w)]));
  const best = Object.entries(t).sort((a, b) => b[1] - a[1])[0][0];
  console.log(
    `${label.padEnd(42)} ` +
      Object.entries(t)
        .map(([k, v]) => `${k}=${String(v).padStart(3)}`)
        .join("  ") +
      `   → ${best}`,
  );
};

console.log(`weights sum to ${Object.values(W).reduce((a, b) => a + b)}\n`);
row("base", S, W);
row('"retroactive coverage" → weight 2', S, { ...W, retro: 2 });
row('"density" → 5, "risk" → 3', S, { ...W, density: 5, risk: 3 });

const heavy = JSON.parse(JSON.stringify(S));
heavy.A.subagent = heavy.B.subagent = heavy.C.subagent = 1;
row("fleet delegates heavily", heavy, W);

row("retention horizon off (weight 0)", S, { ...W, retention: 0 });
