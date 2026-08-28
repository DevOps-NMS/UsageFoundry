"use strict";
/**
 * Resolving N live runs' transcripts, which is what `checkContextCeilings` does
 * on every guard tick — once per watched run.
 *
 *   npx tsc -p tsconfig.test.json && node bench/resolve.js
 *
 * N defaults to 4 (`maxConcurrentRuns`'s default). BENCH_N=25 for the fleet an
 * operator can opt into.
 */
const path = require("node:path");
const BUILD = path.join(__dirname, "..", ".test-build", "lib");
const transcripts = require(path.join(BUILD, "transcripts.js"));
const { PROJECTS_DIR } = require(path.join(BUILD, "config.js"));

async function time(fn) {
  const t0 = process.hrtime.bigint();
  const out = await fn();
  return [Number(process.hrtime.bigint() - t0) / 1e6, out];
}

function med(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const N = Number(process.env.BENCH_N || 4);
  const runs = Number(process.env.BENCH_RUNS || 20);
  console.log(`corpus: ${PROJECTS_DIR}   N=${N} live runs, ${runs} ticks`);

  const { files } = await transcripts.listTranscriptFiles(PROJECTS_DIR);
  // Real session ids off the corpus, so every lookup hits rather than scanning
  // for something absent.
  const ids = files
    .slice(0, N)
    .map((f) => path.basename(f).replace(/\.jsonl$/, ""));
  console.log(`resolving ${ids.length} session ids`);

  // What the loop does today: one walk per watched run.
  const perRun = [];
  for (let i = 0; i < runs; i++) {
    const [ms] = await time(async () => {
      const out = [];
      for (const id of ids) out.push(await transcripts.resolveSessionTranscript(id));
      return out;
    });
    perRun.push(ms);
  }
  console.log(`per-run walk (today)         median ${med(perRun).toFixed(1)} ms/tick`);

  // One walk for the whole tick, each run resolved against it.
  if (typeof transcripts.sessionTranscriptResolver === "function") {
    const shared = [];
    for (let i = 0; i < runs; i++) {
      const [ms] = await time(async () => {
        const resolve = transcripts.sessionTranscriptResolver();
        const out = [];
        for (const id of ids) out.push(await resolve(id));
        return out;
      });
      shared.push(ms);
    }
    console.log(`one walk per tick            median ${med(shared).toFixed(1)} ms/tick`);
    console.log(
      `saved ${(med(perRun) - med(shared)).toFixed(1)} ms/tick  (${(med(perRun) / med(shared)).toFixed(1)}x)`,
    );

    // Same answers, or the change is a bug rather than a speed-up.
    const resolve = transcripts.sessionTranscriptResolver();
    let same = true;
    for (const id of ids) {
      const a = await transcripts.resolveSessionTranscript(id);
      const b = await resolve(id);
      if (a !== b) { same = false; console.error(`MISMATCH ${id}: ${a} !== ${b}`); }
    }
    // An id that is not on disk must still answer null.
    const absent = await resolve("00000000-0000-0000-0000-000000000000");
    console.log(`same answers as per-run walk: ${same}; absent id -> ${absent}`);
    if (!same || absent !== null) process.exit(1);
  } else {
    console.log("one walk per tick            (not implemented yet)");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
