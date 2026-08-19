#!/usr/bin/env node
// Score the spike against the labelled set in docs/validator-baseline.md §3.
//
// Two phases, because the transport may be asynchronous:
//   --emit     compose every case's prompt and write it out
//   --collect  read whatever replies exist, parse the verdicts, print the report
// With `--transport api` both happen in one pass.
//
// The report deliberately separates three things that a single agreement number
// hides:
//   * false-finished   — said finished, the label says not-done or partial.
//                        These are the errors the feature exists to prevent.
//   * false-not-finished — said not-finished, the label says finished. These
//                        cost a real re-run.
//   * reconstruction failures — cases whose diff this harness could not rebuild.
//                        A verdict there measures buildCases.mjs, not the model,
//                        so the headline is reported with and without them.
//
// Usage:
//   node scripts/validator-spike/score.mjs --emit    [--io-dir <dir>] [--with-testimony]
//   node scripts/validator-spike/score.mjs --collect [--io-dir <dir>] [--with-testimony] [--out <file>]

import fs from "node:fs";
import path from "node:path";
import { validate, arg } from "./validate.mjs";

const HERE = import.meta.dirname;
const CASES = path.join(HERE, "cases");

/** validator-baseline.md's label vocabulary, mapped onto the spike's verdicts. */
const EXPECTED = {
  finished: "finished",
  "not-done": "not-finished",
  partial: "not-finished",
  unjudgeable: "unjudgeable",
};

/**
 * A case whose diff could not be rebuilt presents an empty diff to the model
 * even though the run committed. Any verdict on it measures the reconstruction,
 * not the validator, so it is held out of the headline and reported on its own.
 */
function isReconstructionFailure(c) {
  return c.diff?.mode === "empty" && c.attribution === "unattributed" && c.label !== "not-done";
}

