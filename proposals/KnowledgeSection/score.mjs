/**
 * The comparison table's arithmetic, so a reader can change a score they
 * disagree with and see what it does to the ranking rather than take the
 * ranking on trust.
 *
 *   node proposals/KnowledgeSection/score.mjs
 *
 * No dependencies, no imports. The criteria and their weights are
 * `01-constraints.md`'s; every per-option score is argued in that option's own
 * file and the one-line notes below are pointers, not the argument.
 *
 * Scores are 1 to 5 with 5 always best, including for the negative criteria:
 * 5 on "contradicts" means it contradicts nothing.
 */

const CRITERIA = [
  { key: "visible", weight: 5, label: "1 Closes not-visible" },
  { key: "overwhelming", weight: 4, label: "2 Closes overwhelming" },
  { key: "navigate", weight: 4, label: "3 Closes navigate" },
  { key: "contradicts", weight: 5, label: "4 Contradicts nothing" },
  { key: "keyboard", weight: 3, label: "5 Keyboard" },
  { key: "screenreader", weight: 3, label: "6 Screen reader" },
  { key: "phone", weight: 3, label: "7 Phone at 390px" },
  { key: "regression", weight: 3, label: "8 Regression risk" },
  { key: "radius", weight: 2, label: "9 Radius and reversibility" },
];

const OPTIONS = [
  {
    id: "G",
    name: "The combination — E1, B, C, F2, F3",
    file: "08-option-g-the-combination.md",
    visible: 5, overwhelming: 5, navigate: 4, contradicts: 4,
    keyboard: 4, screenreader: 5, phone: 4, regression: 2, radius: 3,
  },
  {
    id: "B",
    name: "Orientation layer on the canvas",
    file: "03-option-b-orientation-layer.md",
    visible: 5, overwhelming: 1, navigate: 4, contradicts: 5,
    keyboard: 4, screenreader: 5, phone: 2, regression: 2, radius: 4,
  },
  {
    id: "E",
    name: "The first three moves",
    file: "06-option-e-the-first-three-moves.md",
    visible: 1, overwhelming: 3, navigate: 1, contradicts: 4,
    keyboard: 3, screenreader: 3, phone: 4, regression: 4, radius: 5,
  },
  {
    id: "F",
    name: "Change what it opens on",
    file: "07-option-f-change-what-it-opens-on.md",
    visible: 3, overwhelming: 2, navigate: 2, contradicts: 4,
    keyboard: 4, screenreader: 3, phone: 3, regression: 5, radius: 5,
  },
  {
    id: "C",
    name: "Progressive disclosure in the panel",
    file: "04-option-c-progressive-disclosure.md",
    visible: 1, overwhelming: 5, navigate: 1, contradicts: 3,
    keyboard: 3, screenreader: 3, phone: 5, regression: 3, radius: 4,
  },
  {
    id: "D",
    name: "Split the route",
    file: "05-option-d-split-the-route.md",
    visible: 1, overwhelming: 4, navigate: 2, contradicts: 3,
    keyboard: 4, screenreader: 3, phone: 5, regression: 1, radius: 1,
  },
  {
    id: "A",
    name: "Change nothing",
    file: "02-option-a-change-nothing.md",
    visible: 1, overwhelming: 1, navigate: 1, contradicts: 5,
    keyboard: 3, screenreader: 2, phone: 2, regression: 5, radius: 5,
  },
];

const ceiling = CRITERIA.reduce((sum, c) => sum + c.weight * 5, 0);
const total = (option) =>
  CRITERIA.reduce((sum, c) => sum + c.weight * option[c.key], 0);

const scored = OPTIONS.map((o) => ({ ...o, total: total(o) })).sort(
  (a, b) => b.total - a.total,
);

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log(`Total weight ${CRITERIA.reduce((s, c) => s + c.weight, 0)}, ceiling ${ceiling}\n`);
console.log(
  pad("", 3) + pad("Option", 38) + CRITERIA.map((c) => num(c.label.slice(0, 1), 4)).join("") + num("Total", 8),
);
for (const o of scored) {
  console.log(
    pad(o.id, 3) +
      pad(o.name, 38) +
      CRITERIA.map((c) => num(o[c.key], 4)).join("") +
      num(o.total, 8),
  );
}

console.log("\nCriteria and weights:");
for (const c of CRITERIA) console.log(`  ${c.label} — weight ${c.weight}`);

// The three sentences of the complaint, scored on their own, because the
// weighted total rewards not breaking things and the null option scores a
// perfect 5 on three criteria by construction. `09-comparison.md` says so in
// words; this prints it.
console.log("\nThe operator's three sentences only (criteria 1-3, weight 13, ceiling 65):");
const complaintOnly = CRITERIA.slice(0, 3);
const complaintTotal = (o) =>
  complaintOnly.reduce((sum, c) => sum + c.weight * o[c.key], 0);
for (const o of [...OPTIONS].sort((a, b) => complaintTotal(b) - complaintTotal(a))) {
  console.log(`  ${pad(o.id, 3)}${pad(o.name, 38)}${num(complaintTotal(o), 4)}`);
}
