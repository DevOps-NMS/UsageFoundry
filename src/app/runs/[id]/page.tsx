"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import type {
  EnforcementModeDTO,
  RunDTO,
  RunEventDTO,
  PruneSavingsDTO,
  RunTelemetryDTO,
} from "@/lib/apiTypes";
import {
  STATUS_TONE,
  fmtClock,
  fmtCycleInFlight,
  fmtCycles,
  fmtDateTime,
  fmtDuration,
  fmtPct,
  fmtRelative,
  fmtRunOrigin,
  fmtTokens,
  fmtUSD,
  pollFailureMessage,
  shortPath,
} from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty, Stat } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { ListGroup, ListRow } from "@/components/ui/List";
import { Log, LogLine, Spinner } from "@/components/ui/Log";
import { Meter } from "@/components/Meter";
import { Notice } from "@/components/ui/Notice";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/SegmentedControl";
import { StatusMark } from "@/components/StatusMark";
import { cycleOutputs } from "@/lib/cycles";
import {
  LOG_FILTER_OPTIONS,
  describeEvent,
  logFilterActive,
  matchesLogFilter,
  type LogFilterKind,
} from "@/lib/logLine";
import { actionFailureMessage, jsonRequest } from "@/lib/jsonRequest";
import { RunAgentCost } from "@/components/RunAgentCost";
import { RunDiff } from "@/components/RunDiff";
import { RunLand } from "@/components/RunLand";
import { RunOutput } from "@/components/RunOutput";
import { RunReview } from "@/components/RunReview";
import { RunTasks } from "@/components/RunTasks";

/* ------------------------------------------------------------------ */
/* What state the run is in, said once                                 */
/* ------------------------------------------------------------------ */

/**
 * Runs the orchestrator still owns: they will spend again on their own.
 *
 * `waiting` is one of them. It holds no folder, but it is a run that has not
 * happened yet rather than one that is over, so the page keeps its Stop button
 * and its live log.
 */
const ACTIVE_STATUSES: ReadonlySet<RunDTO["status"]> = new Set([
  "running",
  "queued",
  "paused",
  "waiting",
]);

/**
 * The line under a headline figure.
 *
 * `StatSub` is the kit's version and takes no `className`, so it cannot be made
 * tabular at a call site — and every one of these carries a figure that moves
 * as the page polls. Stated once here rather than repeated inline.
 */
const SUB = "mt-0.5 text-xs tabular-nums text-ink-muted";

type StateTone = "neutral" | "info" | "ok" | "warn" | "danger";

/**
 * The inspector's leading edge, tinted by how much attention the state wants.
 *
 * A complete class string per tone, never `border-l-${tone}`: Tailwind scans
 * source as plain text, so an interpolated name emits no rule at all and the
 * edge silently disappears in the shipped container. Same rule as `Badge`.
 */
const STATE_ACCENT: Record<StateTone, string> = {
  neutral: "border-l-line-strong",
  info: "border-l-accent",
  ok: "border-l-ok",
  warn: "border-l-warn",
  danger: "border-l-danger",
};

/**
 * When this run's limits are acted on — in the run form's own words, verbatim.
 * An operator who chose "Stop, then resume" on that form should read it back
 * here rather than a synonym they have to map onto what they picked.
 */
const ENFORCEMENT: Record<EnforcementModeDTO, string> = {
  "between-cycles": "Between cycles",
  live: "Stop mid-cycle",
  "live-resume": "Stop, then resume",
};

interface RunState {
  tone: StateTone;
  /** What happened, in a phrase. */
  headline: string;
  /** What it means, in a sentence. Never repeats `run.stop_reason`, which is
   *  rendered underneath it verbatim. */
  detail: ReactNode;
}

function describeRun(
  run: RunDTO,
  ctx: { now: number; cycleInFlight: string | null; stoppedByGuard: boolean },
): RunState {
  switch (run.status) {
    case "waiting": {
      const pending = (run.dependsOn ?? []).filter((d) => !d.satisfied);
      return {
        tone: "info",
        headline: "Waiting for another run",
        detail: (
          <>
            It starts once{" "}
            {pending.length === 1 ? (
              <>
                run{" "}
                <Link className="mono" href={`/runs/${pending[0].runId}`}>
                  {pending[0].runId.slice(0, 8)}
                </Link>{" "}
                has {pending[0].edge === "on-success" ? "completed" : "finished"}
              </>
            ) : (
              `all ${pending.length} runs it was told to start after have finished`
            )}
            . It holds no folder and no checkout meanwhile, so nothing else is
            waiting on it.
          </>
        ),
      };
    }

    case "queued": {
      const ahead = run.queuePosition ?? 0;
      return {
        tone: "info",
        headline: "Waiting for its folder",
        detail:
          ahead === 0
            ? "Next in line — it starts as soon as the run ahead of it finishes."
            : `${ahead} other run${ahead === 1 ? " is" : "s are"} ahead of it.`,
      };
    }

    case "running":
      return {
        tone: "info",
        headline: "Working",
        detail: ctx.cycleInFlight
          ? `On ${ctx.cycleInFlight}.`
          : "Starting its first work cycle.",
      };

    case "paused":
      return {
        tone: "warn",
        headline: "Waiting for the next 5-hour window",
        detail: (
          <>
            Your 5-hour window reached the percentage this run was told to step
            aside at.{" "}
            {run.resume_at ? (
              <>
                It tries again at {fmtDateTime(run.resume_at)},{" "}
                <strong className="font-semibold text-ink">
                  {fmtRelative(run.resume_at, ctx.now)}
                </strong>
                .
              </>
            ) : (
              "It tries again when the window rolls over."
            )}{" "}
            It is still holding{" "}
            <span className="mono" title={run.work_dir ?? run.folder}>
              {run.relPath || run.mountLabel || shortPath(run.folder, 2)}
            </span>
            , so nothing else can run there until it finishes or you stop it.
          </>
        ),
      };

    case "blocked":
      return {
        tone: "warn",
        headline: "Refused to start",
        detail: "It never started a work cycle, so it has spent nothing.",
      };

    case "failed":
      return {
        tone: "danger",
        headline: "It failed",
        detail:
          run.exit_code === null || run.exit_code === undefined
            ? "A work cycle ended without finishing."
            : `A work cycle exited ${run.exit_code}.`,
      };

    case "stopped":
      // A guard is not a fault, and must not be dressed as one. The signal is
      // the budget event's own payload, never the wording of `stop_reason`.
      return ctx.stoppedByGuard
        ? {
            tone: "neutral",
            headline: "Stopped by one of your limits",
            detail:
              "Nothing went wrong — a limit you set was reached. Resume it with more room to carry on.",
          }
        : {
            tone: "neutral",
            headline: "Stopped",
            detail: "It will not start another work cycle on its own.",
          };

    case "needs-review":
      // Says what the state means and what to do about it, never what the agent
      // said — that is rendered verbatim underneath, which is the contract on
      // `RunState.detail` above.
      return {
        tone: "warn",
        headline: "Needs review",
        detail:
          "Nothing failed. It reached something it could not get past on its own, and said so rather than spending more work cycles against it.",
      };

    case "completed":
      if (run.reported_done) {
        return {
          tone: "ok",
          headline: "Reported the task complete",
          detail:
            "The agent judged the task done. Read what changed before you land it.",
        };
      }
      // `completed` is also what a run that used up its cycle cap is written
      // as, and the cap defaults to 1 — so this is the ordinary case, not the
      // rare one, and calling it "complete" would be a lie.
      return run.max_iterations > 0
        ? {
            tone: "neutral",
            headline: `Used all ${run.max_iterations} work cycle${
              run.max_iterations === 1 ? "" : "s"
            }`,
            detail:
              "It never reported the task complete, so there is probably more to do.",
          }
        : {
            tone: "neutral",
            headline: "Finished",
            detail: "It stopped without reporting the task complete.",
          };
  }
}

