"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { BootReconcileDTO, RunDTO } from "@/lib/apiTypes";
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
import { FleetControls } from "@/components/FleetControls";
import { RestartClosed } from "@/components/RestartClosed";
import { StatusMark } from "@/components/StatusMark";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
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
const ACTIVE: ReadonlySet<RunDTO["status"]> = new Set([
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
const REOPENABLE: ReadonlySet<RunDTO["status"]> = new Set(["failed", "stopped"]);

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The list route returns this many; anything older is simply not on the wire. */
const SERVER_LIMIT = 100;

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
 * The list view's own box and its pinned header.
 *
 * Deliberately *not* the `overflow-x-auto` wrapper the tables elsewhere use:
 * a scroll container of its own would make the header stick to a box that
 * never scrolls, which is a no-op dressed as a feature. Without it the
 * scrollport is the content pane, so the header pins under the toolbar as the
 * page scrolls, which is what a Finder list does and the whole point of it.
 *
 * That cost the page a horizontal scrollbar on a window narrower than this
 * app's own sidebar plus about 640px, which is every phone. `Table`'s `stack`
 * is what answers it rather than a wrapper: below `md` there are no columns to
 * be too wide for, the pinned header goes with them, and the scrollport is
 * still the pane.
 */
const LIST_VIEW = "rounded-lg border border-line bg-surface";

const STICKY_HEAD =
  "sticky top-0 z-10 bg-surface shadow-[inset_0_-1px_0_var(--border)]";

/**
 * Where the run worked, as one line.
 *
 * One tone rather than two: the mount used to be drawn in `ink-faint`, which is
 * 3.4:1 on the card surface in light mode, and this is a line a person reads
 * rather than a rule they glance past.
 */
function folderLabel(run: RunDTO): string {
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
  run: RunDTO,
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
  runs: RunDTO[];
  kind: ListKind;
  caption: string;
  now: number;
  loading?: boolean;
  busyId?: string | null;
  onStop?: (id: string) => void;
  onResume?: (id: string) => void;
}) {
  return (
    <div className={LIST_VIEW}>
      <Table stack>
        <caption className="sr-only">{caption}</caption>
        <THead>
          <tr>
            <Th scope="col" className={`w-[150px] ${STICKY_HEAD}`}>
              Status
            </Th>
            <Th scope="col" className={`w-full ${STICKY_HEAD}`}>
              Run
            </Th>
            <Th
              scope="col"
              num
              className={`w-[88px] ${STICKY_HEAD}`}
              title="Work cycles that finished, against the run's cap"
            >
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
    </div>
  );
}

export default function RunsPage() {
  const [runs, setRuns] = useState<RunDTO[]>([]);
  const [boot, setBoot] = useState<BootReconcileDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  // Ticked into state rather than read during render: paused runs show a live
  // countdown, and a Date.now() in the render body differs between the server
  // pass and hydration.
  const [now, setNow] = useState(() => Date.now());

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
      const data = (await res.json().catch(() => ({}))) as {
        runs?: RunDTO[];
        lastBootReconcile?: BootReconcileDTO | null;
        error?: string;
      };
      if (!res.ok || !data.runs) {
        const detail = data.error ?? (res.ok ? "no runs in the response" : null);
        setPollError(pollFailureMessage(res.status, detail));
        return;
      }
      setRuns(data.runs);
      setBoot(data.lastBootReconcile ?? null);
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
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [loadRuns]);

  /**
   * One pass, three buckets, no overlap. The page this replaces rendered the
   * active runs in their own table *and* again in the history table below it,
   * so a running run appeared twice.
   */
  const { active, recent, older } = useMemo(() => {
    const active: RunDTO[] = [];
    const recent: RunDTO[] = [];
    const older: RunDTO[] = [];
    for (const r of runs) {
      if (ACTIVE.has(r.status)) {
        active.push(r);
        continue;
      }
      const at = r.finished_at ?? r.started_at ?? r.created_at;
      (now - at < RECENT_WINDOW_MS ? recent : older).push(r);
    }
    active.sort(
      (a, b) =>
        ACTIVE_ORDER[a.status as keyof typeof ACTIVE_ORDER] -
        ACTIVE_ORDER[b.status as keyof typeof ACTIVE_ORDER],
    );
    return { active, recent, older };
  }, [runs, now]);

  const olderFiltered = useMemo(
    () => (filter === "all" ? older : older.filter((r) => r.status === filter)),
    [older, filter],
  );

  async function act(id: string, path: string, method: string) {
    setBusyId(id);
    setActionError(null);
    try {
      const res = await fetch(path, { method });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `Request failed (${res.status})`);
      }
      await loadRuns();
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
   * The finished runs a bulk pick-up would act on: exactly the ones this page
   * is displaying, in the order it displays them.
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
      </div>

      {/* A restart ends every run it finds and each one needs picking up by
          hand, which used to be one line on container stdout — leaving a screen
          of `failed` runs with nothing here saying they died together. Bounded
          to the same 24 hours this page already calls recent: within a day it
          is the explanation for what is below it, and after that it is noise
          the status endpoint still carries. `quiet`, because it is context
          rather than something to act on now. */}
      {boot !== null && boot.closed > 0 && now - boot.at < RECENT_WINDOW_MS && (
        <Notice tone="warn" quiet>
          The server restarted {fmtRelative(boot.at, now)} and closed out{" "}
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
      <RestartClosed onReopened={() => void loadRuns()} />

      <FleetControls reopenable={reopenable} onChanged={loadRuns} />

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

      {older.length > 0 && (
        <details>
          {/* No `display` utility here on purpose: anything but `list-item`
              drops the native disclosure triangle, and the triangle is the
              only thing saying this opens — which is also why the 44px target
              below the breakpoint is bought with padding rather than with the
              `max-md:min-h-11` every other control here takes: a min-height on
              a list-item leaves the word and its triangle at the top of a box
              the finger is aiming at the middle of. */}
          <summary className="ui-transition mb-3 cursor-pointer py-2 max-md:py-3.5 text-sm font-semibold text-ink-muted marker:text-ink-faint hover:text-ink">
            Older runs ({older.length})
          </summary>
          <div className="mb-3">
            <SegmentedControl
              label="Show older runs by how they ended"
              options={FILTERS}
              value={filter}
              onChange={setFilter}
            />
          </div>
          {olderFiltered.length === 0 ? (
            <Card emphasis="quiet">
              <Empty>
                <div className="text-ink-muted">No older run ended that way.</div>
                <div className="mt-2">
                  <Button variant="secondary" onClick={() => setFilter("all")}>
                    Show all {older.length}
                  </Button>
                </div>
              </Empty>
            </Card>
          ) : (
            <RunList
              runs={olderFiltered}
              kind="history"
              now={now}
              caption="Older runs, newest first"
            />
          )}
          {runs.length >= SERVER_LIMIT && (
            <p className="mt-3 text-xs text-ink-muted">
              Showing the {SERVER_LIMIT} most recent runs — the list route does
              not page beyond that yet.
            </p>
          )}
        </details>
      )}
    </>
  );
}
