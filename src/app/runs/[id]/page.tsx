"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import type { RunDTO, RunEventDTO, RunTelemetryDTO } from "@/lib/apiTypes";
import {
  STATUS_TONE,
  fmtClock,
  fmtCycleInFlight,
  fmtDateTime,
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
import { Log, LogLine, Spinner } from "@/components/ui/Log";
import { describeEvent } from "@/lib/logLine";
import { Notice } from "@/components/ui/Notice";
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
 * The lead card's left edge, tinted by how much attention the state wants.
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

/** Shaped like the page it is standing in for, so nothing jumps on arrival. */
function RunSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading this run…</span>
      <div className="mb-1 h-7 w-52 rounded-sm bg-inset" />
      <div className="mb-4 h-4 w-80 rounded-sm bg-inset" />
      <Card emphasis="primary" className="border-l-[3px] border-l-line-strong">
        <div className="mb-2 h-5 w-44 rounded-sm bg-inset" />
        <div className="h-4 w-full max-w-[46ch] rounded-sm bg-inset" />
        <div className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4">
          <div className="h-8 w-24 rounded-sm bg-inset" />
          <div className="h-8 w-24 rounded-sm bg-inset" />
        </div>
      </Card>
      <Card className="mt-6">
        <div className="mb-3 h-4 w-24 rounded-sm bg-inset" />
        <div className="h-40 w-full rounded-sm bg-inset" />
      </Card>
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
  // The reopen form. Held as strings because blank is meaningful — it is what
  // `normalizePolicy` reads as "no limit" — and a number input cannot hold it.
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [reopenCycles, setReopenCycles] = useState("");
  const [reopenCost, setReopenCost] = useState("");
  const [reopenMinutes, setReopenMinutes] = useState("");
  const [reopenNote, setReopenNote] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  // Mirrors `pinnedToBottom` into render, because the way back to the live edge
  // has to be a control the reader can see. The ref stays the source of truth
  // for the autoscroll effect: it is read during an effect that must not wait
  // for a re-render.
  const [atLiveEdge, setAtLiveEdge] = useState(true);
  const [missed, setMissed] = useState(0);
  const seenLines = useRef(0);
  // null until the run's first status is known — see the effect below.
  const [logOpen, setLogOpen] = useState<boolean | null>(null);

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

  const status = run?.status;
  const active = status !== undefined && ACTIVE_STATUSES.has(status);

  // The log is the page while a run works and history once it has finished, so
  // it starts open on an active run and folded on a settled one. Frozen at the
  // first status that arrives: a run that finishes while you are reading it
  // must not pull the log shut under you.
  useEffect(() => {
    if (!status) return;
    setLogOpen((prev) => prev ?? ACTIVE_STATUSES.has(status));
  }, [status]);
  const showLog = logOpen ?? active;

  // Follow the tail, but stop fighting the user if they scroll up to read.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (pinnedToBottom.current) {
      el.scrollTop = el.scrollHeight;
      seenLines.current = lines.length;
      setMissed(0);
    } else {
      setMissed(Math.max(0, lines.length - seenLines.current));
    }
  }, [lines.length, showLog]);

  // `Log` takes no attribute passthrough and is a shared primitive this run does
  // not own, so the two things a scrolling region needs — a name, and a way for
  // a keyboard to reach it — are set here. `role="log"` is what tells a screen
  // reader the additions are appended output rather than a changed document.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.tabIndex = 0;
    el.setAttribute("role", "log");
    el.setAttribute("aria-label", "Run event log");
  }, [showLog]);

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

  // Only ticks while parked, so a finished run's page does no work. Must sit
  // above the `if (!run)` early return — hooks cannot live behind one.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (run?.status !== "paused") return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [run?.status]);

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

  async function stop() {
    const res = await fetch(`/api/runs/${id}`, { method: "DELETE" });
    const json = (await res.json().catch(() => ({}))) as { outcome?: string };
    // Between work cycles there is no child to signal, but the run still stops
    // at the next check — say so rather than leaving the button looking inert.
    setStopNote(
      json.outcome === "signalled"
        ? "Stopping the current work cycle…"
        : json.outcome === "cancelled"
          ? run?.status === "paused"
            ? "Stopped — it will not resume."
            : "Stopping — it will not start another work cycle."
          : "This run is not active.",
    );
  }

  async function tryNow() {
    const res = await fetch(`/api/runs/${id}/resume`, { method: "POST" });
    const json = (await res.json().catch(() => ({}))) as { outcome?: string };
    // Deliberately does not bypass the guard — it rejoins the queue and the
    // ordinary pre-cycle check decides. Asking early while the window is still
    // full parks it again, which is the honest outcome; a button that spends
    // past a limit the operator set would be worse than no button.
    setStopNote(
      json.outcome === "requeued"
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
    setReopenOpen(true);
  }

  async function submitReopen() {
    if (!run) return;
    setReopenError(null);
    const asLimit = (v: string) => (v.trim() === "" ? null : Number(v));
    const res = await fetch(`/api/runs/${id}/reopen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // Everything not on this form carries over untouched — the window
        // percentages, the enforcement mode, and what happens after DONE.
        budget: {
          ...run.budget,
          maxIterations: asLimit(reopenCycles),
          maxRunCostUSD: asLimit(reopenCost),
          maxDurationMinutes: asLimit(reopenMinutes),
        },
        followUp: reopenNote,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setReopenError(json.error ?? "Could not pick this run up.");
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
  // which is `blocked` too and already holds a checkout.
  const blockedBeforeStart = run.status === "blocked" && run.work_dir === null;
  const pickupable =
    run.status === "failed" ||
    run.status === "stopped" ||
    run.status === "completed" ||
    blockedBeforeStart;
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
  const costPct = run.budget.maxRunCostUSD
    ? Math.min(run.spent_usd / run.budget.maxRunCostUSD, 1)
    : null;
  const state = describeRun(run, {
    now: nowTick,
    cycleInFlight,
    stoppedByGuard,
  });
  const isolated = run.isolation === "worktree" && Boolean(run.worktree_branch);

  return (
    <>
      <h1 className="mb-1 flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
        Run <span className="mono text-lg">{run.id.slice(0, 8)}</span>
        <Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>
      </h1>
      <p className="mb-4 max-w-[80ch] text-sm text-ink-muted">
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

      {/* The lead card: what is happening, what it has cost, and the one thing
          to do about it. Everything below recedes from here. */}
      <Card
        emphasis={active ? "primary" : "default"}
        className={`border-l-[3px] ${STATE_ACCENT[state.tone]}`}
      >
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            {/* Announced, because it is the one thing on the page that changes
                on its own and matters. The detail below it is not: while the
                run is parked it carries a countdown that reticks every second,
                and a live region there would read it out every second. */}
            <h2
              aria-live="polite"
              className="flex items-center gap-2 text-lg font-semibold tracking-tight text-ink"
            >
              {run.status === "running" && <Spinner />}
              {state.headline}
            </h2>
            <p className="mt-1 max-w-[70ch] text-sm text-ink-muted">
              {state.detail}
            </p>
            {run.stop_reason && (
              <p className="mt-1 max-w-[70ch] text-xs text-ink-muted">
                {run.stop_reason}
              </p>
            )}
            {haltedWith && (
              <p className="mt-1 max-w-[70ch] text-xs text-ink-muted">
                Stopping a workflow run is final, so this run cannot be picked
                up on its own — start “{haltedWith}” again to do this work.
              </p>
            )}
          </div>

          <ButtonRow>
            {run.status === "paused" && (
              <Button className="transition-colors duration-150" onClick={tryNow}>
                Try now
              </Button>
            )}
            {resumable && !reopenOpen && (
              <Button
                className="transition-colors duration-150"
                onClick={openReopen}
              >
                {blockedBeforeStart
                  ? "Try again"
                  : saidDone
                    ? "Ask for more"
                    : "Resume"}
              </Button>
            )}
            {active && (
              <Button
                variant="danger"
                className="transition-colors duration-150"
                onClick={stop}
              >
                {run.status === "paused" ? "Give up" : "Stop run"}
              </Button>
            )}
          </ButtonRow>
        </div>

        {/* Transient feedback for a button that was just pressed. The region is
            always in the DOM so a screen reader announces what arrives in it. */}
        <div aria-live="polite">
          {stopNote && <p className="mt-3 text-sm text-accent">{stopNote}</p>}
        </div>

        {/* The two figures that belong to the run itself: both come from what
            Claude Code reported for a finished work cycle. Telemetry is a
            different measurement and stays in a card of its own. */}
        <div className="mt-4 grid grid-cols-1 gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <div>
            <div className="text-2xs font-semibold uppercase tracking-wider text-ink-muted">
              Spent
            </div>
            <Stat>{fmtUSD(run.spent_usd)}</Stat>
            <div className={SUB}>
              {run.budget.maxRunCostUSD
                ? `of a ${fmtUSD(run.budget.maxRunCostUSD)} limit${
                    costPct !== null ? ` · ${(costPct * 100).toFixed(0)}%` : ""
                  }`
                : "no spending limit set"}
            </div>
            <div className={SUB}>
              {fmtTokens(run.spent_tokens)} tokens, as Claude Code reported them
            </div>
            {/* $0.00 on a run eight minutes into its first cycle is documented
                behaviour rather than a broken counter — Claude Code reports what
                a cycle cost in its terminal `result` event and nowhere earlier. */}
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
            <div className="text-2xs font-semibold uppercase tracking-wider text-ink-muted">
              Work cycles
            </div>
            <Stat>
              {run.iterations}
              {/* 0 is the stored sentinel for "no cap" — see db.ts. */}
              <span className="text-lg font-medium text-ink-muted">
                {run.max_iterations > 0 ? `/${run.max_iterations}` : " · no cap"}
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

        {reopenOpen && (
          <div className="mt-4 border-t border-line pt-4">
            <h3 className="mb-2.5 text-xs font-semibold text-ink">
              {blockedBeforeStart
                ? "Put this run back behind the ones it waits on"
                : !run.session_id
                  ? "Start this run again from its original task"
                  : saidDone
                    ? "Send this run back into the same session"
                    : "Carry on from where this run stopped"}
            </h3>

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
                  : !run.session_id
                    ? "This run never reported a session to resume, so it starts the original task again with this added to the end"
                    : saidDone
                      ? "Sent verbatim as the next turn of the same conversation. Blank asks it to re-check the original task, run the tests and fix what fails"
                      : "Sent verbatim as the next turn of the same conversation. Blank just tells it to continue"}
              </Hint>
            </Field>

            {/* `gap-y-0` is not redundant: the legacy sheet still carries a
                `.grid { gap: 16px }` rule, and without an explicit row gap the
                three fields would inherit 16px on top of their own margin. */}
            <div className="grid gap-x-4 gap-y-0 sm:grid-cols-3">
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
            </div>

            <Hint>
              Everything else carries over: the window percentages, how the
              limits are enforced, what happens after DONE, and the permission
              mode. It keeps its folder
              {isolated ? ` and its checkout on ${run.worktree_branch}` : ""}
            </Hint>

            {reopenError && <Hint tone="danger">{reopenError}</Hint>}

            <ButtonRow className="mt-3">
              <Button
                className="transition-colors duration-150"
                onClick={submitReopen}
              >
                Resume run
              </Button>
              <Button
                variant="secondary"
                className="transition-colors duration-150"
                onClick={() => setReopenOpen(false)}
              >
                Cancel
              </Button>
            </ButtonRow>
          </div>
        )}
      </Card>

      {isolated && (
        <Notice tone="info" quiet className="mt-4">
          <strong>Isolated checkout.</strong> This run works on branch{" "}
          <span className="mono">{run.worktree_branch}</span>, not in your copy of
          the folder — so other runs can use the same project at the same time.
          Nothing lands in your checkout until you merge it.
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
              was working on, so those commits are already here and the diff
              below covers both. Only the last run on a branch can land it.
            </>
          )}
        </Notice>
      )}

      {/* A separate measurement, deliberately not folded into the card above.
          It counts every API request the agent made, including any belonging to
          a work cycle that ended before the CLI reported its cost — so a higher
          number here is the expected outcome of an interrupted run, not a
          discrepancy to reconcile away. */}
      {telemetry && (
        <Card emphasis="quiet" className="mt-4">
          <CardTitle>Telemetry — first-party</CardTitle>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <Stat>{fmtUSD(telemetry.costUSD)}</Stat>
            <div className="text-xs tabular-nums text-ink-muted">
              {telemetry.requests} API{" "}
              {telemetry.requests === 1 ? "request" : "requests"} ·{" "}
              {fmtTokens(telemetry.tokens)} tokens
            </div>
          </div>
          <div className="mt-2 max-w-[80ch] text-xs text-ink-muted">
            Claude Code&rsquo;s own per-request cost for this run. Kept apart from
            the figure above rather than added to it: that one counts only work
            cycles the CLI got to report, so the two disagree by design
            {telemetry.costUSD > run.spent_usd
              ? " — and this one is the larger, which is what an interrupted cycle looks like."
              : "."}
          </div>
        </Card>
      )}

      {/* The outcome, then what it means, then what to do with it. The agent's
          own account comes first within that: it is the only one of these that
          says why. */}
      <RunOutput events={events} emphasis={active ? "quiet" : "default"} />

      <Card emphasis={showLog && active ? "default" : "quiet"} className="mt-6">
        <CardTitle>
          Live log
          <span className="font-normal normal-case tracking-normal tabular-nums text-ink-muted">
            {lines.length} line{lines.length === 1 ? "" : "s"}
          </span>
          {/* Only while the run can still produce output: a finished run whose
              stream has closed is not "disconnected", it is over. */}
          {active &&
            (connected ? (
              <Badge tone="ok">live</Badge>
            ) : (
              <Badge tone="warn">reconnecting</Badge>
            ))}
          <Button
            variant="ghost"
            className="ml-auto transition-colors duration-150"
            aria-expanded={showLog}
            aria-controls="run-log"
            onClick={() => {
              // Reopening lands on the live edge: a fresh scroll container
              // starts at the top, and a reader who asked to see the log again
              // wants the end of it, not the beginning.
              if (!showLog) {
                pinnedToBottom.current = true;
                setAtLiveEdge(true);
              }
              setLogOpen(!showLog);
            }}
          >
            {showLog ? "Hide" : "Show"}
          </Button>
        </CardTitle>

        {/* The wrapper stays mounted whether or not the log is showing, so the
            toggle's aria-controls always names something that exists. */}
        <div className="relative" id="run-log">
          {showLog && (
            <>
              <Log ref={logRef} onScroll={onScroll}>
                {lines.length === 0 && (
                  <Empty>
                    {active
                      ? "Waiting for the first turn…"
                      : "This run produced no output."}
                  </Empty>
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
                  className="absolute bottom-3 right-4 shadow-e2 transition-colors duration-150"
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
            </>
          )}
        </div>
      </Card>

      <RunDiff run={run} />

      {isolated && (
        <>
          <RunReview run={run} />
          <RunLand run={run} />
        </>
      )}

      {handoff && (
        <Card emphasis="quiet" className="mt-6">
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
                <strong>Uncommitted changes left in the checkout.</strong> They
                are not on the branch, so a merge will not bring them over.
              </Notice>
            )}

          <div className="mt-4 border-t border-line pt-3.5">
            <div className="mb-2 text-xs font-semibold text-ink">Review it</div>
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
              // Withheld rather than shown with a caveat: a copyable command
              // gets copied.
              <Hint tone="warn">{String(handoff.payload.mergeBlocked)}</Hint>
            )}
          </div>
        </Card>
      )}

      <Card emphasis="quiet" className="mt-6">
        <CardTitle>Task</CardTitle>
        <div
          tabIndex={0}
          role="group"
          aria-label="Task given to the agent"
          className="mono max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-inset p-2.5 text-ink-muted"
        >
          {run.prompt}
        </div>
      </Card>
    </>
  );
}
