// The arithmetic behind 10-comparison.md, so it can be checked rather than
// believed. `node proposals/ChatPanelExperience/score.mjs`
//
// Scores are 0–3 and every one of them is a judgement; the weights are the
// argument. What the script buys is that the ranking cannot be quietly wrong
// about its own addition.

const CRITERIA = [
  // Weight 5: an interface that asserts something the code contradicts is a
  // different class of defect from one that is merely quiet. Six of the
  // findings are of this kind (see 02-option-a).
  { key: "misled", weight: 5, label: "Closes a finding where the panel currently misleads" },
  // Weight 3: things an operator cannot do. Real, and recoverable by leaving
  // the page — which is what makes them cheaper than the row above.
  { key: "cannot", weight: 3, label: "Closes a finding where an operator cannot do something" },
  // Weight 3: the brief's central question. Scored apart from the two above so
  // an option that answers everything except the wait cannot look like it did.
  { key: "wait", weight: 3, label: "Answers the ten-minute silent wait specifically" },
  // Weight 4, inverted: this repository's verification loop is typecheck plus a
  // hand smoke test, so a change's cost is dominated by how much of it nothing
  // can check.
  { key: "cheap", weight: 4, label: "Cheap — lines, surfaces, and no migration" },
  // Weight 5, inverted: the approval route and the spawn path are the two
  // surfaces where a mistake starts a billed agent under the wrong rules.
  { key: "safe", weight: 5, label: "Touches nothing on the approval or spawn path" },
  // Weight 2: an option that makes another one work is worth more than its own
  // score. E without G makes the batch worse (measured); B is the prerequisite
  // for C's honest cost readout.
  { key: "unblocks", weight: 2, label: "Unblocks or is required by another option" },
];

const OPTIONS = {
  "A change nothing":            { misled: 0, cannot: 0, wait: 0, cheap: 3, safe: 3, unblocks: 0 },
  "B name the clock":            { misled: 3, cannot: 1, wait: 2, cheap: 3, safe: 3, unblocks: 2 },
  "C live activity feed":        { misled: 2, cannot: 3, wait: 3, cheap: 0, safe: 1, unblocks: 1 },
  "D legible endings":           { misled: 3, cannot: 2, wait: 0, cheap: 3, safe: 3, unblocks: 0 },
  "E open the proposal":         { misled: 3, cannot: 3, wait: 0, cheap: 3, safe: 3, unblocks: 1 },
  "F amend before approving":    { misled: 0, cannot: 3, wait: 0, cheap: 1, safe: 0, unblocks: 0 },
  "G room for the list":         { misled: 2, cannot: 2, wait: 0, cheap: 3, safe: 3, unblocks: 3 },
  "H reach the history":         { misled: 1, cannot: 2, wait: 0, cheap: 2, safe: 3, unblocks: 0 },
};

const rows = Object.entries(OPTIONS).map(([name, s]) => ({
  name,
  total: CRITERIA.reduce((n, c) => n + c.weight * s[c.key], 0),
  s,
}));
rows.sort((a, b) => b.total - a.total);

const width = Math.max(...rows.map((r) => r.name.length));
console.log(
  "".padEnd(width),
  CRITERIA.map((c) => `${c.key}×${c.weight}`.padStart(11)).join(" "),
  "  total",
);
for (const r of rows) {
  console.log(
    r.name.padEnd(width),
    CRITERIA.map((c) => String(r.s[c.key]).padStart(11)).join(" "),
    String(r.total).padStart(7),
  );
}

// The recommendation is a combination, so its score is not a row above.
const combo = ["D legible endings", "E open the proposal", "G room for the list"];
console.log(
  `\nRecommended combination (${combo.join(" + ")}):`,
  "max per criterion, not summed — they close disjoint findings.",
);
const best = CRITERIA.reduce(
  (n, c) => n + c.weight * Math.max(...combo.map((k) => OPTIONS[k][c.key])),
  0,
);
console.log("  combined:", best, " best single:", rows[0].total);
