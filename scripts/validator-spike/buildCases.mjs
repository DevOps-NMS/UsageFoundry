#!/usr/bin/env node
// Reconstruct the validator's inputs for every run in `docs/validator-baseline.md`.
//
// The spike needs, per run, exactly what a validator would be handed at run end:
// the task text and the branch diff. Neither is reachable here. The operator's
// database is at /data/usagefoundry.db, which is root-owned 0700 by design
// (commit 01b34b7) and is masked by an empty tmpfs in this sandbox, so
// `runs.task` cannot be read; and every `uf/*` branch that survives has been
// merged into main, so `worktree_base..branch` is empty for all of them.
//
// So both inputs are rebuilt from the session transcripts under
// ~/.claude/projects/-workspace--uf-worktrees-*/, which is the same fallback the
// measurement run used. The task text comes back exact — it is the first user
// turn. The diff is reconstructed by attributing commits to a run through the
// `git commit -m` invocations in its own transcript, which is the method
// validator-baseline.md §2 describes but did not record machine-readably.
//
// The important consequence, and it is stated in every case file: a run whose
// commits cannot be attributed gets an EMPTY diff, and an empty diff is also
// what a run that committed nothing leaves. `emptyDiffReason` is what tells the
// two apart, and a verdict on `attribution: "unattributed"` is measuring this
// script, not the validator.
//
// Usage:
//   node scripts/validator-spike/buildCases.mjs [--out <dir>] [--budget <bytes>]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const BASELINE = path.join(REPO_ROOT, "docs", "validator-baseline.md");
const TRANSCRIPT_ROOT = path.join(os.homedir(), ".claude", "projects");

/** The baseline's folder column, mapped to the checkout each run worked in. */
const REPOS = {
  UsageFoundry: "/workspace/UsageFoundry",
  VisualMerge: "/workspace/VisualMerge",
  VibeHub: "/workspace/VibeHub",
  // §3's table names the folder; §2's names the checkout it lives in.
  GHtranslator: "/workspace/gh-layer10",
  orient: "/workspace/orient",
  RSSDashboard: "/workspace/RSSDashboard",
};

/** Default patch budget. `review.ts` budgets its reviewer at 60 kB; match it. */
const DEFAULT_BUDGET = 60_000;

/**
 * Three runs committed in a form that hides the message from the transcript
 * (`-F` a file this script cannot find, or an editor), so no subject resolves.
 * validator-baseline.md §3 names their commits outright in its evidence column —
 * runs 22, 30 and 38 — and those are the commits its labels were assigned on.
 * Reading them back is reconstruction, not a hint: the sha comes from the same
 * document as the label, and the case records `attribution: "baseline-evidence"`
 * so the scorer can hold them out.
 *
 * Run 24 is the fourth such run and is deliberately absent: §3 records only
 * "5 commits (time-window attribution)" for it, with no sha, and guessing one
 * would be inventing the input.
 */
const BASELINE_EVIDENCE_COMMITS = {
  22: ["61423da"],
  30: ["83fa7ab"],
  38: ["b73546d"],
};

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

// ---------------------------------------------------------------- the labels

/** Parse §3's table. The label column is the ground truth everything is scored against. */
function readLabels() {
  const rows = [];
  for (const line of fs.readFileSync(BASELINE, "utf8").split("\n")) {
    // | 3 | `2514d080` | `caee658f` | UsageFoundry | done | finished | reason | evidence |
    const m = line.match(/^\|\s*(\d+)\s*\|\s*`([0-9a-f]{8})`\s*\|\s*`([0-9a-f]{8})`\s*\|(.*)$/);
    if (!m) continue;
    const rest = m[4].split("|").map((c) => c.trim());
    rows.push({
      n: Number(m[1]),
      runId: m[2],
      sessionId: m[3],
      folder: rest[0],
      stop: rest[1],
      label: rest[2].replace(/\*/g, "").trim(),
      labelReason: rest[3],
      labelEvidence: rest[4],
    });
  }
  return rows;
}

// ----------------------------------------------------------- the transcripts

function indexTranscripts() {
  const index = new Map();
  for (const dir of fs.readdirSync(TRANSCRIPT_ROOT)) {
    if (!dir.includes("uf-worktrees")) continue;
    const full = path.join(TRANSCRIPT_ROOT, dir);
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith(".jsonl")) continue;
      index.set(file.slice(0, 8), path.join(full, file));
    }
  }
  return index;
}

