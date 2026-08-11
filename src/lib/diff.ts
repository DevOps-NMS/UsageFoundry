import fs from "node:fs";
import { git } from "./git";
import {
  describeFolder,
  getRun,
  resolveWorkspaceFolder,
  type RunRow,
} from "./orchestrator";

/**
 * What a run changed, as a diff the run page can render.
 *
 * The event log describes the *process* — every tool call, every assistant
 * turn. This describes the *outcome*, which is what a review actually needs and
 * what the handoff card previously delegated to the operator's own shell.
 *
 * Two shapes, and the difference is not cosmetic. An isolated run owns a branch
 * and a base commit, so `<base>...<branch>` is exactly its work and nothing
 * else. A run that worked directly in the operator's folder has no such range:
 * whatever is in that tree is the run's edits *and* the operator's, mixed, with
 * nothing recording where one ends. That case reports a file list and says so,
 * rather than presenting a confident diff of the wrong thing.
 *
 * Every git call here goes through `git()` — argv array, no shell, environment
 * scrubbed — and the repository path is re-proved inside its mount on every
 * request, because a folder validated when the run was created is not a folder
 * still contained an hour later.
 */

export type DiffFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "changed";

export interface DiffFile {
  path: string;
  /** Set only for a rename or copy. */
  oldPath: string | null;
  status: DiffFileStatus;
  /** Null for a binary file, where git reports no line counts. */
  added: number | null;
  deleted: number | null;
  binary: boolean;
  /** Null when this file's patch was left out to stay inside the size budget. */
  patch: string | null;
  /** True when `patch` holds only the first `MAX_FILE_PATCH_LINES` lines. */
  patchTruncated: boolean;
}

export interface RunDiff {
  /**
   * `range` — an isolated run's branch against its base commit: exact.
   * `worktree` — a non-isolated run: the folder's current state, which
   *   includes anything the operator did themselves.
   * `none` — nothing to show, with `reason` saying why. Not an error.
   */
  kind: "range" | "worktree" | "none";
  reason: string | null;
  base: string | null;
  branch: string | null;
  files: DiffFile[];
  filesChanged: number;
  added: number;
  deleted: number;
  /** Files whose patch was withheld for size, newest budget first. */
  omittedPatches: number;
  /** Uncommitted paths still sitting in the run's checkout. */
  uncommitted: string[];
  /** Present when the run worked in the operator's own folder. */
  caveat: string | null;
}

/** Files given a patch. Beyond this the list is still complete; the bodies are not. */
const MAX_PATCH_FILES = 40;
/** Total patch lines across all files. A generated lockfile alone can exceed this. */
const MAX_PATCH_LINES = 4_000;
/** Patch lines kept per file. */
const MAX_FILE_PATCH_LINES = 600;
/** Hard stop on what is read from `git diff` at all. */
const MAX_DIFF_BYTES = 4_000_000;

/* ------------------------------------------------------------------ */
/* Parsing — pure, and tested                                          */
/* ------------------------------------------------------------------ */

export interface NumstatEntry {
  path: string;
  oldPath: string | null;
  added: number | null;
  deleted: number | null;
}

/**
 * Parse `git diff --numstat -z -M`.
 *
 * `-z` because the alternative is quoted, escaped paths: git renders anything
 * non-ASCII as `"src/caf\303\251.ts"` in the default format, and a file list
 * that silently mangles a name is one a review then reasons about wrongly.
 *
 * Records are `added \t deleted \t path NUL`, except a rename or copy, which is
 * `added \t deleted \t NUL oldPath NUL newPath NUL` — the third tab-field is
 * empty and the two paths follow as separate NUL-terminated fields. `-` in
 * place of a count means binary.
 */
export function parseNumstat(raw: string): NumstatEntry[] {
  const out: NumstatEntry[] = [];
  const fields = raw.split("\0");
  const num = (s: string) => (s === "-" ? null : Number(s));

  for (let i = 0; i < fields.length; i++) {
    const head = fields[i];
    if (!head) continue;

    // Only the first two tabs are separators. A filename may contain one — the
    // whole reason this format is NUL-separated — and splitting on every tab
    // would truncate that name to its first segment.
    const firstTab = head.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : head.indexOf("\t", firstTab + 1);
    if (secondTab === -1) continue;

    const addedRaw = head.slice(0, firstTab);
    const deletedRaw = head.slice(firstTab + 1, secondTab);
    const tail = head.slice(secondTab + 1);

    if (tail === "") {
      // Rename or copy: the two paths are the next two fields.
      const oldPath = fields[i + 1];
      const newPath = fields[i + 2];
      // A record cut short — a killed git, a truncated read — must end the
      // parse rather than produce a file with an empty name.
      if (!oldPath || !newPath) break;
      i += 2;
      out.push({
        path: newPath,
        oldPath,
        added: num(addedRaw),
        deleted: num(deletedRaw),
      });
      continue;
    }

    out.push({
      path: tail,
      oldPath: null,
      added: num(addedRaw),
      deleted: num(deletedRaw),
    });
  }
  return out;
}

