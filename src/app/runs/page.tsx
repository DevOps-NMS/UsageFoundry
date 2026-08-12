"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import type { RunDTO } from "@/lib/apiTypes";
import {
  STATUS_TONE,
  fmtCycles,
  fmtDateTime,
  fmtTokens,
  fmtUSD,
  pollFailureMessage,
  shortPath,
} from "@/lib/format";
import { RunCard } from "@/components/RunCard";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
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

/**
 * A shape per status, drawn rather than coloured.
 *
 * The word beside it is what a screen reader reads and what makes the state
 * unambiguous; the shape is what lets thirty rows be scanned without reading
 * any of them. Tone cannot do that job on its own here — `paused`, `stopped`
 * and `blocked` are all amber, so in greyscale or to a colour-blind operator
 * the badge would carry no signal at all until it was read word by word.
 */
const STATUS_MARK: Record<RunDTO["status"], ReactNode> = {
  running: <circle cx="5" cy="5" r="3.4" fill="currentColor" />,
  queued: (
    <circle
      cx="5"
      cy="5"
      r="3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    />
  ),
  paused: (
    <path
      d="M3.4 1.8v6.4M6.6 1.8v6.4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
  ),
  completed: (
    <path
      d="m1.7 5.2 2.3 2.3 4.3-4.8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  stopped: (
    <rect x="1.8" y="1.8" width="6.4" height="6.4" rx="1.2" fill="currentColor" />
  ),
  failed: (
    <path
      d="M2.4 2.4 7.6 7.6M7.6 2.4 2.4 7.6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
  ),
  blocked: (
    <g fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="5" cy="5" r="3.2" />
      <path d="M2.7 7.3 7.3 2.7" />
    </g>
  ),
};

function StatusBadge({ status }: { status: RunDTO["status"] }) {
  return (
    <Badge tone={STATUS_TONE[status]}>
      <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 shrink-0" aria-hidden="true">
        {STATUS_MARK[status]}
      </svg>
      {status}
    </Badge>
  );
}

/**
 * Where the run worked, as one line — the same construction `RunCard` uses, so
 * the card band and the table below it name a folder identically.
 *
 * One tone rather than two: the mount used to be drawn in `ink-faint`, which is
 * 3.4:1 on the card surface in light mode, and this is a line a person reads
 * rather than a rule they glance past.
 */
