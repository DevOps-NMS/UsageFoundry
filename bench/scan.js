"use strict";
/**
 * Transcript read path: the directory walk, a cold scan (every byte parsed) and
 * a warm scan (the offset cache holds, so only the walk and the stats repeat).
 *
 * Warm is the figure that matters: the dashboard polls `GET /api/usage` every
 * 10s and every one of those polls is a warm scan.
 *
 *   npx tsc -p tsconfig.test.json && node bench/scan.js
 */
const path = require("node:path");

// `BUILD=` points this at a second compile — how every before/after number in
// the commit messages was taken, by building the older tree into its own
// directory and alternating the two runs rather than trusting one ordering.
const BUILD = process.env.BUILD || path.join(__dirname, "..", ".test-build", "lib");
const transcripts = require(path.join(BUILD, "transcripts.js"));
const { PROJECTS_DIR } = require(path.join(BUILD, "config.js"));

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

function report(label, samples) {
  const s = stats(samples);
  const f = (v) => v.toFixed(1).padStart(8);
  console.log(
    `${label.padEnd(34)} n=${String(s.n).padStart(3)}  min=${f(s.min)}  median=${f(s.median)}  mean=${f(s.mean)}  max=${f(s.max)}  (ms)`,
  );
}

async function time(fn) {
  const t0 = process.hrtime.bigint();
  const out = await fn();
  const t1 = process.hrtime.bigint();
  return [Number(t1 - t0) / 1e6, out];
}

async function main() {
  const runs = Number(process.env.BENCH_RUNS || 20);
  console.log(`corpus: ${PROJECTS_DIR}`);

  // --- walk -------------------------------------------------------------
  const [, first] = await time(() => transcripts.listTranscriptFiles(PROJECTS_DIR));
  console.log(`files:  ${first.files.length}  failures: ${first.failures.length}`);

  const walk = [];
  for (let i = 0; i < runs; i++) {
    const [ms] = await time(() => transcripts.listTranscriptFiles(PROJECTS_DIR));
    walk.push(ms);
  }
  report("listTranscriptFiles", walk);

  // The walk's output order decides which copy of a duplicated record survives
  // the dedupe, so a cache that reorders is a correctness bug, not a slow path.
  const again = await transcripts.listTranscriptFiles(PROJECTS_DIR);
  const stable = again.files.length === first.files.length &&
    again.files.every((f, i) => f === first.files[i]);
  console.log(`walk order stable across calls: ${stable}`);

  // --- cold scan --------------------------------------------------------
  const [coldMs, cold] = await time(() => transcripts.scanUsage());
  console.log(
    `cold scanUsage                     ${coldMs.toFixed(1)} ms   entries=${cold.entries.length} toolCalls=${cold.toolCalls?.length ?? 0}`,
  );
  console.log(`  rss after cold scan: ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);

  // --- warm scan --------------------------------------------------------
  const warm = [];
  for (let i = 0; i < runs; i++) {
    const [ms] = await time(() => transcripts.scanUsage());
    warm.push(ms);
  }
  report("warm scanUsage", warm);

  // Warm scan minus the walk is what the stat pass, dedupe and sort cost.
  const w = stats(warm).median;
  const l = stats(walk).median;
  console.log(
    `\nwalk is ${((l / w) * 100).toFixed(0)}% of a warm scan (${l.toFixed(1)} of ${w.toFixed(1)} ms)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
