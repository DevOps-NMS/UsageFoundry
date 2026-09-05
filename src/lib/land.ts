import fs from "node:fs";
import { runVerify } from "./landGate";
import { openPullRequest, planDelivery } from "./delivery";
import path from "node:path";
import { git } from "./git";
import { db } from "./db";
import { commitDiff, type DiffFile } from "./diff";
import { GITHUB_TOKEN } from "./config";
import { getSettings } from "./settings";
import {
  assistRefusal,
  assistRunning,
  reviewPaths,
  startAssist,
  type ReviewRow,
} from "./review";
import {
  MAX_WORKTREE_SLOTS,
  TERMINAL_STATUSES,
  activeRuns,
  auxWorktreePath,
  conflictKey,
  describeFolder,
  emitRunEvent,
  forgetSlotVerdict,
  getRun,
  overlaps,
  repoSlug,
  resolveWorkspaceFolder,
  workDirOf,
  worktreeStore,
  type RunRow,
} from "./orchestrator";

/**
 * Bringing an isolated run's branch home.
 *
 * CLAUDE.md said "an isolated run works on a branch, and the tool never
 * merges", and this is the deliberate replacement for that rule rather than a
 * repeal of it. What the rule protected still holds, and every one of those
 * protections is enforced here rather than described in a caveat:
 *
 *   - **A merge into a dirty tree can lose work.** The operator's checkout must
 *     be clean, and "could not tell" counts as dirty — the same rule
 *     `emitHandoff` uses to decide whether to print a merge command at all.
 *   - **The tool must not write into the operator's checkout by surprise.**
 *     Nothing here touches it until the operator presses land. Finding out
 *     *whether* a merge would work touches nothing at all: `merge-tree` does a
 *     three-way merge in memory and writes only unreferenced objects.
 *   - **A conflict is never resolved in the operator's checkout.** A merge that
 *     fails there is aborted immediately and the conflicting files reported.
 *     Claude can be asked to resolve one, but it does so in an *isolated*
 *     checkout, merging the target into the run's branch — the opposite
 *     direction — so a resolution that goes badly costs a branch nobody has
 *     landed yet. See `resolveConflicts`.
 *   - **An active run's branch is not landable.** A `running` or `paused` run is
 *     still committing to it, and the base it merges cleanly against now is not
 *     the base it will have in ten minutes.
 *
 * Branch names are never accepted from the wire. Every entry point takes a run
 * id and reads the branch off the row, which is the only place it was ever
 * written — by this app, as `uf/<slot>-<id8>`.
 */

export type LandStrategy = "merge" | "squash";

/**
 * Every git call on the landing path runs with no clock on it.
 *
 * There is no length of time after which merging somebody's work becomes the
 * wrong thing to do, so nothing here is allowed to give up on one. A timeout in
 * `git()` is a `SIGKILL`, and a killed git is `ok: false` — which this file
 * cannot tell apart from git having refused, so a merge that was simply large
 * came back as "git refused the merge and it was rolled back", and a `status`
 * or a `merge-tree` that ran long came back as a checkout that could not be
 * read or a conflict state that could not be determined, both of which refuse
 * the land outright. Every one of those is a clock deciding what a repository
 * should have decided.
 *
 * It is spelled at each call rather than changed in `git()` because the default
 * is right everywhere else: a 20-second bound on the *page* reads that annotate
 * a folder list is what keeps a request answering. This is the path where the
 * answer is worth waiting for however long it takes.
 */
const NO_CLOCK = { timeoutMs: 0 } as const;

/** One `<<<<<<< … >>>>>>>` block, exactly as the merge would leave it. */
export interface ConflictRegion {
  /** The block, markers included. */
  text: string;
  /** True when the block was cut for length, or its closing marker is missing. */
  truncated: boolean;
}

/**
 * A path git could not merge, with git's own account of why.
 *
 * The list of paths comes from `merge-tree`'s stage records, which is the
 * authoritative statement of what conflicts. `type` and `message` come from its
 * informational section and are decoration: a record naming a path the stage
 * records did not is ignored rather than added, so what counts as conflicting
 * never depends on parsing prose.
 */
export interface ConflictFile {
  path: string;
  /** git's own name for the conflict — `content`, `modify/delete`, … */
  type: string | null;
  /** git's one-line explanation. The whole story for a conflict with no markers. */
  message: string | null;
  regions: ConflictRegion[];
  /** Regions this file has beyond the ones in `regions`. */
  regionsOmitted: number;
  /**
   * False when the merged content was never read, so an empty `regions` says
   * nothing about this file. A modify/delete leaves no markers at all and a
   * content conflict always leaves some, and the two must not read alike.
   */
  regionsRead: boolean;
}

export type MergePreview =
  | { outcome: "already-merged" }
  | { outcome: "fast-forward" }
  | { outcome: "clean" }
  | { outcome: "conflict"; files: ConflictFile[] }
  /** Could not be determined — git too old, or the command failed. */
  | { outcome: "unknown"; reason: string };

export interface CheckoutState {
  path: string;
  /** Branch the operator has checked out, or null when detached/unreadable. */
  headBranch: string | null;
  dirty: boolean;
  /** False when `git status` itself failed — which counts as dirty. */
  readable: boolean;
}

/** One path in a checkout that is changed and no commit holds. */
export interface PendingChange {
  /** The path as it stands now. */
  path: string;
  /** Where a rename or copy came from, else null. */
  origPath: string | null;
  /** git's two status letters — `??` untracked, `" M"` edited, `"A "` staged. */
  code: string;
}

/**
 * Work sitting in a run's own checkout that no commit holds.
 *
 * Never the operator's tree: this is read from the run's worktree slot, and
 * only while that slot still has the run's own branch checked out.
 */
export interface PendingWork {
  path: string;
  /** Every changed path, including the ones `files` leaves out. */
  count: number;
  files: PendingChange[];
  /** False when `git status` failed, so `files` says nothing about this checkout. */
  readable: boolean;
  /** The run's task as a commit subject, offered as the default. */
  suggestedMessage: string;
}

/**
 * One run that holds, or is declared to hold, a branch several runs share.
 *
 * `iterations` is here for the same reason `edgeSatisfied` reads it: a run that
 * finished without a work cycle put nothing on the branch and never will, so it
 * is not a link in the chain however it is recorded. Without that, one blocked
 * dependent would make its predecessor's branch unlandable for ever.
 */
export interface ChainMember {
  runId: string;
  status: RunRow["status"];
  iterations: number;
}

export interface LandState {
  runId: string;
  runStatus: RunRow["status"];
  branch: string;
  /**
   * Every run on this branch, oldest first — one entry for the ordinary run
   * whose branch is its own, several when runs continue one another's work.
   */
  chain: ChainMember[];
  /** Branch this work lands into. */
  target: string | null;
  /**
   * True when the target was not recorded at creation and has been worked out
   * from the base commit instead. Surfaced, never hidden: it is a deduction.
   */
  targetInferred: boolean;
  branchExists: boolean;
  ahead: number;
  behind: number;
  merged: boolean;
  /**
   * Landed by this tool, and unchanged since. The only way to know a squash
   * landed: git sees no ancestry, so without this the branch reads as unmerged
   * for ever and would be offered for landing a second time.
   */
  landedUnchanged: boolean;
  preview: MergePreview;
  checkout: CheckoutState | null;
  /**
   * Uncommitted work in the run's own checkout, or null when there is none to
   * see — no slot, a slot another run has taken over, or a clean one.
   */
  pending: PendingWork | null;
  /** Why landing is refused right now, or null when it is offered. */
  blocked: string | null;
  landedAt: number | null;
  landedInto: string | null;
  landedStrategy: string | null;
}

/**
 * Folders with a land in flight.
 *
 * A merge is a multi-step, non-atomic write into a directory, and two of them
 * interleaved is the same failure the run loop's folder claim exists to
 * prevent. `globalThis` for the reason every other long-lived map here uses it:
 * module state resets on a dev hot reload.
 */
const landing = ((globalThis as unknown as { __ufLanding?: Set<string> })
  .__ufLanding ??= new Set<string>());

/* ------------------------------------------------------------------ */
/* Reading the state                                                   */
/* ------------------------------------------------------------------ */

/** Re-prove a stored path inside its mount, exactly as the run loop does. */
function repoPathFor(dir: string): string | null {
  try {
    const resolved = resolveWorkspaceFolder(dir, describeFolder(dir).mountId);
    return resolved === dir ? resolved : null;
  } catch {
    return null;
  }
}

/** Conflicted files whose merged content is read. Each costs a `git show`. */
const MAX_CONTENT_FILES = 10;
/** Regions rendered per file. */
const MAX_REGIONS_PER_FILE = 5;
/** Lines kept per region. */
const MAX_REGION_LINES = 80;
/** Hard stop on how much of one conflicted file is read. */
const MAX_CONTENT_BYTES = 1_000_000;

/**
 * Parse `git merge-tree --write-tree -z`.
 *
 * Exit 0 is a clean merge, exit 1 means conflicts, anything else is an error —
 * including "unknown option" from a git older than 2.38, which is a real
 * possibility on a host-mounted toolchain and must not read as "no conflicts".
 *
 * `-z` is what makes the conflict *types* readable. The plain output states them
 * only in prose — "CONFLICT (content): Merge conflict in f.txt" — and finding
 * the path in that sentence means parsing a filename out of a human message,
 * which is the mistake `splitPatches` exists to avoid. With `-z` the record is
 * `<path-count> NUL <path>… NUL <type> NUL <message> NUL`, so the paths arrive
 * as fields.
 *
 * The whole output is one NUL-separated stream: the merged tree's oid, then one
 * `<mode> <oid> <stage>\t<path>` record per conflicted path per stage, then an
 * empty record, then the informational records. The same path appears once per
 * stage, so the list is de-duplicated.
 *
 * Everything after the stage records is parsed defensively and contributes
 * nothing but annotation: a git whose informational format differs loses the
 * type and the message, and still reports exactly which files conflict.
 */
export function parseMergeTree(
  stdout: string,
  stderr: string,
  code: number | null,
): MergePreview {
  if (code === 0) return { outcome: "clean" };
  if (code !== 1) {
    const detail = stderr.split("\n")[0] ?? "";
    return {
      outcome: "unknown",
      reason: /unknown option|usage: git merge-tree/i.test(stderr)
        ? "This git is too old to preview a merge — 2.38 or newer is needed."
        : `git could not preview the merge${detail ? `: ${detail}` : "."}`,
    };
  }

  const fields = stdout.split("\0");
  const byPath = new Map<string, ConflictFile>();

  let i = 1; // field 0 is the merged tree's oid
  for (; i < fields.length && fields[i] !== ""; i++) {
    const tab = fields[i].indexOf("\t");
    if (tab === -1) continue;
    const path = fields[i].slice(tab + 1);
    if (!byPath.has(path)) {
      byPath.set(path, {
        path,
        type: null,
        message: null,
        regions: [],
        regionsOmitted: 0,
        regionsRead: false,
      });
    }
  }

  // Informational records. `Auto-merging f.txt` is one of these too and is not
  // a conflict, so only `CONFLICT (…)` records annotate anything.
  for (i += 1; i < fields.length; ) {
    const count = Number(fields[i]);
    if (!Number.isInteger(count) || count < 1 || i + count + 2 >= fields.length) break;
    const paths = fields.slice(i + 1, i + 1 + count);
    const type = fields[i + count + 1];
    const message = fields[i + count + 2];
    i += count + 3;

    const kind = /^CONFLICT \((.+)\)$/.exec(type)?.[1];
    if (!kind) continue;
    for (const p of paths) {
      const file = byPath.get(p);
      if (file) {
        file.type = kind;
        file.message = explanation(message, p);
      }
    }
  }

  return { outcome: "conflict", files: [...byPath.values()] };
}

/**
 * What git's sentence says that the type and the path do not.
 *
 * Its messages open by restating the type — "CONFLICT (modify/delete): d.txt
 * deleted in …" — and for the ordinary case the whole sentence is "Merge
 * conflict in f.txt", which is the file's own name under its own heading. Both
 * are dropped: what survives is the part that carries something, like which
 * version git kept, or which paths a rename collided with.
 */
function explanation(message: string, path: string): string | null {
  const rest = message.trim().replace(/^CONFLICT \([^)]*\):\s*/, "");
  return rest === "" || rest === `Merge conflict in ${path}` ? null : rest;
}

/**
 * The `<<<<<<<`/`>>>>>>>` blocks in a file the merge could not reconcile.
 *
 * Anchored on the two labelled markers only, for the reason
 * `hasConflictMarkers` documents: a bare `=======` is a markdown heading
 * underline, and a region parser that started on one would render half a
 * document as a conflict. A block with no closing marker — a file cut by the
 * read budget — is kept and flagged rather than dropped.
 */
