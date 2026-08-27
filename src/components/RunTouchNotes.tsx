"use client";

import { Notice } from "@/components/ui/Notice";

/**
 * The sentences two surfaces have to say identically about the same data.
 *
 * The table under the diff and the map at `/runs/[id]/touched` read the same
 * `run_events` rows through the same reconciliation, so a hedge worded twice is
 * a hedge that drifts — and the one that matters here is not a caveat but the
 * whole of what a recorded call means. `run_events` stores a tool *call* when it
 * is made and a *result* only when it failed (`orchestrator.ts`), and the
 * failure row carries no `tool_use` id joining it back, only a
 * whitespace-flattened 160-character command string that is wrong exactly inside
 * a retry loop. Nothing either surface draws may say a touch succeeded, and the
 * sentence saying so lives here once.
 *
 * The three ways of having nothing are here for the same reason: swept, named-no
 * file and no-such-run all render as an empty list on one surface and as an
 * empty canvas on the other, and both read as a run that touched nothing.
 */

/** Where the run's changes are, relative to the surface saying this. */
export type TouchChangesAt = "above" | "files-tab";

/**
 * Complete strings per variant rather than an interpolated clause: the sentence
 * has to survive being read on either surface, and a half of it assembled at the
 * call site is a half nobody reviews.
 */
const CHANGES_AT: Record<TouchChangesAt, string> = {
  above: "Its changes are still above",
  "files-tab": "Its changes are still on this run's Files tab",
};

const RECONCILE_VERB: Record<"listed" | "drawn", string> = {
  listed: "only listed",
  drawn: "only drawn",
};

/** What a run that named no file gets instead of an empty list. */
export const TOUCH_IDLE_SENTENCE = "No tool call in this run's log named a file.";

/**
 * The two figures, and the hedge that governs every mark either surface makes.
 *
 * The hedge belongs on the header and not on the rows: no row can honestly say
 * whether its own call worked, and a column that is wrong inside a retry loop is
 * worse than one that is absent.
 */
export function TouchHeadline({
  distinctTouched,
  cycles,
}: {
  distinctTouched: number;
  cycles: number;
}) {
  return (
    <p className="mb-3 text-sm text-ink-muted">
      <strong className="font-semibold tabular-nums text-ink">{distinctTouched}</strong>{" "}
      distinct file{distinctTouched === 1 ? "" : "s"} named across{" "}
      <strong className="font-semibold tabular-nums text-ink">{cycles}</strong> work
      cycle{cycles === 1 ? "" : "s"}. A call being recorded means it was{" "}
      <em>attempted</em>: this app stores a tool result only when the tool failed, so
      nothing here says a read or a write succeeded.
    </p>
  );
}

/**
 * Swept, which is a retention policy and not an idle run.
 *
 * `run_events` is swept at `eventRetentionDays` while a checkout is kept on its
 * own clock, so a run old enough has a diff and no touches at all.
 */
export function TouchSweptNotice({
  horizonDays,
  changesAt,
}: {
  horizonDays: number;
  changesAt: TouchChangesAt;
}) {
  return (
    <Notice tone="warn" quiet>
      This run&apos;s tool events were removed on the {horizonDays}-day event horizon,
      so nothing here can say what it touched. {CHANGES_AT[changesAt]} — a checkout is
      kept on a different clock.
    </Notice>
  );
}

/**
 * No diff, which makes the changed set *unknown* rather than empty.
 *
 * Every claim about what did not change is withheld under this, on both
 * surfaces: "read and never changed" over a file nobody can say was not changed
 * is the reconciliation asserting the thing it exists to check.
 */
export function TouchNoDiffNotice({
  reason,
  shows,
}: {
  reason: string | null;
  shows: "listed" | "drawn";
}) {
  return (
    <Notice tone="warn" quiet>
      {reason ?? "There is no diff for this run."} Without one, these files cannot be
      reconciled against what changed — {RECONCILE_VERB[shows]}.
    </Notice>
  );
}
