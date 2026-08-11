"use client";

import Link from "next/link";
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
 */
function statusDetail(run: RunDTO, now: number): string | null {
  if (run.status === "running") return fmtCycleInFlight(run);
  if (run.status === "queued") {
    const ahead = run.queuePosition ?? 0;
    return ahead === 0
      ? "next up — starts when the folder frees"
      : `${ahead} run${ahead === 1 ? "" : "s"} ahead`;
  }
  if (run.status === "paused") {
    return run.resume_at
      ? `waiting for the 5-hour window — tries again ${fmtRelative(run.resume_at, now)}`
      : "waiting for the 5-hour window";
  }
  return null;
}

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
      <div className="mb-2 flex items-start justify-between gap-3">
        <Link
          href={`/runs/${run.id}`}
          className="mono min-w-0 flex-1 truncate font-medium text-ink hover:text-accent"
          title={run.work_dir ?? run.folder}
        >
          {where}
        </Link>
        <Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>
      </div>

      {run.isolation === "worktree" && (
        <div className="mb-2 text-xs text-ink-faint">
          own checkout
          {run.worktree_branch && (
            <>
              {" · "}
              <span className="mono">{run.worktree_branch}</span>
            </>
          )}
        </div>
      )}

      {/* The task is what distinguishes two runs in the same project, so it is
          the one field that must survive truncation legibly. */}
      <p className="mb-3 line-clamp-2 text-sm text-ink-muted" title={run.prompt}>
        {run.prompt}
      </p>

      {/* Amber for the two states that are waiting on something; a run that is
          simply working is not a warning. Full class strings either side of the
          ternary, never an interpolated fragment — Tailwind scans source as
          text and would emit neither. */}
      {detail && (
        <div
          className={
            run.status === "running"
              ? "mb-3 text-xs text-ink-muted"
              : "mb-3 text-xs text-warn"
          }
        >
          {detail}
        </div>
      )}

      {bars.length > 0 ? (
        <div className="mb-3">
          {bars.map((b) => (
            <Meter
              key={b.label}
              compact
              label={b.label}
              fraction={b.fraction}
              value={b.value}
            />
          ))}
        </div>
      ) : (
        <div className="mb-3 text-xs text-ink-faint">
          {fmtCycles(run.iterations, run.max_iterations)} ·{" "}
          {fmtUSD(run.spent_usd)}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/runs/${run.id}`}
          className="rounded-sm border border-line-strong bg-inset px-3 py-1.5 text-sm font-medium text-ink no-underline hover:border-ink-faint hover:no-underline"
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
