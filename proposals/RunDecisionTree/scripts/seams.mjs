// The seams and the scaffolding: compaction boundaries with their metadata,
// last-prompt bookmarks, attachment kinds, and the real-prompt/tool-result split
// inside `user` records.
//
// The load-bearing check is `logicalParentUuid` resolution. `parentUuid` is null
// at every compaction boundary, so a naive walk fragments the run into
// disconnected components; the boundary record points back at the exact
// pre-compaction record through a different field. This script proves that field
// resolves (4/4 in the grounding run) rather than assuming it.
//
//   node scripts/seams.mjs <transcript.jsonl>

import fs from "node:fs";
const lines = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
const recs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const byUuid = new Map(recs.filter(r => r.uuid).map(r => [r.uuid, r]));
for (const [i, r] of recs.entries()) {
  if (r.subtype === "compact_boundary") {
    console.log(`#${i+1} compact_boundary parentUuid=${r.parentUuid} logicalParentUuid=${r.logicalParentUuid} resolves=${byUuid.has(r.logicalParentUuid)} meta=${JSON.stringify(r.compactMetadata)} content=${JSON.stringify(String(r.content).slice(0,120))}`);
  }
}
const lp = recs.filter(r => r.type === "last-prompt");
console.log(`last-prompt records: ${lp.length}; leafUuid resolves: ${lp.filter(r => byUuid.has(r.leafUuid)).length}; distinct lastPrompt: ${new Set(lp.map(r=>r.lastPrompt)).size}`);
console.log("first lastPrompt:", JSON.stringify(String(lp[0]?.lastPrompt).slice(0,150)));
const att = recs.filter(r => r.type === "attachment");
const attKinds = {}; for (const a of att) attKinds[a.attachment?.type ?? "?"] = (attKinds[a.attachment?.type ?? "?"]||0)+1;
console.log("attachment kinds:", attKinds);
const qo = recs.filter(r => r.type === "queue-operation");
console.log("queue-operation sample:", JSON.stringify(qo[0]).slice(0,220));
// user records: which are real operator turns vs tool results?
let realUser = 0, toolResultUser = 0, metaUser = 0;
for (const r of recs) if (r.type === "user") {
  const c = r.message?.content;
  if (Array.isArray(c) && c.some(b => b.type === "tool_result")) toolResultUser++;
  else if (r.isMeta) metaUser++;
  else realUser++; }
console.log(`user records: real=${realUser} toolResult=${toolResultUser} meta=${metaUser}`);
const ps = {}; for (const r of recs) if (r.type === "user" && r.promptSource) ps[r.promptSource]=(ps[r.promptSource]||0)+1;
console.log("promptSource:", ps);
