"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import type {
  EnforcementModeDTO,
  RunDTO,
  RunEventDTO,
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
  fmtTokens,
  fmtUSD,
  pollFailureMessage,
  shortPath,
} from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty, Stat } from "@/components/ui/Card";
import { Field, Input, Textarea } from "@/components/ui/Field";
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
import { describeEvent } from "@/lib/logLine";
import { actionFailureMessage, jsonRequest } from "@/lib/jsonRequest";
import { RunDiff } from "@/components/RunDiff";
import { RunLand } from "@/components/RunLand";
import { RunOutput } from "@/components/RunOutput";
import { RunReview } from "@/components/RunReview";

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

/** How this run's guards are enforced, in the words the run form uses. */
const ENFORCEMENT: Record<EnforcementModeDTO, string> = {
  "between-cycles": "between cycles",
  live: "mid-cycle",
  "live-resume": "mid-cycle, parks",
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
    <div className="mt-4 border-t border-line pt-4">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-ink">
        {title}
        {action && <span className="ml-auto">{action}</span>}
      </h3>
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
  const logRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  // Mirrors `pinnedToBottom` into render, because the way back to the live edge
  // has to be a control the reader can see. The ref stays the source of truth
  // for the autoscroll effect: it is read during an effect that must not wait
  // for a re-render.
  const [atLiveEdge, setAtLiveEdge] = useState(true);
  const [missed, setMissed] = useState(0);
  const seenLines = useRef(0);

  // Poll the run row for status/spend; the SSE stream carries the log.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/runs/${id}`, { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as {
          run?: RunDTO;
          telemetry?: RunTelemetryDTO | null;
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
        setPollError(null);
      } catch (err) {
        if (!alive) return;
        setPollError(
          pollFailureMessage(null, err instanceof Error ? err.message : String(err)),
        );
      }
    };
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  useEffect(() => {
    const es = new EventSource(`/api/runs/${id}/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      try {
        const e = JSON.parse(msg.data) as RunEventDTO;
        if (e.kind === "replay-complete") return;
        setEvents((prev) => [...prev, e]);
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
          : [{ key: e.id ?? `${e.ts}-${i}`, ts: e.ts, entry }];
      }),
    [events],
  );

  // Computed here rather than inside `RunOutput` because the tab bar has to
  // know whether there is a report before it offers a tab for one.
  const cycles = useMemo(() => cycleOutputs(events), [events]);

  const status = run?.status;
  const active = status !== undefined && ACTIVE_STATUSES.has(status);

  // Follow the tail, but stop fighting the user if they scroll up to read.
  // Keyed on the tab as well: the pane is unmounted while another tab is up, so
  // returning to it lands a fresh scroll container at the top, and this is what
  // puts it back on the live edge.
  useEffect(() => {
    const el = logRef.current;
    if (!el || tab !== "log") return;
    if (pinnedToBottom.current) {
      el.scrollTop = el.scrollHeight;
      seenLines.current = lines.length;
      setMissed(0);
    } else {
      setMissed(Math.max(0, lines.length - seenLines.current));
    }
  }, [lines.length, tab]);

  function onScroll() {
    const el = logRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    pinnedToBottom.current = pinned;
    // Bails out of the re-render when the answer has not changed, so dragging
    // the scrollbar does not re-render the page on every frame.
    setAtLiveEdge((prev) => (prev === pinned ? prev : pinned));
    if (pinned) {
      seenLines.current = lines.length;
      setMissed(0);
    }
  }

  const jumpToLive = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedToBottom.current = true;
    setAtLiveEdge(true);
    seenLines.current = lines.length;
    setMissed(0);
  }, [lines.length]);

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
    setStopNote(
      res.data.outcome === "requeued"
        ? "Trying now — if the 5-hour window is still too full it steps aside again."
        : "This run is not waiting.",
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
          is what you came for) and sit on the right on a wide one. */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start">
        <Card
          emphasis={active ? "primary" : "default"}
          className={`border-l-[3px] ${STATE_ACCENT[state.tone]} lg:col-start-2 lg:row-start-1 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100dvh-var(--toolbar-h)-2rem)] lg:overflow-y-auto`}
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
          {haltedWith && (
            <p className="mt-1 text-xs text-ink-muted">
              Stopping a workflow run is final, so this run cannot be picked up
              on its own — start “{haltedWith}” again to do this work.
            </p>
          )}

          <ButtonRow className="mt-3">
            {run.status === "paused" && <Button onClick={tryNow}>Try now</Button>}
            {resumable && !reopenOpen && (
              <Button onClick={openReopen}>
                {/* Both kinds of `blocked` never started a work cycle, so
                    "Resume" would name something that never happened. */}
                {run.status === "blocked"
                  ? "Try again"
                  : saidDone
                    ? "Ask for more"
                    : "Resume"}
              </Button>
            )}
            {active && (
              <Button variant="danger" onClick={stop}>
                {run.status === "paused" ? "Give up" : "Stop run"}
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
                limits are enforced, what happens after DONE, and the permission
                mode. It keeps its folder
                {isolated ? ` and its checkout on ${run.worktree_branch}` : ""}
              </Hint>

              {reopenError && <Hint tone="danger">{reopenError}</Hint>}

              <ButtonRow className="mt-3">
                <Button onClick={submitReopen} busy={reopenBusy}>
                  Resume run
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

          {/* The two figures that belong to the run itself: both come from what
              Claude Code reported for a finished work cycle. Telemetry is a
              different measurement and stays in a block of its own. */}
          <div className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4">
            <div>
              <div className="text-xs font-semibold text-ink">Spent</div>
              <Stat>{fmtUSD(run.spent_usd)}</Stat>
              <div className={SUB}>
                {fmtTokens(run.spent_tokens)} tokens, as Claude Code reported
                them
              </div>
              {/* $0.00 on a run eight minutes into its first cycle is documented
                  behaviour rather than a broken counter — Claude Code reports
                  what a cycle cost in its terminal `result` event and nowhere
                  earlier. */}
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
              {!active && <div className={SUB}>exit {run.exit_code ?? "—"}</div>}
              {(run.done_retriggers ?? 0) > 0 && (
                <div className={SUB}>
                  {run.done_retriggers} sent back after it reported done
                </div>
              )}
            </div>
          </div>

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
            <ListGroup footnote="A run steps aside or stops when a window passes its percentage. Blank means that guard is off.">
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
              <ListRow label="Checked">
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
              <p className="mt-2 text-xs leading-snug text-ink-muted">
                Claude Code&rsquo;s own per-request cost for this run. Kept apart
                from the figure above rather than added to it: that one counts
                only work cycles the CLI got to report, so the two disagree by
                design
                {telemetry.costUSD > run.spent_usd
                  ? " — and this one is the larger, which is what an interrupted cycle looks like."
                  : "."}
              </p>
            </Section>
          )}

          {isolated && (
            <Section title="Checkout">
              <p className="text-xs leading-snug text-ink-muted">
                This run works on branch{" "}
                <span className="mono text-ink">{run.worktree_branch}</span>, not
                in your copy of the folder — so other runs can use the same
                project at the same time. Nothing lands in your checkout until
                you merge it.
                {run.continues_run && (
                  <>
                    {" "}
                    It carries on the branch run{" "}
                    <Link
                      href={`/runs/${run.continues_run}`}
                      className="mono underline underline-offset-2"
                    >
                      {run.continues_run.slice(0, 8)}
                    </Link>{" "}
                    was working on, so those commits are already here and the
                    Changes tab covers both. Only the last run on a branch can
                    land it.
                  </>
                )}
              </p>
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
        </Card>

        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <SegmentedControl
              label="What to show for this run"
              options={tabs}
              value={activeTab}
              onChange={selectTab}
            />
            {activeTab === "log" && (
              <div className="flex items-center gap-2 text-xs tabular-nums text-ink-muted">
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
            <div className="relative">
              <Log
                ref={logRef}
                onScroll={onScroll}
                size="pane"
                label="Run event log"
              >
                {lines.length === 0 && (
                  <div className="font-sans">
                    <Empty>
                      {active
                        ? "Waiting for the first turn…"
                        : "This run produced no output."}
                    </Empty>
                  </div>
                )}
                {lines.map((l) => (
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
              {!atLiveEdge && lines.length > 0 && (
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
          )}

          {activeTab === "report" && <RunOutput cycles={cycles} />}

          {activeTab === "changes" && <RunDiff run={run} />}

          {activeTab === "review" && <RunReview run={run} />}

          {activeTab === "land" && (
            <>
              <RunLand run={run} />

              {handoff && (
                <Card emphasis="quiet" className="mt-4">
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
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
