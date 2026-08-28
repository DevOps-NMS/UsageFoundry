// What a run cost, and what a reconstruction pass over it would cost.
//
// The run's own spend comes from the transcript's `usage` fields, which is the
// only figure here that is not an estimate. The reconstruction cost is derived
// from the decision skeleton (scripts/skeleton.mjs) at the bytes-per-token
// ratio the transcript calibrates against itself (scripts/calib.mjs) — that
// ratio counts JSON punctuation, so it over-counts prose and the figures below
// are upper bounds.
//
//   node scripts/cost.mjs <transcript.jsonl> [bytesPerToken] [skeletonBytes]

import fs from "node:fs";

const file = process.argv[2];
const BPT = Number(process.argv[3] || 2.59);

// $/MTok, list rates. Cache writes bill at 1.25x input, reads at 0.1x.
const MODELS = [
  ["haiku-4.5", 1, 5],
  ["sonnet-5 (intro)", 2, 10],
  ["sonnet-5 (list)", 3, 15],
  ["opus-5", 5, 25],
];
const RUN_MODEL = { in: 5, out: 25 }; // the run itself was opus-5

let input = 0;
let cacheWrite = 0;
let cacheRead = 0;
let output = 0;
let requests = 0;
let peak = 0;

for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line) continue;
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    continue;
  }
  const u = r.type === "assistant" && r.message?.usage;
  if (!u) continue;
  requests++;
  input += u.input_tokens || 0;
  cacheWrite += u.cache_creation_input_tokens || 0;
  cacheRead += u.cache_read_input_tokens || 0;
  output += u.output_tokens || 0;
  peak = Math.max(
    peak,
    (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
  );
}

const runUSD =
  (input * RUN_MODEL.in +
    cacheWrite * RUN_MODEL.in * 1.25 +
    cacheRead * RUN_MODEL.in * 0.1 +
    output * RUN_MODEL.out) /
  1e6;

console.log(`assistant requests   ${requests}`);
console.log(`input_tokens         ${input}`);
console.log(`cache_creation       ${cacheWrite}`);
console.log(`cache_read           ${cacheRead}`);
console.log(`output_tokens        ${output}`);
console.log(`peak request context ${peak}`);
console.log(`run cost @ opus-5    $${runUSD.toFixed(2)}`);

// Skeleton size: recompute if not supplied, so this script stands alone.
let skeletonBytes = Number(process.argv[4] || 0);
if (!skeletonBytes) {
  const out = [];
  const digest = (name, i = {}) => {
    if (name === "Bash") return String(i.command || "").slice(0, 300);
    if (name === "Read") return `${i.file_path}${i.offset ? `:${i.offset}+${i.limit}` : ""}`;
    if (name === "Edit")
      return `${i.file_path} :: ${String(i.old_string || "").slice(0, 120)} => ${String(i.new_string || "").slice(0, 120)}`;
    if (name === "Write") return `${i.file_path} (${String(i.content || "").length}B)`;
    return JSON.stringify(i).slice(0, 300);
  };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.subtype === "compact_boundary") {
      const m = r.compactMetadata || {};
      out.push(`[COMPACT trigger=${m.trigger} pre=${m.preTokens} post=${m.postTokens}]`);
      continue;
    }
    const c = r.message?.content;
    if (typeof c === "string" && r.type === "user") {
      out.push(`[PROMPT ${c.length}B] ${c.slice(0, 400)}`);
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === "text" && r.type === "assistant" && (b.text || "").trim()) {
        out.push(`SAY: ${b.text.trim()}`);
      } else if (b.type === "tool_use") {
        out.push(`DO(${b.name}): ${digest(b.name, b.input)}`);
      } else if (b.type === "tool_result") {
        const cc = b.content;
        const txt =
          typeof cc === "string" ? cc : Array.isArray(cc) ? cc.map((x) => x.text ?? "").join("") : "";
        out.push(`${b.is_error ? "ERR" : "GOT"}: ${txt.slice(0, 240)}`);
      }
    }
  }
  skeletonBytes = Buffer.byteLength(out.join("\n"));
  console.log(`\nskeleton lines       ${out.length}`);
}

const skeletonTokens = Math.round(skeletonBytes / BPT);
const OUT_TOKENS = 6000; // a tree of this size, annotated
console.log(`skeleton bytes       ${skeletonBytes} (${((skeletonBytes / fs.statSync(file).size) * 100).toFixed(1)}% of transcript)`);
console.log(`skeleton tokens      ${skeletonTokens} @ ${BPT} B/tok`);
console.log(`\nreconstruction pass (${skeletonTokens} in, ${OUT_TOKENS} out):`);
for (const [name, pIn, pOut] of MODELS) {
  const usd = (skeletonTokens * pIn + OUT_TOKENS * pOut) / 1e6;
  console.log(
    `  ${name.padEnd(18)} $${usd.toFixed(4)}   ${((usd / runUSD) * 100).toFixed(2)}% of the run`,
  );
}
