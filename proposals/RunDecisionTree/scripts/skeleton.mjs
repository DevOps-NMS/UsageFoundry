// Reduce a transcript to the acts a decision tree would be built from, and
// measure what fraction of the file that is.
//
// Each record becomes one line: a tool call as name-plus-digest, a result
// truncated, assistant prose in full, a prompt's head, a compaction boundary's
// numbers. The digest lengths (300 / 240 / 400 chars) are a design choice, not a
// measurement — they are the point at which a tool call still identifies itself
// without carrying its payload.
//
// The answer for the grounding run is 3.6%, which is what makes a reconstruction
// pass affordable and a view-time walk tractable.
//
//   node scripts/skeleton.mjs <transcript.jsonl>
//   SKELETON_OUT=/tmp/skel.txt node scripts/skeleton.mjs <transcript.jsonl>

import fs from "node:fs";
const f = process.argv[2];
const recs = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const digest = (name, input) => {
  const i = input || {};
  if (name === "Bash") return String(i.command || "").slice(0, 300);
  if (name === "Read") return `${i.file_path}${i.offset ? `:${i.offset}+${i.limit}` : ""}`;
  if (name === "Edit") return `${i.file_path} :: ${String(i.old_string || "").slice(0, 120)} => ${String(i.new_string || "").slice(0, 120)}`;
  if (name === "Write") return `${i.file_path} (${String(i.content || "").length}B)`;
  if (name === "Grep" || name === "Glob") return JSON.stringify(i).slice(0, 200);
  return JSON.stringify(i).slice(0, 300);
};
const uses = new Map();
const out = [];
for (const r of recs) {
  if (r.subtype === "compact_boundary") { out.push(`[COMPACT trigger=${r.compactMetadata?.trigger} pre=${r.compactMetadata?.preTokens} post=${r.compactMetadata?.postTokens}]`); continue; }
  const c = r.message?.content;
  if (typeof c === "string" && r.type === "user") { out.push(`[PROMPT ${c.length}B] ${c.slice(0, 400)}`); continue; }
  if (!Array.isArray(c)) continue;
  for (const b of c) {
    if (b.type === "text" && r.type === "assistant" && (b.text || "").trim()) out.push(`SAY: ${b.text.trim()}`);
    else if (b.type === "tool_use") { uses.set(b.id, b.name); out.push(`DO(${b.name}): ${digest(b.name, b.input)}`); }
    else if (b.type === "tool_result") {
      const cc = b.content; const txt = typeof cc === "string" ? cc : Array.isArray(cc) ? cc.map(x => x.text ?? "").join("") : "";
      out.push(`${b.is_error ? "ERR" : "GOT"}: ${txt.slice(0, 240)}`);
    }
  }
}
const skel = out.join("\n");
// Written only when asked for: this proposal's scripts are otherwise read-only.
if (process.env.SKELETON_OUT) fs.writeFileSync(process.env.SKELETON_OUT, skel);
const BPT = Number(process.argv[3] || 2.59);
const bytes = Buffer.byteLength(skel);
console.log(`skeleton lines=${out.length} bytes=${bytes} (${(bytes / fs.statSync(f).size * 100).toFixed(1)}% of transcript) tokens@${BPT}B/tok=${Math.round(bytes / BPT)}`);
// prose-only variant: assistant text + prompts + compaction markers only
const prose = out.filter(l => l.startsWith("SAY:") || l.startsWith("[PROMPT") || l.startsWith("[COMPACT"));
const pb = Buffer.byteLength(prose.join("\n"));
console.log(`prose-only lines=${prose.length} bytes=${pb} tokens@${BPT}=${Math.round(pb / BPT)}`);