function pct(n, d) {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const argv = process.argv.slice(2);
  const options = {
    transport: arg(argv, "--transport", "file"),
    model: arg(argv, "--model", "claude-sonnet-4-5"),
    ioDir: arg(argv, "--io-dir", path.join(HERE, "io")),
    withTestimony: argv.includes("--with-testimony"),
  };
  const emitOnly = argv.includes("--emit");

  const files = fs.readdirSync(CASES).filter((f) => f.endsWith(".json")).sort();
  const results = [];
  for (const file of files) {
    const c = JSON.parse(fs.readFileSync(path.join(CASES, file), "utf8"));
    if (c.reachable === false) {
      results.push({ ...c, status: "unreachable" });
      continue;
    }
    const r = await validate(c, { ...options, name: path.basename(file, ".json") });
    results.push({ ...r, label: c.label, folder: c.folder, stop: c.stop, labelReason: c.labelReason, reconstructionFailure: isReconstructionFailure(c) });
  }

  if (emitOnly) {
    const pending = results.filter((r) => r.status === "awaiting-response").length;
    process.stdout.write(`${results.length} cases; ${pending} request(s) written to ${options.ioDir}\n`);
    return;
  }

  // ------------------------------------------------------------------ scoring
  const answered = results.filter((r) => r.status === "ok");
  const scored = answered.filter((r) => !r.reconstructionFailure);

  const agree = (rs) => rs.filter((r) => r.verdict === EXPECTED[r.label]).length;

  const falseFinished = scored.filter(
    (r) => r.verdict === "finished" && (r.label === "not-done" || r.label === "partial"),
  );
  const falseNotFinished = scored.filter((r) => r.verdict === "not-finished" && r.label === "finished");
  const unjudgeableRows = scored.filter((r) => r.label === "unjudgeable");

  const costs = answered.map((r) => r.costUSD).filter((c) => c != null);
  const times = answered.map((r) => r.ms).filter((m) => m != null);
  const diffTotals = answered.map((r) => r.diffBytesTotal).filter((n) => n > 0);

  const lines = [];
  const say = (s = "") => lines.push(s);

  say(`# Validator spike — score against docs/validator-baseline.md §3`);
  say();
  say(`model: ${options.model} · transport: ${options.transport} · testimony: ${options.withTestimony ? "given" : "withheld"}`);
  say();
  say(`cases: ${results.length} · answered: ${answered.length} · unparseable: ${results.filter((r) => r.status === "unparseable").length} · awaiting: ${results.filter((r) => r.status === "awaiting-response").length}`);
  say(`held out as reconstruction failures: ${answered.filter((r) => r.reconstructionFailure).length}`);
  say();

  say(`## Agreement`);
  say();
  say(`- scored set: **${agree(scored)}/${scored.length}** (${pct(agree(scored), scored.length)})`);
  say(`- including reconstruction failures: ${agree(answered)}/${answered.length} (${pct(agree(answered), answered.length)})`);
  say(`- trivial baseline (always answer \`finished\`): ${scored.filter((r) => r.label === "finished").length}/${scored.length} (${pct(scored.filter((r) => r.label === "finished").length, scored.length)})`);
  say();

  say(`## Confusion (rows = label, columns = verdict)`);
  say();
  say(`| label | finished | not-finished | unjudgeable | n |`);
  say(`|---|---:|---:|---:|---:|`);
  for (const label of ["finished", "partial", "not-done", "unjudgeable"]) {
    const rows = scored.filter((r) => r.label === label);
    if (rows.length === 0 && label === "partial") continue;
    const n = (v) => rows.filter((r) => r.verdict === v).length;
    say(`| ${label} | ${n("finished")} | ${n("not-finished")} | ${n("unjudgeable")} | ${rows.length} |`);
  }
  say();

  say(`## false-finished — said finished, the label says the work was not done`);
  say();
  say(`**${falseFinished.length} of ${scored.filter((r) => r.label === "not-done" || r.label === "partial").length}** such rows.`);
  for (const r of falseFinished) {
    say();
    say(`- case ${r.n} (\`${r.runId}\`, session \`${r.sessionId}\`) — label \`${r.label}\``);
    say(`  - label's reason: ${r.labelReason}`);
    say(`  - spike said: ${r.reason}`);
    for (const e of r.evidence) say(`    - ${e}`);
  }
  say();

  say(`## false-not-finished — said not-finished, the label says finished`);
  say();
  say(`**${falseNotFinished.length} of ${scored.filter((r) => r.label === "finished").length}** such rows.`);
  for (const r of falseNotFinished) {
    say(`- case ${r.n} (\`${r.runId}\`) — ${r.reason}`);
  }
  say();

  say(`## Rows the labels call \`unjudgeable\` (${unjudgeableRows.length})`);
  say();
  for (const r of unjudgeableRows) {
    say(`- case ${r.n} → **${r.verdict}** — ${r.reason}`);
  }
  say();

  say(`## Cost, wall clock, and diff size`);
  say();
  say(`- cost per verdict: ${costs.length ? `median $${median(costs).toFixed(4)}, total $${costs.reduce((a, b) => a + b, 0).toFixed(2)} over ${costs.length}` : "not measured by this transport"}`);
  say(`- wall clock per verdict: ${times.length ? `median ${(median(times) / 1000).toFixed(1)} s` : "not measured by this transport"}`);
  say(`- prompt size: median ${median(answered.map((r) => r.promptChars))} chars`);
  say(`- diff size (whole branch diff, before shortening): median ${median(diffTotals)} B, max ${Math.max(...diffTotals)} B over ${diffTotals.length} non-empty`);
  say(`- shortened to fit: ${answered.filter((r) => r.diffTruncated).length} of ${answered.length}`);
  say(`- empty diffs: ${answered.filter((r) => r.emptyDiff).length} · chained branches: ${answered.filter((r) => r.chained).length}`);
  say();

  say(`## Every verdict`);
  say();
  say(`| # | label | verdict | ok | attribution | diff B | reason |`);
  say(`|---|---|---|---|---|---:|---|`);
  for (const r of results) {
    if (r.status !== "ok") {
      say(`| ${r.n} | ${r.label} | _${r.status}_ | | ${r.attribution ?? ""} | | |`);
      continue;
    }
    const ok = r.verdict === EXPECTED[r.label] ? "✓" : r.reconstructionFailure ? "—" : "✗";
    say(`| ${r.n} | ${r.label} | ${r.verdict} | ${ok} | ${r.attribution} | ${r.diffBytesTotal} | ${r.reason.replace(/\|/g, "\\|")} |`);
  }
  say();

  const report = lines.join("\n");
  const out = arg(argv, "--out", null);
  if (out) fs.writeFileSync(out, report);
  process.stdout.write(`${report}\n`);
}

await main();