/* ------------------------------------------------------------------ */
/* The inspector                                                       */
/* ------------------------------------------------------------------ */

/**
 * One block of the inspector.
 *
 * A `div`, never a `<section>`: the legacy stylesheet still carries
 * `section + section { margin-top: 24px }`, which would fire between every pair
 * of these — the trap `Card` already documents.
 *
 * Sentence case at a weight step, not 11px uppercase with tracking. macOS names
 * a group in the same voice as the group; the shouting was the web dashboard
 * this page is being moved off.
 */
function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    // The `first:` half is what makes a block sit directly under the heading of
    // the region it opens rather than under a hairline drawn a line below one.
    // It is a `:first-child` rule rather than a prop because three of the four
    // regions have a *conditional* first block — `Agent` and `Checkout` are
    // both gated — so which one opens the region is not knowable where the
    // region is written.
    <div className="mt-4 border-t border-line pt-4 first:mt-0 first:border-t-0 first:pt-0">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-ink">
        {title}
        {action && <span className="ml-auto">{action}</span>}
      </h3>
      {children}
    </div>
  );
}

/**
 * A named group of blocks in the inspector, and the reason they sit together.
 *
 * Eleven blocks at one weight is a column where a state you see constantly and
 * one most operators never see are peers. The heading is a step above a
 * block's own — `text-sm` against `text-xs`, the two-step `conventions.md`
 * already has — and nothing here folds: every block that was in the column is
 * still in it, still with its own heading.
 *
 * A `div`, never a `<section>`. `section + section { margin-top: 24px }` is
 * still in the legacy layer and would fire between every pair of these, which
 * reads as a spacing decision somebody made rather than as a stylesheet rule
 * nobody meant to trigger. `Section` above and `Card` both document the same
 * trap.
 */
function Region({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-5 border-t border-line pt-4">
      <h2 className="mb-2 text-sm font-semibold text-ink">{title}</h2>
      {children}
    </div>
  );
}

/**
 * Where the run sits against each limit that is actually configured.
 *
 * The spend bar is the one that needs saying: the solid fill is `spent_usd`,
 * which is a floor of what Claude Code itself measured, and the hatched band
 * past it is what a cycle killed before it reported has been *estimated* at.
 * Summing the two into one fill would present the estimate as a correction to
 * the measurement; the band is the app's established vocabulary for a span it
 * cannot put a number on, and it is also what the guard reads — so the meter
 * shows the threshold that will actually stop the run without claiming the
 * estimate is money the CLI reported.
 */
function guardBars(run: RunDTO, now: number) {
  const bars: Array<{
    label: string;
    fraction: number;
    upperFraction?: number | null;
    value: string;
  }> = [];

  if (run.max_iterations > 0) {
    bars.push({
      label: "Work cycles",
      fraction: run.iterations / run.max_iterations,
      value: fmtCycles(run.iterations, run.max_iterations),
    });
  }

  const costCap = run.budget.maxRunCostUSD;
  if (costCap !== null && costCap > 0) {
    const estimated = run.spent_usd_est ?? 0;
    bars.push({
      label: "Spend",
      fraction: run.spent_usd / costCap,
      upperFraction:
        estimated > 0 ? (run.spent_usd + estimated) / costCap : null,
      value: `${fmtUSD(run.spent_usd)} / ${fmtUSD(costCap)}`,
    });
  }

  const minutes = run.budget.maxDurationMinutes;
  if (minutes !== null && minutes > 0 && run.started_at) {
    // `finished_at` first: the clock only ticks while the run can still move,
    // so on a run that is over `now` is whenever the page happened to be
    // opened, and the bar would read how long ago that was.
    const elapsed = (run.finished_at ?? now) - run.started_at;
    bars.push({
      label: "Time",
      fraction: elapsed / (minutes * 60_000),
      value: `${fmtDuration(elapsed)} / ${minutes}m`,
    });
  }

  return bars;
}

/** A guard's value in the inspector's list, or the fact that it is not set. */
function GuardValue({ children }: { children: ReactNode }) {
  return (
    <span className="text-sm tabular-nums text-ink">{children}</span>
  );
}

/* ------------------------------------------------------------------ */
/* The main pane                                                       */
/* ------------------------------------------------------------------ */

/**
 * What the pane shows. The log leads because that is what this page is for —
 * nothing switches it on its own, so a run that finishes while you are reading
 * one tab never moves you to another.
 */
type RunTab = "log" | "report" | "changes" | "review" | "land";

/* ------------------------------------------------------------------ */

