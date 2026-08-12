"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { RunDTO } from "@/lib/apiTypes";
import {
  STATUS_TONE,
  fmtCycleInFlight,
  fmtCycles,
  fmtDuration,
  fmtRelative,
  fmtUSD,
  shortPath,
} from "@/lib/format";
import { Meter } from "@/components/Meter";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

/**
 * A shape per status, drawn beside the status word inside its badge.
 *
 * The badge already carries a tone, and tone alone is what a red/green
 * colour-blind reader loses first — `paused` and `stopped` share a tone
 * outright, and `running` differs from `completed` only in hue. The word is
 * the accessible fallback; this is what makes the four states separable at a
 * glance, across a grid, without reading any of them.
 */
const STATUS_GLYPH: Record<RunDTO["status"], ReactNode> = {
  // Filled: spending right now.
  running: <circle cx="5" cy="5" r="3.4" fill="currentColor" />,
  // Hollow: alive but doing nothing.
  queued: (
    <circle cx="5" cy="5" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
  ),
  // The universal pause bars: held, will resume itself.
  paused: (
    <>
      <rect x="2.4" y="1.9" width="1.8" height="6.2" rx="0.6" fill="currentColor" />
      <rect x="5.8" y="1.9" width="1.8" height="6.2" rx="0.6" fill="currentColor" />
    </>
  ),
  completed: (
    <path
      d="M2 5.3 4.2 7.5 8 2.9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  // A stop square: ended, but by a decision rather than a fault.
  stopped: <rect x="2.3" y="2.3" width="5.4" height="5.4" rx="1.2" fill="currentColor" />,
  blocked: (
    <>
      <circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.7 7.3 7.3 2.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  failed: (
    <path
      d="M2.7 2.7 7.3 7.3M7.3 2.7 2.7 7.3"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
  ),
};

function StatusMark({ status }: { status: RunDTO["status"] }) {
  return (
    // aria-hidden: the status word sits immediately beside it inside the same
    // badge, so announcing the shape would read the state twice.
    <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 shrink-0" aria-hidden="true">
      {STATUS_GLYPH[status]}
    </svg>
  );
}

/** Where the run sits against each limit that is actually configured. */
function progressOf(run: RunDTO, now: number) {
  // `value` rather than `detail`: on a card the raw pair ("2/5", "$2.14 of
  // $5.00") is what the operator acts on, and a detail line under each bar sits
  // flush against the next bar's label, which reads as belonging to that one.
  const bars: Array<{ label: string; fraction: number; value: string }> = [];

  if (run.max_iterations > 0) {
    bars.push({
      label: "Work cycles",
      fraction: run.iterations / run.max_iterations,
      value: fmtCycles(run.iterations, run.max_iterations),
    });
  }

  const costCap = run.budget.maxRunCostUSD;
  if (costCap !== null && costCap > 0) {
    // spent_usd_est covers cycles killed before the CLI reported, and the guard
    // reads the sum — so the bar has to as well, or it sits below the threshold
    // that actually stops the run.
    const spent = run.spent_usd + (run.spent_usd_est ?? 0);
    bars.push({
      label: "Spend",
      fraction: spent / costCap,
      value: `${fmtUSD(spent)} / ${fmtUSD(costCap)}`,
    });
  }

  const minutes = run.budget.maxDurationMinutes;
  if (minutes !== null && minutes > 0 && run.started_at) {
    const elapsed = now - run.started_at;
    bars.push({
      label: "Time",
      fraction: elapsed / (minutes * 60_000),
      value: `${fmtDuration(elapsed)} / ${minutes}m`,
    });
  }

  return bars;
}

/**
 * Status line that says what the run is *waiting on* — or, once it is working,
 * which cycle it has open. The bars above count finished cycles, so without
 * this a run eight minutes into cycle 1 is indistinguishable from one that was
 * marked running and never started.
 *
 * `exact` is the precise instant behind a relative phrase, for the `title`. The
 * relative form is what an operator reads; the absolute one is what they need
 * when deciding whether to wait.
 */
function statusDetail(
  run: RunDTO,
  now: number,
): { text: string; exact?: string } | null {
  if (run.status === "running") {
    const text = fmtCycleInFlight(run);
    return text ? { text } : null;
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
          text: `waiting for the 5-hour window — tries again ${fmtRelative(run.resume_at, now)}`,
          exact: new Date(run.resume_at).toLocaleString(),
        }
      : { text: "waiting for the 5-hour window" };
  }
  return null;
}

/** The three statuses whose detail line appears and disappears as they work. */
const ACTIVE: ReadonlySet<RunDTO["status"]> = new Set(["running", "queued", "paused"]);

export function RunCard({
  run,
  now,
  onStop,
  onResume,
  busy,
}: {
  run: RunDTO;
  now: number;
  onStop: (id: string) => void;
  onResume: (id: string) => void;
  busy: boolean;
}) {
  const bars = progressOf(run, now);
  const detail = statusDetail(run, now);
  const where = run.mountLabel
    ? `${run.mountLabel}${run.relPath ? ` / ${run.relPath}` : ""}`
    : shortPath(run.folder, 2);

  return (
    <Card emphasis={run.status === "running" ? "primary" : "default"}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link
            href={`/runs/${run.id}`}
            className="mono block truncate font-medium text-ink hover:text-accent"
            title={run.work_dir ?? run.folder}
          >
            {where}
          </Link>
          {run.isolation === "worktree" && (
            <div className="mt-1 truncate text-xs text-ink-muted">
              own checkout
              {run.worktree_branch && (
                <>
                  {" · "}
                  <span className="mono">{run.worktree_branch}</span>
                </>
              )}
            </div>
          )}
        </div>
        <Badge tone={STATUS_TONE[run.status]}>
          <StatusMark status={run.status} />
          {run.status}
        </Badge>
      </div>

      {/* The task is what distinguishes two runs in the same project, so it is
          the one field that must survive truncation legibly. */}
      <p className="mt-3 line-clamp-2 text-sm text-ink-muted" title={run.prompt}>
        {run.prompt}
      </p>

      {/* Amber for the two states that are waiting on something; a run that is
          simply working is not a warning. Full class strings either side of the
          ternary, never an interpolated fragment — Tailwind scans source as
          text and would emit neither.

          The slot is held open for the whole of an active run's life, empty or
          not: `active_iteration` is cleared between cycles, so `statusDetail`
          returns null there and, without a reserved height, the card lost a
          line and every card below it in the grid moved — on a poll tick the
          operator did not ask for and cannot connect to anything. */}
      {ACTIVE.has(run.status) && (
        <div
          className={
            run.status === "running"
              ? "mt-3 min-h-5 text-xs text-ink-muted"
              : "mt-3 min-h-5 text-xs text-warn"
          }
          title={detail?.exact}
        >
          {detail?.text}
        </div>
      )}

      {bars.length > 0 ? (
        <div className="mt-3">
          {bars.map((b) => (
            <Meter
              key={b.label}
              size="compact"
              label={b.label}
              fraction={b.fraction}
              value={b.value}
            />
          ))}
        </div>
      ) : (
        <div className="mt-3 text-xs tabular-nums text-ink-muted">
          {fmtCycles(run.iterations, run.max_iterations)} ·{" "}
          {fmtUSD(run.spent_usd)}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {/* Geometry copied from Button/secondary rather than approximated: the
            two sit side by side, and 2px of difference in height reads as a
            misalignment rather than as a distinction. */}
        <Link
          href={`/runs/${run.id}`}
          className="rounded-sm border border-line-strong bg-inset px-3.5 py-2 text-sm font-medium text-ink no-underline hover:border-ink-faint hover:no-underline"
        >
          Open
        </Link>
        {run.status === "paused" && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => onResume(run.id)}
          >
            Try now
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => onStop(run.id)}
          className="ml-auto text-danger hover:bg-inset hover:text-danger"
        >
          Stop
        </Button>
      </div>
    </Card>
  );
}
