import { db } from "./db";
import { TOOL_FILE_FIELDS } from "./logLine";
import { getRun, TERMINAL_STATUSES } from "./orchestrator";
import { retentionCutoff } from "./retention";
import { getSettings } from "./settings";
import type { RunTouchDTO, RunTouchedDTO } from "./apiTypes";

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
 * Every file this run's tool events named, collapsed by path, tool and caller.
 *
 * One index range scan: `idx_run_events_run(run_id, id)` leads on `run_id`, so
 * scoping to a run turns the fleet-wide full scan `readCountsFor` pays into a
 * range. There is no index on `kind` and this does not add one — that trade is
 * decided in `fileCostNotice.ts` and it is about the write side, which a reader
 * does not reopen.
 *
 * Relativised against `COALESCE(work_dir, folder)` and then `folder`, and the
 * `CASE` is `readCountsFor`'s rather than a second one: keying on `repo_root`
 * is the difference between a working query and an empty one, because most runs
 * work in a worktree whose paths share no prefix with the repository root.
 *
 * Two deliberate differences from that query. It is **not** filtered to `Read`,
 * since a write is half of what a reconciliation is for. And it **keeps** the
 * rows the `CASE` would otherwise drop at its `ELSE NULL`: a path matching
 * neither column is a touch outside the checkout, which is a group of its own
 * and the one thing nothing in this app has ever shown.
 */
export function scanTouches(runId: string): RunTouchDTO[] {
  const rows = db()
    .prepare(
      `SELECT path, outside, tool, subagent, parent, COUNT(*) AS calls
         FROM (
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
             tool, subagent, parent
           FROM (
             SELECT
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
         )
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