export function conflictRegions(
  text: string,
  limits = { maxRegions: MAX_REGIONS_PER_FILE, maxLines: MAX_REGION_LINES },
): { regions: ConflictRegion[]; omitted: number } {
  const lines = text.split("\n");
  const regions: ConflictRegion[] = [];
  let found = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("<<<<<<< ")) continue;
    found++;

    let end = i;
    while (end < lines.length && !lines[end].startsWith(">>>>>>> ")) end++;
    const closed = end < lines.length;
    const block = lines.slice(i, closed ? end + 1 : lines.length);
    i = closed ? end : lines.length;

    if (regions.length >= limits.maxRegions) continue;
    const cut = block.length > limits.maxLines;
    regions.push({
      text: (cut ? block.slice(0, limits.maxLines) : block).join("\n"),
      truncated: cut || !closed,
    });
  }

  return { regions, omitted: found - regions.length };
}

/**
 * Which branch this run's work belongs to.
 *
 * `worktree_base_branch` is recorded at creation and is the answer whenever it
 * is there. Rows written before that column existed have only a commit, so the
 * branch currently checked out is offered instead — but only after proving the
 * run's base commit is an ancestor of it, which is what makes it a deduction
 * rather than an assumption. A run that branched from somewhere else entirely
 * gets no target and cannot be landed by this tool at all.
 */
async function targetOf(
  run: RunRow,
  repoRoot: string,
  checkout: CheckoutState | null,
): Promise<{ branch: string; inferred: boolean } | null> {
  if (run.worktree_base_branch) {
    return { branch: run.worktree_base_branch, inferred: false };
  }
  const head = checkout?.headBranch;
  if (!head || !run.worktree_base) return null;

  const descends = await git(
    repoRoot,
    ["merge-base", "--is-ancestor", run.worktree_base, head],
    NO_CLOCK,
  );
  return descends.ok ? { branch: head, inferred: true } : null;
}

async function checkoutStateOf(folder: string): Promise<CheckoutState> {
  const head = await git(folder, ["rev-parse", "--abbrev-ref", "HEAD"], NO_CLOCK);
  const status = await git(folder, ["status", "--porcelain"], NO_CLOCK);
  return {
    path: folder,
    headBranch: head.ok && head.stdout !== "HEAD" ? head.stdout : null,
    // Unreadable counts as dirty. A status that failed on a stray index.lock
    // returns an empty stdout, which would otherwise read as "clean" and permit
    // a merge at exactly the moment it is least safe.
    dirty: !status.ok || status.stdout !== "",
    readable: status.ok,
  };
}

/**
 * Everything the run page and the branches page need to decide about a branch.
 *
 * Returns null when the run never had a branch — a non-isolated run, or one
 * that died before its checkout existed. That is an empty state, not an error.
 */
export async function landState(runId: string): Promise<LandState | null> {
  const run = getRun(runId);
  if (!run || run.isolation !== "worktree" || !run.worktree_branch || !run.repo_root) {
    return null;
  }

  const branch = run.worktree_branch;
  const repoRoot = repoPathFor(run.repo_root);
  const chain = branchChain(run);
  const base: LandState = {
    runId,
    runStatus: run.status,
    branch,
    chain,
    target: null,
    targetInferred: false,
    branchExists: false,
    ahead: 0,
    behind: 0,
    merged: false,
    landedUnchanged: false,
    preview: { outcome: "unknown", reason: "Not checked." },
    checkout: null,
    pending: null,
    blocked: null,
    landedAt: run.landed_at,
    landedInto: run.landed_into,
    landedStrategy: run.landed_strategy,
  };

  if (!repoRoot) {
    return {
      ...base,
      blocked: "This run's repository is no longer inside a workspace mount.",
    };
  }

  const exists = await git(
    repoRoot,
    ["rev-parse", "--verify", `refs/heads/${branch}`],
    NO_CLOCK,
  );
  if (!exists.ok) {
    return { ...base, blocked: `Branch ${branch} no longer exists.` };
  }

  const folder = repoPathFor(run.folder);
  const checkout = folder ? await checkoutStateOf(folder) : null;
  // Read alongside the checkout rather than behind a landable branch: a run
  // that could not commit has *nothing* on its branch, which is exactly the
  // state this answers, and the card has to be able to say so.
  const pending = await pendingWork(run);
  const target = await targetOf(run, repoRoot, checkout);

  if (!target) {
    return {
      ...base,
      branchExists: true,
      checkout,
      pending,
      blocked:
        "This run predates target-branch recording and its base commit is not " +
        `on the branch you have checked out, so there is no way to tell where ${branch} belongs. ` +
        "Merge it by hand.",
    };
  }

  const targetExists = await git(
    repoRoot,
    ["rev-parse", "--verify", `refs/heads/${target.branch}`],
    NO_CLOCK,
  );
  if (!targetExists.ok) {
    return {
      ...base,
      branchExists: true,
      checkout,
      pending,
      target: target.branch,
      targetInferred: target.inferred,
      blocked: `The branch this run started from (${target.branch}) no longer exists.`,
    };
  }

  const counts = await git(
    repoRoot,
    ["rev-list", "--left-right", "--count", `${target.branch}...${branch}`],
    NO_CLOCK,
  );
  const [behind = "0", ahead = "0"] = counts.stdout.split(/\s+/);

  const merged = (
    await git(repoRoot, ["merge-base", "--is-ancestor", branch, target.branch], NO_CLOCK)
  ).ok;

  const tip = (await git(repoRoot, ["rev-parse", branch], NO_CLOCK)).stdout;
  const landedUnchanged = !!run.landed_tip && run.landed_tip === tip;

  // Not previewed while the run can still commit: the answer would be stale
  // before it rendered, and `merge-tree` writes objects to work it out.
  // `landRefusal` tests the run's status ahead of the preview, so this never
  // becomes the reason shown.
  const active = ["running", "queued", "paused"].includes(run.status);

  const preview = merged
    ? ({ outcome: "already-merged" } as const)
    : active
      ? ({ outcome: "unknown", reason: "This run can still commit to it." } as const)
      : (
            await git(
              repoRoot,
              ["merge-base", "--is-ancestor", target.branch, branch],
              NO_CLOCK,
            )
          ).ok
        ? ({ outcome: "fast-forward" } as const)
        : await previewMerge(repoRoot, target.branch, branch);

  const state: LandState = {
    ...base,
    branchExists: true,
    target: target.branch,
    targetInferred: target.inferred,
    ahead: Number(ahead) || 0,
    behind: Number(behind) || 0,
    merged,
    landedUnchanged,
    preview,
    checkout,
    pending,
  };
  return {
    ...state,
    blocked: landRefusal({
      ...state,
      pendingCount: pending?.count ?? 0,
      loopBlock: loopStillRepeating(state.chain),
    }),
  };
}

/**
 * Every run on this run's branch, oldest first.
 *
 * Walked over `continues_run` rather than selected on `worktree_branch`,
 * because a dependent that has not been released yet has no branch recorded —
 * its whole isolation plan is deferred until it stops waiting. Selecting on the
 * branch would therefore report a chain of one right up until the next link
 * starts, which is exactly the window in which the first link looks landable
 * and is not.
 *
 * Bounded by construction: `continues_run` is a single id per run and admission
 * refuses a second run continuing the same one, so the walk is a path. The
 * `seen` set is there for the row a hand-edited database could still produce.
 *
 * The one place admission does allow a second is a link that came to nothing —
 * a dependent blocked because its own dependency failed, which is recorded here
 * and never committed. So the step down prefers a successor that can still hold
 * the branch, and only falls back to an empty one to keep the walk total. Both
 * readings agree about what matters: `branchOwner` skips an empty terminal run
 * and `chainBlocker` cannot match one, so which of two is followed decides
 * nothing.
 */
function branchChain(run: RunRow): ChainMember[] {
  const byId = db().prepare("SELECT * FROM runs WHERE id = ?");
  // The settled list is built from `TERMINAL_STATUSES` rather than spelled out,
  // for `admitDependencies`' reason: a second copy is a second thing to forget.
  // Nothing here breaks when it is wrong — this is an ordering rather than a
  // filter, and the docblock above argues that which of two successors is
  // followed decides nothing — but a stale copy quietly stops meaning what it
  // says, and the next member added will not be so lucky.
  const next = db().prepare(
    `SELECT * FROM runs WHERE continues_run = ?
      ORDER BY CASE WHEN iterations > 0
                      OR status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(",")})
                    THEN 0 ELSE 1 END,
               created_at
      LIMIT 1`,
  );
  const seen = new Set<string>([run.id]);

  const head: RunRow[] = [];
  for (let up = run; up.continues_run; ) {
    const prev = byId.get(up.continues_run) as RunRow | undefined;
    if (!prev || seen.has(prev.id)) break;
    seen.add(prev.id);
    head.unshift(prev);
    up = prev;
  }

  const tail: RunRow[] = [];
  for (let down = run; ; ) {
    const after = next.get(down.id, ...TERMINAL_STATUSES) as RunRow | undefined;
    if (!after || seen.has(after.id)) break;
    seen.add(after.id);
    tail.push(after);
    down = after;
  }

  return [...head, run, ...tail].map((r) => ({
    runId: r.id,
    status: r.status,
    iterations: r.iterations,
  }));
}

/**
 * A three-way merge in memory: no checkout, no index, nothing written to any
 * working tree. It does add loose objects to the repository's object store,
 * which gc collects — that is the whole cost of finding out honestly.
 *
 * Those objects are the reason the conflicting *content* can be shown before
 * anyone commits to anything: the tree merge-tree writes holds each conflicted
 * file exactly as a real merge would leave it, markers and all, so the operator
 * sees what they would be reconciling without a merge having happened.
 */
async function previewMerge(
  repoRoot: string,
  target: string,
  branch: string,
): Promise<MergePreview> {
  // No `--name-only`: it lands the conflict list in a simpler shape but arrived
  // two releases after `--write-tree` itself, and this has to work on whatever
  // git the host mounted.
  const res = await git(
    repoRoot,
    ["merge-tree", "--write-tree", "-z", target, branch],
    NO_CLOCK,
  );
  const preview = parseMergeTree(res.stdout, res.stderr, res.code);
  if (preview.outcome !== "conflict") return preview;

  // Field 0 of that same output, per the format `parseMergeTree` documents.
  const tree = res.stdout.split("\0", 1)[0] ?? "";
  return { outcome: "conflict", files: await withRegions(repoRoot, tree, preview.files) };
}

/**
 * Fill in each conflicted file's markers from the merged tree.
 *
 * Capped at `MAX_CONTENT_FILES`, because this runs on every load of the land
 * card and each file is another git process. Files past the cap keep
 * `regionsRead: false` rather than an empty region list — "we did not look" and
 * "there is nothing to see" are different sentences.
 */
