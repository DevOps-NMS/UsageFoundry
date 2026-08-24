"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type {
  BootReconcileDTO,
  RunListDTO,
  RunListItemDTO,
} from "@/lib/apiTypes";
import {
  fmtCycleInFlight,
  fmtCycles,
  fmtDateTime,
  fmtRelative,
  fmtTokens,
  fmtUSD,
  fmtWaitingFor,
  pollFailureMessage,
  shortPath,
} from "@/lib/format";
import { jsonRequest } from "@/lib/jsonRequest";
import { FleetControls } from "@/components/FleetControls";
import { RestartClosed } from "@/components/RestartClosed";
import { StatusMark } from "@/components/StatusMark";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field, Input } from "@/components/ui/Field";
import { ListView, STICKY_HEAD } from "@/components/ui/ListView";
import { Notice } from "@/components/ui/Notice";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/SegmentedControl";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/Table";

/**
 * Runs the orchestrator still owns: they will spend again on their own.
 *
 * `waiting` belongs here even though it holds no folder — it is a run the
 * operator started and expects to see start, and dropping it into the history
 * table below would file a run that has not happened yet under what has.
 */
const ACTIVE: ReadonlySet<RunListItemDTO["status"]> = new Set([
  "running",
  "queued",
  "paused",
  "waiting",
]);

/**
 * What is spending now, then what will spend again on its own, then what has
 * not started. Creation order put a queued run above a running one, which is
 * backwards for a band whose job is "what needs attention".
 */
const ACTIVE_ORDER: Record<"running" | "paused" | "queued" | "waiting", number> = {
  running: 0,
  paused: 1,
  queued: 2,
  // Last: it is not waiting on this machine for anything, it is waiting on
  // another run in this band.
  waiting: 3,
};

/**
 * Statuses the *bulk* pick-up offers, which is narrower than `reopenRun` accepts.
 *
 * `reopenRun` also takes `completed`, and rightly — the agent's judgement that
 * a task is finished is not the operator's. But `completed` is what a run that
 * used up its cycle cap is written as *and* what a run that reported DONE is
 * written as, so a fleet control that swept it in would restart every run that
 * worked. That is a per-run decision with a per-run prompt behind it
 * (`reopenPrompt`), so it keeps the button on its own page.
 *
 * `blocked` is absent for a different reason: it splits two ways and only one
 * is an ordinary pick-up, the other rejoining a chain at `waiting`. A bulk
 * control must not choose between them on somebody's behalf.
 *
 * Duplicated rather than imported from `orchestrator.ts`, which reaches
 * `node:fs` — and it is a different list, so importing would be wrong anyway.
 */
const REOPENABLE: ReadonlySet<RunListItemDTO["status"]> = new Set(["failed", "stopped"]);

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The instant dividing "finished in the last 24 hours" from "older", to the
 * minute.
 *
 * Quantised because it is read in two places that must agree — the bucket pass
 * over the poll's rows, and the `settledBefore` the older-runs fold asks the
 * route for — and the fold re-requests whenever it moves. At millisecond
 * resolution that is a request per poll for an answer that cannot have changed;
 * pinned, the heading drifts on a tab left open overnight and eventually claims
 * a run finished in the last 24 hours that finished the day before. A minute is
 * the coarsest step nobody can see against a 24-hour window, and it bounds how
 * long a run can sit one bucket too high at 60 seconds — under the slack the
 * four-second poll already has.
 */
function bucketBoundary(at: number): number {
  return Math.floor((at - RECENT_WINDOW_MS) / 60_000) * 60_000;
}

/**
 * How the fold below narrows the history, and every value but `all` is a
 * `status` on the wire.
 *
 * These used to be a filter over the rows that had already arrived, which meant
 * "Failed" showed the failed runs among the hundred newest — the same shape of
 * answer as the question asked, and wrong. The server does it now, so the fold
 * pages the whole table.
 */
type Filter = "all" | "completed" | "needs-review" | "stopped" | "failed" | "blocked";

const FILTERS: readonly SegmentedOption<Filter>[] = [
  { value: "all", label: "All" },
  { value: "completed", label: "Completed" },
  // The segment is what makes this ending findable. `ACTIVE` correctly does not
  // hold it, so the run drops into the history table already — but without a
  // segment of its own the one state whose entire content is "a person should
  // look at this" is reachable only under "All".
  { value: "needs-review", label: "Needs review" },
  { value: "stopped", label: "Stopped" },
  { value: "failed", label: "Failed" },
  { value: "blocked", label: "Blocked" },
];