const STATUS_LETTER: Record<string, DiffFileStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "changed",
};

/**
 * Parse `git diff --name-status -z -M` into `newPath -> status`.
 *
 * Same record shape as numstat: a plain change is `STATUS NUL path NUL`, a
 * rename is `R100 NUL oldPath NUL newPath NUL`.
 */
export function parseNameStatus(raw: string): Map<string, DiffFileStatus> {
  const out = new Map<string, DiffFileStatus>();
  const fields = raw.split("\0");

  for (let i = 0; i < fields.length; i++) {
    const code = fields[i];
    if (!code) continue;
    const status = STATUS_LETTER[code[0]];
    if (!status) continue;

    if (code[0] === "R" || code[0] === "C") {
      const newPath = fields[i + 2];
      i += 2;
      if (newPath) out.set(newPath, status);
      continue;
    }
    const p = fields[i + 1];
    i += 1;
    if (p) out.set(p, status);
  }
  return out;
}

/**
 * Split a multi-file `git diff` into one string per file, in emission order.
 *
 * Split rather than a per-file `git diff` call each: one spawn instead of
 * forty. The seam is a line starting exactly `diff --git ` at column zero,
 * which cannot occur inside a hunk — every line of a unified diff body is
 * prefixed by a space, `+`, `-` or `\`, so a *file* that itself contains a diff
 * still cannot forge a header.
 *
 * Chunks are matched to files by position, not by parsing the header path:
 * `--numstat` and the patch come off the same diff queue in the same order, and
 * the header is the one part of git's output that re-quotes odd filenames.
 */
export function splitPatches(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) chunks.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) chunks.push(current.join("\n"));
  return chunks;
}

/** Keep the head of a patch, and say when the tail was dropped. */
export function truncatePatch(
  patch: string,
  maxLines = MAX_FILE_PATCH_LINES,
): { text: string; truncated: boolean } {
  const lines = patch.split("\n");
  if (lines.length <= maxLines) return { text: patch, truncated: false };
  const dropped = lines.length - maxLines;
  return {
    text:
      lines.slice(0, maxLines).join("\n") +
      `\n… ${dropped} more line${dropped === 1 ? "" : "s"} not shown`,
    truncated: true,
  };
}

/**
 * Which files get a patch body.
 *
 * The file *list* is always complete — it is cheap and it is what tells the
 * operator the shape of the change. Bodies are budgeted, and what the budget
 * leaves out is counted rather than quietly dropped: a diff view that shows
 * twelve of forty files without saying so reads as a run that touched twelve.
 */
export function selectForPatch(
  entries: readonly NumstatEntry[],
  limits = {
    maxFiles: MAX_PATCH_FILES,
    maxLines: MAX_PATCH_LINES,
    maxFileLines: MAX_FILE_PATCH_LINES,
  },
): { selected: NumstatEntry[]; omitted: NumstatEntry[] } {
  const selected: NumstatEntry[] = [];
  const omitted: NumstatEntry[] = [];
  let lines = 0;

  for (const e of entries) {
    // A binary file costs nothing: git emits one "Binary files … differ" line
    // for it rather than a patch, so it never eats the line budget a text file
    // would.
    const cost = Math.min((e.added ?? 0) + (e.deleted ?? 0), limits.maxFileLines);
    if (selected.length >= limits.maxFiles || lines + cost > limits.maxLines) {
      omitted.push(e);
      continue;
    }
    selected.push(e);
    lines += cost;
  }
  return { selected, omitted };
}

/* ------------------------------------------------------------------ */
/* Building the diff                                                   */
/* ------------------------------------------------------------------ */

/**
 * Re-prove a stored repository path inside its mount.
 *
 * Same pair of checks the run loop makes before every spawn, and for the same
 * reason: a path that was contained when the run was created can be a symlink
 * out of the workspace by the time someone opens the run page. Returns null
 * rather than throwing — a repository that has since moved is an empty state,
 * not a server error.
 */