/** Shaped like the page it is standing in for, so nothing jumps on arrival. */
function RunSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading this run…</span>
      <div className="mb-1 h-7 w-52 rounded-sm bg-inset" />
      <div className="mb-5 h-4 w-80 rounded-sm bg-inset" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start">
        <div>
          <div className="mb-3 h-8 w-64 rounded-sm bg-inset" />
          <div className="h-72 w-full rounded-sm bg-inset" />
        </div>
        <Card className="border-l-[3px] border-l-line-strong">
          <div className="mb-2 h-5 w-44 rounded-sm bg-inset" />
          <div className="h-4 w-full rounded-sm bg-inset" />
          <div className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4">
            <div className="h-8 w-20 rounded-sm bg-inset" />
            <div className="h-8 w-20 rounded-sm bg-inset" />
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function RunDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [run, setRun] = useState<RunDTO | null>(null);
  const [telemetry, setTelemetry] = useState<RunTelemetryDTO | null>(null);
  const [pruning, setPruning] = useState<PruneSavingsDTO | null>(null);
  const [events, setEvents] = useState<RunEventDTO[]>([]);
  const [connected, setConnected] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [stopNote, setStopNote] = useState<string | null>(null);
  // Held apart from `stopNote` rather than folded into it: that one renders in
  // the accent tone as a statement about the run, and a press that may or may
  // not have landed is neither.
  const [actionError, setActionError] = useState<string | null>(null);
  // The reopen form. Held as strings because blank is meaningful — it is what
  // `normalizePolicy` reads as "no limit" — and a number input cannot hold it.
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenBusy, setReopenBusy] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [reopenCycles, setReopenCycles] = useState("");
  const [reopenCost, setReopenCost] = useState("");
  const [reopenMinutes, setReopenMinutes] = useState("");
  const [reopenNote, setReopenNote] = useState("");
  const [tab, setTab] = useState<RunTab>("log");
  // The log's filter. Over the events already in client state and nowhere near
  // the route: this narrows what is drawn, it does not ask for more.
  const [logQuery, setLogQuery] = useState("");
  const [logKind, setLogKind] = useState<LogFilterKind>("all");
  const logRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  // Mirrors `pinnedToBottom` into render, because the way back to the live edge
  // has to be a control the reader can see. The ref stays the source of truth
  // for the autoscroll effect: it is read during an effect that must not wait
  // for a re-render.
  const [atLiveEdge, setAtLiveEdge] = useState(true);
  const [missed, setMissed] = useState(0);
  const seenLines = useRef(0);
  // Which filter `seenLines` was counted under, so a change to it is told apart
  // from lines arriving. Both move the same number.
  const seenFilter = useRef("");

  const status = run?.status;
  const active = status !== undefined && ACTIVE_STATUSES.has(status);

  /**
   * Whether this page still has a reason to ask the row again.
   *
   * A row nobody has read yet is one of them — the first load is not gated on
   * anything, or a page opened on a finished run would never read it. A row the
   * orchestrator still owns is the other.
   */
  const polling = run === null || active;
  // Read by the SSE handler, which is created once per run id and would
  // otherwise close over the first render's answer for the life of the page.
  const pollingRef = useRef(true);
  useEffect(() => {
    pollingRef.current = polling;
  }, [polling]);
  // Bumped to re-arm the poll after it has stood down — see the third edge in
  // the note below.
  const [woken, setWoken] = useState(0);

  // Poll the run row for status/spend; the SSE stream carries the log.
  //
  // The interval is for a run that can still move. A terminal row cannot change
  // on its own, and this route is polled every three seconds for as long as the
  // tab is left open — on a finished run that is an unbounded number of requests
  // asking a question whose answer was settled hours ago.
  //
  // Three edges, and which of them the code relies on rather than hopes for.
  // The first load sits above the gate, so opening a finished run still reads
  // it. A run that finishes while the page is open flips `active` false only
  // *because* a poll said so, and this effect re-runs on that flip and loads
  // once more before declining to re-arm — that last read is what catches a
  // `finished_at`, a stop reason or a spend figure written between the two. And
  // a run picked up again from another tab reaches this page over SSE, which
  // stays subscribed to the bus whatever the row says: the first event to
  // arrive after the poll has stood down bumps `woken`, which re-runs this
  // effect, and the load it does sees the row running again and re-arms. So the
  // page is never frozen on an ending that has since been undone.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/runs/${id}`, { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as {
          run?: RunDTO;
          telemetry?: RunTelemetryDTO | null;
          pruning?: PruneSavingsDTO | null;
          error?: string;
        };
        if (!alive) return;
        if (!res.ok || !json.run) {
          // A 404 or a lapsed session used to leave the loading state on screen
          // for ever, which is indistinguishable from a slow request.
          setPollError(
            pollFailureMessage(res.status, json.error ?? (res.ok ? "no run in the response" : null)),
          );
          return;
        }
        setRun(json.run);
        setTelemetry(json.telemetry ?? null);
        setPruning(json.pruning ?? null);
        setPollError(null);
      } catch (err) {
        if (!alive) return;
        setPollError(
          pollFailureMessage(null, err instanceof Error ? err.message : String(err)),
        );
      }
    };
    void load();
    if (!polling) {
      return () => {
        alive = false;
      };
    }
    const t = setInterval(() => void load(), 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, polling, woken]);

  useEffect(() => {
    const es = new EventSource(`/api/runs/${id}/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      try {
        const e = JSON.parse(msg.data) as RunEventDTO;
        if (e.kind === "replay-complete") return;
        setEvents((prev) => [...prev, e]);
        // An event on a run this page had written off means somebody picked it
        // up. Guarded on the ref rather than sent unconditionally: while the
        // poll is running this would tear the interval down and re-create it on
        // every log line the agent writes.
        if (!pollingRef.current) setWoken((n) => n + 1);
      } catch {
        /* malformed frame — skip rather than tear down the stream */
      }
    };
    return () => es.close();
  }, [id]);

  // Rendered once rather than per paint: `describeEvent` runs over the whole
  // stream, and the log's header counts the lines it will draw.
  const lines = useMemo(
    () =>
      events.flatMap((e, i) => {
        const entry = describeEvent(e);
        return entry === null
          ? []
          : [{ key: e.id ?? `${e.ts}-${i}`, ts: e.ts, kind: e.kind, entry }];
      }),
    [events],
  );

  const logFilter = useMemo(
    () => ({ query: logQuery, kind: logKind }),
    [logQuery, logKind],
  );
  const filtering = logFilterActive(logFilter);
  // The kind leads and a space separates: the union has no spaces in it, so no
  // two filters can produce one key however the query is worded.
  const filterKey = `${logKind} ${logQuery}`;
  const shown = useMemo(
    () =>
      filtering
        ? lines.filter((l) => matchesLogFilter(l.kind, l.entry, logFilter))
        : lines,
    [lines, logFilter, filtering],
  );

  /**
   * How many events the replay never sent, as the stream route counted them.
   *
   * Summed rather than taken from the newest notice: a reconnect replays from
   * the last event this page saw, so each notice is about a different gap, and
   * every one of them is events the filter below has no way to search.
   */
  const droppedEvents = useMemo(
    () =>
      events.reduce(
        (n, e) =>
          n +
          (typeof e.payload?.droppedEvents === "number"
            ? e.payload.droppedEvents
            : 0),
        0,
      ),
    [events],
  );

  // Computed here rather than inside `RunOutput` because the tab bar has to
  // know whether there is a report before it offers a tab for one.
  const cycles = useMemo(() => cycleOutputs(events), [events]);

  // Follow the tail, but stop fighting the user if they scroll up to read.
  // Keyed on the tab as well: the pane is unmounted while another tab is up, so
  // returning to it lands a fresh scroll container at the top, and this is what
  // puts it back on the live edge.
  useEffect(() => {
    const el = logRef.current;
    if (!el || tab !== "log") return;
    // Narrowing the log is a new view of it, so what counts as "arrived while
    // you were reading" starts again. Without this, clearing a filter reports
    // every line it had been hiding as new — a "300 new" badge on a button
    // that jumps to a tail nothing has been added to.
    if (seenFilter.current !== filterKey) {
      seenFilter.current = filterKey;
      seenLines.current = shown.length;
      setMissed(0);
      if (pinnedToBottom.current) el.scrollTop = el.scrollHeight;
      return;
    }
    if (pinnedToBottom.current) {
      el.scrollTop = el.scrollHeight;
      seenLines.current = shown.length;
      setMissed(0);
    } else {
      setMissed(Math.max(0, shown.length - seenLines.current));
    }
  }, [shown.length, tab, filterKey]);

  function onScroll() {
    const el = logRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    pinnedToBottom.current = pinned;
    // Bails out of the re-render when the answer has not changed, so dragging
    // the scrollbar does not re-render the page on every frame.
    setAtLiveEdge((prev) => (prev === pinned ? prev : pinned));
    if (pinned) {
      seenLines.current = shown.length;
      setMissed(0);
    }
  }

  const jumpToLive = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedToBottom.current = true;
    setAtLiveEdge(true);
    seenLines.current = shown.length;
    setMissed(0);
  }, [shown.length]);

  /** Coming back to the log lands on the live edge, not where you left it. */
  function selectTab(next: RunTab) {
    if (next === "log") {
      pinnedToBottom.current = true;
      setAtLiveEdge(true);
    }
    setTab(next);
  }

  // Only ticks while the run can still move, so a finished run's page does no
  // work. Must sit above the `if (!run)` early return — hooks cannot live
  // behind one.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  // Whether a guard ended this run, read off the budget event's own payload
  // rather than off the wording of `stop_reason` — that is user-facing prose
  // and parsing it would break the first time it is reworded.
  const stoppedByGuard = useMemo(
    () =>
      events.some(
        (e) =>
          e.kind === "budget" &&
          e.payload?.allowed === false &&
          e.payload?.disposition !== "pause",
      ),
    [events],
  );

  /**
   * Both of these read an *outcome* out of a 200 and say what it means, so a
   * request that never got one must not fall through to that sentence: "This
   * run is not active." is what the page says about a run that is over, and
   * printing it because a 401 or a dropped connection came back tells the
   * operator their agent has stopped while it goes on spending. `jsonRequest`
   * is what puts that failure on its own branch — and in its own tone, because
   * the accent note beside these buttons is the success voice.
   */
  async function stop() {
    setActionError(null);
    const res = await jsonRequest<{ outcome?: string }>(`/api/runs/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setStopNote(null);
      setActionError(actionFailureMessage(res, "Could not stop this run."));
      return;
    }
    // Between work cycles there is no child to signal, but the run still stops
    // at the next check — say so rather than leaving the button looking inert.
    setStopNote(
      res.data.outcome === "signalled"
        ? "Stopping the current work cycle…"
        : res.data.outcome === "cancelled"
          ? run?.status === "paused"
            ? "Stopped — it will not resume."
            : "Stopping — it will not start another work cycle."
          : "This run is not active.",
    );
  }

  async function tryNow() {
    setActionError(null);
    const res = await jsonRequest<{ outcome?: string }>(
      `/api/runs/${id}/resume`,
      { method: "POST" },
    );
    if (!res.ok) {
      setStopNote(null);
      setActionError(actionFailureMessage(res, "Could not ask this run to try now."));
      return;
    }
    // Deliberately does not bypass the guard — it rejoins the queue and the
    // ordinary pre-cycle check decides. Asking early while the window is still
    // full parks it again, which is the honest outcome; a button that spends
    // past a limit the operator set would be worse than no button.
    // `not-owner` is its own sentence for the reason the comment above these
    // two handlers gives: it arrives as a 200 carrying an outcome, and falling
    // through to "This run is not waiting" would be a false statement about a
    // row that is waiting, on a server that simply cannot act on it. The pid
    // that can is in the notice above every page rather than repeated here.
    setStopNote(
      res.data.outcome === "requeued"
        ? "Trying now — if the 5-hour window is still too full it steps aside again."
        : res.data.outcome === "not-owner"
          ? "This server does not own the data directory, so it cannot start anything. See the notice above."
          : "This run is not waiting.",
    );
  }

  /**
   * Hold this run back from the two bulk pick-ups, or put it back among them.
   *
   * The one control on this page that does not change what the run *is*. A live
   * run is stopped by the same request, in that order and for the reason on
   * `setRunAside`; a finished one is only marked. Either way the row keeps the
   * status and the stop reason it had, which is what makes the undo an undo.
   */
  async function setAside(aside: boolean) {
    setActionError(null);
    const res = await jsonRequest<{ stopped?: string }>(
      `/api/runs/${id}/set-aside`,
      { method: aside ? "POST" : "DELETE" },
    );
    if (!res.ok) {
      setStopNote(null);
      setActionError(
        actionFailureMessage(
          res,
          aside ? "Could not set this run aside." : "Could not put this run back.",
        ),
      );
      return;
    }
    // `stopped` says which of the two things just happened, and the operator
    // pressed one button for both — a run that was still working needs to hear
    // that its agent is going, not only that a list will skip it.
    setStopNote(
      !aside
        ? "Back among the others. Picking up runs in bulk includes this one again."
        : res.data.stopped === "signalled"
          ? "Stopping the current work cycle, and set aside — no bulk pick-up will start it."
          : res.data.stopped === "cancelled"
            ? "Stopped and set aside — no bulk pick-up will start it."
            : "Set aside — no bulk pick-up will start it.",
    );
  }

  function openReopen() {
    if (!run) return;
    const blankIfNull = (v: number | null) => (v === null ? "" : String(v));
    setReopenCycles(blankIfNull(run.budget.maxIterations));
    setReopenCost(blankIfNull(run.budget.maxRunCostUSD));
    setReopenMinutes(blankIfNull(run.budget.maxDurationMinutes));
    setReopenNote("");
    setReopenError(null);
    setStopNote(null);
    setActionError(null);
    setReopenOpen(true);
  }

  async function submitReopen() {
    if (!run) return;
    setReopenError(null);
    setReopenBusy(true);
    const asLimit = (v: string) => (v.trim() === "" ? null : Number(v));
    // Same reason as `stop` above, one step further on: this one already
    // checked `res.ok`, so a refusal was explained — but a rejected `fetch`
    // escaped the `onClick` after `setReopenError(null)` had run, leaving the
    // panel open with nothing said and the button looking inert.
    const res = await jsonRequest(`/api/runs/${id}/reopen`, {
      method: "POST",
      body: {
        // Everything not on this form carries over untouched — the window
        // percentages, the enforcement mode, and what happens after DONE.
        budget: {
          ...run.budget,
          maxIterations: asLimit(reopenCycles),
          maxRunCostUSD: asLimit(reopenCost),
          maxDurationMinutes: asLimit(reopenMinutes),
        },
        followUp: reopenNote,
      },
    });
    setReopenBusy(false);
    if (!res.ok) {
      setReopenError(actionFailureMessage(res, "Could not pick this run up."));
      return;
    }
    setReopenOpen(false);
    setStopNote(
      reopenNote.trim()
        ? "Back in the queue — your note is the first thing it reads."
        : "Back in the queue — it carries on from where it stopped.",
    );
  }

  if (!run) {
    return (
      <>
        {pollError && <Notice tone="warn">{pollError}</Notice>}
        {!pollError && <RunSkeleton />}
      </>
    );
  }

  // Finished, but with somewhere to carry on from — including `completed`: the
  // agent's judgement that a task is done is not the operator's, and seeing
  // what it built is usually what shows up the next thing to ask for.
  // Blocked before it ever got a workspace — its dependency ended in a way that
  // could not satisfy the edge. That verdict is not revisited on its own, so if
  // the dependency has since been picked up and succeeded, this is the only way
  // back. `work_dir` is what separates it from a run its own guard refused,
  // which is `blocked` too and already holds a checkout — pickable as well, but
  // through the queue rather than back into `waiting`, so it is a different
  // sentence in the panel below rather than a different button.
  const blockedBeforeStart = run.status === "blocked" && run.work_dir === null;
  const guardRefused = run.status === "blocked" && run.work_dir !== null;
  const pickupable =
    run.status === "failed" ||
    run.status === "stopped" ||
    run.status === "completed" ||
    // Mirrors `REOPENABLE`, and the mirror is silent: leaving it out would take
    // the Resume button off the one page whose whole job is getting a run that
    // asked for a person moving again, while `reopenRun` went on accepting it.
    run.status === "needs-review" ||
    // Both shapes of `blocked`, mirroring `reopenRun`: the guard-refused kind is
    // the one whose whole fix is raising a limit and pressing this button.
    run.status === "blocked";
  // Except when a whole workflow was halted on top of it. `reopenRun` refuses a
  // member of a stopped instance — a halt is terminal for the instance, and the
  // guard that bounds its spending is inert once it leaves `started` — so the
  // button's only possible answer is that refusal. Said in words where the
  // button would have been, because a control that is silently absent is a dead
  // end on the page whose whole job is getting the run moving again.
  const haltedWith = pickupable ? (run.haltedWorkflow ?? null) : null;
  const resumable = pickupable && !haltedWith;
  // What blank sends, which is the one thing this form's copy has to get right.
  // A `completed` run that used up its cycle cap never reported anything, and
  // is continued rather than pushed back on — same branch as `reopenPrompt`.
  const saidDone = run.status === "completed" && Boolean(run.reported_done);
  /**
   * One name for one act, said once.
   *
   * The button that opens the panel and the button that commits it are the same
   * decision, and they read as two while one said `Resume run` and the other
   * said whichever of these three applied. Both kinds of `blocked` never
   * started a work cycle, so "Resume" would name something that never happened.
   */
  const resumeLabel =
    run.status === "blocked"
      ? "Try again"
      : saidDone
        ? "Ask for more"
        : "Resume";
  // Orthogonal to every other flag here: a run can be set aside in any status,
  // and it changes nothing this page offers — only what the two bulk pick-ups
  // on the runs page will act on.
  const setAsideAt = run.set_aside_at ?? null;
  const handoff = [...events].reverse().find((e) => e.kind === "handoff");
  const cycleInFlight = fmtCycleInFlight(run);
  const state = describeRun(run, {
    now: nowTick,
    cycleInFlight,
    stoppedByGuard,
  });
  const isolated = run.isolation === "worktree" && Boolean(run.worktree_branch);
  const bars = guardBars(run, nowTick);

  // Review and Land exist only for a run with a branch, and Report only once
  // the agent has said something. A tab that would be empty is not offered —
  // and if the selected one is not on the list, the log is.
  const tabs: SegmentedOption<RunTab>[] = [
    { value: "log", label: "Log" },
    ...(cycles.length > 0
      ? [{ value: "report" as const, label: "Report" }]
      : []),
    { value: "changes", label: "Changes" },
    ...(isolated
      ? [
          { value: "review" as const, label: "Review" },
          { value: "land" as const, label: "Land" },
        ]
      : []),
  ];
  const activeTab = tabs.some((t) => t.value === tab) ? tab : "log";

  return (
    <>
      <h1 className="mb-1 flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
        Run <span className="mono text-lg">{run.id.slice(0, 8)}</span>
        <StatusMark status={run.status} />
        <Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>
        {setAsideAt && <Badge>set aside</Badge>}
      </h1>
      <p className="mb-5 max-w-[80ch] text-sm text-ink-muted">
        {run.mountLabel && <>{run.mountLabel} · </>}
        <span className="mono" title={run.folder}>
          {run.mountLabel ? run.relPath || "." : shortPath(run.folder, 3)}
        </span>{" "}
        ·{" "}
        {run.started_at
          ? `started ${fmtDateTime(run.started_at)}`
          : `created ${fmtDateTime(run.created_at)}`}{" "}
        ·{" "}
        {/* Which gate authorised this run. Three of the five start an agent
            with nobody at the keyboard, so on a page about an unexpected run
            this is the first question — and it was answerable only by joining
            three tables, none of which survived deleting the chat or workflow
            it came from. Picking a run up again is a separate act and says so
            separately, because it does not change where the run came from. */}
        {fmtRunOrigin(run.origin)}
        {run.reopened_at ? ` · picked up again ${fmtRelative(run.reopened_at, nowTick)}` : ""}{" "}
        ·{" "}
        {/* Not a resume: this opens the new-run form pre-filled from this
            run's stored config — same task, same folder, same guards, same
            permission mode — and changes nothing until it is submitted. It is
            also how a template gets seeded from something already known to
            work, since the form can save whatever it is holding. */}
        <Link href={`/runs/new?from=${run.id}`}>Start another like this</Link> ·{" "}
        <Link href="/runs">Back to runs</Link>
      </p>

      {pollError && <Notice tone="warn">{pollError}</Notice>}

      {/* The split. The pane holds what the run produced; the inspector beside
          it holds what the run *is* — its state, its money, its guards — and
          stays put while the log runs off the bottom of the pane. Explicit
          column and row placement rather than source order, so the inspector
          can lead on a narrow window (where there is one column and the state
          is what you came for) and sit on the right on a wide one.

          `lg:flex-1` is what fills the pane, and it is the split's own rule
          rather than decoration: the inspector is the taller column whenever
          the log is what the pane is showing, and with the row sized to it and
          the log a fixed 62vh box the column beside it ended in a screen-deep
          band of nothing — which the page then scrolled through, because the
          inspector's cap is measured from the top of the pane and it starts a
          heading further down. Stacked, at one column, there is no second
          column to be shorter than and the page is meant to scroll. */}
      <div className="grid gap-5 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <Card
          emphasis={active ? "primary" : "default"}
          // `max-lg:min-w-0` is the pane column's own `min-w-0` on the other
          // half of the split, and it is missing rather than withheld. Below
          // `lg` the two stack into one implicit `auto` track, whose floor is
          // this card's min-content — and the Task block inside it is
          // `whitespace-pre-wrap break-words`, where `overflow-wrap:break-word`
          // deliberately does *not* shorten a min-content measurement. So one
          // unbroken token in a prompt — a path, a URL, which is most of them —
          // is a floor under the whole grid, and the page scrolls sideways for
          // it. With the floor at 0 the box is the pane's width and its own
          // `overflow-auto` scrolls the line, which is what that class is for.
          // Scoped to `max-lg:` rather than stated plainly: above the
          // breakpoint the track is a fixed 21rem and this would change which
          // way a pathological prompt overflows.
          className={`max-lg:min-w-0 border-l-[3px] ${STATE_ACCENT[state.tone]} lg:col-start-2 lg:row-start-1 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(var(--pane-h)-2rem)] lg:overflow-y-auto`}
        >
          {/* Announced, because it is the one thing on the page that changes
              on its own and matters. The detail below it is not: while the
              run is parked it carries a countdown that reticks every second,
              and a live region there would read it out every second. */}
          <h2
            aria-live="polite"
            className="flex items-center gap-2 text-md font-semibold tracking-tight text-ink"
          >
            {run.status === "running" && <Spinner />}
            {state.headline}
          </h2>
          <p className="mt-1 text-sm text-ink-muted">{state.detail}</p>
          {run.stop_reason && (
            <p className="mt-1 text-xs text-ink-muted">{run.stop_reason}</p>
          )}
          {/* The agent's own account of what stopped it, verbatim and clipped
              only at the write. Gated on the column rather than on the status:
              it is cleared by every other ending and by a pick-up, so its
              presence already means this row records that ending.
              `whitespace-pre-wrap` because the agent writes paragraphs and the
              three facts it was asked for are usually on separate lines. */}
          {run.needs_review_reason && (
            <p className="mt-2 whitespace-pre-wrap border-l-2 border-l-warn pl-2 text-xs text-ink">
              {run.needs_review_reason}
            </p>
          )}
          {haltedWith && (
            <p className="mt-1 text-xs text-ink-muted">
              Stopping a workflow run is final, so this run cannot be picked up
              on its own — start “{haltedWith}” again to do this work.
            </p>
          )}

          {/* Where the run says it is being held back, next to the Resume
              button that still works. The chip in the heading is the glance;
              this is the sentence, because what an operator needs to know is
              which press it changes — and the answer is not this page's. */}
          {setAsideAt && (
            <p className="mt-1 text-xs text-ink-muted">
              Set aside {fmtRelative(setAsideAt, nowTick)}. Picking up runs in
              bulk skips this one; Resume here still works and puts it back.
            </p>
          )}

          {/* Up to four of these render together, and the variants are what say
              which one the page is for. **At most one `primary` in every
              reachable state**, and the pick-up is the one that gets it: a run
              still working has none, because the only thing to do to it is stop
              it. `Try now` never becomes a second one — it and the pick-up
              cannot co-render, `paused` being the one status that is not
              pickupable — and it is deliberately the quieter of the two, since
              the run rejoins the queue on its own and pressing it does not
              bypass the guard that parked it. */}
          <ButtonRow className="mt-3">
            {run.status === "paused" && (
              <Button variant="secondary" onClick={tryNow}>
                Try now
              </Button>
            )}
            {resumable && !reopenOpen && (
              <Button onClick={openReopen}>{resumeLabel}</Button>
            )}
            {active && (
              <Button variant="danger" onClick={stop}>
                {run.status === "paused" ? "Give up" : "Stop run"}
              </Button>
            )}
            {/* Last, and `ghost`, because this is the one control here that does
                not change what the run *is* — it changes which runs the two bulk
                pick-ups will act on, and nothing else. A live run's press also
                ends a billed agent, and the label says so in words rather than
                in a colour that would put a second red button beside Stop. The
                undo takes the same slot and is `secondary`: a run already set
                aside has nothing else to offer from this row, so it is the one
                thing there is to press. */}
            {setAsideAt ? (
              <Button variant="secondary" onClick={() => void setAside(false)}>
                Put back
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => void setAside(true)}>
                {active ? "Stop and set aside" : "Set aside"}
              </Button>
            )}
          </ButtonRow>

          {/* Transient feedback for a button that was just pressed. The region
              is always in the DOM so a screen reader announces what arrives. */}
          <div aria-live="polite">
            {stopNote && <p className="mt-3 text-sm text-accent">{stopNote}</p>}
            {actionError && (
              <Notice tone="danger" className="mt-3">
                {actionError}
              </Notice>
            )}
          </div>

          {reopenOpen && (
            <Section
              title={
                blockedBeforeStart
                  ? "Put this run back behind the ones it waits on"
                  : guardRefused
                    ? "Start this run again, under the limits below"
                    : !run.session_id
                      ? "Start this run again from its original task"
                      : saidDone
                        ? "Send this run back into the same session"
                        : "Carry on from where this run stopped"
              }
            >
              <Field label="What else needs doing?" htmlFor="re-note">
                <Textarea
                  id="re-note"
                  value={reopenNote}
                  onChange={(e) => setReopenNote(e.target.value)}
                  placeholder="The retry logic is missing a test for the timeout path."
                />
                <Hint>
                  {blockedBeforeStart
                    ? "It starts by itself if the runs ahead of it have since succeeded, and says so again if they have not"
                    : guardRefused
                      ? // The one fact this run's operator needs and no other
                        // branch carries: nothing here overrides the guard that
                        // refused it, and a window percentage is not on this form.
                        "It never started, so it begins its original task with this added to the end. Its guards are checked again before it spawns — raise whatever refused it, or it stops here again"
                      : !run.session_id
                        ? "This run never reported a session to resume, so it starts the original task again with this added to the end"
                        : saidDone
                          ? "Sent verbatim as the next turn of the same conversation. Blank asks it to re-check the original task, run the tests and fix what fails"
                          : "Sent verbatim as the next turn of the same conversation. Blank just tells it to continue"}
                </Hint>
              </Field>

              <Field label="Work cycles" htmlFor="re-cycles">
                <div className="flex items-center gap-2">
                  <Input
                    id="re-cycles"
                    type="number"
                    min={1}
                    className="w-full min-w-0 flex-1"
                    value={reopenCycles}
                    onChange={(e) => setReopenCycles(e.target.value)}
                  />
                  <span className="whitespace-nowrap text-xs text-ink-muted">
                    in total
                  </span>
                </div>
                <Hint>
                  Counts the {run.iterations} it has already had. Blank means no
                  cycle limit, which needs a time limit
                </Hint>
              </Field>

              <Field label="Spending limit" htmlFor="re-cost">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-ink-muted">$</span>
                  <Input
                    id="re-cost"
                    type="number"
                    min={0}
                    step="0.5"
                    className="w-full min-w-0 flex-1"
                    value={reopenCost}
                    onChange={(e) => setReopenCost(e.target.value)}
                  />
                </div>
                <Hint>
                  Counts the {fmtUSD(run.spent_usd + (run.spent_usd_est ?? 0))}{" "}
                  already spent. Blank means no limit
                </Hint>
              </Field>

              <Field label="Time limit" htmlFor="re-minutes">
                <div className="flex items-center gap-2">
                  <Input
                    id="re-minutes"
                    type="number"
                    min={1}
                    className="w-full min-w-0 flex-1"
                    value={reopenMinutes}
                    onChange={(e) => setReopenMinutes(e.target.value)}
                  />
                  <span className="whitespace-nowrap text-xs text-ink-muted">
                    minutes
                  </span>
                </div>
                <Hint>Runs from when it starts again. Blank means no limit</Hint>
              </Field>

              <Hint>
                Everything else carries over: the window percentages, how the
                limits are enforced, what happens after DONE, the permission
                mode
                {run.agent ? `, and the ${run.agent.name} agent` : ""}. It keeps
                its folder
                {isolated ? ` and its checkout on ${run.worktree_branch}` : ""}
              </Hint>

              {reopenError && <Hint tone="danger">{reopenError}</Hint>}

              <ButtonRow className="mt-3">
                {/* The same word the button that opened this panel used. It
                    read `Resume run` under a `Try again`, which is two names
                    for one act on one screen. */}
                <Button onClick={submitReopen} busy={reopenBusy}>
                  {resumeLabel}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setReopenOpen(false)}
                  disabled={reopenBusy}
                >
                  Cancel
                </Button>
              </ButtonRow>
            </Section>
          )}

          <Region title="Against its limits">
            <Section title="Guards">
              {bars.length > 0 && (
                <div className="mb-3">
                  {bars.map((b) => (
                    <Meter
                      key={b.label}
                      size="compact"
                      label={b.label}
                      fraction={b.fraction}
                      upperFraction={b.upperFraction}
                      value={b.value}
                    />
                  ))}
                </div>
              )}
              <ListGroup>
                <ListRow label="5-hour window">
                  <GuardValue>
                    {run.budget.maxSessionFraction === null
                      ? "no guard"
                      : fmtPct(run.budget.maxSessionFraction)}
                  </GuardValue>
                </ListRow>
                <ListRow label="Weekly window">
                  <GuardValue>
                    {run.budget.maxWeeklyFraction === null
                      ? "no guard"
                      : fmtPct(run.budget.maxWeeklyFraction)}
                  </GuardValue>
                </ListRow>
                <ListRow label="When a limit is acted on">
                  <GuardValue>{ENFORCEMENT[run.budget.enforcement]}</GuardValue>
                </ListRow>
                <ListRow label="After DONE">
                  <GuardValue>
                    {run.budget.continueAfterDone ? "sent back in" : "stops"}
                  </GuardValue>
                </ListRow>
                <ListRow label="Permission mode">
                  <GuardValue>{run.budget.permissionMode ?? "—"}</GuardValue>
                </ListRow>
              </ListGroup>
            </Section>
          </Region>

          {/* Three readings of overlapping money, and the region is what says
              they are three. **No figure, meter, badge or total may be drawn at
              this level.** Any sum of two of them double-counts: `spent_usd` is
              what a work cycle's own `result` event reported, `Agent work` is
              this app's price table over the transcripts, and telemetry is
              Claude Code's own per-request cost. Each keeps its own footnote
              saying so, because adjacency is not permission — and a subtotal
              here would break a correctness invariant that will not throw and
              will not fail a typecheck. */}
          <Region title="What it has spent">
            {/* The two figures that belong to the run itself: both come from what
                Claude Code reported for a finished work cycle. Telemetry is a
                different measurement and stays in a block of its own. */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs font-semibold text-ink">Spent</div>
                <Stat>{fmtUSD(run.spent_usd)}</Stat>
                <div className={SUB}>
                  {fmtTokens(run.spent_tokens)} tokens, as Claude Code reported
                  them
                </div>
                {/* $0.00 on a run eight minutes into its first cycle is
                    documented behaviour rather than a broken counter — Claude
                    Code reports what a cycle cost in its terminal `result`
                    event and nowhere earlier. */}
                {cycleInFlight && (
                  <div className={SUB}>
                    excludes the cycle in flight, which is reported when it ends
                  </div>
                )}
                {/* Held apart from the measured figure above, not added to it. */}
                {(run.spent_usd_est ?? 0) > 0 && (
                  <Hint tone="warn">
                    {fmtUSD(run.spent_usd_est ?? 0)} more is estimated from your
                    transcripts for cycles that were cut short
                  </Hint>
                )}
              </div>

              <div>
                <div className="text-xs font-semibold text-ink">Work cycles</div>
                <Stat>
                  {run.iterations}
                  {/* 0 is the stored sentinel for "no cap" — see db.ts. */}
                  <span className="text-lg font-medium text-ink-muted">
                    {run.max_iterations > 0
                      ? `/${run.max_iterations}`
                      : " · no cap"}
                  </span>
                </Stat>
                <div className={SUB}>
                  {run.status === "paused"
                    ? "parked between cycles"
                    : (cycleInFlight ?? (active ? "starting" : "finished"))}
                </div>
                {!active && (
                  <div className={SUB}>exit {run.exit_code ?? "—"}</div>
                )}
                {(run.done_retriggers ?? 0) > 0 && (
                  <div className={SUB}>
                    {run.done_retriggers} sent back after it reported done
                  </div>
                )}
              </div>
            </div>

            {/* Who did the work, and what their share of it cost. The two
                figures above say what the run spent and neither can say this:
                only the transcript records which agent produced a turn, which
                is why this is the same source the dashboard meters come from
                rather than a fourth one. Its own poll and its own route — see
                the component.

                `startedAs` changes nothing about the arithmetic and only what
                the card is allowed to say. Under `--agent` this split has two
                readings an operator would otherwise take for a bug: every row
                under the agent's name and nothing in `(main thread)`, or the
                reverse, on a page whose region below says the run is the
                reviewer. Which one the CLI writes is unmeasured and no branch
                here depends on it, so the card names the run's agent and lets
                the rows say what they say. */}
            <Section title="Agent work">
              <RunAgentCost
                runId={run.id}
                active={active}
                now={nowTick}
                startedAs={run.agent?.name ?? null}
              />
            </Section>

            {/* A separate measurement, deliberately not folded into the figures
                above. It counts every API request the agent made, including any
                belonging to a work cycle that ended before the CLI reported its
                cost — so a higher number here is the expected outcome of an
                interrupted run, not a discrepancy to reconcile away. */}
            {telemetry && (
              <Section title="Telemetry — first-party">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Stat>{fmtUSD(telemetry.costUSD)}</Stat>
                  <div className="text-xs tabular-nums text-ink-muted">
                    {telemetry.requests} API{" "}
                    {telemetry.requests === 1 ? "request" : "requests"} ·{" "}
                    {fmtTokens(telemetry.tokens)} tokens
                  </div>
                </div>
                {/* Shortened, but never to nothing: this line is one of the two
                    places the three cost readings say in user-visible copy that
                    they must not be added, and the region's whole purpose is
                    that prohibition. */}
                <p className="mt-2 text-xs leading-snug text-ink-muted">
                  Claude Code&rsquo;s own per-request cost, never added to the
                  figures above.
                </p>
              </Section>
            )}

            {/* A fourth reading in this region, and the only one that is not
                money that moved: it is what the run did *not* pay because its
                conversation was pruned between cycles. Never added to the three
                above — the copy says so, on the same grounds the telemetry line
                does. */}
            {pruning && (
              <Section title="Context pruning">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Stat>
                    {pruning.netUSD >= 0 ? "+" : "−"}
                    {fmtUSD(Math.abs(pruning.netUSD))}
                  </Stat>
                  <div className="text-xs tabular-nums text-ink-muted">
                    {fmtTokens(pruning.tokensRemoved)} tokens removed over{" "}
                    {pruning.prunes} {pruning.prunes === 1 ? "prune" : "prunes"}
                  </div>
                </div>
                <p className="mt-2 text-xs leading-snug text-ink-muted">
                  What later turns did not have to re-read, less what the edits
                  cost. Not spend, and never added to the figures above.
                </p>
              </Section>
            )}
          </Region>

          {/* What was decided before it started, and the region is what keeps
              `Agent` *beside* the guards rather than among them — two regions
              away from `Against its limits`. A row inside that guard group
              would claim the agent bounds something, and it bounds strictly
              nothing: `--agent` sets the session's system prompt, and its model
              where the run named none, while the permission mode, the isolation
              grant and the deny list are all argued at the spawn and untouched
              by it, which `orchestrator.test.ts` asserts again with one
              selected. Tidying it into the guards is a change nothing would
              report. */}
          <Region title="How it was set up">
            {/* What it says is what was sent: the run's own frozen copy, so it
                still names the agent after that agent has been renamed or
                deleted. */}
            {run.agent && (
              <Section title="Agent">
                <ListGroup>
                  <ListRow label="Started as">
                    <GuardValue>{run.agent.name}</GuardValue>
                  </ListRow>
                  <ListRow label="Its model">
                    <GuardValue>
                      {run.agent.model ?? "the run's own"}
                    </GuardValue>
                  </ListRow>
                </ListGroup>
              </Section>
            )}

            {isolated && (
              <Section title="Checkout">
                <div className="mono break-all text-sm text-ink">
                  {run.worktree_branch}
                </div>
                {/* The link rather than the sentence it was in: which run this
                    branch carries on is a fact the Changes and Land tabs both
                    act on, and it is the one thing here the branch name does
                    not already say. */}
                {run.continues_run && (
                  <div className={SUB}>
                    carries on{" "}
                    <Link
                      href={`/runs/${run.continues_run}`}
                      className="mono underline underline-offset-2"
                    >
                      {run.continues_run.slice(0, 8)}
                    </Link>
                  </div>
                )}
              </Section>
            )}

            <Section title="Task">
              <div
                tabIndex={0}
                role="group"
                aria-label="Task given to the agent"
                className="mono max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-inset p-2.5 text-ink-muted"
              >
                {run.prompt}
              </div>
            </Section>
          </Region>
        </Card>

        <div className="min-w-0 lg:col-start-1 lg:row-start-1 lg:flex lg:flex-col">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <SegmentedControl
              label="What to show for this run"
              options={tabs}
              value={activeTab}
              onChange={selectTab}
            />
            {activeTab === "log" && (
              <div className="flex items-center gap-2 text-xs tabular-nums text-ink-muted">
                {/* The filter's own readout, because the count is what says a
                    filter is on: "12 of 431" is the fact, and a bare 12 beside
                    a box with words in it is the same number as a run that
                    only wrote twelve lines. */}
                {filtering && `${shown.length} of `}
                {lines.length} line{lines.length === 1 ? "" : "s"}
                {/* Only while the run can still produce output: a finished run
                    whose stream has closed is not "disconnected", it is over. */}
                {active &&
                  (connected ? (
                    <Badge tone="ok">live</Badge>
                  ) : (
                    <Badge tone="warn">reconnecting</Badge>
                  ))}
              </div>
            )}
          </div>

          {activeTab === "log" && (
            <>
              {/* Above the filter and outside the log's scroll container, both
                  deliberately: the tasks are the log's header rather than lines
                  in it, so Find/Show narrows the feed below and leaves this
                  alone, and it stays put while the feed scrolls. Renders
                  nothing on a run that backgrounded nothing. */}
              <RunTasks
                events={events}
                droppedEvents={droppedEvents}
                active={active}
                now={nowTick}
              />

              {/* Over the events already in client state, and that is the whole
                  of what it is: no route, no query, nothing fetched. The
                  Field's own bottom margin is the gap to the log below it —
                  a caller's `mb-0` on a Field is a no-op, since Tailwind emits
                  a numeric utility's values ascending and the component's own
                  `mb-3.5` wins whatever the call site writes. */}
              {/* `items-start`, not `items-end`: the text field grows a hint
                  when the replay was truncated, and aligned on their bottoms
                  the picker would drop a line lower the moment it appeared. */}
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1 basis-56">
                  <Field
                    label="Find in this log"
                    htmlFor="log-filter-text"
                    // Only while a filter is on, and only when the replay was
                    // cut: the log's own truncation line already says the log
                    // is not all of it, and what this adds is that the *filter*
                    // searched only what is here. A filter that finds nothing
                    // in a truncated log otherwise reads as proof of absence.
                    hint={
                      filtering && droppedEvents > 0
                        ? `${droppedEvents.toLocaleString()} earlier events were never sent to this page, so nothing in them can match`
                        : undefined
                    }
                    hintTone="warn"
                  >
                    <Input
                      id="log-filter-text"
                      type="search"
                      placeholder="Text in a line"
                      value={logQuery}
                      onChange={(e) => setLogQuery(e.target.value)}
                    />
                  </Field>
                </div>
                {/* The width is on a wrapper, never on the control, and it goes
                    full width once the two have wrapped — a 224px picker on a
                    390px line reads as a control that failed to stretch. */}
                <div className="w-56 max-md:w-full">
                  <Field label="Show" htmlFor="log-filter-kind">
                    <Select
                      id="log-filter-kind"
                      value={logKind}
                      onChange={(e) =>
                        setLogKind(e.target.value as LogFilterKind)
                      }
                    >
                      {LOG_FILTER_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </div>

              {/* The log narrows in place and nothing moves focus, so a reader
                  who cannot see the count in the header above has no signal
                  that the filter did anything. Same sr-only shape as the runs
                  history's own filter. */}
              <p className="sr-only" aria-live="polite">
                {filtering
                  ? `${shown.length} of ${lines.length} lines shown`
                  : ""}
              </p>

              <div className="relative lg:min-h-[18rem] lg:flex-1">
                <Log
                  ref={logRef}
                  onScroll={onScroll}
                  size="pane"
                  label="Run event log"
                >
                  {shown.length === 0 && (
                    <div className="font-sans">
                      <Empty>
                        {filtering
                          ? "No line here matches."
                          : active
                            ? "Waiting for the first turn…"
                            : "This run produced no output."}
                      </Empty>
                    </div>
                  )}
                  {shown.map((l) => (
                    <LogLine
                      key={l.key}
                      entry={l.entry}
                      timestamp={fmtClock(l.ts)}
                    />
                  ))}
                </Log>

                {/* The way back. Autoscroll stops the moment the reader scrolls
                    up, which is right — but without this the only way to rejoin
                    the tail of a long log is to drag to the bottom by hand. */}
                {!atLiveEdge && shown.length > 0 && (
                  <Button
                    variant="secondary"
                    className="absolute bottom-3 right-4 shadow-e2"
                    onClick={jumpToLive}
                  >
                    Jump to live
                    {missed > 0 && (
                      <span className="ml-1.5 tabular-nums text-ink-muted">
                        {missed} new
                      </span>
                    )}
                  </Button>
                )}
              </div>
            </>
          )}

          {activeTab === "report" && <RunOutput cycles={cycles} />}

          {activeTab === "changes" && <RunDiff run={run} />}

          {activeTab === "review" && <RunReview run={run} />}

          {activeTab === "land" && (
            <>
              <RunLand run={run} />

              {/* The generation of this feature that `RunLand` above replaced,
                  kept whole and moved one click away. Two things it says are
                  not said anywhere else — the commit list as the agent wrote it,
                  and the `git merge` line — so it is an escape hatch rather than
                  a duplicate, and Tier 2 evidence is what a fold is for.

                  What it withholds is unchanged and must stay withheld: the
                  merge command is absent entirely while the operator's checkout
                  is dirty, never shown with a warning, because a copyable
                  command gets copied. */}
              {handoff && (
                <Disclosure
                  className="mt-4"
                  summary="Do it in your own terminal"
                  summaryClassName="text-xs font-semibold text-ink-muted"
                >
                  <Card emphasis="quiet" className="mt-3">
                    <CardTitle>In your own terminal</CardTitle>

                    {Array.isArray(handoff.payload.commits) &&
                    handoff.payload.commits.length > 0 ? (
                      <div className="mono max-h-40 overflow-auto rounded-sm border border-line bg-inset p-2.5">
                        {(handoff.payload.commits as string[]).map((c) => (
                          <div key={c} className="whitespace-pre-wrap text-ink-muted">
                            {c}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <Empty>The agent made no commits on this branch.</Empty>
                    )}

                    {Array.isArray(handoff.payload.uncommitted) &&
                      handoff.payload.uncommitted.length > 0 && (
                        <Notice tone="warn" quiet className="mt-3">
                          <strong>Uncommitted changes left in the checkout.</strong>{" "}
                          They are not on the branch, so a merge will not bring
                          them over.
                        </Notice>
                      )}

                    <div className="mt-4 border-t border-line pt-3.5">
                      <div className="mb-2 text-xs font-semibold text-ink">
                        Review it
                      </div>
                      {(Array.isArray(handoff.payload.review)
                        ? (handoff.payload.review as string[])
                        : []
                      ).map((c) => (
                        <div key={c} className="mono break-all text-ink-muted">
                          {c}
                        </div>
                      ))}
                    </div>

                    <div className="mt-4 border-t border-line pt-3.5">
                      <div className="mb-2 text-xs font-semibold text-ink">
                        Bring it in
                      </div>
                      {handoff.payload.merge ? (
                        <div className="mono break-all text-ink-muted">
                          {String(handoff.payload.merge)}
                        </div>
                      ) : (
                        // Withheld rather than shown with a caveat: a copyable
                        // command gets copied.
                        <Hint tone="warn">
                          {String(handoff.payload.mergeBlocked)}
                        </Hint>
                      )}
                    </div>
                  </Card>
                </Disclosure>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