/**
 * Where the run worked, as one line.
 *
 * One tone rather than two: the mount used to be drawn in `ink-faint`, which is
 * 3.4:1 on the card surface in light mode, and this is a line a person reads
 * rather than a rule they glance past.
 */
function folderLabel(run: RunListItemDTO): string {
  if (!run.mountLabel) return shortPath(run.folder, 2);
  return `${run.mountLabel} / ${run.relPath || "."}`;
}

/**
 * What a run that is not working is waiting *on*, or null.
 *
 * Deliberately silent for `running`: that state's detail is the work cycle it
 * has open, and `fmtCycleInFlight` is the only thing allowed to say it — in its
 * own column, in its own words. Two places describing a running run is how one
 * of them ends up added to the count beside it.
 *
 * `exact` is the precise instant behind a relative phrase, for the `title`.
 */
function waitingDetail(
  run: RunListItemDTO,
  now: number,
): { text: string; exact?: string } | null {
  if (run.status === "waiting") {
    // Always a sentence, even if the list somehow came back empty: a blank line
    // on the one status whose whole meaning is "waiting for something" would
    // read as a run that is waiting for nothing.
    return { text: fmtWaitingFor(run.dependsOn) ?? "waiting for another run" };
  }
  if (run.status === "queued") {
    const ahead = run.queuePosition ?? 0;
    return {
      text:
        ahead === 0
          ? "next up — starts when the folder frees"
          : `${ahead} run${ahead === 1 ? "" : "s"} ahead`,
    };
  }
  if (run.status === "paused") {
    return run.resume_at
      ? {
          text: `tries again ${fmtRelative(run.resume_at, now)}`,
          exact: new Date(run.resume_at).toLocaleString(),
        }
      : { text: "waiting for the 5-hour window" };
  }
  return null;
}

function SkeletonBar({ className = "" }: { className?: string }) {
  // No pulse: a loop would be the only motion on a page that is otherwise
  // still, and it says nothing the layout is not already saying.
  return <div className={`h-3 rounded-full bg-line ${className}`} />;
}

/**
 * What an empty band says when the reason it is empty is that nothing was read.
 * "Nothing is running" is a claim about the machine, and making it off the back
 * of a failed request is the same lie the poll-failure notice exists to stop.
 */
function Unread() {
  return (
    <Empty>
      <span className="text-ink-muted">Nothing could be read from the server.</span>
    </Empty>
  );
}

/**
 * Which set of columns a list draws.
 *
 * `active` carries the two facts only a live run has — what it is waiting on,
 * and the work cycle it has open — and the controls that act on it. `history`
 * carries what it ended up costing. A column that would be a dash in every row
 * is not drawn, which is why this is two shapes rather than one with holes.
 */
type ListKind = "active" | "history";

/**
 * Placeholder rows in the real grid, so the first poll lands into a list that
 * is already the right shape. The alternative — an empty state until data
 * arrives — told the operator "no runs finished in the last 24 hours" before
 * anything had been read, then replaced it with a table.
 */
function SkeletonRows() {
  return (
    <>
      {["a", "b", "c"].map((key) => (
        // Six cells, which is what both shapes have: a placeholder row one cell
        // short of its header is a column that jumps sideways when the poll
        // answers, which is the thing this exists to prevent.
        <Tr key={key}>
          <Td aria-hidden="true">
            <SkeletonBar className="w-16" />
          </Td>
          {/* The same `w-full max-w-0` the task cell carries, so the column
              edges do not move when the poll answers — and the same release of
              it below the breakpoint, where a zero max-width is a zero-width
              block rather than the column that gives. */}
          <Td aria-hidden="true" className="w-full max-w-0 max-md:max-w-none">
            <SkeletonBar className="w-[58%]" />
            <SkeletonBar className="mt-3 w-[30%]" />
          </Td>
          <Td aria-hidden="true">
            <SkeletonBar className="ml-auto w-9" />
          </Td>
          <Td aria-hidden="true">
            <SkeletonBar className="ml-auto w-16" />
          </Td>
          <Td aria-hidden="true">
            <SkeletonBar className="ml-auto w-10" />
          </Td>
          <Td aria-hidden="true">
            <SkeletonBar className="ml-auto w-16" />
          </Td>
        </Tr>
      ))}
    </>
  );
}

/**
 * The list view.
 *
 * Column order is the order the question is asked: how is it, what is it, then
 * the figures that get compared between rows. Every width but the task's is
 * fixed and every value in those columns is nowrap, so a four-second poll
 * cannot move a column edge — the task column absorbs the slack instead.
 */
