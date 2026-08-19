#!/usr/bin/env node
// Score the spike against the labelled set in proposals/ExternalValidator/validator-baseline.md §3.
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
 * True when this harness cannot vouch that the model was shown the run's whole
 * diff. A verdict there measures buildCases.mjs, not the validator.
 *
 * The rule is deliberately label-independent, so it cannot be tuned after the
 * fact to improve a number — it holds out a row whichever way that row went:
 *
 *   - `ambiguous` — the run typed a commit subject that matches more than one
 *     commit in the repository, so a commit that demonstrably exists was
 *     dropped. The model saw a genuinely short diff and is right to notice a
 *     deliverable missing from it.
 *   - `unattributed` — the run typed a commit and none of its subjects resolved
 *     at all, so the model was shown an empty diff for a run that may well have
 *     committed.
 *
 * It costs something to apply honestly: one of the two `not-done` rows is
 * `unattributed`, so the held-out figures leave the positive class at n=1. Both
 * cuts are reported for that reason.
 */
function isReconstructionFailure(c) {
  return (c.unresolvedSubjects?.ambiguous?.length ?? 0) > 0 || c.attribution === "unattributed";
}

/**
 * The `file` transport cannot see what the answer cost — the sender is not this
 * process. If the host measured it, drop the figures in <io-dir>/usage.json as
 * `{ "<case name>": { tokens, ms } }` and they are reported here rather than
 * silently omitted.
 *
 * `tokens` is a total, not a split, so it is priced as input with a fixed
 * output allowance carved out. That is an over-estimate for a single API call
 * in one direction (a multi-turn sender re-sends the prompt, mostly from cache,
 * and cache reads bill at a tenth) and an under-estimate in the other (the
 * sender's own system prompt rides along). It is a scale, not an invoice, and
 * the report says so on the line it prints.
 */
const SONNET_INPUT_PER_TOKEN = 3 / 1e6;
const SONNET_OUTPUT_PER_TOKEN = 15 / 1e6;
const ASSUMED_OUTPUT_TOKENS = 450;

function readMeasuredUsage(ioDir) {
  const file = path.join(ioDir, "usage.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function priceTokens(tokens) {
  const output = Math.min(ASSUMED_OUTPUT_TOKENS, tokens);
  return (tokens - output) * SONNET_INPUT_PER_TOKEN + output * SONNET_OUTPUT_PER_TOKEN;
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
  const measuredUsage = readMeasuredUsage(options.ioDir);
  /** `--only 1,2,6` scores one stratum without disturbing the corpus. */
  const only = arg(argv, "--only", null)
    ? new Set(arg(argv, "--only", "").split(",").map((s) => Number(s.trim())))
    : null;

  const files = fs
    .readdirSync(CASES)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => !only || only.has(Number(f.slice(0, 2))))
    .sort();
  const results = [];
  for (const file of files) {
    const c = JSON.parse(fs.readFileSync(path.join(CASES, file), "utf8"));
    if (c.reachable === false) {
      results.push({ ...c, status: "unreachable" });
      continue;
    }
    const name = path.basename(file, ".json");
    const r = await validate(c, { ...options, name });
    const measured = measuredUsage?.[name];
    results.push({
      ...r,
      label: c.label,
      folder: c.folder,
      stop: c.stop,
      labelReason: c.labelReason,
      reconstructionFailure: isReconstructionFailure(c),
      diffIntegrity:
        (c.unresolvedSubjects?.ambiguous?.length ?? 0) > 0
          ? `${c.unresolvedSubjects.ambiguous.length} ambiguous`
          : c.attribution === "unattributed"
            ? "unattributed"
            : "complete",
      ms: r.ms ?? measured?.ms ?? null,
      costUSD: r.costUSD ?? (measured ? priceTokens(measured.tokens) : null),
      measuredTokens: measured?.tokens ?? null,
    });
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

  say(`# Validator spike — score against proposals/ExternalValidator/validator-baseline.md §3`);
  say();
  say(`model: ${options.model} · transport: ${options.transport} · testimony: ${options.withTestimony ? "given" : "withheld"}`);
  say();
  say(`cases: ${results.length} · answered: ${answered.length} · unparseable: ${results.filter((r) => r.status === "unparseable").length} · awaiting: ${results.filter((r) => r.status === "awaiting-response").length}`);
  const heldOut = answered.filter((r) => r.reconstructionFailure);
  say(`held out — this harness cannot vouch the model saw the whole diff: ${heldOut.length} (cases ${heldOut.map((r) => r.n).join(", ") || "none"})`);
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
  const tokenCounts = answered.map((r) => r.measuredTokens).filter((t) => t != null);
  say(`- cost per verdict: ${costs.length ? `median $${median(costs).toFixed(4)}, total $${costs.reduce((a, b) => a + b, 0).toFixed(2)} over ${costs.length}` : "not measured by this transport"}`);
  if (tokenCounts.length) {
    say(`  - priced from measured totals at Sonnet list ($3/$15 per Mtok), ${ASSUMED_OUTPUT_TOKENS} tokens of it treated as output`);
    say(`  - tokens per verdict: median ${median(tokenCounts)}, min ${Math.min(...tokenCounts)}, max ${Math.max(...tokenCounts)}`);
  }
  say(`- wall clock per verdict: ${times.length ? `median ${(median(times) / 1000).toFixed(1)} s, min ${(Math.min(...times) / 1000).toFixed(1)} s, max ${(Math.max(...times) / 1000).toFixed(1)} s` : "not measured by this transport"}`);
  say(`- prompt size: median ${median(answered.map((r) => r.promptChars))} chars`);
  say(`- diff size (whole branch diff, before shortening): median ${median(diffTotals)} B, max ${Math.max(...diffTotals)} B over ${diffTotals.length} non-empty`);
  say(`- shortened to fit: ${answered.filter((r) => r.diffTruncated).length} of ${answered.length}`);
  say(`- empty diffs: ${answered.filter((r) => r.emptyDiff).length} · chained branches: ${answered.filter((r) => r.chained).length}`);
  say();

  say(`## Every verdict`);
  say();
  say(`| # | label | verdict | ok | diff | diff B | reason |`);
  say(`|---|---|---|---|---|---:|---|`);
  for (const r of results) {
    if (r.status !== "ok") {
      say(`| ${r.n} | ${r.label} | _${r.status}_ | | ${r.diffIntegrity ?? ""} | | |`);
      continue;
    }
    const ok = r.verdict === EXPECTED[r.label] ? "✓" : r.reconstructionFailure ? "—" : "✗";
    say(`| ${r.n} | ${r.label} | ${r.verdict} | ${ok} | ${r.diffIntegrity} | ${r.diffBytesTotal} | ${r.reason.replace(/\|/g, "\\|")} |`);
  }
  say();

  const report = lines.join("\n");
  const out = arg(argv, "--out", null);
  if (out) fs.writeFileSync(out, report);
  process.stdout.write(`${report}\n`);
}

await main();
