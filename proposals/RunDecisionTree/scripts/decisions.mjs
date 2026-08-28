// The decision-shaped moments in one run, printed verbatim: assistant prose,
// commit messages lifted out of Bash `tool_use.input.command`, tool failures,
// and the files touched more than once.
//
// Prints rather than summarises on purpose. The proposal's central claim is that
// a run's first-hand rationale is thin, and a reader should be able to see the
// whole of it — eleven stage directions and one stated reason — rather than take
// a count on trust.
//
// The `len` column is `text.length` (UTF-16 code units), not bytes; the two
// differ for the final report, which carries multi-byte punctuation. See
// 11-validation.md A9.
//
//   node scripts/decisions.mjs <transcript.jsonl>

import fs from "node:fs";
const f = process.argv[2];
const recs = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const uses = new Map(); const order = [];
for (const r of recs) { const c = r.message?.content; if (!Array.isArray(c)) continue;
  for (const b of c) if (b.type === "tool_use") { uses.set(b.id, { name: b.name, input: b.input, uuid: r.uuid, ts: r.timestamp }); order.push(b.id); } }
let errs = 0, ok = 0; const errByTool = {};
for (const r of recs) { const c = r.message?.content; if (!Array.isArray(c)) continue;
  for (const b of c) if (b.type === "tool_result" && uses.has(b.tool_use_id)) {
    const u = uses.get(b.tool_use_id); u.isError = !!b.is_error;
    const cc = b.content; const txt = typeof cc === "string" ? cc : Array.isArray(cc) ? cc.map(x => x.text ?? "").join("") : "";
    u.resultLen = txt.length; u.resultHead = txt.slice(0, 100);
    if (b.is_error) { errs++; errByTool[u.name] = (errByTool[u.name] || 0) + 1; } else ok++; } }
// commits
const commits = [...uses.values()].filter(u => u.name === "Bash" && /git commit/.test(u.input?.command || ""));
// edits per file
const files = {};
for (const u of uses.values()) if (u.name === "Edit" || u.name === "Write") { const p = u.input?.file_path || "?"; files[p] = (files[p] || 0) + 1; }
const revisited = Object.entries(files).filter(([, n]) => n > 1);
// assistant text blocks
const texts = [];
for (const r of recs) { if (r.type !== "assistant") continue; const c = r.message?.content; if (!Array.isArray(c)) continue;
  for (const b of c) if (b.type === "text" && (b.text || "").trim().length >= 40) texts.push({ uuid: r.uuid, ts: r.timestamp, len: b.text.length, head: b.text.trim().slice(0, 90).replace(/\n/g, " ") }); }
// real operator turns
const turns = recs.filter(r => r.type === "user" && Array.isArray(r.message?.content) && !r.message.content.some(b => b.type === "tool_result"));
console.log(JSON.stringify({
  toolCalls: uses.size, toolOk: ok, toolErrors: errs, errByTool,
  gitCommits: commits.length,
  editedOrWrittenFiles: Object.keys(files).length,
  filesTouchedMoreThanOnce: revisited.length,
  assistantTextBlocks40plus: texts.length,
  operatorTurns: turns.length,
  compactBoundaries: recs.filter(r => r.subtype === "compact_boundary").length,
}, null, 1));
console.log("--- assistant prose moments ---");
for (const t of texts) console.log(`${t.ts}  ${String(t.len).padStart(6)}B  ${t.head}`);
console.log("--- commit messages ---");
for (const c of commits) { const m = /-m\s+(['"])([\s\S]*?)\1/.exec(c.input.command); console.log("  " + (m ? m[2].split("\n")[0] : c.input.command.slice(0, 110))); }
console.log("--- tool errors (rejected paths) ---");
for (const u of uses.values()) if (u.isError) console.log(`  ${u.name}: ${JSON.stringify(String(u.input?.command || u.input?.file_path || "").slice(0, 70))} -> ${JSON.stringify(u.resultHead.slice(0, 70))}`);