function RunList({
  runs,
  kind,
  caption,
  now,
  loading = false,
  busyId = null,
  onStop,
  onResume,
}: {
  runs: RunListItemDTO[];
  kind: ListKind;
  caption: string;
  now: number;
  loading?: boolean;
  busyId?: string | null;
  onStop?: (id: string) => void;
  onResume?: (id: string) => void;
}) {
  // Not a scroll container, which is what `plain` is: the scrollport is the
  // content pane instead, so the header pins under the toolbar as the page
  // scrolls. That cost the page a horizontal scrollbar on a window narrower
  // than this app's own sidebar plus about 640px, which is every phone, and
  // `Table`'s `stack` is what answers it rather than a wrapper — below `md`
  // there are no columns to be too wide for, the pinned header goes with them,
  // and the scrollport is still the pane.
  return (
    <ListView box="plain">
      <Table stack>
        <caption className="sr-only">{caption}</caption>
        <THead>
          {/* These are `w-[…]` and not `min-w-[…]`, and that is the opposite
              of every other table in the app — `/branches`, `/agents` and both
              workflow surfaces all state floors. It is deliberate, it is the
              one place the difference matters, and it was measured rather than
              argued.

              Auto table layout hands a `width` back to whichever column asked
              for `width: 100%` — the Run column, which is what makes it the one
              that gives — so none of these figures is what the browser draws:
              Status renders 84px against the 150 written here, Cycles 59
              against 88, Spent 56 against 92. A `min-width` *would* be honoured,
              and on a wrapped table that is the right answer. Not here. This
              list is the app's one table outside `TableWrap` (`box="plain"`
              above), because an `overflow-x-auto` would pin the sticky header
              to a box that never scrolls — so a floor under these columns is a
              floor under the *pane*. Measured: with floors the table stops
              shrinking at 594px and the pane scrolls sideways from ~615px down,
              which covers every window from 768px (where the table is still
              flat) to about 880. With plain widths it keeps collapsing to
              468px and the pane never scrolls at all.

              conventions.md ranks those two costs and this is the losing side
              of it: "a table must not be the reason the pane scrolls
              sideways". What it buys is that a long status wraps — "next up —
              starts when the folder frees" comes out one word per line at
              84px. That is a real cost, recorded rather than fixed, and the
              fix is to shorten the status line or give the pane a wrapper, not
              to change these back. */}
          <tr>
            <Th scope="col" className={`w-[150px] ${STICKY_HEAD}`}>
              Status
            </Th>
            <Th scope="col" className={`w-full ${STICKY_HEAD}`}>
              Run
            </Th>
            <Th scope="col" num className={`w-[88px] ${STICKY_HEAD}`}>
              Cycles
            </Th>
            {kind === "active" ? (
              <Th scope="col" className={`w-[150px] ${STICKY_HEAD}`}>
                In flight
              </Th>
            ) : (
              <Th scope="col" num className={`w-[88px] ${STICKY_HEAD}`}>
                Tokens
              </Th>
            )}
            <Th scope="col" num className={`w-[92px] ${STICKY_HEAD}`}>
              Spent
            </Th>
            {kind === "history" && (
              <Th scope="col" num className={`w-[128px] ${STICKY_HEAD}`}>
                Finished
              </Th>
            )}
            {kind === "active" && (
              <Th scope="col" className={STICKY_HEAD}>
                <span className="sr-only">Controls</span>
              </Th>
            )}
          </tr>
        </THead>
        <TBody>
          {loading ? (
            <SkeletonRows />
          ) : (
            runs.map((r) => {
              const detail = kind === "active" ? waitingDetail(r, now) : null;
              return (
                <Tr
                  key={r.id}
                  // The row whose action is in flight is the nearest thing this
                  // list has to a selection, and it is the one row the operator
                  // is waiting on. `focus-within` is the keyboard's half of the
                  // hover tint `Tr` already carries — a separate variant, so
                  // neither of them is setting a background the other also sets.
                  className={
                    busyId === r.id
                      ? "bg-selection focus-within:bg-inset"
                      : "focus-within:bg-inset"
                  }
                >
                  <Td className="align-top">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusMark status={r.status} />
                      <span className="text-ink">{r.status}</span>
                      {/* Beside the status rather than replacing it: this run
                          ended however it ended, and being held back from the
                          bulk pick-ups is a separate fact about it. Without the
                          chip the only sign is a Fleet count one row lower that
                          quietly does not include it. */}
                      {r.set_aside_at && <Badge>set aside</Badge>}
                    </div>
                    {detail && (
                      <div
                        className="mt-0.5 text-xs text-ink-muted"
                        title={detail.exact}
                      >
                        {detail.text}
                      </div>
                    )}
                  </Td>
                  {/* `w-full max-w-0` is what makes this the column that gives.
                      A truncating line is `white-space: nowrap`, so its
                      min-content width is the whole sentence — capped at 56ch,
                      that made the table 916px wide however narrow the window
                      got, and the pane scrolled sideways into empty canvas
                      beside cards that had stopped at its own edge. Zero as the
                      cell's *max* content contribution and 100% as its
                      preference leaves the fixed columns their widths and hands
                      this one whatever is left, which is what the ellipsis was
                      for.

                      Released below the breakpoint, and it has to be: there are
                      no columns to give to there, so a zero max-width is simply
                      a block of zero width with the task overflowing out of it.
                      The truncation still holds the line to the pane. */}
                  <Td className="w-full max-w-0 align-top max-md:max-w-none">
                    {/* The task is what tells two runs in the same project
                        apart, so it leads and the folder hangs under it. Both
                        truncate; both keep the whole value in `title`. 56ch is
                        an upper bound on a wide window, never a floor. */}
                    <Link
                      href={`/runs/${r.id}`}
                      className="block max-w-[56ch] truncate font-medium text-ink hover:text-accent"
                      title={r.prompt}
                    >
                      {r.prompt}
                    </Link>
                    <div
                      className="mono mt-0.5 max-w-[56ch] truncate text-ink-muted"
                      title={r.work_dir ?? r.folder}
                    >
                      {folderLabel(r)}
                    </div>
                  </Td>
                  {/* The head carried a `title` saying "work cycles that
                      finished, against the run's cap", which is banned twice
                      over: a hover has no touch equivalent, and this table
                      stacks — below the breakpoint the head is not rendered at
                      all, so on a phone that sentence did not exist. It is
                      gone rather than relocated, because nothing was lost. The
                      figure is `n/m`, which reads as "n of m" without help,
                      and the half the title was really distinguishing —
                      finished against still running — is the `In flight`
                      column standing next to it on the only list where a run
                      can be in flight. */}
                  <Td
                    num
                    label="Cycles"
                    className="whitespace-nowrap align-top text-ink-muted"
                  >
                    {fmtCycles(r.iterations, r.max_iterations)}
                  </Td>
                  {kind === "active" ? (
                    // Its own column, never folded into the count beside it:
                    // `fmtCycles` counts cycles that *finished*, so a run reads
                    // 0/2 for the whole of its first one — which is exactly what
                    // a run that was marked running and never started reads.
                    // `fmtCycleInFlight` is the only decider, wording included,
                    // and it refuses the column on any status but running. The
                    // stacked label is the same word the column head uses, for
                    // the same reason: two names for this one would be two
                    // descriptions of a running run, which is what the split
                    // from the count beside it exists to prevent.
                    <Td
                      label="In flight"
                      className="whitespace-nowrap align-top text-xs text-ink-muted"
                    >
                      {fmtCycleInFlight(r) ?? "—"}
                    </Td>
                  ) : (
                    <Td
                      num
                      label="Tokens"
                      className="whitespace-nowrap align-top text-ink-muted"
                    >
                      {fmtTokens(r.spent_tokens)}
                    </Td>
                  )}
                  <Td num label="Spent" className="whitespace-nowrap align-top">
                    {fmtUSD(r.spent_usd)}
                  </Td>
                  {kind === "history" && (
                    <Td
                      num
                      label="Finished"
                      className="whitespace-nowrap align-top text-ink-muted"
                    >
                      {fmtDateTime(r.finished_at ?? r.started_at ?? r.created_at)}
                    </Td>
                  )}
                  {kind === "active" && (
                    <Td className="whitespace-nowrap align-top">
                      <div className="flex items-center justify-end gap-1.5">
                        {r.status === "paused" && onResume && (
                          <Button
                            variant="secondary"
                            size="compact"
                            disabled={busyId === r.id}
                            onClick={() => onResume(r.id)}
                          >
                            Try now
                          </Button>
                        )}
                        {onStop && (
                          <Button
                            variant="ghost"
                            size="compact"
                            disabled={busyId === r.id}
                            onClick={() => onStop(r.id)}
                            className="text-danger hover:bg-inset hover:text-danger"
                          >
                            Stop
                          </Button>
                        )}
                      </div>
                    </Td>
                  )}
                </Tr>
              );
            })
          )}
        </TBody>
      </Table>
    </ListView>
  );
}

