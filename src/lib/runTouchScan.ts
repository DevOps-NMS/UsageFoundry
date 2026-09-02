import { db } from "./db";
import { TOOL_FILE_FIELDS } from "./logLine";
import { getRun, TERMINAL_STATUSES } from "./orchestrator";
import { retentionCutoff } from "./retention";
import { getSettings } from "./settings";
import type { RunTouchDTO, RunTouchStepDTO, RunTouchedDTO } from "./apiTypes";

/**
 * What a run's tool events say it touched, read from the database.
 *
 * Server-only, and split from `runTouches.ts` for the reason `apiTypes.ts`
 * states at the head of its own file: the reconciliation runs in the browser,
 * against a file list the Changes tab has already fetched, and a client
 * component that imported this module would pull `node:fs` in behind it.
 *
 * **Not derived from the page's event array.** That array is the newest 2,000
 * events inside 4 MB (`stream/route.ts`), so a client-side derivation would
 * silently describe the tail of a long run as the whole of it — which is the
 * failure this feature exists to make visible, arriving in the feature itself.
 */

/**
 * The path fields, as a `json_extract` for each, in `HEADLINE_FIELDS`' order.
 *
 * Built from the constant rather than written out, so a field renamed in
 * `logLine.ts` cannot leave this reading `NULL` for every row — a query that
 * returns nothing looks exactly like a run that touched nothing. The names are
 * this repository's own identifiers and never reach the parameter binder,
 * because they are part of the SQL text rather than a value in it.
 */
const PATH_EXPR = `COALESCE(${TOOL_FILE_FIELDS.map(
  (field) => `json_extract(e.payload, '$.input.${field}')`,
).join(", ")})`;

/**
 * One row per file-naming tool call, relativised and ordered, as a subquery.
 *
 * Written once and read by both scans, because the `CASE` is the part that is
 * wrong in a way nothing reports: it is `readCountsFor`'s, and keying on
 * `repo_root` instead of `COALESCE(work_dir, folder)` then `folder` returns an
 * empty result for every worktree-isolated run and looks exactly like a working
 * query. A second copy of it here would be a second thing to get right, and the
 * one that drifted would be the one nobody read.
 *
 * One index range scan either way: `idx_run_events_run(run_id, id)` leads on
 * `run_id`, so scoping to a run turns the fleet-wide full scan `readCountsFor`
 * pays into a range. There is no index on `kind` and this does not add one —
 * that trade is decided in `fileCostNotice.ts` and it is about the write side,
 * which a reader does not reopen.
 *
 * Two deliberate differences from that query. It is **not** filtered to `Read`,
 * since a write is half of what a reconciliation is for. And it **keeps** the
 * rows the `CASE` would otherwise drop at its `ELSE NULL`: a path matching
 * neither column is a touch outside the checkout, which is a group of its own
 * and the one thing nothing in this app has ever shown.
 *
 * `id` is carried out of the subquery because it is the only thing that orders
 * the rows: `run_events.id` is `AUTOINCREMENT` and so ascending in emit order,
 * where `ts` is a millisecond clock several calls can share.
 */
const TOUCH_ROWS = `
  SELECT
    CASE
      WHEN instr(raw, work || '/') = 1 THEN substr(raw, length(work) + 2)
      WHEN instr(raw, folder || '/') = 1 THEN substr(raw, length(folder) + 2)
      ELSE raw
    END AS path,
    CASE
      WHEN instr(raw, work || '/') = 1 OR instr(raw, folder || '/') = 1
        THEN 0
      ELSE 1
    END AS outside,
    id, ts, tool, subagent, parent
  FROM (
    SELECT
      e.id AS id,
      e.ts AS ts,
      ${PATH_EXPR} AS raw,
      COALESCE(json_extract(e.payload, '$.name'), 'tool') AS tool,
      json_extract(e.payload, '$.subagent') AS subagent,
      json_extract(e.payload, '$.parentToolUseId') AS parent,
      COALESCE(r.work_dir, r.folder) AS work,
      r.folder AS folder
    FROM run_events e
    JOIN runs r ON r.id = e.run_id
    WHERE e.run_id = ? AND e.kind = 'tool'
  )
  WHERE raw IS NOT NULL AND raw <> ''
`;