async function withRegions(
  repoRoot: string,
  tree: string,
  files: ConflictFile[],
): Promise<ConflictFile[]> {
  if (!tree) return files;

  const out: ConflictFile[] = [];
  for (const file of files) {
    if (out.length >= MAX_CONTENT_FILES) {
      out.push(file);
      continue;
    }
    // Not every conflict leaves markers: a modify/delete keeps one version
    // whole, and a path that is not in the merged tree, or a file too large to
    // read, returns nothing at all. All three mean "no regions", which the
    // file's own message already explains.
    const blob = await git(repoRoot, ["show", `${tree}:${file.path}`], {
      maxBytes: MAX_CONTENT_BYTES,
    });
    if (!blob.ok) {
      out.push(file);
      continue;
    }
    const { regions, omitted } = conflictRegions(blob.stdout);
    out.push({ ...file, regions, regionsOmitted: omitted, regionsRead: true });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Deciding                                                            */
/* ------------------------------------------------------------------ */

/** Ids are UUIDs; the whole app names a run by its first eight characters. */
const short = (id: string) => id.slice(0, 8);

/** Statuses a run leaves on its own, and so may still commit from. */
const UNSETTLED: readonly RunRow["status"][] = [
  "waiting",
  "queued",
  "running",
  "paused",
];

/**
 * The run in a chain that owns the branch: the last one with work on it.
 *
 * Ordered by creation, which is dependency order — a run can only be told to
 * continue a branch that already exists, so it is always the younger. Members
 * that ended without a work cycle are skipped rather than counted: a dependent
 * that was blocked because its dependency failed is recorded on this branch and
 * put nothing on it, and letting it own the branch would make the run that
 * *did* the work unlandable for ever.
 *
 * Falls back to the first link when every member is empty. The branch then has
 * no commits at all, which `ahead === 0` refuses two checks later — but naming
 * the run that created it is a truer sentence than naming the last one to fail.
 */
function branchOwner(chain: readonly ChainMember[]): string | null {
  const worked = chain.filter(
    (m) => UNSETTLED.includes(m.status) || m.iterations > 0,
  );
  return worked.at(-1)?.runId ?? chain[0]?.runId ?? null;
}

/**
 * Another run on this branch that can still add to it, if there is one.
 *
 * Read by every door that would destroy or hand over the branch —
 * `landRefusal`, `purgeRefusal`, `deleteBranch` — because a chain turns each of
 * them from "this run's branch" into "a ref several runs are still writing to",
 * and all three were written when those were the same sentence.
 */
export function chainBlocker(
  runId: string,
  chain: readonly ChainMember[],
): ChainMember | null {
  return (
    chain.find((m) => m.runId !== runId && UNSETTLED.includes(m.status)) ?? null
  );
}

/**
 * A workflow loop block that is still repeating on this chain's branch, by name.
 *
 * `chainBlocker` answers "can another run that already exists still commit to
 * this ref", and a loop block is the one thing in this app that can commit to it
 * through a run that *does not exist yet*. Between the moment a pass reaches a
 * terminal status and the moment the next one is created there is no unsettled
 * member on the branch at all, so every door here — landing, deleting, purging,
 * paying for a conflict resolution — would read the chain as finished and act on
 * a ref that is about to move.
 *
 * Read straight off the tables rather than through `workflows.ts`, which imports
 * `mergeQueue.ts`, which imports this file. A loop block that has settled, or an
 * instance that was halted, leaves no `looping` row, so this is silent for every
 * branch that is not a live loop's — which is all of them on most installs.
 */
function loopStillRepeating(chain: readonly ChainMember[]): string | null {
  if (chain.length === 0) return null;
  const row = db()
    .prepare(
      `SELECT b.node_name AS name
         FROM workflow_instance_runs w
         JOIN workflow_instance_blocks b
           ON b.instance_id = w.instance_id AND b.node_id = w.emitted_by
        WHERE b.status = 'looping'
          AND w.run_id IN (${chain.map(() => "?").join(",")})
        LIMIT 1`,
    )
    .get(...chain.map((m) => m.runId)) as { name: string } | undefined;
  return row?.name ?? null;
}

/** The sentence every door that would move or destroy the branch shares. */
function loopRefusal(blockName: string, doing: string): string {
  return (
    `The workflow block “${blockName}” repeats on this branch and has another ` +
    `pass to decide on, so ${doing}. Stop that run of the workflow first.`
  );
}

/**
 * Why this branch cannot be landed right now, or null when it can.
 *
 * Pure, and separated from everything that touches a filesystem, because this
 * is the decision that writes into a directory the operator owns. Every branch
 * of it is a refusal that has to be *explained*: the handoff card's rule was
 * "withhold and say why, never show-and-caveat", and a landing button that is
 * simply greyed out is the same failure in a different shape.
 */
export function landRefusal(s: {
  runId: string;
  runStatus: RunRow["status"];
  branchExists: boolean;
  target: string | null;
  merged: boolean;
  landedUnchanged: boolean;
  ahead: number;
  /** Uncommitted paths in the run's own checkout. */
  pendingCount: number;
  preview: MergePreview;
  checkout: CheckoutState | null;
  /** Every run on this branch, oldest first. See `ChainMember`. */
  chain: readonly ChainMember[];
  /**
   * A loop block still repeating on this branch, by name. See
   * `loopStillRepeating` — the run that would commit next does not exist yet, so
   * `chain` cannot see it.
   */
  loopBlock?: string | null;
}): string | null {
  if (!s.branchExists) return "This branch no longer exists.";
  if (!s.target) return "There is no recorded branch for this work to land into.";

  // `needs-review` is deliberately absent, and it looks like an omission. A run
  // that asked for review cannot commit again unless somebody reopens it —
  // exactly like `completed`, `stopped` and `failed`, all three of which are
  // landable today — and an operator who has read the reason may well decide the
  // partial work is worth having. Taking the button away would leave them with a
  // branch and no route to it.
  if (s.runStatus === "running" || s.runStatus === "queued" || s.runStatus === "paused") {
    return (
      "This run is still active. It can commit again at any moment, so anything " +
      "landed now would be half its work."
    );
  }

  // Before the chain tests rather than inside them: a loop on its first pass is
  // a chain of one, so the whole block below is skipped and the branch would
  // read as a finished run's.
  if (s.loopBlock) {
    return loopRefusal(
      s.loopBlock,
      "anything landed now would be what it has done so far rather than all of it",
    );
  }

  // One branch, one Land button. Three runs extending each other's work share a
  // ref, so without this every one of them offers to land it: the operator
  // merges the first, the second still reads unmerged because the branch has
  // moved since, and the merge queue would take the same branch three times.
  // The last link is the one that has all of it. Both refusals name a run,
  // because "this cannot be landed" with no address is a dead end on a page
  // whose whole purpose is to get the work merged.
  if (s.chain.length > 1) {
    const owner = branchOwner(s.chain);
    if (owner && owner !== s.runId) {
      const last = s.chain.find((m) => m.runId === owner)!;
      return (
        `Run ${short(owner)} carries this branch on from here and is the one that lands it ` +
        `(it is ${last.status}). Landing from this run would take the same branch a second time, ` +
        "not a smaller part of it — the whole chain is on one ref."
      );
    }
    const busy = chainBlocker(s.runId, s.chain);
    if (busy) {
      return (
        `Run ${short(busy.runId)} is ${busy.status} on this same branch and can still commit to it, ` +
        "so anything landed now would be part of the chain rather than all of it."
      );
    }
  }

  if (s.merged) return `Already in ${s.target} — there is nothing left to land.`;
  // A squash leaves no ancestry to find, so without this the branch reads as
  // unmerged and would be offered for landing a second time — which replays a
  // change that is already in the target.
  if (s.landedUnchanged) {
    return `Already squashed into ${s.target}, and nothing new has been committed to it since.`;
  }
  // An empty branch with a full checkout behind it is not an empty run — it is
  // an agent that wrote everything and committed none of it, which is what
  // `commitPending` exists for. Saying only "no commits" sends the operator
  // looking for work that is sitting right there.
  if (s.ahead === 0) {
    return s.pendingCount > 0
      ? `This branch has no commits of its own, but ${s.pendingCount} path(s) are uncommitted in its checkout. Commit them first.`
      : "This branch has no commits of its own.";
  }

  if (s.preview.outcome === "conflict") {
    return `Merging into ${s.target} conflicts in ${s.preview.files.length} file(s). Resolve them on the branch first.`;
  }
  if (s.preview.outcome === "unknown") return s.preview.reason;

  if (!s.checkout) return "This run's folder is no longer inside a workspace mount.";
  if (!s.checkout.readable) {
    return "Could not read your checkout's status, so nothing is offered. Check it by hand.";
  }
  if (s.checkout.dirty) {
    return "Your checkout has uncommitted changes — commit or stash them first.";
  }
  if (s.checkout.headBranch !== s.target) {
    return (
      `Your checkout is on ${s.checkout.headBranch ?? "a detached HEAD"}, and this work belongs on ` +
      `${s.target}. Switch to it first — landing onto the wrong branch is not something this can undo.`
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Doing it                                                            */
/* ------------------------------------------------------------------ */

export type LandOutcome =
  | {
      ok: true;
      message: string;
      /**
       * The `run_reviews` row a conflict resolution started, for a caller that
       * has to wait for it. Absent when nothing was spawned — including the
       * resolution that finds the branches agree after all.
       */
      assistId?: string;
    }
  | { ok: false; reason: string; conflicts?: string[] };

/**
 * Merge the run's branch into its target, in the operator's own checkout.
 *
 * The one write this app makes outside `.uf-worktrees`. Every check is taken
 * again here from a fresh read rather than trusted from whatever the page was
 * showing — the page may have been open for an hour, and the checkout is
 * somewhere a person also works.
 */
export async function landRun(
  runId: string,
  strategy: LandStrategy = getSettings().landStrategy,
): Promise<LandOutcome> {
  const run = getRun(runId);
  if (!run) return { ok: false, reason: "No such run." };

  const state = await landState(runId);
  if (!state) return { ok: false, reason: "This run has no branch to land." };
  if (state.blocked) return { ok: false, reason: state.blocked };

  const folder = state.checkout!.path;
  const target = state.target!;
  const branch = state.branch;

  // A run working in this folder — or in anything above or below it — makes the
  // tree move under the merge. `conflictKey`/`overlaps` is the same comparison
  // the folder claim uses, so "the same folder" means the same thing here as it
  // does there.
  const key = conflictKey(folder);
  const busy = activeRuns().find((r) => overlaps(key, conflictKey(workDirOf(r))));
  if (busy) {
    return {
      ok: false,
      reason: `Run ${busy.id.slice(0, 8)} is working in this folder. Landing while it writes would merge into a moving tree.`,
    };
  }

  if (landing.has(folder)) {
    return { ok: false, reason: "Another branch is being landed into this folder." };
  }
  landing.add(folder);

  try {
    // THE OPERATOR'S OWN CHECK, BEFORE ANYTHING MOVES.
    //
    // Everything above this line is about the checkout — clean, on target,
    // nobody working in it. None of it is about the work. `landVerifyCommand`
    // is the one place an operator can say "not unless this passes", and it
    // has to run before the merge rather than after: a failing check on an
    // already-merged branch is a report, and what was asked for is a refusal.
    //
    // Off by default, and an unset command is not a check that passed. On the
    // branch, not the target, because the question is whether THIS work is
    // good — so it runs against the run's own tree, which is where the agent
    // left it.
    const verify = await runVerify(state.checkout!.path, getSettings().landVerifyCommand);
    if (!verify.passed) {
      landing.delete(folder);
      return { ok: false, reason: verify.reason };
    }

    // Read before the merge: after a squash there is nothing in the target's
    // history that points back at these commits, and this is what makes them
    // identifiable afterwards.
    const tip = (await git(folder, ["rev-parse", branch], NO_CLOCK)).stdout;

    // No clock on the merge itself, which is the whole of `NO_CLOCK`'s reason:
    // a merge killed part-way through reads here exactly like git refusing one,
    // so a repository large enough to take a while was told its work could not
    // be merged and had it rolled back.
    const merge =
      strategy === "squash"
        ? await git(folder, ["merge", "--squash", branch], NO_CLOCK)
        : await git(folder, ["merge", "--no-edit", branch], NO_CLOCK);

    if (!merge.ok) {
      const conflicts = await conflictedFiles(folder);
      await unwind(folder, strategy);
      return {
        ok: false,
        reason:
          conflicts.length > 0
            ? `The merge conflicted and was rolled back — your checkout is untouched. Conflicting: ${conflicts.join(", ")}`
            : `git refused the merge and it was rolled back: ${merge.stderr.split("\n")[0] || "unknown error"}`,
        conflicts,
      };
    }

    if (strategy === "squash") {
      // `--squash` stages the change and stops. Without this the operator is
      // left holding a staged merge that the app claims to have landed.
      const commit = await git(
        folder,
        [
          "commit",
          "-m",
          taskSubject(run),
          "-m",
          `Squashed from ${branch} (UsageFoundry run ${run.id}).`,
        ],
        NO_CLOCK,
      );
      if (!commit.ok) {
        await unwind(folder, strategy);
        return {
          ok: false,
          reason: `The squash could not be committed and was rolled back: ${commit.stderr.split("\n")[0] || "unknown error"}`,
        };
      }
    }

    const now = Date.now();
    db()
      .prepare(
        "UPDATE runs SET landed_at=?, landed_into=?, landed_strategy=?, landed_tip=? WHERE id=?",
      )
      .run(now, target, strategy, tip || null, runId);

    emitRunEvent({
      runId,
      ts: now,
      kind: "land",
      payload: { branch, target, strategy, folder },
    });

    return {
      ok: true,
      message:
        strategy === "squash"
          ? `Squashed ${branch} into ${target} as one commit.`
          : `Merged ${branch} into ${target}.`,
    };
  } finally {
    landing.delete(folder);
  }
}

/**
 * Paths git left conflicted, read before the merge is unwound.
 *
 * `-z` for `parseNumstat`'s reason, and it matters more here than it does
 * there: the default format C-quotes any path holding a non-ASCII byte, and
 * every consumer of this list uses what it returns as a real path — the
 * resolution prompt names it, `run_reviews.resolved_paths` keeps it for
 * `resolutionChange`'s pathspec, the `after` handler joins it onto the checkout
 * and reads it, and `git add` stages it. So `café.txt` arriving as
 * `"caf\303\251.txt"` did not mangle a name in a report, it made the branch
 * unresolvable: the read failed, an unreadable file counts as unresolved, and
 * the whole merge was rolled back after the resolution had been paid for.
 *
 * `trim: false` for `parseStatusZ`'s reason — a leading space is part of a
 * filename — so the empty record after the final NUL is dropped here instead.
 * It has to be: `:(top,literal)` with an empty path matches the entire tree.
 *
 * Exported for `conflictedPaths.test.ts` and for nothing else, `logLifecycle`'s
 * precedent: what has to be pinned is the argv as much as the parse.
 */
export async function conflictedFiles(folder: string): Promise<string[]> {
  const res = await git(folder, ["diff", "--name-only", "--diff-filter=U", "-z"], {
    ...NO_CLOCK,
    trim: false,
  });
  return res.ok ? res.stdout.split("\0").filter((p) => p !== "") : [];
}

/**
 * Put the checkout back the way it was found.
 *
 * `merge --abort` is the right undo for a real merge. A failed `--squash` never
 * writes MERGE_HEAD, so abort has nothing to work from and `reset --hard` is
 * the only recovery — safe here, and only here, because the tree was proved
 * clean seconds earlier and no run is allowed to be writing in it.
 */
async function unwind(folder: string, strategy: LandStrategy): Promise<void> {
  // Least of all this one: a rollback killed part-way through leaves the
  // operator's own checkout mid-merge.
  const abort = await git(folder, ["merge", "--abort"], NO_CLOCK);
  if (abort.ok || strategy !== "squash") return;
  await git(folder, ["reset", "--hard", "HEAD"], NO_CLOCK);
}

/** First line of the task, as a commit subject. */
function taskSubject(run: RunRow): string {
  const first = run.prompt.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  const subject = first.length > 68 ? `${first.slice(0, 65)}…` : first;
  return subject || `UsageFoundry run ${run.id.slice(0, 8)}`;
}

/* ------------------------------------------------------------------ */
/* Resolving a conflict, with help                                     */
/* ------------------------------------------------------------------ */

/**
 * Conflict markers git leaves in a file it could not merge.
 *
 * Only the two labelled markers, never the bare `=======` line: that is an
 * ordinary markdown heading underline, and treating it as evidence of a
 * conflict would refuse a perfectly resolved file.
 */
export function hasConflictMarkers(text: string): boolean {
  return /^(<<<<<<< |>>>>>>> )/m.test(text);
}

/** Which of the conflicted files the agent left with markers still in them. */
export function unresolvedFiles(
  files: ReadonlyArray<{ path: string; text: string | null }>,
): string[] {
  // A file that cannot be read is unresolved: refusing to commit is the
  // recoverable mistake, committing half a merge is not.
  return files.filter((f) => f.text === null || hasConflictMarkers(f.text)).map((f) => f.path);
}

/** Where the resolution happens: never the operator's checkout. */
interface ResolveCheckout {
  path: string;
  /** True when this call created it, so this call removes it. */
  temporary: boolean;
}

/**
 * A checkout of the run's branch to merge into, outside the operator's tree.
 *
 * Prefers the run's own slot when it still holds that branch and is clean —
 * nothing to create, nothing to delete. Otherwise a dedicated one, because a
 * slot is reused by later runs and taking one that another run is about to
 * adopt is the collision the whole worktree scheme exists to avoid.
 *
 * Exported for the test that two runs resolving at once are handed two
 * directories. Nothing else calls it.
 */
export async function resolveCheckout(
  repoRoot: string,
  run: RunRow,
  branch: string,
): Promise<ResolveCheckout> {
  const own = run.worktree_path;
  if (own && fs.existsSync(own)) {
    const head = await git(own, ["rev-parse", "--abbrev-ref", "HEAD"], NO_CLOCK);
    const status = await git(own, ["status", "--porcelain"], NO_CLOCK);
    if (head.ok && head.stdout === branch && status.ok && status.stdout === "") {
      return { path: own, temporary: false };
    }
  }

  // Named for the run, not for the repository. The store is shared by every run
  // in it and a resolution holds its checkout for as long as its agent runs, so
  // one `<slug>-resolve` for the whole repository meant the removal below
  // deleting a live resolution's working tree out from under a billed child —
  // and that resolution's `after` handler then aborting the merge it found in
  // its place, which belonged to the run that had taken the directory over.
  // Throws unless the store is a real directory inside the mount.
  const slot = auxWorktreePath(repoRoot, `resolve-${short(run.id)}`);
  if (fs.existsSync(slot)) {
    // Left behind by an earlier attempt that could not clean up. Removing it is
    // safe because the path is this run's alone and `resolveConflicts` admits
    // one resolution per run, so nothing live can be standing in it.
    await git(repoRoot, ["worktree", "remove", "--force", slot], NO_CLOCK);
    fs.rmSync(slot, { recursive: true, force: true });
  }
  await git(repoRoot, ["worktree", "prune"], NO_CLOCK);

  // A full checkout, and one that is being made in order to merge. The half
  // hour it used to be given was the same guess as the merge's two minutes.
  const add = await git(repoRoot, ["worktree", "add", slot, branch], NO_CLOCK);
  if (!add.ok) {
    throw new Error(`Could not create a checkout to resolve in: ${add.stderr.split("\n")[0]}`);
  }
  return { path: slot, temporary: true };
}

async function discardCheckout(
  repoRoot: string,
  checkout: ResolveCheckout,
): Promise<void> {
  if (!checkout.temporary) return;
  await git(repoRoot, ["worktree", "remove", "--force", checkout.path], NO_CLOCK);
}

/**
 * Runs whose resolution is being set up.
 *
 * `assistRunning` is the durable guard and stays the one that answers for a
 * resolution already under way, but it reads a row `startAssist` has not
 * inserted yet: two callers for one run — the merge queue draining it while the
 * operator presses the button — both pass it, and the second's checkout setup
 * then deletes the first's. Held only as far as the row, never for the life of
 * the child, so a spawn that fails cannot lock a run out of resolving. On
 * `globalThis` for the reason `landing` above is.
 */
const resolving = ((globalThis as unknown as { __ufResolving?: Set<string> })
  .__ufResolving ??= new Set<string>());

/**
 * Merge the target *into* the run's branch, and have Claude resolve what git
 * could not.
 *
 * The direction is the whole design. Merging the operator's branch into the
 * run's branch happens in an isolated checkout, so a resolution that goes badly
 * costs a branch nobody has landed yet and touches nothing the operator owns.
 * When it goes well the branch contains the target, and landing it becomes a
 * fast-forward — which the ordinary landing path then performs under all of its
 * usual checks. There is no path here that writes into the operator's checkout.
 *
 * The agent resolves *text* and nothing else: it is not asked to commit, and
 * `acceptEdits` does not let it run git. This app checks that no marker
 * survived and then makes the commit itself. An agent that reports success
 * having left `<<<<<<<` in a file is the exact failure this ordering prevents.
 */
export async function resolveConflicts(runId: string): Promise<LandOutcome> {
  // Checked and taken in one turn — `createRun`'s folder-claim property — so
  // two callers arriving together cannot both get past it.
  if (resolving.has(runId)) {
    return { ok: false, reason: "A resolution for this run is already being started." };
  }
  resolving.add(runId);
  try {
    return await startResolution(runId);
  } finally {
    resolving.delete(runId);
  }
}

/** The body of `resolveConflicts`, bracketed by its claim. */
async function startResolution(runId: string): Promise<LandOutcome> {
  const run = getRun(runId);
  if (!run) return { ok: false, reason: "No such run." };
  if (assistRunning(runId, "resolve")) {
    return { ok: false, reason: "A resolution for this run is already running." };
  }

  const state = await landState(runId);
  if (!state) return { ok: false, reason: "This run has no branch." };
  if (!state.branchExists || !state.target) {
    return { ok: false, reason: state.blocked ?? "There is nothing to resolve." };
  }
  if (["running", "queued", "paused"].includes(run.status)) {
    return {
      ok: false,
      reason: "This run is still active — it can commit again, and would be resolving against a moving branch.",
    };
  }
  // Same sentence from the other end of a chain: the branch is shared, so a run
  // further along it moves this one's branch just as surely as this run would.
  // Refused before the spawn rather than after, because a resolution is billed.
  const sibling = chainBlocker(run.id, state.chain);
  if (sibling) {
    return {
      ok: false,
      reason: `Run ${short(sibling.runId)} is ${sibling.status} on this same branch, so a resolution paid for now would be resolving against a moving branch.`,
    };
  }
  // And the run that is not there yet — a loop's next pass. Same sentence, and
  // it matters most here of the four: this door is the one that spends money.
  const repeating = loopStillRepeating(state.chain);
  if (repeating) {
    return {
      ok: false,
      reason: loopRefusal(
        repeating,
        "a resolution paid for now would be resolving against a moving branch",
      ),
    };
  }
  if (state.preview.outcome !== "conflict") {
    return {
      ok: false,
      reason:
        state.preview.outcome === "unknown"
          ? state.preview.reason
          : `${state.branch} does not conflict with ${state.target}, so there is nothing to resolve.`,
    };
  }

  const refusal = await assistRefusal();
  if (refusal) return { ok: false, reason: refusal };

  const repoRoot = repoPathFor(run.repo_root!);
  if (!repoRoot) {
    return { ok: false, reason: "This run's repository is no longer inside a workspace mount." };
  }

  const target = state.target;
  const branch = state.branch;
  let checkout: ResolveCheckout;
  try {
    checkout = await resolveCheckout(repoRoot, run, branch);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  const merge = await git(checkout.path, ["merge", "--no-edit", target], NO_CLOCK);
  if (merge.ok) {
    // The preview was stale — the branches agree after all. The merge commit is
    // real and useful: landing is now a fast-forward.
    await discardCheckout(repoRoot, checkout);
    return {
      ok: true,
      message: `${target} merged into ${branch} with no conflicts, so nothing needed resolving.`,
    };
  }

  const conflicted = await conflictedFiles(checkout.path);
  if (conflicted.length === 0) {
    await git(checkout.path, ["merge", "--abort"], NO_CLOCK);
    await discardCheckout(repoRoot, checkout);
    return {
      ok: false,
      reason: `git could not merge ${target} into ${branch}: ${merge.stderr.split("\n")[0] || "unknown error"}`,
    };
  }

  // Only where a toolchain can exist. `resolveCheckout` reuses the run's own
  // worktree when that tree is clean and standing on the branch, and otherwise
  // cuts a fresh one that has no dependency tree in it — where a check fails for
  // a reason that is not the merge, and an agent reading a missing-module error
  // as its own bad resolution will "fix" code that was right.
  const verifyTools = checkout.temporary ? [] : getSettings().resolveVerifyTools;

  const outcome = startAssist({
    run,
    kind: "resolve",
    cwd: checkout.path,
    // It edits files in an isolated checkout and does nothing else. It is not
    // given `bypassPermissions`, and it is not asked to run git — the commit is
    // made below, after the result has been checked.
    permissionMode: "acceptEdits",
    allowedTools: verifyTools,
    prompt: resolvePrompt(branch, target, conflicted, verifyTools),
    counts: { files: conflicted.length, shown: conflicted.length, truncated: false },
    // Recorded now rather than derived later: the throwaway checkout is gone
    // minutes from here, and these paths are what makes the resolution's own
    // change readable afterwards instead of the whole merge.
    paths: conflicted,
    after: async (result) => {
      // The spawn itself failed — a crash, a timeout, a refusal. Roll back and
      // keep its own error: reporting "markers are still in f.txt" would be
      // true and useless, because the agent never ran.
      if (result.status === "failed") {
        await git(checkout.path, ["merge", "--abort"], NO_CLOCK);
        await discardCheckout(repoRoot, checkout);
        return;
      }

      const left = unresolvedFiles(
        conflicted.map((p) => ({ path: p, text: readIfPossible(path.join(checkout.path, p)) })),
      );
      if (left.length > 0) {
        await git(checkout.path, ["merge", "--abort"], NO_CLOCK);
        await discardCheckout(repoRoot, checkout);
        return {
          status: "failed" as const,
          error: `Conflict markers are still in ${left.join(", ")}. The merge was rolled back; ${branch} is unchanged.`,
        };
      }

      const staged = await git(
        checkout.path,
        ["add", "--", ...conflicted.map((p) => `:(top,literal)${p}`)],
        NO_CLOCK,
      );
      const unmerged = await git(checkout.path, ["ls-files", "-u"], NO_CLOCK);
      if (!staged.ok || !unmerged.ok || unmerged.stdout !== "") {
        await git(checkout.path, ["merge", "--abort"], NO_CLOCK);
        await discardCheckout(repoRoot, checkout);
        return {
          status: "failed" as const,
          error: `The resolution could not be staged, so the merge was rolled back and ${branch} is unchanged.`,
        };
      }

      const commit = await git(checkout.path, ["commit", "--no-edit"], NO_CLOCK);
      if (!commit.ok) {
        await git(checkout.path, ["merge", "--abort"], NO_CLOCK);
        await discardCheckout(repoRoot, checkout);
        return {
          status: "failed" as const,
          error: `The merge could not be committed and was rolled back: ${commit.stderr.split("\n")[0] || "unknown error"}`,
        };
      }

      // Read before the checkout goes: this is the only handle on what the
      // resolution decided. Its prose survives in the row either way, but prose
      // is what the agent says it did, not what it did.
      const head = await git(checkout.path, ["rev-parse", "HEAD"], NO_CLOCK);

      await discardCheckout(repoRoot, checkout);
      emitRunEvent({
        runId,
        ts: Date.now(),
        kind: "land",
        payload: { branch, target, resolved: conflicted },
      });
      return {
        status: "completed" as const,
        resolvedCommit: head.ok ? head.stdout : undefined,
      };
    },
  });

  return outcome.ok
    ? {
        ok: true,
        message: `Resolving ${conflicted.length} conflicting file(s) in an isolated checkout. Your own checkout is not involved.`,
        assistId: outcome.id,
      }
    : { ok: false, reason: outcome.reason };
}

/** What a resolution actually did, as a diff. */
export interface ResolutionChange {
  /** The merge commit it made on the run's branch. */
  commit: string;
  files: DiffFile[];
  /** Files whose patch was withheld for size. */
  omittedPatches: number;
}

/**
 * The change a completed resolution made to the files it was given.
 *
 * The agent's answer says what it kept and why; this says what is on the
 * branch. It is taken against the merge commit's **first** parent — the branch
 * as it stood before the target arrived — so each file reads as "how this ended
 * up, against what the run had committed", which is the question an operator
 * about to land it is actually asking.
 *
 * Restricted to the recorded conflicted paths. The rest of the merge is
 * whatever git reconciled by itself, and folding it in here would present it as
 * something a model decided.
 */
export async function resolutionChange(
  row: ReviewRow,
): Promise<ResolutionChange | null> {
  if (row.kind !== "resolve" || row.status !== "completed" || !row.resolved_commit) {
    return null;
  }
  const paths = reviewPaths(row);
  if (paths.length === 0) return null;

  const run = getRun(row.run_id);
  const repoRoot = run?.repo_root ? repoPathFor(run.repo_root) : null;
  if (!repoRoot) return null;

  const diff = await commitDiff(repoRoot, row.resolved_commit, paths);
  return diff && { commit: row.resolved_commit, ...diff };
}

function readIfPossible(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * `verify` is the tool patterns this invocation was actually granted, so the
 * prompt cannot promise a command the argv did not allow. Naming them rather
 * than saying "run the tests" is what keeps the two in step: an agent told to
 * verify and then refused reports the refusal as a finding about the merge,
 * which is how nineteen resolutions came to carry a limitation in their report
 * text instead of a result.
 */
function resolvePrompt(
  branch: string,
  target: string,
  files: string[],
  verify: readonly string[] = [],
): string {
  return [
    `You are resolving a git merge conflict in an isolated checkout. \`${target}\` has just been`,
    `merged into \`${branch}\` and git could not reconcile these files:`,
    "",
    ...files.map((f) => `  ${f}`),
    "",
    "Each one contains conflict markers (<<<<<<<, =======, >>>>>>>). Edit every one of them so",
    "that the result keeps the intent of *both* sides — the branch's change and the change that",
    "arrived from the other branch — and remove every marker. Read the surrounding code first;",
    "picking one side wholesale is almost always wrong.",
    "",
    "Rules:",
    "- Edit only the files listed above. Do not touch anything else.",
    "- Do not run git. Do not commit or stage anything: that is done for you once your work has",
    "  been checked, and a merge with a marker left in it is rejected.",
    "- If two changes genuinely cannot both stand, keep the one from the branch being merged in",
    `  (\`${target}\`) and say so in your answer.`,
    ...(verify.length
      ? [
          `- You may run these, and nothing else: ${verify.join(", ")}. Run them once the markers`,
          "  are gone and say what they printed. If one fails, fix the resolution rather than the",
          "  code around it — a failure here is almost always a merge you got wrong.",
        ]
      : [
          "- You cannot run commands in this checkout, so do not try: judge the result by reading it.",
          "  Say plainly in your answer what you could not check rather than treating it as a defect.",
        ]),
    "",
    "When you are done, reply with one short paragraph per file saying what you kept and why.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Committing what an agent left in its checkout                       */
/* ------------------------------------------------------------------ */

/**
 * Work an agent did and did not commit.
 *
 * This exists because that state is reachable and its symptoms point the wrong
 * way. `acceptEdits` held mutating git for a human until `buildArgs` started
 * granting `git add`/`git commit` to an isolated run, so every run from before
 * that — and any run whose agent simply never got round to committing — ends
 * `completed` with a full checkout and an empty branch. What the land card then
 * said was "this branch has no commits of its own", which reads as a run that
 * did nothing.
 *
 * It is also what unblocks the slot: `ensureWorktree` refuses to reuse a
 * checkout with uncommitted work in it, so leftovers do not just sit there —
 * they take a worktree slot out of circulation until someone deals with them.
 */

/** Paths listed per checkout. The count beside them is always the whole set. */
const MAX_PENDING_FILES = 40;
/** Longest commit message accepted. A subject is a sentence, not a file. */
const MAX_COMMIT_MESSAGE = 1_000;

/**
 * Parse `git status --porcelain -z`.
 *
 * Records are `XY <space> <path> NUL`, and a rename or copy carries its source
 * in the *next* field — with `-z` the arrow is dropped and the order reversed,
 * so the current path comes first and the original follows. Consuming that
 * second field is not optional: left in the stream it becomes a change of its
 * own, with the first two characters of a filename read as status letters.
 *
 * The caller must not trim this output. `" M path"` opens with a space that
 * means "unstaged", and losing it shifts every field in that record — which is
 * why `git()` takes `trim: false`.
 */
export function parseStatusZ(raw: string): PendingChange[] {
  const out: PendingChange[] = [];
  const fields = raw.split("\0");

  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    // `XY ` and at least one character of path. The trailing field after the
    // final NUL is empty and lands here too.
    if (record.length < 4 || record[2] !== " ") continue;

    const code = record.slice(0, 2);
    const renamed = /[RC]/.test(code);
    const origPath = renamed ? (fields[i + 1] ?? null) : null;
    // A record cut short — a killed git — must not silently pair a rename with
    // whatever field happens to follow it later.
    if (renamed && origPath === null) break;
    if (renamed) i++;

    out.push({ path: record.slice(3), origPath, code });
  }

  return out;
}

/** A run's own checkout as it stands now, which need not still be its own. */
interface SlotState {
  /** The checkout recorded for this run, or null when it never had one. */
  path: string | null;
  /** The branch that checkout holds **now**: a slot is reused by later runs. */
  checkedOutBranch: string | null;
  /** False when `git status` failed — which is not the same as clean. */
  readable: boolean;
  files: PendingChange[];
}

async function slotState(run: RunRow): Promise<SlotState> {
  const slot = run.worktree_path;
  if (!slot || !fs.existsSync(slot)) {
    return { path: slot ?? null, checkedOutBranch: null, readable: false, files: [] };
  }

  const head = await git(slot, ["rev-parse", "--abbrev-ref", "HEAD"], NO_CLOCK);
  const checkedOutBranch = head.ok && head.stdout !== "HEAD" ? head.stdout : null;
  // Status is read only once the slot is proved to still hold this run's
  // branch. Anything uncommitted under a different branch is a later run's, and
  // reporting it here would offer to commit one run's work onto another's.
  if (!checkedOutBranch || checkedOutBranch !== run.worktree_branch) {
    return { path: slot, checkedOutBranch, readable: head.ok, files: [] };
  }

  const status = await git(slot, ["status", "--porcelain", "-z"], {
    ...NO_CLOCK,
    trim: false,
  });
  return {
    path: slot,
    checkedOutBranch,
    readable: status.ok,
    files: status.ok ? parseStatusZ(status.stdout) : [],
  };
}

/** What the land card shows about uncommitted work, or nothing to show. */
async function pendingWork(run: RunRow): Promise<PendingWork | null> {
  const slot = await slotState(run);
  if (!slot.path || slot.checkedOutBranch !== run.worktree_branch) return null;
  // An unreadable status still surfaces: "we could not tell" and "there is
  // nothing there" are different sentences, and only the second one is silence.
  if (slot.readable && slot.files.length === 0) return null;

  return {
    path: slot.path,
    count: slot.files.length,
    files: slot.files.slice(0, MAX_PENDING_FILES),
    readable: slot.readable,
    suggestedMessage: taskSubject(run),
  };
}

/**
 * Why this app will not make a commit in that checkout, or null when it will.
 *
 * Pure and separated for the reason `landRefusal` is: it decides whether to
 * write, and the expensive way to be wrong is not refusing — it is committing
 * a slot's contents onto the wrong branch after a later run took that slot
 * over, which produces a commit nobody made against work nobody wrote.
 */
export function commitRefusal(s: {
  runStatus: RunRow["status"];
  isolated: boolean;
  /** The branch recorded for this run. */
  branch: string | null;
  /** The branch its checkout holds now — not necessarily the same one. */
  checkedOutBranch: string | null;
  readable: boolean;
  pendingCount: number;
  message: string;
}): string | null {
  if (!s.isolated) {
    return "This run worked directly in your own checkout, so committing there is yours to do.";
  }
  if (!s.branch) return "This run has no branch of its own.";

  if (s.runStatus === "running" || s.runStatus === "queued" || s.runStatus === "paused") {
    return (
      "This run is still active. It can write to that checkout at any moment, so a " +
      "commit now would catch a change half-written."
    );
  }

  if (!s.checkedOutBranch) {
    return (
      `The checkout this run worked in is gone. Its commits are still on ${s.branch}; ` +
      "anything it had not committed is not."
    );
  }
  if (s.checkedOutBranch !== s.branch) {
    return (
      `That checkout slot now holds ${s.checkedOutBranch}, not ${s.branch} — whatever is ` +
      "uncommitted in it belongs to another run."
    );
  }
  if (!s.readable) {
    return "Could not read that checkout's status, so nothing is offered. Check it by hand.";
  }
  if (s.pendingCount === 0) return "There is nothing uncommitted in that checkout.";

  const message = s.message.trim();
  if (message === "") return "A commit message is required.";
  if (message.length > MAX_COMMIT_MESSAGE) {
    return `That message is ${message.length} characters; ${MAX_COMMIT_MESSAGE} is the most this takes.`;
  }
  return null;
}

/**
 * Commit everything uncommitted in the run's checkout, onto the run's branch.
 *
 * `add -A` rather than the listed paths: gitignored files stay ignored, so what
 * this stages is exactly what the status above listed, and a file the agent
 * created between the page load and the click is part of the same work rather
 * than a leftover for the next run to trip over. Nothing is written to the
 * operator's own tree at any point — the branch is what moves.
 */
export async function commitPending(
  runId: string,
  message?: string,
): Promise<LandOutcome> {
  const run = getRun(runId);
  if (!run) return { ok: false, reason: "No such run." };

  const slot = await slotState(run);
  // Absent is "use the task", which is what the inventory's one-click commit
  // sends. A message that *was* given and is blank is refused below rather than
  // quietly replaced — the operator cleared it, and a commit subject they did
  // not write is not a repair for that.
  const resolved = message === undefined ? taskSubject(run) : message;

  const refusal = commitRefusal({
    runStatus: run.status,
    isolated: run.isolation === "worktree",
    branch: run.worktree_branch,
    checkedOutBranch: slot.checkedOutBranch,
    readable: slot.readable,
    pendingCount: slot.files.length,
    message: resolved,
  });
  if (refusal) return { ok: false, reason: refusal };

  const dir = slot.path!;
  const branch = run.worktree_branch!;

  // The status proves the slot still holds this run's branch; this proves
  // nobody is about to start writing in it. A run records its slot when it is
  // created, so a queued one owns the path before `ensureWorktree` has switched
  // the branch over — and the check above would not see it yet.
  const holder = activeRuns().find((r) => r.worktree_path === dir);
  if (holder) {
    return {
      ok: false,
      reason: `Run ${holder.id.slice(0, 8)} has that checkout. Wait for it to finish.`,
    };
  }

  const staged = await git(dir, ["add", "-A"], NO_CLOCK);
  if (!staged.ok) {
    return {
      ok: false,
      reason: `git could not stage the changes: ${staged.stderr.split("\n")[0] || "unknown error"}`,
    };
  }

  const commit = await git(
    dir,
    ["commit", "-m", resolved.trim(), "-m", `Committed from UsageFoundry run ${run.id}.`],
    NO_CLOCK,
  );
  if (!commit.ok) {
    // Left staged rather than reset. This app's own git runs with hooks off, so
    // the refusal is git's own — a signing key it cannot reach, a locked index —
    // and re-running is the likely next move; the agent may also have staged
    // part of this itself, and unstaging that would be this app undoing work it
    // did not do.
    return {
      ok: false,
      reason:
        `git refused the commit: ${commit.stderr.split("\n")[0] || "unknown error"}. ` +
        `The changes are staged in ${dir}.`,
    };
  }

  const head = await git(dir, ["rev-parse", "--short", "HEAD"], NO_CLOCK);
  const count = slot.files.length;

  // Freeing the slot is half of what this button is for, and admission
  // remembers which slots it found unusable — so say the answer has changed
  // rather than leaving the next run to wait out the memo's window.
  forgetSlotVerdict(dir);

  emitRunEvent({
    runId,
    ts: Date.now(),
    kind: "land",
    payload: { branch, commit: head.ok ? head.stdout : null, files: count },
  });

  return {
    ok: true,
    message:
      `Committed ${count} path${count === 1 ? "" : "s"} to ${branch}` +
      (head.ok ? ` as ${head.stdout}.` : "."),
  };
}

/* ------------------------------------------------------------------ */
/* Deleting a landed branch                                            */
/* ------------------------------------------------------------------ */

/**
 * Delete a branch whose commits are all in its target.
 *
 * The one action here with no undo, so it is offered for merged branches only —
 * and "merged" is re-established from git at the moment of the request rather
 * than read from `landed_at`, because `reopenRun` can put commits back on a
 * branch this tool landed weeks ago.
 *
 * Its checkout goes first when one is still registered: git will not delete a
 * branch that a worktree has checked out, and a slot holding uncommitted work
 * is left alone rather than forced.
 */
export async function deleteBranch(runId: string): Promise<LandOutcome> {
  const run = getRun(runId);
  if (!run?.worktree_branch || !run.repo_root) {
    return { ok: false, reason: "This run has no branch." };
  }
  const state = await landState(runId);
  if (!state) return { ok: false, reason: "This run has no branch." };
  if (!state.branchExists) return { ok: false, reason: "This branch is already gone." };
  if (["running", "queued", "paused"].includes(run.status)) {
    return { ok: false, reason: "This run is still active." };
  }
  // Merged is not "finished" once a chain shares the ref: the run behind this
  // one is going to commit to the branch this would delete, and git's ancestry
  // test says nothing about commits that have not been made yet.
  const heir = chainBlocker(run.id, state.chain);
  if (heir) {
    return {
      ok: false,
      reason: `Run ${short(heir.runId)} is ${heir.status} and set to carry this branch on. Deleting it now would take its starting point away.`,
    };
  }
  const repeating = loopStillRepeating(state.chain);
  if (repeating) {
    return {
      ok: false,
      reason: loopRefusal(
        repeating,
        "deleting it now would take the next pass's starting point away",
      ),
    };
  }

  const repoRoot = repoPathFor(run.repo_root);
  if (!repoRoot) {
    return { ok: false, reason: "This run's repository is no longer inside a workspace mount." };
  }

  // A squash rewrites the commits, so git's ancestry test can never call this
  // branch merged and `branch -d` would refuse it for ever. The tip recorded at
  // land time is the stronger statement in that case — it says *these exact
  // commits* are the ones that were taken — and it stops being true the moment
  // the branch moves, which is precisely when deleting would lose something.
  if (!state.merged && !state.landedUnchanged) {
    return {
      ok: false,
      reason: run.landed_at
        ? `${state.branch} has gained commits since it was landed. Land those too, or delete it by hand.`
        : `${state.branch} has ${state.ahead} commit(s) that are not in ${state.target ?? "any branch"}. Deleting it would be the only unrecoverable thing here.`,
    };
  }

  const slot = await worktreeHolding(repoRoot, state.branch);
  if (slot) {
    const status = await git(slot, ["status", "--porcelain"]);
    if (!status.ok || status.stdout !== "") {
      return {
        ok: false,
        reason: `Its checkout at ${slot} still holds uncommitted work. Clear it first.`,
      };
    }
    const removed = await git(repoRoot, ["worktree", "remove", slot]);
    if (!removed.ok) {
      return { ok: false, reason: `Could not remove its checkout: ${removed.stderr.split("\n")[0]}` };
    }
  }

  // `-d` wherever git can see the merge for itself: its check is a second
  // opinion on the one above, and disagreeing with it is a reason to stop
  // rather than to force. `-D` only for a squash, where git structurally
  // cannot see it and the tip comparison above is what stands in for it.
  const del = await git(repoRoot, [
    "branch",
    state.merged ? "-d" : "-D",
    state.branch,
  ]);
  if (!del.ok) {
    return { ok: false, reason: `git refused to delete the branch: ${del.stderr.split("\n")[0]}` };
  }

  emitRunEvent({
    runId,
    ts: Date.now(),
    kind: "land",
    payload: { branch: state.branch, deleted: true, worktreeRemoved: slot ?? null },
  });

  return {
    ok: true,
    message: slot
      ? `Deleted ${state.branch} and freed its checkout slot.`
      : `Deleted ${state.branch}.`,
  };
}

/**
 * Which checkout holds each branch, for every worktree this repository has.
 *
 * One call rather than one per branch: the inventory asks this of every row it
 * lists, and `worktree list` already answers for all of them at once.
 */
async function worktreeBranches(repoRoot: string): Promise<Map<string, string>> {
  const held = new Map<string, string>();
  const list = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!list.ok) return held;

  let current: string | null = null;
  for (const line of list.stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/") && current) {
      held.set(line.slice("branch refs/heads/".length), current);
    }
  }
  return held;
}

/** The worktree with this branch checked out, if any is still registered. */
async function worktreeHolding(
  repoRoot: string,
  branch: string,
): Promise<string | null> {
  return (await worktreeBranches(repoRoot)).get(branch) ?? null;
}

/* ------------------------------------------------------------------ */
/* Purging a branch, landed or not                                     */
/* ------------------------------------------------------------------ */

/**
 * Why a purge is refused, or null when it goes ahead.
 *
 * `deleteBranch` is the careful door: it refuses anything git cannot see as
 * merged, because that refusal is all that stands between a stray click and
 * work that exists nowhere else. This is the deliberate other one — for the
 * attempt that went nowhere, the agent that produced a mess, the slot that is
 * out of circulation because of it — and it destroys committed work on purpose.
 *
 * So the caller has to name the branch it means. That echo is not
 * authentication, and it is not compared against anything from the wire but the
 * row itself: it is what stops a request aimed at one branch from landing on
 * another, and it forces the interface to spell out what is about to go.
 */
export function purgeRefusal(s: {
  runId: string;
  runStatus: RunRow["status"];
  branch: string | null;
  branchExists: boolean;
  confirmBranch: string;
  /** Every run on this branch, oldest first. See `ChainMember`. */
  chain: readonly ChainMember[];
  /** A loop block still repeating on it. See `loopStillRepeating`. */
  loopBlock?: string | null;
}): string | null {
  if (!s.branch) return "This run has no branch.";
  if (!s.branchExists) return `${s.branch} is already gone.`;
  if (["running", "queued", "paused"].includes(s.runStatus)) {
    return "This run is still active. Stop it before purging the branch it is working on.";
  }
  // "Not an active run" stopped meaning "nobody is using this branch" the day a
  // second run could be told to carry it on. Purging here would destroy the
  // work under a run that has not started yet, and the run would then fail on a
  // missing branch with no trace of who removed it.
  const busy = chainBlocker(s.runId, s.chain);
  if (busy) {
    return (
      `Run ${short(busy.runId)} is ${busy.status} and set to carry this branch on. ` +
      "Stop that run first — purging now would take the branch out from under it."
    );
  }
  if (s.loopBlock) {
    return loopRefusal(
      s.loopBlock,
      "purging now would take the branch out from under the next pass",
    );
  }
  if (s.confirmBranch !== s.branch) {
    return `Purging ${s.branch} has to name it. Nothing was deleted.`;
  }
  return null;
}

/**
 * Delete the branch whatever state it is in, and free the checkout holding it.
 *
 * The commits go, and so does anything uncommitted in its slot — both are
 * counted *before* anything is removed, so the sentence afterwards says what
 * was lost rather than that something was. Nothing here touches the operator's
 * own checkout, and nothing here is recoverable through this app.
 */
export async function purgeBranch(
  runId: string,
  confirmBranch: string,
): Promise<LandOutcome> {
  const run = getRun(runId);
  if (!run?.worktree_branch || !run.repo_root) {
    return { ok: false, reason: "This run has no branch." };
  }

  const repoRoot = repoPathFor(run.repo_root);
  if (!repoRoot) {
    return { ok: false, reason: "This run's repository is no longer inside a workspace mount." };
  }

  const branch = run.worktree_branch;
  const exists = await git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);

  const chain = branchChain(run);
  const refusal = purgeRefusal({
    runId: run.id,
    runStatus: run.status,
    branch,
    branchExists: exists.ok,
    confirmBranch,
    chain,
    loopBlock: loopStillRepeating(chain),
  });
  if (refusal) return { ok: false, reason: refusal };

  // A run with no recorded base has no range to count against, and a count is
  // left out rather than guessed at.
  const from = run.worktree_base_branch ?? run.worktree_base;
  const ahead = from
    ? Number((await git(repoRoot, ["rev-list", "--count", `${from}..${branch}`])).stdout) || 0
    : 0;

  const slot = await worktreeHolding(repoRoot, branch);
  let discarded = 0;
  if (slot) {
    const holder = activeRuns().find((r) => r.worktree_path === slot);
    if (holder) {
      return {
        ok: false,
        reason: `Run ${holder.id.slice(0, 8)} has that checkout. Wait for it to finish.`,
      };
    }

    const status = await git(slot, ["status", "--porcelain", "-z"], { trim: false });
    discarded = status.ok ? parseStatusZ(status.stdout).length : 0;

    // `--force` is the whole difference from `deleteBranch`, which leaves a
    // checkout with work in it alone. Here that work is what is being purged.
    const removed = await git(repoRoot, ["worktree", "remove", "--force", slot]);
    if (!removed.ok) {
      return { ok: false, reason: `Could not remove its checkout: ${removed.stderr.split("\n")[0]}` };
    }
    // The slot is gone, so whatever admission remembered about it is about a
    // directory that no longer exists — see `forgetSlotVerdict`.
    forgetSlotVerdict(slot);
  }

  const del = await git(repoRoot, ["branch", "-D", branch]);
  if (!del.ok) {
    return { ok: false, reason: `git refused to delete the branch: ${del.stderr.split("\n")[0]}` };
  }

  emitRunEvent({
    runId,
    ts: Date.now(),
    kind: "land",
    payload: {
      branch,
      deleted: true,
      purged: true,
      commits: ahead,
      discarded,
      worktreeRemoved: slot ?? null,
    },
  });

  const lost = [
    ahead > 0 ? `${ahead} commit${ahead === 1 ? "" : "s"}` : null,
    discarded > 0 ? `${discarded} uncommitted path${discarded === 1 ? "" : "s"}` : null,
  ].filter(Boolean);

  return {
    ok: true,
    message: lost.length
      ? `Purged ${branch}. ${lost.join(" and ")} went with it.`
      : `Purged ${branch}.`,
  };
}

/* ------------------------------------------------------------------ */
/* Inventory                                                           */
/* ------------------------------------------------------------------ */

export interface BranchSummary {
  runId: string;
  runStatus: RunRow["status"];
  branch: string;
  target: string | null;
  repoRoot: string;
  repoLabel: string;
  createdAt: number;
  ahead: number;
  merged: boolean;
  /** Landed by this tool and unchanged since — how a squash shows as done. */
  landedUnchanged: boolean;
  /**
   * Uncommitted paths in the checkout still holding this branch. Null when no
   * checkout holds it, when its status could not be read, or when the probe cap
   * below was reached — all of which mean "nothing to offer here", never "clean".
   */
  uncommitted: number | null;
  exists: boolean;
  active: boolean;
  landedAt: number | null;
  prompt: string;
}

/** A checkout the allocator will not reuse, and what is in the way. */
export interface DirtySlot {
  /** Directory name inside the store — what the operator has to go and find. */
  name: string;
  /** Uncommitted paths in it, or null when its status could not be read. */
  uncommitted: number | null;
}

/** One repository's checkout slots, so exhaustion is visible before it bites. */
export interface CheckoutStoreSummary {
  repoRoot: string;
  repoLabel: string;
  store: string;
  /** `MAX_WORKTREE_SLOTS`. */
  ceiling: number;
  /** Slots a queued, running or paused run holds. */
  heldByRuns: number;
  /** Existing checkouts nothing holds that cannot be reused, lowest slot first. */
  dirty: DirtySlot[];
  /**
   * Slot numbers still allocatable, or null when the probe cap stopped the walk
   * — "not counted", never a claim that there are none left.
   */
  free: number | null;
}

/** One repository holding branches, and how many of them it holds. */
export interface BranchRepo {
  repoRoot: string;
  repoLabel: string;
  branches: number;
}

export interface BranchInventory {
  branches: BranchSummary[];
  /**
   * Branches matching the filter that this page does not show — across every
   * run this app has recorded, not merely the ones a run-count window reached.
   */
  notShown: number;
  /** Branches matching the filter, in total. */
  total: number;
  /** Where this page starts in that list. */
  offset: number;
  /** How many branches this page was allowed to examine. */
  limit: number;
  /** The repository filter in force, or null for every repository. */
  repo: string | null;
  /** Every repository holding a branch, whatever the filter — for the picker. */
  repos: BranchRepo[];
  /**
   * Slot pressure for the repositories on this page — see `checkoutStores`.
   *
   * Scoped to what was examined rather than to every repository in `repos`, for
   * the reason the branch cap exists at all: each checkout costs a `git status`,
   * and a filter that pays for repositories it is not showing is the cost this
   * page bounds everywhere else.
   */
  checkouts: CheckoutStoreSummary[];
}

/** Branches examined per request. Each costs a `rev-list --count`. */
const MAX_INVENTORY = 60;
/** Checkouts whose status is read per request. Each is another git process. */
const MAX_PENDING_PROBES = 20;
/** Checkout slots whose status is read per request. Each is another git process. */
const MAX_SLOT_PROBES = 48;

/**
 * What each repository's checkout store holds, and how much of it is left.
 *
 * The gap this fills: running out of slots is now a refusal — an isolated run
 * on a repository with none left does not start at all — and until this there
 * was nowhere an operator could see that coming. The number that matters is not
 * the branches on this page but the *slots* behind them, since a slot holding
 * uncommitted work is retired until somebody deals with it (`slotIsDirty`, and
 * the comment above it says why that is right) while nothing reclaims one.
 *
 * Read by directory listing rather than by walking 1…64: a slot number with no
 * directory is free and costs nothing to establish, so the cost is one `git
 * status` per checkout that actually exists, capped like every other probe on
 * this page. The one thing this cannot see is a directory left under this
 * repository's slot name by an older build of this app that named slots the
 * lossy way — `allocateSlotPath` skips such a directory, so `free` is an upper
 * bound there rather than a count. `worktreeSlug` is what made that near
 * impossible; see its own note.
 */
export async function checkoutStores(
  repoRoots: readonly string[],
): Promise<CheckoutStoreSummary[]> {
  const held = new Set(
    activeRuns()
      .map((r) => r.worktree_path)
      .filter((p): p is string => !!p),
  );

  const stores: CheckoutStoreSummary[] = [];
  let probes = 0;

  for (const repoRoot of repoRoots) {
    const store = worktreeStore(repoRoot);
    if (!store) continue;

    let entries: string[];
    try {
      entries = fs.readdirSync(store);
    } catch {
      // No store yet, or one that cannot be read. Either way this cannot say
      // anything true about how many slots are left, and a row claiming all of
      // them are free is the sentence a refusal would contradict.
      continue;
    }

    const slug = repoSlug(repoRoot);
    const slotNumber = (name: string): number | null => {
      if (!name.startsWith(`${slug}-`)) return null;
      const tail = name.slice(slug.length + 1);
      if (!/^\d+$/.test(tail)) return null;
      const n = Number(tail);
      return n >= 1 && n <= MAX_WORKTREE_SLOTS ? n : null;
    };

    // The union of what is on disk and what a live run has been given, because
    // the two do not have to agree: a slot is claimed at admission and the
    // checkout is created when the run starts, so a queued run holds a slot
    // number with no directory behind it yet. Counting directories alone would
    // report that number free while the allocator is already skipping it. The
    // run pass runs second so a held slot that also exists reads as held.
    const occupied = new Map<number, "held" | "onDisk">();
    for (const name of entries) {
      const n = slotNumber(name);
      if (n !== null) occupied.set(n, "onDisk");
    }
    for (const heldPath of held) {
      if (path.dirname(heldPath) !== store) continue;
      const n = slotNumber(path.basename(heldPath));
      if (n !== null) occupied.set(n, "held");
    }

    let heldByRuns = 0;
    let capped = false;
    const dirty: DirtySlot[] = [];

    for (const n of [...occupied.keys()].sort((a, b) => a - b)) {
      if (occupied.get(n) === "held") {
        heldByRuns++;
        continue;
      }
      const name = `${slug}-${n}`;
      const slotPath = path.join(store, name);
      if (probes >= MAX_SLOT_PROBES) {
        capped = true;
        continue;
      }
      probes++;
      const status = await git(slotPath, ["status", "--porcelain", "-z"], {
        trim: false,
      });
      // Unreadable counts as dirty, exactly as `slotIsDirty` counts it. The
      // allocator will skip this slot, so listing it as free would say the
      // opposite of what the next run on this repository is refused for.
      if (!status.ok) {
        dirty.push({ name, uncommitted: null });
        continue;
      }
      const uncommitted = parseStatusZ(status.stdout).length;
      if (uncommitted > 0) dirty.push({ name, uncommitted });
    }

    stores.push({
      repoRoot,
      repoLabel: describeFolder(repoRoot).relPath || repoRoot,
      store,
      ceiling: MAX_WORKTREE_SLOTS,
      heldByRuns,
      dirty,
      free: capped ? null : MAX_WORKTREE_SLOTS - heldByRuns - dirty.length,
    });
  }

  return stores;
}

/**
 * One branch's runs in chain order, oldest first.
 *
 * Ordered by how far down the `continuesRun` links a run sits, rather than by
 * the order the query handed them over. That order is `created_at DESC`, and a
 * chain is written in a single synchronous pass — `createRun` runs from entry to
 * INSERT with no await, and a workflow instantiates its whole graph that way —
 * so two links routinely share a millisecond and which of them comes back first
 * is then whatever the sort felt like. `nextQueuedIn` needed `batch_id` for the
 * same collision; here no tiebreak would do, because the true order *is* the
 * links. Reading it off them is what stops the wrong link being named the
 * branch's owner, and that failure does not degrade gracefully: the row this
 * page keeps then refuses to land, naming an owner whose row it never listed,
 * and the branch has no route in the UI that reaches it at all.
 *
 * Depth rather than a walk from the head, because it is total. A member whose
 * predecessor is not in the group — purged out from under it, or never on this
 * branch — is depth 0 beside the real first link instead of derailing the walk,
 * and a hand-edited row that made a chain a cycle stops at its own `seen` set
 * and keeps the arrival order this replaced. Equal depths keep that order too,
 * which is why the base is reversed first: for everything the links cannot
 * separate, oldest-first is still the best reading available.
 */
function chainOrder<T extends BranchCandidate>(held: readonly T[]): T[] {
  const byId = new Map(held.map((r) => [r.id, r]));
  const depth = new Map<string, number>();
  for (const run of held) {
    const seen = new Set<string>([run.id]);
    let links = 0;
    for (let up = run; up.continuesRun; ) {
      const prev = byId.get(up.continuesRun);
      if (!prev || seen.has(prev.id)) break;
      seen.add(prev.id);
      links++;
      up = prev;
    }
    depth.set(run.id, links);
  }
  return [...held]
    .reverse()
    .sort((a, b) => depth.get(a.id)! - depth.get(b.id)!);
}

/**
 * One row per branch, not one per run that has held it.
 *
 * A chain of runs extending each other shares a ref, and this page is a list of
 * *branches* — so three links would otherwise be three rows with identical
 * ahead counts, identical merge state, three Land checkboxes and, because the
 * table keys on the branch, three identical React keys. Picking two of them
 * would queue the same branch twice, which is precisely the "once per link"
 * failure `landRefusal` exists to stop.
 *
 * The row kept is `branchOwner`'s, so the page and the Land button agree about
 * which run answers for the branch — see `chainOrder` for where that order
 * comes from, which is not the order the runs arrive in.
 *
 * A `waiting` link is missing from this list entirely (its branch is null until
 * it is released), so a row can look landable while a run is queued up behind
 * it. That is the same approximation `canLand` on the page already makes and
 * says so: the structural question is answered here, and whether it can really
 * be landed is re-derived from git and the full chain by `landRun`.
 */
function oneRunPerBranch<T extends BranchCandidate>(runs: readonly T[]): T[] {
  const byBranch = new Map<string, T[]>();
  for (const run of runs) {
    const key = `${run.repoRoot}\0${run.branch}`;
    const list = byBranch.get(key);
    if (list) list.push(run);
    else byBranch.set(key, [run]);
  }

  const kept: T[] = [];
  for (const held of byBranch.values()) {
    if (held.length === 1) {
      kept.push(held[0]);
      continue;
    }
    const chain = chainOrder(held).map((r) => ({
      runId: r.id,
      status: r.status,
      iterations: r.iterations,
    }));
    const owner = branchOwner(chain);
    kept.push(held.find((r) => r.id === owner) ?? held[0]);
  }
  return kept;
}

/** Everything the selection below reads off a branch-bearing run, and no more. */
export interface BranchCandidate {
  id: string;
  status: RunRow["status"];
  iterations: number;
  repoRoot: string;
  branch: string;
  /** `runs.continues_run` — the link `chainOrder` reads. Null for a first link. */
  continuesRun: string | null;
}

/** Which slice of the inventory a caller is asking for. */
export interface BranchQuery {
  /** `repo_root` to keep, or null/undefined for every repository. */
  repo?: string | null;
  /** Branches to skip, in the order below. */
  offset?: number;
  /** Branches to examine. Clamped to `MAX_INVENTORY`, whatever is asked for. */
  limit?: number;
}

export interface BranchSelection<T> {
  /** The branches this request pays git for, in the order they are listed. */
  examined: T[];
  total: number;
  offset: number;
  limit: number;
  notShown: number;
  /** Branch counts per repository, over the *unfiltered* set. */
  repos: Array<{ repoRoot: string; branches: number }>;
}

/**
 * Which branches this request examines, and what it must say about the rest.
 *
 * Pure, and separated from the git work below for the reason `selectPromotable`
 * is separated from the spawn: the failure mode is silent. A branch dropped here
 * is work committed on a ref with no route in the UI that reaches it — nothing
 * throws, nothing is red, and the count that ought to say so is computed from
 * the same truncated list. So `total` is counted over every candidate handed in
 * and `notShown` is derived from it rather than from the page.
 *
 * `runs` must be newest-first, as the query that feeds it orders them. The
 * collapse to one row per branch happens *before* the slice, so a page holds
 * `limit` branches rather than `limit` runs, and a chain of five links does not
 * consume five rows of somebody's page.
 *
 * `repos` is deliberately computed over the unfiltered set: it is what the
 * picker is drawn from, and a filter that removes the other repositories from
 * the list you would use to change it is a filter you cannot get out of.
 */
export function selectBranchCandidates<T extends BranchCandidate>(
  runs: readonly T[],
  query: BranchQuery = {},
): BranchSelection<T> {
  const all = oneRunPerBranch(runs);

  const counts = new Map<string, number>();
  for (const run of all) counts.set(run.repoRoot, (counts.get(run.repoRoot) ?? 0) + 1);

  const matching = query.repo ? all.filter((r) => r.repoRoot === query.repo) : all;

  // A limit that is missing, zero, negative or unreadable is the default page
  // rather than the smallest legal one: these arrive off a query string, and a
  // one-row page is a far worse answer to a typo than the ordinary one.
  const asked = Math.floor(Number(query.limit));
  const limit =
    Number.isFinite(asked) && asked > 0
      ? Math.min(MAX_INVENTORY, asked)
      : MAX_INVENTORY;
  // Clamped rather than refused: an offset past the end is what pressing Next
  // on a page that shrank under you produces, and an empty page with an honest
  // total is a better answer than a 400.
  const offset = Math.min(
    Math.max(0, Math.floor(Number(query.offset) || 0)),
    Math.max(0, matching.length - 1),
  );
  const examined = matching.slice(offset, offset + limit);

  return {
    examined,
    total: matching.length,
    offset,
    limit,
    notShown: matching.length - examined.length,
    repos: [...counts].map(([repoRoot, branches]) => ({ repoRoot, branches })),
  };
}

/**
 * Every branch-bearing run this app has recorded, newest first.
 *
 * A query of its own rather than `listRuns(400)` and a filter, because the
 * question is "which branches exist" and answering it from the newest N *runs*
 * silently stops answering it: at twenty-five concurrent runs the 400 newest are
 * about five hours of work, after which a branch is not merely off the page but
 * uncounted, so nothing on the page can say it is there. Only the columns the
 * selection reads are fetched — the full rows for the handful actually examined
 * are read back afterwards, so a machine with fifty thousand runs on it does not
 * load fifty thousand prompts to list sixty branches.
 */
function branchBearingRuns(): Array<BranchCandidate & { createdAt: number }> {
  return db()
    .prepare(
      `SELECT id, status, iterations, repo_root AS repoRoot,
              worktree_branch AS branch, continues_run AS continuesRun,
              created_at AS createdAt
         FROM runs
        WHERE isolation = 'worktree'
          AND worktree_branch IS NOT NULL
          AND repo_root IS NOT NULL
        ORDER BY created_at DESC`,
    )
    .all() as Array<BranchCandidate & { createdAt: number }>;
}

/** A collected branch row, as far as the probe decision needs to see it. */
export interface ProbeCandidate {
  /** The checkout still holding this branch, or null when none does. */
  slot: string | null;
}

/**
 * Which collected rows are worth a `git status`, by index into the list.
 *
 * Decided in one synchronous pass before any probe is dispatched, because the
 * probes below run concurrently and a `probes < MAX_PENDING_PROBES` test spread
 * across awaits no longer caps anything: every turn scheduled together reads
 * the counter before any of them has incremented it, so the cap is exceeded by
 * however many happened to start at once, and *which* rows got a probe becomes
 * a function of how the event loop interleaved them — two identical requests
 * answering with `uncommitted` on different branches, with nothing anywhere
 * saying so. Deciding here keeps the cap exact and keeps the answer the one the
 * serial loop gave: the first `limit` rows, in page order, whose branch some
 * checkout still holds. Rows without a checkout are skipped without spending
 * cap, since there is nothing to ask git about.
 */
export function selectProbeTargets(
  rows: readonly ProbeCandidate[],
  limit: number,
): number[] {
  const picked: number[] = [];
  for (let i = 0; i < rows.length && picked.length < limit; i++) {
    if (rows[i].slot) picked.push(i);
  }
  return picked;
}

/**
 * Read-only git children one pool of this page keeps in flight.
 *
 * The page runs two — the commit counts and the status probes are independent
 * of each other — so at most sixteen `git` processes exist at once, against a
 * page whose ceilings are sixty counts and twenty probes. The bound is about
 * the container rather than about correctness: this app is also running agents,
 * and forking every probe at once to save a wave is not a trade worth making.
 */
const BRANCH_GIT_CONCURRENCY = 8;

/**
 * Run `fn` over `items` with at most `limit` in flight, results in input order.
 *
 * Deliberately the same worker pool `transcripts.ts` runs its scan through,
 * copied rather than imported because that one is private to its module. A pool
 * rather than chunked `Promise.all` batches for the same reason it gives: a
 * batch runs at the speed of its slowest member and leaves the other slots
 * idle, and a `git status` costs whatever the checkout it lands on is worth —
 * 140 ms against a 15,082-entry worktree, a few against a small one.
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

/**
 * One branch's row with its two per-branch git reads still outstanding.
 *
 * Collected across every repository before either is run, so both can be
 * resolved concurrently: neither depends on the other, on any other branch's
 * answer, or on anything the collecting loop writes.
 */
interface PendingBranch extends ProbeCandidate {
  summary: Omit<BranchSummary, "ahead" | "uncommitted">;
  repoRoot: string;
  /** `<target>..<branch>`, or null when there is nothing to count. */
  aheadRange: string | null;
}

/**
 * Every branch this app has produced, with enough state to decide about it.
 *
 * Grouped by repository so the two set-shaped questions — which refs still
 * exist, and which are merged into a given target — are one `for-each-ref` each
 * rather than one git call per branch. The per-branch commit count is not
 * set-shaped and stays one call, which is what the cap above bounds. That cap is
 * on the *page*, not on what exists: `query` is what moves which sixty branches
 * are paid for, and the counts beside them describe the whole set.
 */
export async function branchInventory(
  query: BranchQuery = {},
): Promise<BranchInventory> {
  const selection = selectBranchCandidates(branchBearingRuns(), query);

  const rows =
    selection.examined.length === 0
      ? []
      : (db()
          .prepare(
            `SELECT * FROM runs WHERE id IN (${selection.examined
              .map(() => "?")
              .join(",")})`,
          )
          .all(...selection.examined.map((r) => r.id)) as RunRow[]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const examined = selection.examined
    .map((r) => byId.get(r.id))
    .filter((r): r is RunRow => r !== undefined);
  const active = new Set(activeRuns().map((r) => r.id));

  const byRepo = new Map<string, RunRow[]>();
  for (const run of examined) {
    const list = byRepo.get(run.repo_root!) ?? [];
    list.push(run);
    byRepo.set(run.repo_root!, list);
  }

  const pending: PendingBranch[] = [];
  const roots: string[] = [];

  for (const [rawRoot, runs] of byRepo) {
    const repoRoot = repoPathFor(rawRoot);
    if (!repoRoot) continue;
    roots.push(repoRoot);

    // One call for the whole repository. Only a branch some checkout still
    // holds can have uncommitted work of its own to report.
    const heldBy = await worktreeBranches(repoRoot);

    // Name and tip together: the tip is what identifies a squash-landed branch,
    // and asking for it here costs nothing over asking for the name alone.
    const tips = new Map<string, string>();
    for (const line of (
      await git(repoRoot, [
        "for-each-ref",
        "--format=%(refname:short) %(objectname)",
        "refs/heads/uf/",
      ])
    ).stdout.split("\n")) {
      const sp = line.lastIndexOf(" ");
      if (sp > 0) tips.set(line.slice(0, sp), line.slice(sp + 1));
    }

    // One membership query per distinct target, not per branch.
    const mergedByTarget = new Map<string, Set<string>>();
    for (const run of runs) {
      const target = run.worktree_base_branch;
      if (!target || mergedByTarget.has(target)) continue;
      const res = await git(repoRoot, [
        "for-each-ref",
        "--merged",
        target,
        "--format=%(refname:short)",
        "refs/heads/uf/",
      ]);
      mergedByTarget.set(
        target,
        new Set(res.ok ? res.stdout.split("\n").filter(Boolean) : []),
      );
    }

    for (const run of runs) {
      const branch = run.worktree_branch!;
      const target = run.worktree_base_branch;
      const exists = tips.has(branch);
      const merged = exists && !!target && (mergedByTarget.get(target)?.has(branch) ?? false);

      pending.push({
        repoRoot,
        aheadRange: exists && target ? `${target}..${branch}` : null,
        slot: (exists ? heldBy.get(branch) : undefined) ?? null,
        summary: {
          runId: run.id,
          runStatus: run.status,
          branch,
          target,
          repoRoot,
          repoLabel: describeFolder(repoRoot).relPath || repoRoot,
          createdAt: run.created_at,
          merged,
          landedUnchanged: !!run.landed_tip && run.landed_tip === tips.get(branch),
          exists,
          active: active.has(run.id),
          landedAt: run.landed_at,
          prompt: run.prompt,
        },
      });
    }
  }

  // Both per-branch reads are resolved here rather than one per turn of the
  // loop above, because serially they *were* the request: a `git status`
  // against a 15,082-entry checkout measures 140 ms, and eight of them made up
  // 1.12 s of a 1.13 s `GET /api/branches` — each probe holding up the next
  // branch's turn for no reason, since neither read decides anything the other
  // one or the loop needs. `MAX_PENDING_PROBES` still bounds how many probes
  // run at all; `selectProbeTargets` is where it is applied, and its own note
  // says why that has to happen before the first one is dispatched.
  const probeTargets = selectProbeTargets(pending, MAX_PENDING_PROBES);
  const [aheads, probed] = await Promise.all([
    mapWithLimit(pending, BRANCH_GIT_CONCURRENCY, async (p) =>
      p.aheadRange === null
        ? 0
        : Number(
            (await git(p.repoRoot, ["rev-list", "--count", p.aheadRange])).stdout,
          ) || 0,
    ),
    mapWithLimit(probeTargets, BRANCH_GIT_CONCURRENCY, async (i) => {
      // Non-null: `selectProbeTargets` picks only rows a checkout holds.
      const status = await git(pending[i].slot!, ["status", "--porcelain", "-z"], {
        trim: false,
      });
      return status.ok ? parseStatusZ(status.stdout).length : null;
    }),
  ]);

  const uncommittedByRow = new Map<number, number | null>();
  probeTargets.forEach((row, i) => uncommittedByRow.set(row, probed[i]));

  const branches: BranchSummary[] = pending.map((p, i) => ({
    ...p.summary,
    ahead: aheads[i],
    // A row nothing probed stays null, which the page reads as "not asked" —
    // the same answer a failed probe gives, and never a claim of clean.
    uncommitted: uncommittedByRow.get(i) ?? null,
  }));

  // Back into the order the selection listed them in, rather than re-sorted by
  // the kept run's own `created_at`. The two differ for a chain — the row kept
  // is the chain's *owner*, which can be an older link than the one that fixed
  // the group's place in the list — and the page order has to be the order the
  // slice was taken in, or which branches land on which page depends on which
  // link happens to own each of them.
  const order = new Map(selection.examined.map((r, i) => [r.id, i]));
  branches.sort((a, b) => (order.get(a.runId) ?? 0) - (order.get(b.runId) ?? 0));

  return {
    branches,
    notShown: selection.notShown,
    total: selection.total,
    offset: selection.offset,
    limit: selection.limit,
    repo: query.repo ?? null,
    repos: selection.repos
      .map(({ repoRoot, branches: n }) => {
        const resolved = repoPathFor(repoRoot) ?? repoRoot;
        return {
          repoRoot,
          repoLabel: describeFolder(resolved).relPath || resolved,
          branches: n,
        };
      })
      .sort((a, b) => a.repoLabel.localeCompare(b.repoLabel)),
    checkouts: await checkoutStores(roots),
  };
}


/**
 * Push a run's branch to its checkout's remote and open a pull request on it.
 *
 * The exit `M1` names as missing. Reached from one endpoint on one press and
 * from nowhere in the run loop: an outward-facing action taken by a loop is a
 * different product from one taken by a person, and this app has been careful
 * everywhere else about which of those it is.
 *
 * The push is ordinary and never forced. `githubEnv()` supplies the credential
 * the same way it does for an agent's own push, so nothing new enters the trust
 * boundary — what is new is that the app may use a capability its children
 * already had.
 *
 * The verify gate runs first, and deliberately the same one Land uses: an
 * operator who has said "not unless this passes" has not said anything about
 * which exit the work leaves by. Publishing an unverified branch to a remote
 * other people can see would be a wider version of exactly what they refused.
 */
export async function deliverRun(
  runId: string,
  o: { title?: string; body?: string } = {},
): Promise<
  | { ok: true; url: string; number: number }
  | { ok: false; reason: string }
> {
  const run = getRun(runId);
  if (!run) return { ok: false, reason: "No such run." };

  const state = await landState(runId);
  if (!state) return { ok: false, reason: "This run has no branch to deliver." };

  const folder = state.checkout?.path;
  if (!folder) return { ok: false, reason: "This run has no checkout to push from." };

  const remoteUrl = (
    await git(folder, ["remote", "get-url", "origin"], NO_CLOCK)
  ).stdout.trim();

  const plan = planDelivery({
    token: GITHUB_TOKEN,
    remoteUrl,
    branch: state.branch,
    target: state.target,
  });
  if (!plan.ok) return { ok: false, reason: plan.reason };

  const verify = await runVerify(folder, getSettings().landVerifyCommand);
  if (!verify.passed) return { ok: false, reason: verify.reason };

  // Never `--force`, and the upstream is set so a second press is an ordinary
  // fast-forward rather than a new branch.
  const push = await git(
    folder,
    ["push", "--set-upstream", "origin", `${plan.head}:${plan.head}`],
    NO_CLOCK,
  );
  if (!push.ok) {
    return {
      ok: false,
      reason: `The branch could not be pushed: ${push.stderr.trim() || "git refused"}.`,
    };
  }

  const opened = await openPullRequest({
    remote: plan.remote,
    head: plan.head,
    base: plan.base,
    title: o.title?.trim() || `${run.prompt.split("\n")[0].slice(0, 72)}`,
    body:
      o.body?.trim() ||
      `Opened by UsageFoundry from run \`${run.id.slice(0, 8)}\`.\n\n` +
        `The task this run was given:\n\n> ${run.prompt.slice(0, 1500)}\n`,
  });
  if (!opened.ok) return { ok: false, reason: opened.reason };

  // On the run's own timeline, the way a land is: this is the other exit, and
  // the question "where did this work go" is asked on the run's page.
  emitRunEvent({
    runId,
    ts: Date.now(),
    kind: "deliver",
    payload: {
      branch: plan.head,
      base: plan.base,
      remote: `${plan.remote.owner}/${plan.remote.repo}`,
      url: opened.pr.url,
      number: opened.pr.number,
    },
  });
  return { ok: true, url: opened.pr.url, number: opened.pr.number };
}
