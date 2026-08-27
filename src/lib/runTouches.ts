import type { RunTouchDTO } from "./apiTypes";

/**
 * What a run touched, reconciled against what its branch changed.
 *
 * **This module reaches nothing.** No database, no filesystem, no `git` — it is
 * imported by `RunTouches.tsx`, which is a `"use client"` file, and the reason
 * `apiTypes.ts` states for declaring wire shapes rather than importing them
 * holds here too: one `import` of a server module and `node:fs` follows it into
 * the browser bundle. The scan that produces its input lives beside it in
 * `runTouchScan.ts`, which is server-only for exactly that reason.
 *
 * The reconciliation is client-side by design rather than by accident: the diff
 * half of it is the numstat the Changes tab has already fetched, and doing it on
 * the server would mean a second `runDiff` — several more git processes per tab
 * open, for a file list the page is already holding.
 */

/** One file, with every call that named it collapsed onto it. */
export interface TouchedFile {
  /** Relative to the checkout, or absolute when `outside`. */
  path: string;
  /** Calls that read it. Also the fallback for a tool this build cannot place. */
  reads: number;
  /** Calls that wrote it. */
  writes: number;
  /** Listed by the branch diff. */
  inDiff: boolean;
  /** Matched neither `runs.work_dir` nor `runs.folder`. */
  outside: boolean;
  /**
   * Who made the calls — `main`, a sub-agent's own name, or `delegated`.
   *
   * A list because one file is routinely read by the main thread and edited by a
   * sub-agent, and picking one of the two to display would make the other
   * disappear. Sorted, so two runs that did the same work render the same way.
   */
  by: string[];
  /**
   * Which tools named it, distinct and sorted.
   *
   * Carried on the file rather than left as a shape of its own, because that is
   * the *only* form tool identity is allowed to take on the map at
   * `/runs/[id]/touched`: tool → file is a star with a dozen hubs and nearly
   * every file hanging off `Read`, which draws one fact an operator already
   * knows. As an attribute it costs a set per file and answers "what was done to
   * this file" without giving `Read` a node of its own.
   *
   * The table above this does not read it. It is here rather than in a second
   * pass over the same rows because the pass that fills `by` is already open,
   * and a second derivation of the same scan is the thing this module exists to
   * stop.
   */
  tools: string[];
}

/**
 * The four groups, in the order they are read.
 *
 * `changedNotTouched` leads because it is the group with no surface anywhere
 * else: a file in the diff that no tool call named was written by a `Bash` —
 * `sed -i`, a formatter, a codegen step — or by an event that has aged out.
 */
export interface TouchReport {
  /** In the diff, named by no tool call. Rows carry no counts. */
  changedNotTouched: TouchedFile[];
  touchedAndChanged: TouchedFile[];
  /** Read and never written, or edited and reverted. */
  touchedNotChanged: TouchedFile[];
  /** Outside the checkout entirely, so the diff can say nothing about it. */
  outsideCheckout: TouchedFile[];
  /**
   * Distinct files the run's tool events named — the three touched groups, not
   * the first.
   *
   * Reported rather than left to be counted off the groups because it is one of
   * the two numbers the slice exists to produce: it is what decides whether a
   * file × work-cycle grid has an axis short enough to draw.
   */
  distinctTouched: number;
}

/**
 * Tools that write the file they name. Everything else counts as a read.
 *
 * A tool-name table is exactly what `HEADLINE_FIELDS` refuses to be, and for a
 * good reason — the CLI's tool set moves. It is unavoidable here because no
 * field on a call says whether it wrote, and the fallback is chosen so that
 * being wrong is cheap: an unknown writer is counted as a read, which understates
 * one column and leaves the group the file lands in — the load-bearing part —
 * untouched, because a write this list has never heard of still puts the file in
 * the diff and therefore in `touchedAndChanged`.
 */
