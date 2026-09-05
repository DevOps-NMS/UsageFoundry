// The comparison table's arithmetic. `node proposals/OrchestratorChatQuality/score.mjs`
//
// Seven criteria, weighted. Scores are 1-5 and every one of them is a judgement
// argued in the option's own file — this script does the multiplication, not the
// judging. Change a weight and re-run to see whether the ranking is robust to it;
// 09-comparison.md records which weights the ranking survives.

const CRITERIA = [
  { key: "evidence", weight: 5, label: "Evidential strength — observed, or reasoned from text" },
  { key: "cost", weight: 5, label: "Cost of the failure it prevents" },
  { key: "cheap", weight: 3, label: "Cheapness to implement (5 = a few lines)" },
  { key: "safe", weight: 4, label: "Low risk of breaking an instruction that measures well" },
  { key: "check", weight: 3, label: "Verifiable after shipping, from transcripts alone" },
  { key: "freq", weight: 3, label: "How often the failure fires in the corpus" },
  { key: "place", weight: 3, label: "Fix lands where the decision is actually made" },
];

const OPTIONS = {
  "A — change nothing": { evidence: 5, cost: 1, cheap: 5, safe: 5, check: 1, freq: 1, place: 1 },
  "B — name the asking tool": { evidence: 5, cost: 4, cheap: 5, safe: 4, check: 5, freq: 5, place: 5 },
  "C — standing instructions": { evidence: 5, cost: 4, cheap: 5, safe: 5, check: 5, freq: 1, place: 5 },
  "D — the edge pair": { evidence: 4, cost: 5, cheap: 4, safe: 3, check: 3, freq: 3, place: 5 },
  "E — the duplicate check": { evidence: 2, cost: 2, cheap: 5, safe: 5, check: 4, freq: 3, place: 4 },
  "F — the approval order": { evidence: 5, cost: 3, cheap: 5, safe: 5, check: 3, freq: 3, place: 3 },
};

const MAX = CRITERIA.reduce((n, c) => n + c.weight * 5, 0);
const rows = Object.entries(OPTIONS).map(([name, s]) => ({
  name,
  total: CRITERIA.reduce((n, c) => n + c.weight * s[c.key], 0),
  s,
}));
rows.sort((a, b) => b.total - a.total);

const w = Math.max(...rows.map((r) => r.name.length));
console.log(`Criteria (weight):`);
for (const c of CRITERIA) console.log(`  ${String(c.weight)} × ${c.label}`);
console.log(`\nMaximum possible: ${MAX}\n`);
console.log(`${"".padEnd(w)}  ${CRITERIA.map((c) => c.key.padStart(8)).join(" ")}    total`);
for (const r of rows) {
  console.log(
    `${r.name.padEnd(w)}  ${CRITERIA.map((c) => String(r.s[c.key]).padStart(8)).join(" ")}    ${String(r.total).padStart(5)}`,
  );
}

console.log(`\nRanking: ${rows.map((r) => `${r.name.split(" — ")[0]} ${r.total}`).join(" > ")}`);
const ties = rows.filter((r, i) => i > 0 && r.total === rows[i - 1].total);
if (ties.length) console.log(`Tied: ${ties.map((t) => t.name).join(", ")} — see 09-comparison.md for the tiebreak.`);
