// Record-type histogram for one transcript, plus which types carry a null
// parent and what fields each type actually has.
//
// Written because the transcript is not the two-type file it looks like:
// alongside `user`/`assistant` it carries `attachment` (the harness's injected
// context), `last-prompt` (a resume bookmark, rewritten as the leaf moves) and
// `queue-operation`. Knowing which of those are decision-bearing and which are
// scaffolding is prerequisite to folding any of it into a tree.
//
//   node scripts/types.mjs <transcript.jsonl>

import fs from "node:fs";
const lines = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
const t = {}, sub = {}, nullParentType = {};
let i = 0;
for (const l of lines) { i++; let r; try { r = JSON.parse(l); } catch { t["UNPARSEABLE"] = (t["UNPARSEABLE"]||0)+1; continue; }
  const k = r.type ?? "(no type)"; t[k] = (t[k]||0)+1;
  if (r.subtype) sub[r.type+"/"+r.subtype] = (sub[r.type+"/"+r.subtype]||0)+1;
  if (r.parentUuid === null || r.parentUuid === undefined) { const kk = k + (r.subtype?"/"+r.subtype:""); nullParentType[kk] = (nullParentType[kk]||0)+1; }
}
console.log("types:", t); console.log("subtypes:", sub); console.log("null-parent by type:", nullParentType);
// keys on a sample of each type
const seenType = new Set();
for (const l of lines) { let r; try { r = JSON.parse(l); } catch { continue; }
  const k = r.type ?? "(no type)"; if (seenType.has(k)) continue; seenType.add(k);
  console.log("sample["+k+"] keys:", Object.keys(r).sort().join(",")); }
