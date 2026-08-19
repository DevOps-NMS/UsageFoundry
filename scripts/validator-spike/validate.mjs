#!/usr/bin/env node
// The spike: one run's task text plus its branch diff in, one verdict out.
//
//   finished | not-finished | unjudgeable, a one-line reason, and the evidence.
//
// The prompt lives in prompt.md and is the only place the model's instructions
// are written; this file assembles evidence, sends it, and parses the answer
// back. The three verdict names are the brief's and map one-to-one onto
// docs/external-validator.md §5's proposed column values (did-the-work /
// did-not / cannot-tell).
//
// Usage:
//   node scripts/validator-spike/validate.mjs <case.json> [options]
//
//   --transport api        POST to the Messages API. Needs ANTHROPIC_API_KEY.
//   --transport file       Two-phase, for a host with no key: writes
//                          <io-dir>/<case>.request.md and exits 3; run it again
//                          once <io-dir>/<case>.response.md exists and it parses
//                          the verdict out of that file. Same prompt bytes
//                          either way.
//   --io-dir <dir>         Where the file transport reads and writes.
//   --model <id>           Default claude-sonnet-4-5.
//   --with-testimony       Also give the model the run's own final turn, marked
//                          as the run's account of itself. Off by default: the
//                          brief's input is task + diff, and this is the one
//                          extra artefact external-validator.md decision 2
//                          settled on, so it is a flag in order to be measured.
//   --json                 Print the result object and nothing else.

import fs from "node:fs";
import path from "node:path";

const PROMPT_FILE = path.join(import.meta.dirname, "prompt.md");
const DEFAULT_MODEL = "claude-sonnet-4-5";

/** USD per million tokens, for the `api` transport's cost line. */
const PRICES = {
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const VERDICTS = ["finished", "not-finished", "unjudgeable"];

export function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
}

// ------------------------------------------------------------------ evidence

/**
 * Turn a case into the evidence block the prompt interpolates.
 *
 * Three things this must say out loud rather than let the model infer, because
 * each one otherwise reads as a missing deliverable:
 *   - an empty diff, and why it is empty;
 *   - a shortened patch, and which files were dropped;
 *   - a branch shared by a chain, so the verdict covers the branch not the run.
 */
export function buildEvidence(caseFile, { withTestimony = false } = {}) {
  const out = [];
  const d = caseFile.diff ?? { mode: "empty" };

  out.push(`Branch: ${caseFile.branch ?? "(unknown)"}`);

  if (caseFile.chained) {
    out.push(
      "",
      "**This branch carries more than one run.** " +
        (caseFile.chainEvidence?.join("; ") || "") +
        ". The diff below is the branch's, not this run's alone: work by an " +
        "earlier or parallel run on the same branch appears in it, and this " +
        "run's own boundaries are not recoverable. Judge the branch against " +
        "this task, and say so in your reason.",
    );
  }

  if (d.mode === "empty") {
    out.push(
      "",
      "## The branch diff is EMPTY",
      "",
      `Nothing was committed on this branch — ${caseFile.emptyDiffReason ?? "no commits were attributed to this run"}.`,
      "",
      "This is evidence, not a missing input. An empty diff is the correct " +
        "outcome for a task whose deliverable never enters the repository, and " +
        "it is also what a run that simply did not do the work leaves behind. " +
        "Decide which of those the task text implies; if the task text cannot " +
        "settle it, that is `unjudgeable`.",
    );
  } else {
    out.push(
      "",
      `Commits attributed to this run: ${caseFile.commits.length}`,
      ...caseFile.commits.map((c) => `  ${c.sha.slice(0, 8)}  ${c.subject}`),
      "",
      "## Diffstat (complete — every file that changed is listed here)",
      "",
      "```",
      d.stat,
      "```",
    );

    if (d.truncated) {
      const dropped = d.omitted
        .map((o) => `  ${o.file} (${o.bytes} bytes of patch)`)
        .join("\n");
      out.push(
        "",
        "## The patch below is SHORTENED",
        "",
        `The full patch is ${d.totalBytes} bytes across ${d.fileCount} files, which does not ` +
          `fit in one request. ${d.omitted.length} file(s) are listed in the diffstat above but ` +
          "their patch bodies are omitted here:",
        "",
        dropped,
        "",
        "Those files did change. Treat them as changed; you simply cannot read how.",
      );
    }

    out.push(
      "",
      `## Patch${d.truncated ? " (shortened, see above)" : ""}`,
      "",
      "```diff",
      d.text.trimEnd(),
      "```",
    );
  }

  if (withTestimony && caseFile.finalText) {
    out.push(
      "",
      "## The run's own final message — TESTIMONY, not evidence",
      "",
      "This is the agent's own account of what it did, written by the same " +
        "agent that produced the diff. It is not independent of the work. Use " +
        "it only to understand what the run believed it was delivering, never " +
        "as proof that it delivered it.",
      "",
      "```",
      caseFile.finalText.trim(),
      "```",
    );
  }

  return out.join("\n");
}

