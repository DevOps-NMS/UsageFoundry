// One transcript, counted: records by type, tool calls by name, assistant prose,
// thinking-block emptiness, todo writes, compaction boundaries, and parent-chain
// integrity.
//
// The parent-chain pass is the one worth explaining. It counts null parents and
// *dangling* parents separately, because they mean opposite things: a null
// parent is a known seam (a compaction boundary, a last-prompt bookmark), while
// a dangling one would mean the file is corrupt. Run A has 102 of the first and
// zero of the second, which is why the chain is repairable rather than lost.
//
//   node scripts/census.mjs <transcript.jsonl>
//
// Note: `textBlocks`/`textBytes` include `user` records whose content is a
// string — the SDK prompts, ~20 KB each — so they are NOT the assistant-prose
// figure quoted in the proposal. See 11-validation.md A4.

import fs from "node:fs";
const file = process.argv[2];
const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
const st = {
  records: lines.length, user: 0, assistant: 0, system: 0, other: 0,
  sidechain: 0, textBlocks: 0, textBytes: 0, textNonTrivial: 0,
  thinkingEmpty: 0, thinkingFull: 0, toolUse: 0, toolResult: 0,
  isMeta: 0, compactBoundary: 0, sessions: new Set(), models: new Set(),
  parentNull: 0, uuids: new Set(), missingParent: 0,
};
const byTool = {}; const todos = []; const texts = [];
const seen = new Set();
for (const l of lines) {
  let r; try { r = JSON.parse(l); } catch { st.other++; continue; }
  if (r.uuid) { st.uuids.add(r.uuid); seen.add(r.uuid); }
  if (r.sessionId) st.sessions.add(r.sessionId);
  if (r.isSidechain) st.sidechain++;
  if (r.isMeta) st.isMeta++;
  if (r.isCompactSummary || r.subtype === "compact_boundary" || r.compactMetadata) st.compactBoundary++;
  if (r.parentUuid === null || r.parentUuid === undefined) st.parentNull++;
  if (r.type === "user") st.user++; else if (r.type === "assistant") st.assistant++;
  else if (r.type === "system") st.system++; else st.other++;
  if (r.message?.model) st.models.add(r.message.model);
  const c = r.message?.content;
  if (typeof c === "string") { st.textBlocks++; st.textBytes += Buffer.byteLength(c); continue; }
  if (!Array.isArray(c)) continue;
  for (const b of c) {
    if (b.type === "text") {
      st.textBlocks++; const t = b.text || ""; st.textBytes += Buffer.byteLength(t);
      if (t.trim().length >= 40) { st.textNonTrivial++; texts.push({ uuid: r.uuid, ts: r.timestamp, len: t.length, text: t }); }
    } else if (b.type === "thinking") {
      if ((b.thinking || "").length) st.thinkingFull++; else st.thinkingEmpty++;
    } else if (b.type === "tool_use") {
      st.toolUse++; byTool[b.name] = (byTool[b.name] || 0) + 1;
      if (b.name === "TodoWrite") todos.push({ uuid: r.uuid, ts: r.timestamp, todos: b.input?.todos || [] });
    } else if (b.type === "tool_result") st.toolResult++;
  }
}
// second pass: parent chain integrity
for (const l of lines) { let r; try { r = JSON.parse(l); } catch { continue; }
  if (r.parentUuid && !seen.has(r.parentUuid)) st.missingParent++; }
console.log(JSON.stringify({
  file, ...st, sessions: [...st.sessions], models: [...st.models],
  uuids: st.uuids.size, textAvgBytes: Math.round(st.textBytes / Math.max(1, st.textBlocks)),
  byTool: Object.fromEntries(Object.entries(byTool).sort((a, b) => b[1] - a[1])),
  todoWrites: todos.length,
  todoItemsTotal: todos.reduce((n, t) => n + t.todos.length, 0),
  todoDistinctTitles: new Set(todos.flatMap((t) => t.todos.map((x) => x.content || x.activeForm))).size,
}, null, 1));