function readTranscript(file) {
  const entries = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A transcript can end mid-write. A truncated tail loses turns, never
      // corrupts the ones already parsed, so keep going rather than fail.
    }
  }
  return entries;
}

function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * The task text is the first user turn, kept verbatim.
 *
 * The design document left open whether the app's generated preamble (the
 * worktree notice, the unattended notice, the DONE contract) should be stripped.
 * Simplest option taken: keep it. It is what `runs.prompt` holds and what the
 * agent was actually given, and stripping it means guessing where generated text
 * ends and the operator's own words begin.
 */
function extractTask(entries) {
  const first = entries.find((e) => e.type === "user" && !e.isSidechain && e.message);
  return first ? blockText(first.message.content).trim() : "";
}

/** The last non-sidechain assistant turn — `cycleEnding` reads exactly this. */
function extractFinalText(entries) {
  const assistants = entries.filter((e) => e.type === "assistant" && !e.isSidechain && e.message);
  for (let i = assistants.length - 1; i >= 0; i--) {
    const text = blockText(assistants[i].message.content).trim();
    if (text) return text;
  }
  return "";
}

function extractBranch(entries) {
  for (const e of entries) if (e.gitBranch) return e.gitBranch;
  return null;
}

/**
 * Every commit subject the run typed, across the three shapes that actually
 * occur. Of 533 `git commit` invocations in these transcripts, 299 wrap the
 * message in a heredoc (`-m "$(cat <<'EOF' … EOF)"`), 99 use a plain quoted
 * `-m`, and 61 pass `-F <file>` — so a `-m "…"` regex alone recovers under a
 * fifth of them, which is what makes commit attribution look impossible.
 *
 * `-F <file>` carries no subject in the command itself, so it is chased back to
 * whichever earlier turn wrote that file. A commit written from an editor leaves
 * nothing at all, and those runs fall through to `attribution: "unattributed"`.
 */