export function composePrompt(caseFile, options) {
  const template = fs.readFileSync(PROMPT_FILE, "utf8").replace(/^<!--[\s\S]*?-->\n*/, "");
  return template
    .replace("{{TASK}}", caseFile.task || "(no task text recovered)")
    .replace("{{EVIDENCE}}", buildEvidence(caseFile, options));
}

// -------------------------------------------------------------------- parsing

/**
 * The verdict is read from a JSON object, never from prose. The diff is written
 * by another agent and can address the reader; a value lifted out of a named
 * field is at least a value the reader chose to put there, whereas
 * string-matching the prose would let the branch pick the answer.
 */
export function parseVerdict(text) {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    let parsed;
    try {
      parsed = JSON.parse(fences[i][1]);
    } catch {
      continue;
    }
    if (!parsed || !VERDICTS.includes(parsed.verdict)) continue;
    return {
      verdict: parsed.verdict,
      reason: String(parsed.reason ?? "").trim(),
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : [],
    };
  }
  return null;
}

// ----------------------------------------------------------------- transports

async function sendViaApi(prompt, model) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set; use --transport file");

  const started = Date.now();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`messages API ${response.status}: ${body?.error?.message ?? JSON.stringify(body)}`);
  }

  const text = body.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const price = PRICES[model];
  const inputTokens =
    (body.usage?.input_tokens ?? 0) +
    (body.usage?.cache_read_input_tokens ?? 0) +
    (body.usage?.cache_creation_input_tokens ?? 0);
  return {
    text,
    ms: Date.now() - started,
    usage: body.usage,
    costUSD: price
      ? (inputTokens * price.input + (body.usage?.output_tokens ?? 0) * price.output) / 1e6
      : null,
  };
}

function sendViaFile(prompt, ioDir, name) {
  fs.mkdirSync(ioDir, { recursive: true });
  const responseFile = path.join(ioDir, `${name}.response.md`);
  if (fs.existsSync(responseFile)) {
    return { text: fs.readFileSync(responseFile, "utf8"), ms: null, usage: null, costUSD: null };
  }
  fs.writeFileSync(path.join(ioDir, `${name}.request.md`), prompt);
  return null;
}

// --------------------------------------------------------------------- driver

export async function validate(caseFile, options) {
  const prompt = composePrompt(caseFile, options);
  const meta = {
    n: caseFile.n,
    runId: caseFile.runId,
    sessionId: caseFile.sessionId,
    promptChars: prompt.length,
    diffBytesSent: caseFile.diff?.bytes ?? 0,
    diffBytesTotal: caseFile.diff?.totalBytes ?? 0,
    diffTruncated: Boolean(caseFile.diff?.truncated),
    emptyDiff: (caseFile.diff?.mode ?? "empty") === "empty",
    chained: Boolean(caseFile.chained),
    attribution: caseFile.attribution ?? "unreachable",
  };

  const sent =
    options.transport === "api"
      ? await sendViaApi(prompt, options.model)
      : sendViaFile(prompt, options.ioDir, options.name);

  if (!sent) return { ...meta, status: "awaiting-response" };

  const parsed = parseVerdict(sent.text);
  if (!parsed) {
    return { ...meta, status: "unparseable", ms: sent.ms, costUSD: sent.costUSD, raw: sent.text };
  }
  return {
    ...meta,
    status: "ok",
    ...parsed,
    ms: sent.ms,
    costUSD: sent.costUSD,
    usage: sent.usage,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  /** Flags that consume the next argv entry, so its value is never read as the case path. */
  const VALUED = new Set(["--transport", "--model", "--io-dir", "--only", "--out"]);
  let casePath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (VALUED.has(argv[i])) i++;
      continue;
    }
    casePath = argv[i];
    break;
  }
  if (!casePath) {
    process.stderr.write("usage: validate.mjs <case.json> [--transport api|file] [--io-dir <dir>]\n");
    process.exit(2);
  }
  const caseFile = JSON.parse(fs.readFileSync(casePath, "utf8"));
  if (caseFile.reachable === false) {
    process.stderr.write(`case ${casePath} was not reconstructable: ${caseFile.unreachableReason}\n`);
    process.exit(2);
  }

  const options = {
    transport: arg(argv, "--transport", "api"),
    model: arg(argv, "--model", DEFAULT_MODEL),
    ioDir: arg(argv, "--io-dir", path.join(import.meta.dirname, "io")),
    withTestimony: argv.includes("--with-testimony"),
    name: path.basename(casePath, ".json"),
  };

  const result = await validate(caseFile, options);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.status === "awaiting-response") {
    process.stdout.write(`request written to ${path.join(options.ioDir, `${options.name}.request.md`)}\n`);
  } else if (result.status === "unparseable") {
    process.stdout.write("no verdict: the reply carried no parseable JSON verdict block\n");
  } else {
    process.stdout.write(`${result.verdict}\n  ${result.reason}\n`);
    for (const e of result.evidence) process.stdout.write(`  - ${e}\n`);
    if (result.costUSD != null) {
      process.stdout.write(`  [$${result.costUSD.toFixed(4)}, ${result.ms} ms]\n`);
    }
  }
  if (result.status === "awaiting-response") process.exit(3);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