/**
 * Every file this run's tool events named, collapsed by path, tool and caller.
 *
 * The collapse is the whole difference from `scanTouchSequence` below: this one
 * answers "what did the run touch", which is a set, and that one answers "in
 * what order", which is a list. Neither is derivable from the other — a count
 * has no positions in it, and a list of positions is the wrong payload to hand
 * the Files tab's table, which draws one row per file.
 */
export function scanTouches(runId: string): RunTouchDTO[] {
  const rows = db()
    .prepare(
      `SELECT path, outside, tool, subagent, parent, COUNT(*) AS calls
         FROM (${TOUCH_ROWS})
        GROUP BY path, outside, tool, subagent, parent`,
    )
    .all(runId) as {
    path: string;
    outside: number;
    tool: string;
    subagent: string | null;
    parent: string | null;
    calls: number;
  }[];

  return rows.map((row) => ({
    path: row.path,
    outside: row.outside === 1,
    tool: row.tool,
    subagent: row.subagent,
    parentToolUseId: row.parent,
    calls: row.calls,
  }));
}

/**
 * The same calls, uncollapsed and in the order the run made them.
 *
 * A second reader rather than a flag on the first, and the split is the same
 * one `runTouches.ts` and this file already make. `scanTouches` answers the
 * Files tab, which is polled open on every run page and draws one row per file;
 * shipping it a row per *call* would multiply that payload by however many times
 * a file was read, for a figure the table renders as a single number. So the
 * order rides on its own route, read only by the map at `/runs/[id]/touched`.
 *
 * **Ordered by `e.id` and never by `ts`.** `id` is `AUTOINCREMENT`, so ascending
 * `id` is emit order; `ts` is a millisecond clock and a burst of tool calls
 * inside one millisecond would come back in whatever order the query planner
 * felt like — a replay that draws a plausible sequence that did not happen.
 *
 * **Nothing here says a call succeeded**, which is `runTouches.ts`' rule and is
 * sharper on this surface than on the table: a playhead moving file to file
 * reads as progress. `orchestrator.ts` records a tool call when it is made and a
 * result only when it *failed*, and the failure row carries no `tool_use` id
 * joining it back — so there is no field to add and no join to invent. The
 * sequence is what the run *attempted*, in order.
 *
 * Server-only for this module's own reason: the surface that draws it is a
 * `"use client"` file, so the derivation over these rows lives in
 * `touchReplay.ts` beside `runTouches.ts` and reaches nothing.
 */
export function scanTouchSequence(runId: string): RunTouchStepDTO[] {
  const rows = db()
    .prepare(`SELECT path, outside, ts, tool, subagent, parent FROM (${TOUCH_ROWS}) ORDER BY id`)
    .all(runId) as {
    path: string;
    outside: number;
    ts: number;
    tool: string;
    subagent: string | null;
    parent: string | null;
  }[];

  return rows.map((row) => ({
    path: row.path,
    outside: row.outside === 1,
    at: row.ts,
    tool: row.tool,
    subagent: row.subagent,
    parentToolUseId: row.parent,
  }));
}

/**
 * The answer the route gives, with the three ways of having nothing kept apart.
 *
 * The horizon is checked **after** the scan rather than instead of it. Either
 * order is one query, and this one cannot hide rows: a run past the horizon
 * whose sweep has not run yet still has its events, and announcing the policy
 * over data that is sitting right there would be a readout describing the
 * schedule instead of the database.
 */
export function touchesFor(runId: string, now = Date.now()): RunTouchedDTO {
  const run = getRun(runId);
  if (!run) return { kind: "none", reason: "No such run." };

  const touches = scanTouches(runId);
  if (touches.length > 0) {
    return { kind: "report", touches, cycles: run.iterations };
  }

  const horizonDays = getSettings().eventRetentionDays;
  const cutoff = retentionCutoff(horizonDays, now);
  const settled = TERMINAL_STATUSES.includes(run.status);
  if (
    settled &&
    cutoff !== null &&
    horizonDays !== null &&
    run.finished_at !== null &&
    run.finished_at < cutoff
  ) {
    return { kind: "swept", horizonDays };
  }

  return { kind: "empty", cycles: run.iterations };
}