function extractCommitSubjects(entries) {
  const subjects = [];
  const add = (raw) => {
    const subject = String(raw).split("\n")[0].trim();
    // A second -m on the same command is the body, not another commit.
    if (subject && !subject.startsWith("$(") && !subjects.includes(subject)) subjects.push(subject);
  };

  /** path -> first line of the last content written there before now. */
  const writtenFiles = new Map();

  for (const e of entries) {
    if (e.type !== "assistant" || e.isSidechain || !Array.isArray(e.message?.content)) continue;
    for (const block of e.message.content) {
      if (block.type !== "tool_use") continue;

      if (block.name === "Write" && typeof block.input?.file_path === "string") {
        writtenFiles.set(path.basename(block.input.file_path), String(block.input.content ?? ""));
        continue;
      }
      if (block.name !== "Bash") continue;
      const command = block.input?.command;
      if (typeof command !== "string") continue;

      // `cat > msg.txt <<'EOF' … EOF` is the other way a -F file gets written.
      for (const m of command.matchAll(/>\s*(\S+)\s*<<-?\s*['"]?(\w+)['"]?\r?\n([\s\S]*?)\r?\n\2/g)) {
        writtenFiles.set(path.basename(m[1]), m[3]);
      }

      if (!/\bgit\s+commit\b/.test(command)) continue;

      // Heredoc bodies opened anywhere in the command: the message is the body's
      // first line whether it arrives via `-m "$(cat <<EOF)"` or `-F -`.
      for (const m of command.matchAll(/<<-?\s*['"]?(\w+)['"]?\r?\n([\s\S]*?)\r?\n\1/g)) add(m[2]);

      for (const m of command.matchAll(/-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g)) {
        add(m[1] !== undefined ? m[1].replace(/\\(["`$\\])/g, "$1") : m[2]);
      }

      for (const m of command.matchAll(/-F\s+(\S+)/g)) {
        const body = writtenFiles.get(path.basename(m[1].replace(/^["']|["']$/g, "")));
        if (body) add(body);
      }
    }
  }
  return subjects;
}

// ------------------------------------------------------- attributing commits

/** subject -> [sha], across every ref in the repository. Built once per repo. */
const subjectIndexCache = new Map();
function subjectIndex(repo) {
  if (subjectIndexCache.has(repo)) return subjectIndexCache.get(repo);
  const index = new Map();
  const log = git(repo, ["log", "--all", "--no-merges", "--format=%H%x00%s%x00%ct"]);
  for (const line of log.split("\n")) {
    if (!line) continue;
    const [sha, subject, ct] = line.split("\0");
    if (!index.has(subject)) index.set(subject, []);
    index.get(subject).push({ sha, subject, committedAt: Number(ct) });
  }
  subjectIndexCache.set(repo, index);
  return index;
}

function attribute(repo, subjects) {
  const index = subjectIndex(repo);
  const commits = [];
  const ambiguous = [];
  const missing = [];
  for (const subject of subjects) {
    const hits = index.get(subject);
    if (!hits) missing.push(subject);
    else if (hits.length > 1) ambiguous.push(subject);
    else commits.push(hits[0]);
  }
  commits.sort((a, b) => a.committedAt - b.committedAt);
  return { commits, ambiguous, missing };
}

// ------------------------------------------------------------- the diff text

/**
 * `--no-ext-diff --no-textconv` on every invocation: both name commands the
 * repository being diffed configures, and reading someone's branch is not a
 * reason to run their code (`diff.ts:315-324` takes the same position).
 */
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color"];

function isContiguous(repo, commits) {
  if (commits.length < 2) return commits.length === 1;
  const first = commits[0].sha;
  const last = commits[commits.length - 1].sha;
  try {
    const count = git(repo, ["rev-list", "--count", "--no-merges", `${first}^..${last}`]).trim();
    return Number(count) === commits.length;
  } catch {
    return false;
  }
}

/**
 * Build the patch, then shorten it to `budget` bytes if it does not fit.
 *
 * A shortened diff says so and names what it dropped, with the line counts, so
 * the reader can tell "this file did not change" from "this file's patch was
 * cut". Whole files are dropped, never half a patch.
 */
function buildDiff(repo, commits, budget) {
  if (commits.length === 0) {
    return { mode: "empty", text: "", stat: "", truncated: false, omitted: [], bytes: 0 };
  }

  const first = commits[0].sha;
  const last = commits[commits.length - 1].sha;
  const contiguous = isContiguous(repo, commits);

  let stat;
  let files;
  let patchFor;
  let mode;
  if (contiguous) {
    mode = "range";
    const range = [`${first}^`, last];
    stat = git(repo, ["diff", ...DIFF_FLAGS, "--stat", ...range]);
    files = git(repo, ["diff", ...DIFF_FLAGS, "--name-only", ...range]).split("\n").filter(Boolean);
    patchFor = (file) =>
      git(repo, ["diff", ...DIFF_FLAGS, ...range, "--", `:(top,literal)${file}`]);
  } else {
    // Non-contiguous commits (another run's work interleaved on the same
    // branch) have no single range. Concatenating each commit's own patch is
    // the honest shape: it is this run's commits and nobody else's.
    mode = "per-commit";
    stat = commits
      .map((c) => `${c.sha.slice(0, 8)} ${c.subject}\n${git(repo, ["show", ...DIFF_FLAGS, "--stat", "--format=", c.sha])}`)
      .join("\n");
    const seen = new Set();
    for (const c of commits) {
      for (const f of git(repo, ["show", ...DIFF_FLAGS, "--name-only", "--format=", c.sha]).split("\n")) {
        if (f) seen.add(f);
      }
    }
    files = [...seen];
    patchFor = (file) =>
      commits
        .map((c) => git(repo, ["show", ...DIFF_FLAGS, "--format=", c.sha, "--", `:(top,literal)${file}`]))
        .filter(Boolean)
        .join("");
  }

  const patches = files.map((file) => ({ file, patch: patchFor(file) }));
  patches.sort((a, b) => a.patch.length - b.patch.length);

  const kept = [];
  const omitted = [];
  let used = 0;
  for (const p of patches) {
    if (used + p.patch.length <= budget) {
      kept.push(p);
      used += p.patch.length;
    } else {
      omitted.push({ file: p.file, bytes: p.patch.length });
    }
  }
  // Restore the natural order for anything that made it in.
  const order = new Map(files.map((f, i) => [f, i]));
  kept.sort((a, b) => order.get(a.file) - order.get(b.file));

  return {
    mode,
    text: kept.map((p) => p.patch).join(""),
    stat: stat.trim(),
    truncated: omitted.length > 0,
    omitted,
    bytes: used,
    totalBytes: patches.reduce((n, p) => n + p.patch.length, 0),
    fileCount: files.length,
  };
}

// ------------------------------------------------------------------ assembly

function main() {
  const outDir = arg("--out", path.join(REPO_ROOT, "scripts", "validator-spike", "cases"));
  const budget = Number(arg("--budget", String(DEFAULT_BUDGET)));
  fs.mkdirSync(outDir, { recursive: true });

  const labels = readLabels();
  if (labels.length === 0) throw new Error(`no labelled rows parsed from ${BASELINE}`);
  const transcripts = indexTranscripts();

  // A branch carrying more than one sampled session is a chain: the diff below
  // covers the branch, not the run.
  const sessionsPerBranch = new Map();
  const branchOf = new Map();
  for (const row of labels) {
    const file = transcripts.get(row.sessionId);
    if (!file) continue;
    const branch = extractBranch(readTranscript(file));
    if (!branch) continue;
    branchOf.set(row.sessionId, branch);
    sessionsPerBranch.set(branch, (sessionsPerBranch.get(branch) ?? 0) + 1);
  }

  const summary = [];
  for (const row of labels) {
    const file = transcripts.get(row.sessionId);
    const repo = REPOS[row.folder];
    const base = {
      ...row,
      repo: repo ?? null,
      transcript: file ?? null,
    };

    if (!file || !repo) {
      const c = { ...base, reachable: false, unreachableReason: !file ? "no transcript" : "unknown folder" };
      fs.writeFileSync(path.join(outDir, `${String(row.n).padStart(2, "0")}-${row.sessionId}.json`), JSON.stringify(c, null, 2));
      summary.push({ n: row.n, label: row.label, attribution: "unreachable" });
      continue;
    }

    const entries = readTranscript(file);
    const task = extractTask(entries);
    const finalText = extractFinalText(entries);
    const branch = branchOf.get(row.sessionId) ?? null;
    const subjects = extractCommitSubjects(entries);
    const { commits, ambiguous, missing } = attribute(repo, subjects);

    let attribution;
    if (commits.length > 0) attribution = "commit-message";
    else if (subjects.length > 0) attribution = "unattributed";
    else attribution = "no-commits";

    if (commits.length === 0 && BASELINE_EVIDENCE_COMMITS[row.n]) {
      for (const short of BASELINE_EVIDENCE_COMMITS[row.n]) {
        const [sha, subject] = git(repo, ["log", "-1", "--format=%H%x00%s", short]).trim().split("\0");
        commits.push({ sha, subject });
      }
      attribution = "baseline-evidence";
    }

    const diff = buildDiff(repo, commits, budget);

    const emptyDiffReason =
      diff.mode !== "empty"
        ? null
        : attribution === "no-commits"
          ? "the run ran no `git commit -m` at all"
          : `the run committed (${subjects.length} subject(s) seen) but none resolved to a commit in this repository`;

    const shared = branch ? (sessionsPerBranch.get(branch) ?? 1) > 1 : false;
    const continuation = /already carries the work of run [0-9a-f]{8}, which you are continuing/.test(task);

    const c = {
      ...base,
      reachable: true,
      branch,
      /** True when this run's diff cannot be separated from the chain's. */
      chained: shared || continuation,
      chainEvidence: [
        shared ? `${sessionsPerBranch.get(branch)} sampled sessions share branch ${branch}` : null,
        continuation ? "the task text carries the app's continuation notice" : null,
      ].filter(Boolean),
      task,
      /**
       * Testimony, not evidence. `external-validator.md` decision 2 settled that
       * the validator gets exactly this one turn, marked as the run's own account
       * of itself. Recorded here so the scorer can measure with and without it.
       */
      finalText,
      attribution,
      commits: commits.map((c) => ({ sha: c.sha, subject: c.subject })),
      unresolvedSubjects: { ambiguous, missing },
      diff,
      emptyDiffReason,
    };
    fs.writeFileSync(path.join(outDir, `${String(row.n).padStart(2, "0")}-${row.sessionId}.json`), JSON.stringify(c, null, 2));
    summary.push({
      n: row.n,
      label: row.label,
      attribution,
      commits: commits.length,
      diffBytes: diff.totalBytes ?? 0,
      truncated: diff.truncated,
      chained: c.chained,
    });
  }

  const counts = summary.reduce((acc, s) => ((acc[s.attribution] = (acc[s.attribution] ?? 0) + 1), acc), {});
  process.stdout.write(`${summary.length} cases written to ${outDir}\n`);
  process.stdout.write(`attribution: ${JSON.stringify(counts)}\n`);
  for (const s of summary) {
    process.stdout.write(
      `  ${String(s.n).padStart(2)} ${s.label.padEnd(12)} ${String(s.attribution).padEnd(14)} ` +
        `commits=${String(s.commits ?? 0).padStart(2)} diff=${String(s.diffBytes ?? 0).padStart(7)}B` +
        `${s.truncated ? " TRUNCATED" : ""}${s.chained ? " chained" : ""}\n`,
    );
  }
}

main();
