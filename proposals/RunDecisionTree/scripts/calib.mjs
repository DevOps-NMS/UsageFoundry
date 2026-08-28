// Bytes per context token, calibrated from the transcript's own usage fields.
//
// Every cost figure for a *hypothetical* pass over a transcript needs a
// bytes-to-tokens ratio, and guessing one in a document that demands
// measurements elsewhere would be dishonest. The transcript supplies it: between
// two consecutive assistant records with no compaction between them, the growth
// in (input + cache_read + cache_creation) is the token cost of the records in
// between, whose serialized bytes are known.
//
// The ratio counts JSON keys and punctuation, which tokenize densely, so it
// over-counts prose — every cost derived from it is an upper bound, which is the
// safe direction.
//
// Also reports thinking-signature bytes against thinking-text bytes, which is
// how the proposal quantifies what the transcript spends marking reasoning it
// does not keep.
//
//   node scripts/calib.mjs <transcript.jsonl>

import fs from "node:fs";
const f = process.argv[2];
const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
const recs = lines.map((l, i) => { try { const r = JSON.parse(l); r.__bytes = Buffer.byteLength(l); r.__i = i; return r; } catch { return null; } }).filter(Boolean);
// total context tokens per assistant record
const asst = recs.filter(r => r.type === "assistant" && r.message?.usage);
const ctx = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
// pair consecutive assistant records with no compact boundary between them; measure bytes of the payload records in between (message-bearing only)
let pairs = 0, dTok = 0, dBytes = 0;
for (let k = 1; k < asst.length; k++) {
  const a = asst[k - 1], b = asst[k];
  const between = recs.filter(r => r.__i > a.__i && r.__i < b.__i);
  if (between.some(r => r.subtype === "compact_boundary")) continue;
  const t = ctx(b.message.usage) - ctx(a.message.usage);
  if (t <= 0 || t > 100000) continue;
  // bytes of the assistant record a's own message content + everything between that carries a message
  const payload = [a, ...between].filter(r => r.message).reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r.message)), 0);
  if (payload <= 0) continue;
  pairs++; dTok += t; dBytes += payload;
}
console.log(`calibration pairs=${pairs} tokens=${dTok} messageBytes=${dBytes} bytesPerToken=${(dBytes / dTok).toFixed(2)}`);
// signature bytes spent on empty thinking
let sigBytes = 0, thinkBytes = 0, nThink = 0;
for (const r of recs) { const c = r.message?.content; if (!Array.isArray(c)) continue;
  for (const b of c) if (b.type === "thinking") { nThink++; sigBytes += Buffer.byteLength(b.signature || ""); thinkBytes += Buffer.byteLength(b.thinking || ""); } }
console.log(`thinking blocks=${nThink} signatureBytes=${sigBytes} thinkingTextBytes=${thinkBytes}`);
// peak / total context and the run's own reported cost
const peak = Math.max(...asst.map(r => ctx(r.message.usage)));
const out = asst.reduce((n, r) => n + (r.message.usage.output_tokens || 0), 0);
console.log(`assistant records=${asst.length} peakContextTokens=${peak} totalOutputTokens=${out}`);
console.log(`file bytes=${fs.statSync(f).size} records=${recs.length}`);