function repoPathFor(dir: string): string | null {
  try {
    const resolved = resolveWorkspaceFolder(dir, describeFolder(dir).mountId);
    return resolved === dir ? resolved : null;
  } catch {
    return null;
  }
}

const EMPTY: Omit<RunDiff, "kind" | "reason"> = {
  base: null,
  branch: null,
  files: [],
  filesChanged: 0,
  added: 0,
  deleted: 0,
  omittedPatches: 0,
  uncommitted: [],
  caveat: null,
};

const nothing = (reason: string): RunDiff => ({
  ...EMPTY,
  kind: "none",
  reason,
});

/**
 * Diff arguments shared by every call here.
 *
 * `--no-ext-diff` and `--no-textconv` are the load-bearing ones: both
 * `diff.external` and a `diff.<driver>.textconv` reached through `.gitattributes`
 * are *commands git runs*, configured by the repository being diffed. That is
 * the same class of repository-controlled execution `core.fsmonitor` is cleared
 * for, and rendering someone's branch is not a reason to run their code.
 */
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "-M"];

export async function runDiff(runId: string): Promise<RunDiff> {
  const run = getRun(runId);
  if (!run) return nothing("No such run.");

  if (run.isolation === "worktree" && run.worktree_branch && run.repo_root) {
    return rangeDiff(run);
  }
  return worktreeDiff(run);
}

/** An isolated run: `<base>...<branch>`, which is exactly its own work. */
async function rangeDiff(run: RunRow): Promise<RunDiff> {
  const repoRoot = repoPathFor(run.repo_root!);
  if (!repoRoot) {
    return nothing("This run's repository is no longer inside a workspace mount.");
  }

  const branch = run.worktree_branch!;
  const base = run.worktree_base;
  if (!base) return nothing("This run never recorded the commit it branched from.");

  const exists = await git(repoRoot, ["rev-parse", "--verify", `${branch}^{commit}`]);
  if (!exists.ok) {
    return {
      ...EMPTY,
      kind: "none",
      base,
      branch,
      reason: `Branch ${branch} is gone — it was deleted after this run finished.`,
    };
  }

  const range = `${base}...${branch}`;
  const numstat = await git(repoRoot, ["diff", ...DIFF_FLAGS, "--numstat", "-z", range], {
    maxBytes: MAX_DIFF_BYTES,
  });
  if (!numstat.ok) {
    return {
      ...EMPTY,
      kind: "none",
      base,
      branch,
      reason: numstat.overflowed
        ? "This change is too large to summarise."
        : `git could not diff ${range}: ${numstat.stderr || "unknown error"}`,
    };
  }

  const entries = parseNumstat(numstat.stdout);
  if (entries.length === 0) {
    return {
      ...EMPTY,
      kind: "range",
      base,
      branch,
      reason: "The agent committed nothing to this branch.",
      uncommitted: await uncommittedIn(run),
    };
  }

  const statuses = parseNameStatus(
    (await git(repoRoot, ["diff", ...DIFF_FLAGS, "--name-status", "-z", range])).stdout,
  );

  const { selected, omitted } = selectForPatch(entries);
  const patches = await patchesFor(repoRoot, range, selected);

  return {
    kind: "range",
    reason: null,
    base,
    branch,
    files: buildFiles(entries, statuses, selected, patches),
    filesChanged: entries.length,
    added: entries.reduce((n, e) => n + (e.added ?? 0), 0),
    deleted: entries.reduce((n, e) => n + (e.deleted ?? 0), 0),
    omittedPatches: omitted.length,
    uncommitted: await uncommittedIn(run),
    caveat: null,
  };
}

/**
 * A run that worked in the operator's own folder.
 *
 * There is no range to take: the run committed into their branch, or left
 * uncommitted edits in their tree, alongside whatever they were doing
 * themselves — and nothing on either side records which is which. So this
 * reports the tree's current state as a file list, with the caveat attached,
 * and no patch bodies. Showing a patch here would look exactly like the range
 * case while meaning something else entirely.
 */
async function worktreeDiff(run: RunRow): Promise<RunDiff> {
  const folder = repoPathFor(run.folder);
  if (!folder) {
    return nothing("This run's folder is no longer inside a workspace mount.");
  }

  const inside = await git(folder, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout !== "true") {
    return nothing("This run did not work in a git repository, so there is nothing to diff.");
  }

  const status = await git(folder, ["status", "--porcelain"], {
    maxBytes: MAX_DIFF_BYTES,
  });
  if (!status.ok) {
    return nothing("Could not read the folder's git status.");
  }

  const lines = status.stdout ? status.stdout.split("\n") : [];
  return {
    ...EMPTY,
    kind: "worktree",
    reason: lines.length === 0 ? "Nothing is uncommitted in this folder." : null,
    uncommitted: lines,
    caveat:
      "This run worked directly in your checkout, so this is the folder's " +
      "current state — your own edits included. There is no way to tell them " +
      "apart from the run's.",
  };
}