function folderLabel(run: RunDTO): string {
  if (!run.mountLabel) return shortPath(run.folder, 2);
  return `${run.mountLabel} / ${run.relPath || "."}`;
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
 * Placeholder rows in the real grid, so the first poll lands into a table that
 * is already the right shape. The alternative — an empty state until data
 * arrives — told the operator "no runs finished in the last 24 hours" before
 * anything had been read, then replaced it with a table.
 */
function SkeletonRows() {
  return (
    <>
      {["a", "b", "c"].map((key) => (
        <Tr key={key}>
          <Td aria-hidden="true">
            <SkeletonBar className="w-14" />
          </Td>
          <Td aria-hidden="true">
            <SkeletonBar className="w-[58%]" />
            <SkeletonBar className="mt-3 w-[30%]" />
          </Td>
          <Td aria-hidden="true">
            <SkeletonBar className="ml-auto w-9" />
          </Td>
          <Td aria-hidden="true">
            <SkeletonBar className="ml-auto w-10" />
          </Td>
          <Td aria-hidden="true">
            <SkeletonBar className="ml-auto w-8" />
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
 * Finished runs.
 *
 * Column order is the order the question is asked: how did it end, what was it,
 * then the three figures that get compared between rows. Every width but the
 * task's is fixed and every value in those columns is nowrap, so a four-second
 * poll cannot move a column edge — the task column absorbs the slack instead.
 */
function RunsTable({
  runs,
  caption,
  loading = false,
}: {
  runs: RunDTO[];
  caption: string;
  loading?: boolean;
}) {
  return (
    <TableWrap>
      <Table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <Th scope="col" className="w-[116px]">
              Status
            </Th>
            <Th scope="col" className="w-full">
              Run
            </Th>
            <Th
              scope="col"
              num
              className="w-[104px]"
              title="Work cycles that finished, against the run's cap"
            >
              Cycles
            </Th>
            <Th scope="col" num className="w-[96px]">
              Spent
            </Th>
            <Th scope="col" num className="w-[88px]">
              Tokens
            </Th>
            <Th scope="col" num className="w-[128px]">
              Finished
            </Th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <SkeletonRows />
          ) : (
            runs.map((r) => (
              <Tr
                key={r.id}
                className="transition-colors duration-150 hover:bg-inset focus-within:bg-inset"
              >
                <Td className="align-top">
                  <StatusBadge status={r.status} />
                </Td>
                <Td className="align-top">
                  {/* The task is what tells two runs in the same project apart,
                      so it leads and the folder hangs under it. Both truncate;
                      both keep the whole value in `title`. */}
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
                <Td num className="whitespace-nowrap align-top text-ink-muted">
                  {fmtCycles(r.iterations, r.max_iterations)}
                </Td>
                <Td num className="whitespace-nowrap align-top">
                  {fmtUSD(r.spent_usd)}
                </Td>
                <Td num className="whitespace-nowrap align-top text-ink-muted">
                  {fmtTokens(r.spent_tokens)}
                </Td>
                <Td num className="whitespace-nowrap align-top text-ink-muted">
                  {fmtDateTime(r.finished_at ?? r.started_at ?? r.created_at)}
                </Td>
              </Tr>
            ))
          )}
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
        error?: string;
      };
      if (!res.ok || !data.runs) {
        const detail = data.error ?? (res.ok ? "no runs in the response" : null);
        setPollError(pollFailureMessage(res.status, detail));
        return;
      }
      setRuns(data.runs);
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
        <Link
          href="/runs/new"
          className="rounded-sm border border-transparent bg-accent px-3.5 py-2 text-sm font-medium text-white no-underline transition-[filter] duration-150 hover:brightness-110 hover:no-underline"
        >
          New run
        </Link>
      </div>

      {/* Present even when empty, so the message is announced when it arrives
          rather than only when something else moves focus. */}
      <div role="alert">
        {pollError && <Notice tone="danger">{pollError}</Notice>}
        {actionError && <Notice tone="danger">{actionError}</Notice>}
      </div>

      <section className="mb-8">
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
          <Card emphasis="quiet">
            <Empty>
              <span className="text-ink-muted">Reading runs…</span>
            </Empty>
          </Card>
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

      <section className="mb-8">
        <CardTitle>Finished in the last 24 hours</CardTitle>
        <Card emphasis="quiet">
          {!loaded ? (
            <div aria-busy="true">
              <span className="sr-only">Reading runs…</span>
              <RunsTable runs={[]} loading caption="Runs, still loading" />
            </div>
          ) : blank ? (
            <Unread />
          ) : recent.length === 0 ? (
            <Empty>
              <div className="font-medium text-ink">Nothing finished today</div>
              <div className="mx-auto mt-1 max-w-[46ch] text-ink-muted">
                A run lands here when it stops — whether it reported the task
                done, ran out of work cycles, or hit a limit.
              </div>
            </Empty>
          ) : (
            <RunsTable
              runs={recent}
              caption="Runs that finished in the last 24 hours, newest first"
            />
          )}
        </Card>
      </section>

      {older.length > 0 && (
        <section>
          <details>
            {/* No `display` utility here on purpose: anything but `list-item`
                drops the native disclosure triangle, and the triangle is the
                only thing saying this opens. */}
            <summary className="mb-3 cursor-pointer py-2 text-xs font-semibold uppercase tracking-wider text-ink-muted transition-colors duration-150 marker:text-ink-faint hover:text-ink">
              Older runs ({older.length})
            </summary>
            <Card emphasis="quiet">
              <div
                role="group"
                aria-label="Show older runs by how they ended"
                className="mb-3 flex flex-wrap gap-1.5"
              >
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={filter === f.id}
                    onClick={() => setFilter(f.id)}
                    className={`cursor-pointer rounded-full border px-3.5 py-2 text-xs font-medium transition-colors duration-150 ${
                      filter === f.id
                        ? "border-accent bg-accent-dim text-ink"
                        : "border-line bg-inset text-ink-muted hover:border-line-strong hover:text-ink"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {olderFiltered.length === 0 ? (
                <Empty>
                  <div className="text-ink-muted">
                    No older run ended that way.
                  </div>
                  <div className="mt-2">
                    <Button variant="secondary" onClick={() => setFilter("all")}>
                      Show all {older.length}
                    </Button>
                  </div>
                </Empty>
              ) : (
                <RunsTable
                  runs={olderFiltered}
                  caption="Older runs, newest first"
                />
              )}
              {runs.length >= SERVER_LIMIT && (
                <div className="mt-3 text-xs text-ink-muted">
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
