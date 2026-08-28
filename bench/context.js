"use strict";
/**
 * `apiContextTokens` over every transcript in the store. It is called per live
 * run per guard tick, and its fallbacks read the file a second and third time.
 *
 *   npx tsc -p tsconfig.test.json && node bench/context.js
 */
const fs = require("node:fs");
const path = require("node:path");
const BUILD = path.join(__dirname, "..", ".test-build", "lib");
const { apiContextTokens } = require(path.join(BUILD, "contextPruning.js"));
const transcripts = require(path.join(BUILD, "transcripts.js"));
const { PROJECTS_DIR } = require(path.join(BUILD, "config.js"));

function med(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

async function main() {
  const reps = Number(process.env.BENCH_RUNS || 5);
  const { files } = await transcripts.listTranscriptFiles(PROJECTS_DIR);
  console.log(`corpus: ${PROJECTS_DIR}  ${files.length} transcripts, ${reps} reps each`);

  const rows = [];
  for (const f of files) {
    let size;
    try { size = fs.statSync(f).size; } catch { continue; }
    const samples = [];
    let tokens = 0;
    for (let i = 0; i < reps; i++) {
      const t0 = process.hrtime.bigint();
      tokens = apiContextTokens(f);
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    rows.push({ f, size, ms: med(samples), tokens });
  }

  rows.sort((a, b) => b.ms - a.ms);
  const total = rows.reduce((a, b) => a + b.ms, 0);
  const big = rows.filter((r) => r.size > 1_048_576);
  console.log(`\ntotal across corpus: ${total.toFixed(0)} ms   median per file ${med(rows.map((r) => r.ms)).toFixed(2)} ms`);
  console.log(`files over the 1 MB tail window: ${big.length}`);
  console.log(`\nslowest 12 (these are the ones a live run pays every tick):`);
  for (const r of rows.slice(0, 12)) {
    console.log(
      `${r.ms.toFixed(1).padStart(8)} ms  ${(r.size / 1e6).toFixed(1).padStart(6)} MB  tokens=${String(r.tokens).padStart(8)}  ${path.basename(r.f)}`,
    );
  }
  // The figure a reviewer should compare before and after: the aggregate, and
  // the worst single file a run could be sitting on.
  console.log(`\nSUMMARY total=${total.toFixed(0)}ms worst=${rows[0].ms.toFixed(1)}ms`);
}

main().catch((e) => { console.error(e); process.exit(1); });