/** Uncommitted work left in an isolated run's checkout, if it still exists. */
async function uncommittedIn(run: RunRow): Promise<string[]> {
  const slot = run.worktree_path;
  if (!slot || !fs.existsSync(slot)) return [];
  const st = await git(slot, ["status", "--porcelain"]);
  return st.ok && st.stdout ? st.stdout.split("\n") : [];
}

/**
 * Patch bodies for the selected files, in one call.
 *
 * Paths come back from git and go straight out again as pathspecs, so each is
 * pinned with `:(top,literal)` — without it a filename containing `*` or `[`
 * would be read as a glob and quietly pull in files the caller did not select.
 */
async function patchesFor(
  repoRoot: string,
  range: string,
  selected: readonly NumstatEntry[],
): Promise<string[] | null> {
  if (selected.length === 0) return [];

  const pathspecs = selected.flatMap((e) =>
    e.oldPath ? [`:(top,literal)${e.oldPath}`, `:(top,literal)${e.path}`] : [`:(top,literal)${e.path}`],
  );

  const res = await git(
    repoRoot,
    ["diff", ...DIFF_FLAGS, range, "--", ...pathspecs],
    { maxBytes: MAX_DIFF_BYTES, timeoutMs: 60_000 },
  );
  if (!res.ok) return null;

  const chunks = splitPatches(res.stdout);
  // Positional matching is only sound while the counts agree. They should
  // always agree — same diff queue, same order — so a mismatch means an
  // assumption here is wrong, and the honest response is no patches at all
  // rather than hunks filed under the wrong filename.
  return chunks.length === selected.length ? chunks : null;
}

function buildFiles(
  entries: readonly NumstatEntry[],
  statuses: Map<string, DiffFileStatus>,
  selected: readonly NumstatEntry[],
  patches: string[] | null,
): DiffFile[] {
  const patchByPath = new Map<string, string>();
  if (patches) {
    selected.forEach((e, i) => patchByPath.set(e.path, patches[i] ?? ""));
  }

  return entries.map((e) => {
    const raw = patchByPath.get(e.path);
    const cut = raw === undefined ? null : truncatePatch(raw);
    return {
      path: e.path,
      oldPath: e.oldPath,
      status: statuses.get(e.path) ?? (e.oldPath ? "renamed" : "modified"),
      added: e.added,
      deleted: e.deleted,
      binary: e.added === null && e.deleted === null,
      patch: cut?.text ?? null,
      patchTruncated: cut?.truncated ?? false,
    };
  });
}

/**
 * The diff as text for a reviewer, bounded and honest about the bound.
 *
 * A large change cannot be sent whole — argv itself caps out well before a
 * model's context does — so the cut is made at a file boundary and named. A
 * reviewer that silently receives a third of a change writes a confident review
 * of the wrong thing.
 */
export function diffAsText(diff: RunDiff, maxBytes: number): {
  text: string;
  shown: number;
  truncated: boolean;
} {
  const parts: string[] = [];
  const missing: DiffFile[] = [];
  let used = 0;
  let full = true;

  for (const f of diff.files) {
    const header = `\n--- ${f.path}${f.oldPath ? ` (renamed from ${f.oldPath})` : ""} ---\n`;
    const block = f.patch === null ? null : header + f.patch + "\n";

    // Once the budget is spent every later file is missing, patch or not — and
    // a file whose patch was already withheld for size is missing too.
    if (!full || block === null || used + block.length > maxBytes) {
      if (block !== null && used + block.length > maxBytes) full = false;
      missing.push(f);
      continue;
    }
    parts.push(block);
    used += block.length;
  }

  const shown = diff.files.length - missing.length;
  if (missing.length > 0) {
    parts.push(
      `\n[TRUNCATED: ${shown} of ${diff.files.length} changed files are included above.\n` +
        `The rest are listed here and their contents were NOT shown to you — say so ` +
        `rather than reasoning about them:\n` +
        missing
          .map((f) => `  ${f.path} (+${f.added ?? "?"} −${f.deleted ?? "?"})`)
          .join("\n") +
        `\n]`,
    );
  }

  return { text: parts.join(""), shown, truncated: missing.length > 0 };
}