const WRITING_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/**
 * Who made a call.
 *
 * `delegated` rather than nothing for a call with a parent and no name: the
 * `Task` that opened the sub-agent may have arrived before this page did or
 * before the event horizon, and "some sub-agent" is the true statement where
 * "the main thread" is not. Same reasoning, and the same fallback, as the log's
 * own attribution in `logLine.ts`.
 */
export function touchActor(row: Pick<RunTouchDTO, "subagent" | "parentToolUseId">): string {
  if (row.subagent) return row.subagent;
  return row.parentToolUseId ? "delegated" : "main";
}

/**
 * Group a run's touches against the paths its branch diff lists.
 *
 * Pure, and every one of its failure modes is silent: a path that fails to merge
 * shows one file as two, a group that takes the wrong side of the set difference
 * reads as "changed without being read" — the one claim here an operator would
 * act on — and a miscount changes which of two files an eye stops at. Nothing
 * throws and nothing fails to typecheck for any of them.
 *
 * `changed` is matched literally. Both sides are already relative to the same
 * checkout: the scan relativises against `COALESCE(work_dir, folder)` then
 * `folder`, and git reports paths relative to the repository root.
 */
export function reconcileTouches(
  touches: readonly RunTouchDTO[],
  changed: readonly string[],
): TouchReport {
  const changedSet = new Set(changed);

  // Keyed on path alone. The same file reached once as a `work_dir` path and
  // once as a `folder` path relativises to one string, and the scan's GROUP BY
  // cannot merge them because it also groups by tool and by caller — so the
  // merge has to happen here or the row appears twice with the counts split.
  const byPath = new Map<
    string,
    TouchedFile & { actors: Set<string>; toolNames: Set<string> }
  >();

  for (const row of touches) {
    let file = byPath.get(row.path);
    if (!file) {
      file = {
        path: row.path,
        reads: 0,
        writes: 0,
        inDiff: !row.outside && changedSet.has(row.path),
        outside: row.outside,
        by: [],
        tools: [],
        actors: new Set<string>(),
        toolNames: new Set<string>(),
      };
      byPath.set(row.path, file);
    }
    if (WRITING_TOOLS.has(row.tool)) file.writes += row.calls;
    else file.reads += row.calls;
    file.actors.add(touchActor(row));
    file.toolNames.add(row.tool);
    // One row outside the checkout and one inside for the same string cannot
    // happen — `outside` is a function of the path — but if it ever did, the
    // conservative reading is that the diff cannot speak for it.
    if (row.outside) {
      file.outside = true;
      file.inDiff = false;
    }
  }

  const files = [...byPath.values()].map(({ actors, toolNames, ...file }) => ({
    ...file,
    by: [...actors].sort(),
    tools: [...toolNames].sort(),
  }));

  const touched = files.filter((f) => !f.outside);
  const report: TouchReport = {
    changedNotTouched: [...changedSet]
      .filter((path) => !byPath.has(path))
      .map((path) => ({
        path,
        reads: 0,
        writes: 0,
        inDiff: true,
        outside: false,
        by: [],
        tools: [],
      })),
    touchedAndChanged: touched.filter((f) => f.inDiff),
    touchedNotChanged: touched.filter((f) => !f.inDiff),
    outsideCheckout: files.filter((f) => f.outside),
    distinctTouched: files.length,
  };

  for (const group of [
    report.changedNotTouched,
    report.touchedAndChanged,
    report.touchedNotChanged,
    report.outsideCheckout,
  ]) {
    group.sort(byCallsThenPath);
  }

  return report;
}

/**
 * Busiest first, then alphabetical.
 *
 * The tiebreak is not cosmetic: `changedNotTouched` has no counts at all, so
 * without it that group's order would be whatever the diff happened to list —
 * which changes between two reads of the same run.
 */
function byCallsThenPath(a: TouchedFile, b: TouchedFile): number {
  const total = b.reads + b.writes - (a.reads + a.writes);
  return total !== 0 ? total : a.path.localeCompare(b.path);
}
