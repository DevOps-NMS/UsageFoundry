// Cross-tabulate `thinking` block emptiness across the whole transcript corpus.
//
// Re-proves the claim the whole proposal turns on: the model this app runs
// never writes its reasoning to disk. Splits by model, entrypoint and effort
// because the eleven non-empty blocks in the corpus are not a counter-example
// once you see which request shape produced them.
//
//   node scripts/thinking-by-model.mjs [projectsDir]
//
// Default projectsDir is ~/.claude/projects.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const root = process.argv[2] || path.join(os.homedir(), ".claude", "projects");
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  // This script takes the projects *directory*, unlike every other script here,
  // which takes a single transcript — an easy argument to get wrong.
  console.error(`not a directory: ${root}\nusage: node scripts/thinking-by-model.mjs [projectsDir]`);
  process.exit(2);
}

const byModel = {};
const byShape = {};
let files = 0;
let records = 0;
let sidechain = 0;

for (const dir of fs.readdirSync(root)) {
  const full = path.join(root, dir);
  let st;
  try {
    st = fs.statSync(full);
  } catch {
    continue;
  }
  if (!st.isDirectory()) continue;
  for (const name of fs.readdirSync(full)) {
    if (!name.endsWith(".jsonl")) continue;
    files++;
    for (const line of fs.readFileSync(path.join(full, name), "utf8").split("\n")) {
      if (!line) continue;
      records++;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (r.isSidechain) sidechain++;
      const content = r.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b.type !== "thinking") continue;
        const model = r.message.model || "?";
        const nonEmpty = (b.thinking || "").length > 0;
        byModel[model] ??= { empty: 0, full: 0, fullBytes: 0 };
        const m = byModel[model];
        if (nonEmpty) {
          m.full++;
          m.fullBytes += Buffer.byteLength(b.thinking);
        } else {
          m.empty++;
        }
        const shape = `${model} | entrypoint=${r.entrypoint} | effort=${r.effort ?? "-"}`;
        byShape[shape] ??= { empty: 0, full: 0 };
        byShape[shape][nonEmpty ? "full" : "empty"]++;
      }
    }
  }
}

console.log(`files=${files} records=${records} isSidechain=true → ${sidechain}`);
console.log("\nby model:");
for (const [model, v] of Object.entries(byModel).sort(
  (a, b) => b[1].empty + b[1].full - (a[1].empty + a[1].full),
)) {
  console.log(
    `  ${model.padEnd(30)} empty=${String(v.empty).padStart(6)}  non-empty=${String(v.full).padStart(4)}  bytes=${v.fullBytes}`,
  );
}
console.log("\nby request shape:");
for (const [shape, v] of Object.entries(byShape).sort(
  (a, b) => b[1].empty + b[1].full - (a[1].empty + a[1].full),
)) {
  console.log(`  ${shape.padEnd(60)} empty=${String(v.empty).padStart(6)}  non-empty=${v.full}`);
}
