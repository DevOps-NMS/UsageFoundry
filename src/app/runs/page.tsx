"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { RunDTO } from "@/lib/apiTypes";
import {
  STATUS_TONE,
  fmtCycles,
  fmtDateTime,
  fmtTokens,
  fmtUSD,
  shortPath,
} from "@/lib/format";
import { RunCard } from "@/components/RunCard";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { Notice } from "@/components/ui/Notice";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/Table";

/** Runs the orchestrator still owns: they hold a folder and can spend again. */
const ACTIVE: ReadonlySet<RunDTO["status"]> = new Set([
  "running",
  "queued",
  "paused",
]);

/**
 * What is spending now, then what will spend again on its own, then what has
 * not started. Creation order put a queued run above a running one, which is
 * backwards for a band whose job is "what needs attention".
 */
const ACTIVE_ORDER: Record<"running" | "paused" | "queued", number> = {
  running: 0,
  paused: 1,
  queued: 2,
};

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The list route returns this many; anything older is simply not on the wire. */
const SERVER_LIMIT = 100;

type Filter = "all" | "completed" | "stopped" | "failed" | "blocked";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "completed", label: "Completed" },
  { id: "stopped", label: "Stopped" },
  { id: "failed", label: "Failed" },
  { id: "blocked", label: "Blocked" },
];

function FinishedTable({ runs }: { runs: RunDTO[] }) {
  return (
    <TableWrap>
      <Table>
        <thead>
          <tr>
            <Th>Finished</Th>
            <Th>Folder</Th>
            <Th>Task</Th>
            <Th>Status</Th>
            <Th num>Cycles</Th>
            <Th num>Spent</Th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <Tr key={r.id}>
              <Td className="whitespace-nowrap">
                <Link href={`/runs/${r.id}`}>
                  {fmtDateTime(r.finished_at ?? r.started_at ?? r.created_at)}
                </Link>
              </Td>
              <Td className="mono" title={r.folder}>
                {r.mountLabel ? (
                  <>
                    <span className="text-ink-faint">{r.mountLabel} / </span>
                    {r.relPath || "."}
                  </>
                ) : (
                  shortPath(r.folder, 2)
                )}
              </Td>
              <Td
                className="max-w-[28ch] truncate text-ink-muted"
                title={r.prompt}
              >
                {r.prompt}
              </Td>
              <Td>
                <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
              </Td>
              <Td num>{fmtCycles(r.iterations, r.max_iterations)}</Td>
              <Td num>
                {fmtUSD(r.spent_usd)}
                <div className="text-xs text-ink-faint">
                  {fmtTokens(r.spent_tokens)}
                </div>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableWrap>
  );
}

export default function RunsPage() {
  const [runs, setRuns] = useState<RunDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Ticked into state rather than read during render: paused runs show a live
  // countdown, and a Date.now() in the render body differs between the server
  // pass and hydration.
  const [now, setNow] = useState(() => Date.now());

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/runs", { cache: "no-store" });
      if (res.ok) setRuns((await res.json()).runs);
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

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-xl font-semibold tracking-tight">Runs</h1>
          <p className="max-w-[68ch] text-ink-muted">
            A <strong className="font-semibold text-ink">run</strong> hands
            Claude Code one task in one folder and lets it keep working until it
            says the task is done — or until one of your limits is reached.
          </p>
        </div>
        <Link
          href="/runs/new"
          className="rounded-sm border border-transparent bg-accent px-3.5 py-2 text-sm font-medium text-white no-underline hover:brightness-110 hover:no-underline"
        >
          New run
        </Link>
      </div>

      {actionError && <Notice tone="danger">{actionError}</Notice>}

      <section className="mb-6">
        <CardTitle>
          In flight
          {active.length > 0 && <Badge tone="accent">{active.length}</Badge>}
        </CardTitle>
        {active.length === 0 ? (
          <Card emphasis="quiet">
            <Empty>
              {loaded ? (
                <>
                  Nothing running. <Link href="/runs/new">Start a run</Link>.
                </>
              ) : (
                "Loading…"
              )}
            </Empty>
          </Card>
        ) : (
          // items-start so a short queued card does not stretch to match a tall
          // running one and leave a block of dead space inside it.
          <div className="grid items-start gap-4 md:grid-cols-2">
            {active.map((r) => (
              <RunCard
                key={r.id}
                run={r}
                now={now}
                onStop={stop}
                onResume={resume}
                busy={busyId === r.id}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mb-6">
        <CardTitle>Finished in the last 24 hours</CardTitle>
        <Card emphasis="quiet">
          {recent.length === 0 ? (
            <Empty>No runs finished in the last 24 hours.</Empty>
          ) : (
            <FinishedTable runs={recent} />
          )}
        </Card>
      </section>

      {older.length > 0 && (
        <section>
          <details>
            <summary className="mb-3 cursor-pointer text-xs font-semibold uppercase tracking-wider text-ink-muted marker:text-ink-faint">
              Older runs ({older.length})
            </summary>
            <Card emphasis="quiet">
              <div className="mb-3 flex flex-wrap gap-1.5">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFilter(f.id)}
                    className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-medium ${
                      filter === f.id
                        ? "border-accent bg-accent-dim text-ink"
                        : "border-line bg-inset text-ink-muted hover:text-ink"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {olderFiltered.length === 0 ? (
                <Empty>No runs match that filter.</Empty>
              ) : (
                <FinishedTable runs={olderFiltered} />
              )}
              {runs.length >= SERVER_LIMIT && (
                <div className="mt-3 text-xs text-ink-faint">
                  Showing the {SERVER_LIMIT} most recent runs — the list route
                  does not page beyond that yet.
                </div>
              )}
            </Card>
          </details>
        </section>
      )}
    </>
  );
}