export default function RunsPage() {
  const [runs, setRuns] = useState<RunListItemDTO[]>([]);
  const [boot, setBoot] = useState<BootReconcileDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  // What the fold at the bottom is asking the server for. Held here rather than
  // read back off the answer so pressing Next twice in a row is two pages
  // forward and not two requests for the same one — the branches page's own
  // note, and the same reason its offset lives beside its repository.
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [history, setHistory] = useState<RunListDTO | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  /** Which history request is allowed to write; see `loadHistory`. */
  const historyRequest = useRef(0);

  /**
   * The instant that divides "finished in the last 24 hours" from "older".
   *
   * One value, read by both sides, which is the whole point: the poll's rows are
   * bucketed against it here and the fold asks the route for the settled runs
   * from *before* it. Two clocks a few seconds apart would leave a run sitting
   * on the boundary in neither list — on this page a run that has simply
   * vanished — or in both, which is the duplication the bucket pass below was
   * written to end. Advanced by the poll and quantised by `bucketBoundary`, so
   * the fold reloads when it steps rather than on every poll.
   */
  const [boundary, setBoundary] = useState(() => bucketBoundary(Date.now()));
  // Ticked into state rather than read during render: paused runs show a live
  // countdown, and a Date.now() in the render body differs between the server
  // pass and hydration.
  //
  // Three clocks, because three different things ask the time here and only one
  // of them counts down. `now` is the countdown's, and it runs only while a run
  // is actually waiting on one — see `counting` below. `readAt` is the instant
  // the list on screen was read, and it is what the restart notice's relative
  // phrase measures its age against: that answer cannot change without the rows
  // changing, so it moves once per poll rather than sixty times a minute.
  // `boundary` above is the third and is the one shared with the server.
  const [now, setNow] = useState(() => Date.now());
  const [readAt, setReadAt] = useState(() => Date.now());

  /**
   * A failed poll has to say so. This used to drop every non-ok answer on the
   * floor and had no `catch` at all, so a signed-out session or a restarting
   * container left the last good list frozen on screen, indefinitely, looking
   * exactly like a quiet afternoon — and the rejection from the interval was an
   * unhandled one that nothing on the page reacted to.
   */
  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/runs", { cache: "no-store" });
      // Parsed before the status check: a 500 carries no JSON, and letting that
      // throw would report a reachable server as an unreachable one.
      const data = (await res.json().catch(() => ({}))) as Partial<
        RunListDTO & { error: string }
      >;
      if (!res.ok || !data.runs) {
        const detail = data.error ?? (res.ok ? "no runs in the response" : null);
        setPollError(pollFailureMessage(res.status, detail));
        return;
      }
      const at = Date.now();
      setRuns(data.runs);
      setBoot(data.lastBootReconcile ?? null);
      setReadAt(at);
      // The bucket boundary rides the poll rather than a clock of its own, and
      // steps once a minute: React discards an identical number, so the fourteen
      // polls in between are not fourteen reloads of the fold below.
      setBoundary(bucketBoundary(at));
      setPollError(null);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      setPollError(pollFailureMessage(null, cause));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadRuns();
    const poll = setInterval(loadRuns, 4000);
    return () => clearInterval(poll);
  }, [loadRuns]);

  /**
   * The fold's own page of history, filtered and paged by the server.
   *
   * A second request rather than a slice of the first, because the two ask
   * different questions of the same table. The poll above is "what is happening
   * now": the newest page, unfiltered, every four seconds, and it is what the
   * two sections above are drawn from. This is "what happened": one page of the
   * runs that settled before the boundary, narrowed by whatever the fold's own
   * controls say, over every row there is rather than over the newest hundred.
   *
   * Not on the four-second poll. A run that settled more than a day ago does not
   * move on its own, so this reloads on what actually changes it: one of the
   * fold's own controls, the boundary stepping to the next minute, or an
   * operator picking a run up through `reload` below.
   */
  const loadHistory = useCallback(async () => {
    // Only the newest request may write. The search settles into one request
    // and each press of Next fires another, so two can be in flight at once —
    // and a slow earlier answer landing last would put a page nobody asked for
    // on screen, with the controls above it describing a different one and
    // nothing saying so.
    const ticket = ++historyRequest.current;
    setHistoryLoading(true);
    // The same value the bucket pass below cuts on, never a second reading of
    // the clock. See `boundary`.
    const params = new URLSearchParams({ settledBefore: String(boundary) });
    if (filter !== "all") params.set("status", filter);
    if (settledQuery) params.set("q", settledQuery);
    if (offset > 0) params.set("offset", String(offset));

    const res = await jsonRequest<RunListDTO>(`/api/runs?${params}`);
    if (ticket !== historyRequest.current) return;
    setHistoryLoading(false);
    if (!res.ok) {
      setHistoryError(pollFailureMessage(res.status, res.error));
      return;
    }
    setHistory(res.data);
    setHistoryError(null);
  }, [filter, settledQuery, offset, boundary]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // A keystroke is not a request: the box is read 250ms after the last one, the
  // figure the vault's own search box settles on. The offset goes with it,
  // because keeping a page-three offset across a narrower search answers it with
  // an empty page, which reads as "nothing matches".
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettledQuery(query.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  /** Both lists, after something on the page changed a run. */
  const reload = useCallback(async () => {
    await Promise.all([loadRuns(), loadHistory()]);
  }, [loadRuns, loadHistory]);

  /**
   * Whether anything on the page is actually counting down.
   *
   * `waitingDetail` is the only reader of a second-resolution clock here, and
   * only on its paused branch — everything else measures an age against
   * `readAt`. Ungated, the tick rebuilt the buckets and reconciled up to a
   * hundred rows sixty times a minute on a page whose figures had not moved
   * since the last four-second poll.
   */
  const counting = useMemo(
    () => runs.some((r) => r.status === "paused" && r.resume_at),
    [runs],
  );

  useEffect(() => {
    if (!counting) return;
    // Seeded on the way in: `now` is frozen while nothing counts down, so by the
    // time a run parks it can be hours stale, and waiting a second to correct it
    // would put a wrong countdown on screen first.
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [counting]);

  /**
   * One pass, two buckets, no overlap — and the third bucket is the server's.
   *
   * This used to sort the same rows into three, the last of them being the
   * hundred-newest window's leftovers. The fold at the bottom asks the route for
   * that bucket directly now, filtered and paged over the whole table, so a row
   * older than the boundary is dropped here rather than rendered in both places
   * — which is the duplication this pass replaced in the first place, when the
   * active runs appeared in their own table *and* again in the history table.
   *
   * Cut against `boundary` rather than the countdown's clock, for two reasons.
   * It is the same value the fold's request carried, and it has to be, or a run
   * on the boundary lands in neither list; and the rows it sorts arrive with the
   * poll, so asking at 1 Hz rebuilt both arrays — and re-rendered every list
   * below them — to answer a question that cannot change between two reads of
   * the same list.
   */
  const { active, recent } = useMemo(() => {
    const active: RunListItemDTO[] = [];
    const recent: RunListItemDTO[] = [];
    for (const r of runs) {
      if (ACTIVE.has(r.status)) {
        active.push(r);
        continue;
      }
      const at = r.finished_at ?? r.started_at ?? r.created_at;
      if (at < boundary) continue;
      recent.push(r);
    }
    active.sort(
      (a, b) =>
        ACTIVE_ORDER[a.status as keyof typeof ACTIVE_ORDER] -
        ACTIVE_ORDER[b.status as keyof typeof ACTIVE_ORDER],
    );
    return { active, recent };
  }, [runs, boundary]);

  /**
   * Whether the fold is narrowed, which is what tells an empty one apart from an
   * empty history.
   *
   * It also keeps the fold on screen when nothing matches: the controls live
   * inside it, so a fold that disappeared because its own filter matched nothing
   * would take away the only way back out of that filter.
   */
  const filtering = filter !== "all" || settledQuery !== "";

  function clearFilters() {
    setFilter("all");
    setQuery("");
    // Written here as well as through the debounce, so the press reloads once
    // rather than reloading and then reloading again 250ms later.
    setSettledQuery("");
    setOffset(0);
  }

  async function act(id: string, path: string, method: string) {
    setBusyId(id);
    setActionError(null);
    try {
      const res = await fetch(path, { method });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `Request failed (${res.status})`);
      }
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  const stop = (id: string) => act(id, `/api/runs/${id}`, "DELETE");
  const resume = (id: string) => act(id, `/api/runs/${id}/resume`, "POST");

  /** Empty because nothing arrived, as against empty because nothing is there. */
  const blank = runs.length === 0 && pollError !== null;

  /**
   * The finished runs a bulk pick-up would act on: the ones the poll's own page
   * holds, in the order it read them.
   *
   * Read from the poll rather than from what is rendered, and that is a decision
   * now that the fold below is paged. A list built from the rendered rows would
   * make the button's count a function of which page of history somebody
   * happened to be on — press it on page five and it picks up page five — while
   * the poll's page is the same hundred newest runs it has always been, so the
   * count does not move under the operator.
   *
   * Derived here and handed down rather than read inside the control, because
   * the rule is about *what somebody looked at* — a run that failed between the
   * render and the click is not on this list and is not swept in.
   *
   * A run set aside is left out, so the count on the button is what the press
   * would actually start. Only half the answer, and the cheaper half: the list
   * is a reading taken at render, so `reopenFleet` checks the column again
   * against each row before it writes.
   */
  const reopenable = useMemo(
    () =>
      runs
        .filter((r) => REOPENABLE.has(r.status) && !r.set_aside_at)
        .map((r) => ({ id: r.id, status: r.status })),
    [runs],
  );

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-xl font-semibold tracking-tight">Runs</h1>
          <p className="max-w-[68ch] text-ink-muted">
            A <strong className="font-semibold text-ink">run</strong> hands
            Claude Code one task in one folder and lets it keep working until it
            says the task is done — or until one of your limits is reached.
          </p>
        </div>
        <ButtonLink href="/runs/new" variant="primary">
          New run
        </ButtonLink>
      </div>

      {/* Present even when empty, so the message is announced when it arrives
          rather than only when something else moves focus. */}
      <div role="alert">
        {pollError && <Notice tone="danger">{pollError}</Notice>}
        {actionError && <Notice tone="danger">{actionError}</Notice>}
        {/* Up here with the others rather than inside the fold it belongs to:
            the fold is drawn from the answer that failed, so a message inside it
            would be a message inside something that is not on screen. */}
        {historyError && <Notice tone="danger">{historyError}</Notice>}
      </div>

      {/* A restart ends every run it finds and each one needs picking up by
          hand, which used to be one line on container stdout — leaving a screen
          of `failed` runs with nothing here saying they died together. Bounded
          to the same 24 hours this page already calls recent: within a day it
          is the explanation for what is below it, and after that it is noise
          the status endpoint still carries. `quiet`, because it is context
          rather than something to act on now. */}
      {boot !== null && boot.closed > 0 && readAt - boot.at < RECENT_WINDOW_MS && (
        <Notice tone="warn" quiet>
          The server restarted {fmtRelative(boot.at, readAt)} and closed out{" "}
          <strong className="font-semibold text-ink">
            {boot.closed} run{boot.closed === 1 ? "" : "s"}
          </strong>{" "}
          that were in progress
          {boot.kept > 0
            ? `, keeping ${boot.kept} paused run${boot.kept === 1 ? "" : "s"} to resume on their own`
            : ""}
          . Nothing restarts on its own.
        </Notice>
      )}

      {/* And the way back, which the notice above deliberately does not carry.
          The two are about the same restart and answer different questions, so
          they have different lifetimes: that one is *what happened*, bounded to
          the 24 hours this page calls recent and gone afterwards whatever state
          the runs are in, while this one is *what is still outstanding* — it is
          driven by `runs.restart_closed`, so it stays until the last of them has
          been picked up and renders nothing at all once none is left. Above the
          tables rather than in them, because what it is about is a set of rows
          spread across both, and the operator's question is "did a restart just
          eat my afternoon", not "which run is this". */}
      <RestartClosed onReopened={() => void reload()} />

      <FleetControls reopenable={reopenable} onChanged={reload} />

      <div className="mb-8">
        <CardTitle>
          In flight
          {active.length > 0 && <Badge tone="accent">{active.length}</Badge>}
        </CardTitle>
        <p className="sr-only" aria-live="polite">
          {loaded
            ? `${active.length} run${active.length === 1 ? "" : "s"} in flight`
            : ""}
        </p>
        {!loaded ? (
          <div aria-busy="true">
            <span className="sr-only">Reading runs…</span>
            <RunList
              runs={[]}
              kind="active"
              loading
              now={now}
              caption="Runs in flight, still loading"
            />
          </div>
        ) : blank ? (
          <Card emphasis="quiet">
            <Unread />
          </Card>
        ) : active.length === 0 ? (
          <Card emphasis="quiet">
            <Empty>
              <div className="font-medium text-ink">Nothing is running</div>
              <div className="mx-auto mt-1 max-w-[46ch] text-ink-muted">
                A run you start appears here while it works, with what it has
                spent and how close it is to your limits.
              </div>
              <div className="mt-3">
                <Link href="/runs/new">Start a run</Link>
              </div>
            </Empty>
          </Card>
        ) : (
          <RunList
            runs={active}
            kind="active"
            now={now}
            busyId={busyId}
            onStop={stop}
            onResume={resume}
            caption="Runs in flight, the ones spending now first"
          />
        )}
      </div>

      <div className="mb-8">
        <CardTitle>Finished in the last 24 hours</CardTitle>
        {!loaded ? (
          <div aria-busy="true">
            <span className="sr-only">Reading runs…</span>
            <RunList
              runs={[]}
              kind="history"
              loading
              now={now}
              caption="Runs, still loading"
            />
          </div>
        ) : blank ? (
          <Card emphasis="quiet">
            <Unread />
          </Card>
        ) : recent.length === 0 ? (
          <Card emphasis="quiet">
            <Empty>
              <div className="font-medium text-ink">Nothing finished today</div>
              <div className="mx-auto mt-1 max-w-[46ch] text-ink-muted">
                A run lands here when it stops — whether it reported the task
                done, ran out of work cycles, or hit a limit.
              </div>
            </Empty>
          </Card>
        ) : (
          <RunList
            runs={recent}
            kind="history"
            now={now}
            caption="Runs that finished in the last 24 hours, newest first"
          />
        )}
      </div>

      {/* The kit's fold, so the 44px target and the reason a `<summary>` cannot
          buy it with `max-md:min-h-11` are stated once in `ui/Disclosure`
          rather than here. What stays the caller's is the desktop box —
          `mb-3 py-2` is this page's own rhythm — and the count, which renders
          as `Older runs (n)` exactly as before. */}
      {history !== null && (history.total > 0 || filtering) && (
        <Disclosure
          summary="Older runs"
          count={history.total}
          summaryClassName="mb-3 py-2 text-sm font-semibold text-ink-muted"
        >
          {/* Each `Field`'s own `mb-3.5` is this row's vertical gap, so the row
              states only the horizontal one — a `mb-0` here would be a silent
              no-op, because two margin utilities on one element resolve by
              stylesheet order rather than by what the caller wrote. The
              segmented control takes the same margin by hand. */}
          <div className="mb-1 flex flex-wrap items-end gap-x-4">
            {/* The width is on the wrapper, never on the control: `Input`
                already carries `w-full`, and the same stylesheet-order rule
                applies one property over. */}
            <Field label="Search" htmlFor="runs-q">
              <div className="w-[30ch] max-w-full">
                <Input
                  id="runs-q"
                  type="search"
                  value={query}
                  placeholder="Task, folder or run id"
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </Field>

            <div className="mb-3.5">
              <SegmentedControl
                label="Show older runs by how they ended"
                options={FILTERS}
                value={filter}
                onChange={(next) => {
                  setFilter(next);
                  // A narrower filter lands on the first page. Keeping the
                  // offset would answer it with an empty page, which reads as
                  // "nothing matches".
                  setOffset(0);
                }}
              />
            </div>
          </div>
          {history.runs.length === 0 ? (
            <Card emphasis="quiet">
              <Empty>
                <div className="text-ink-muted">
                  No older run matches those filters.
                </div>
                <div className="mt-2">
                  <Button variant="secondary" onClick={clearFilters}>
                    Clear filters
                  </Button>
                </div>
              </Empty>
            </Card>
          ) : (
            <RunList
              runs={history.runs}
              kind="history"
              now={now}
              caption="Older runs, newest first"
            />
          )}
          {/* What this page is a slice of, and the way to the rest of it. The
              count is the server's, over every matching row rather than over
              what arrived — the sentence that used to sit here instead said the
              route did not page beyond a hundred, which is what it now does. */}
          {history.total > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="text-sm tabular-nums text-ink-muted">
                {history.offset + 1}–{history.offset + history.runs.length} of{" "}
                {history.total}
              </span>
              <ButtonRow className="ml-auto">
                <Button
                  variant="secondary"
                  disabled={historyLoading || history.offset === 0}
                  onClick={() =>
                    setOffset(Math.max(0, history.offset - history.limit))
                  }
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    historyLoading ||
                    history.offset + history.limit >= history.total
                  }
                  onClick={() => setOffset(history.offset + history.limit)}
                >
                  Next
                </Button>
              </ButtonRow>
            </div>
          )}
        </Disclosure>
      )}
    </>
  );
}
