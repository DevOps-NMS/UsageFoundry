"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import type {
  BranchInventoryDTO,
  BranchSummaryDTO,
  MergeQueueBatchDTO,
  MergeQueueDTO,
  MergeQueueItemDTO,
} from "@/lib/apiTypes";
import {
  fmtDateTime,
  fmtUSD,
  pollFailureMessage,
  type BadgeTone,
} from "@/lib/format";
import { actionFailureMessage, jsonRequest } from "@/lib/jsonRequest";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { Notice } from "@/components/ui/Notice";
import { Spinner } from "@/components/ui/Log";
import { Toggle } from "@/components/ui/Field";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/Table";

/**
 * Every branch the tool has produced, in one place — and the queue that lands
 * them.
 *
 * A branch is created per *run*, not per checkout slot, so a few dozen runs
 * leave a few dozen `uf/*` refs behind — and until this page the only record of
 * which ones mattered was a run detail page you had to open one at a time.
 *
 * The inventory is not polled: each row costs a git process to work out and
 * nothing in it changes on its own. The queue *does* change on its own, so it is
 * polled while it is working and the inventory is re-read once when it stops —
 * which is exactly when every state in it may have moved.
 */

/**
 * A shape per state, drawn rather than coloured.
 *
 * Four of these seven are amber or grey, so tone alone leaves them identical in
 * greyscale and to a colour-blind operator. The word is the real signal and the
 * shape is what makes a column of them scannable; neither is the colour.
 */
function Mark({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 shrink-0" aria-hidden="true">
      {children}
    </svg>
  );
}

const RING = (
  <circle cx="5" cy="5" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
);
const DISC = <circle cx="5" cy="5" r="3.4" fill="currentColor" />;
const CHECK = (
  <path
    d="m1.7 5.2 2.3 2.3 4.3-4.8"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
  />
);
const CROSS = (
  <path
    d="M2.4 2.4 7.6 7.6M7.6 2.4 2.4 7.6"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
  />
);
const DASH = (
  <path
    d="M1.6 5h6.8"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
  />
);
const SLASH_RING = (
  <g fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="5" cy="5" r="3.2" />
    <path d="M2.7 7.3 7.3 2.7" />
  </g>
);
const DIAMOND = (
  <path d="M5 1.2 8.8 5 5 8.8 1.2 5z" fill="currentColor" />
);
const TRIANGLE = <path d="M2.4 1.6 8.4 5l-6 3.4z" fill="currentColor" />;

/** The branch's own state, before the queue has any say in it. */
function StateBadge({ b }: { b: BranchSummaryDTO }) {
  if (!b.exists)
    return (
      <Badge>
        <Mark>{DASH}</Mark>gone
      </Badge>
    );
  if (b.active)
    return (
      <Badge tone="accent">
        <Mark>{DISC}</Mark>still running
      </Badge>
    );
  if (b.merged)
    return (
      <Badge tone="ok">
        <Mark>{CHECK}</Mark>merged
      </Badge>
    );
  // Squashing rewrites the commits, so git sees no ancestry — this is the only
  // thing that distinguishes "landed as one commit" from "never landed".
  if (b.landedUnchanged)
    return (
      <Badge tone="ok">
        <Mark>{CHECK}</Mark>squashed in
      </Badge>
    );
  if (!b.target)
    return (
      <Badge tone="warn">
        <Mark>{SLASH_RING}</Mark>no target
      </Badge>
    );
  return (
    <Badge tone="warn">
      <Mark>{RING}</Mark>unmerged
    </Badge>
  );
}

/**
 * Whether this branch can be put in the queue at all.
 *
 * Structural only, deliberately: whether it can be *landed* is decided at its
 * turn, from git, because the branches ahead of it change that answer. A run
 * that is still going is offered too — it may well have finished by the time
 * the queue reaches it, and if it has not, that row says so.
 */
const queueable = (b: BranchSummaryDTO) =>
  b.exists && !!b.target && !b.merged && !b.landedUnchanged && b.ahead > 0;

const ITEM_ACTIVE: MergeQueueItemDTO["status"][] = [
  "queued",
  "landing",
  "resolving",
];

const ITEM_TONE: Record<MergeQueueItemDTO["status"], BadgeTone> = {
  queued: "neutral",
  landing: "accent",
  resolving: "accent",
  landed: "ok",
  failed: "danger",
  skipped: "warn",
  cancelled: "neutral",
};

const ITEM_LABEL: Record<MergeQueueItemDTO["status"], string> = {
  queued: "waiting",
  landing: "landing",
  resolving: "resolving",
  landed: "landed",
  failed: "failed",
  skipped: "skipped",
  cancelled: "cancelled",
};

const ITEM_MARK: Record<MergeQueueItemDTO["status"], ReactNode> = {
  queued: RING,
  landing: TRIANGLE,
  resolving: DIAMOND,
  landed: CHECK,
  failed: CROSS,
  skipped: DASH,
  cancelled: SLASH_RING,
};

/**
 * The step number's own ring. Redundant with the badge beside it, on purpose.
 *
 * The item in flight is the one filled in, so the eye lands on where the queue
 * has got to. Nothing is dimmed to achieve that: a failed or skipped row is
 * the row that needs a person, and fading it would be the exact wrong emphasis.
 */
const STEP_RING: Record<MergeQueueItemDTO["status"], string> = {
  queued: "border-line-strong text-ink-muted",
  landing: "border-accent bg-accent-dim text-accent",
  resolving: "border-accent bg-accent-dim text-accent",
  landed: "border-ok text-ok",
  failed: "border-danger text-danger",
  skipped: "border-warn text-warn",
  cancelled: "border-line-strong text-ink-muted",
};

/**
 * What this row is waiting on, as the situation rather than the mechanism.
 *
 * A branch behind another, a branch that conflicts, and a branch the queue
 * never reached are three different sentences: only the first is about the
 * queue's order, only the second is about this branch, and the third is about
 * the repository. The worker writes a message for the last two; the first has
 * none to write, because nothing has happened to it yet.
 */
function stepNote(item: MergeQueueItemDTO, ahead: number): string | null {
  if (item.status === "queued") {
    if (ahead === 0) return "Next to be landed";
    return `Waiting behind ${ahead} branch${ahead === 1 ? "" : "es"}`;
  }
  if (item.message) return item.message;
  if (item.status === "landing") return "Merging it into its target now";
  if (item.status === "resolving")
    return "Claude is resolving the conflict, on this branch, in a throwaway checkout";
  return null;
}

/** "2 landed · 1 left for you · 3 waiting", zeros left out. */
function queueSummary(items: MergeQueueItemDTO[]): string {
  const count = (s: MergeQueueItemDTO["status"]) =>
    items.filter((i) => i.status === s).length;
  const parts: string[] = [];
  const landed = count("landed");
  const working = count("landing") + count("resolving");
  const waiting = count("queued");
  const failed = count("failed");
  const skipped = count("skipped");
  const cancelled = count("cancelled");
  if (landed) parts.push(`${landed} landed`);
  if (working) parts.push(`${working} in flight`);
  if (waiting) parts.push(`${waiting} waiting`);
  if (failed) parts.push(`${failed} left for you`);
  if (skipped) parts.push(`${skipped} not attempted`);
  if (cancelled) parts.push(`${cancelled} cancelled`);
  return parts.join(" · ");
}

function QueueStep({
  item,
  ahead,
  last,
}: {
  item: MergeQueueItemDTO;
  ahead: number;
  last: boolean;
}) {
  const note = stepNote(item, ahead);

  return (
    <li className="flex gap-3">
      {/* The rail is the one rule on this card, and it is the sequence itself:
          these branches land in this order and each one changes the base for
          the next. */}
      <div className="flex w-5 shrink-0 flex-col items-center">
        <span
          className={`flex h-5 w-5 items-center justify-center rounded-full border text-2xs font-semibold tabular-nums transition-colors duration-200 ${STEP_RING[item.status]}`}
        >
          {item.position + 1}
        </span>
        {!last && <span aria-hidden="true" className="w-px flex-1 bg-line" />}
      </div>

      <div className="min-w-0 flex-1 pb-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            href={`/runs/${item.runId}`}
            className="mono max-w-[44ch] truncate font-medium"
            title={item.branch ?? item.runId}
          >
            {item.branch ?? item.runId.slice(0, 8)}
          </Link>
          {item.target && (
            <span className="mono whitespace-nowrap text-ink-muted">
              → {item.target}
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            {item.resolveCostUSD > 0 && (
              <span
                className="tabular-nums text-xs text-ink-muted"
                title="What resolving this branch's conflict cost"
              >
                {fmtUSD(item.resolveCostUSD)}
              </span>
            )}
            <Badge tone={ITEM_TONE[item.status]}>
              <Mark>{ITEM_MARK[item.status]}</Mark>
              {ITEM_LABEL[item.status]}
            </Badge>
          </span>
        </div>
        {note && (
          <div className="mt-0.5 text-xs leading-snug text-ink-muted">{note}</div>
        )}
      </div>
    </li>
  );
}

/**
 * How many branches each row is waiting behind, counted across every batch.
 *
 * One press of Land is one batch and the worker is one queue, so a row's real
 * wait is everything unfinished above it — including the batch queued for
 * another repository ten minutes ago. Counting within the batch would tell the
 * second press of Land it was next when five merges stood in front of it.
 */
function aheadByItem(batches: MergeQueueBatchDTO[]): Map<string, number> {
  const ahead = new Map<string, number>();
  let unfinished = 0;
  for (const batch of batches) {
    for (const item of batch.items) {
      ahead.set(item.id, unfinished);
      if (ITEM_ACTIVE.includes(item.status)) unfinished++;
    }
  }
  return ahead;
}

/**
 * The queue, one group per press of Land.
 *
 * Grouped rather than run together because Cancel is per batch — `cancelBatch`
 * is scoped by `batch_id`, and a button that stopped some other press of Land's
 * branches would be worse than the one that could only reach the newest. The
 * summary above the groups is the whole queue's, since that is the number the
 * operator is actually waiting on; each group carries only what identifies it
 * and the button that stops it.
 */
function QueuePanel({
  queue,
  onCancel,
  busy,
}: {
  queue: MergeQueueDTO;
  onCancel: (batchId: string) => void;
  busy: boolean;
}) {
  const items = queue.batches.flatMap((b) => b.items);
  const spent = items.reduce((n, i) => n + i.resolveCostUSD, 0);
  const active = items.some((i) => ITEM_ACTIVE.includes(i.status));
  const ahead = aheadByItem(queue.batches);

  return (
    <Card className="mb-4">
      <CardTitle>
        Merge queue
        {active && (
          <Badge tone="accent">
            <Spinner /> working
          </Badge>
        )}
        {spent > 0 && <Badge>{fmtUSD(spent)} on conflicts</Badge>}
      </CardTitle>

      <p className="mb-3 text-sm text-ink-muted" aria-live="polite">
        {queueSummary(items)}
        {active && (
          <span className="text-ink-muted">
            {" — "}one at a time, each re-checked against git at its own turn
          </span>
        )}
      </p>

      {queue.batches.map((batch) => {
        const waiting = batch.items.filter((i) => i.status === "queued").length;
        return (
          <section
            key={batch.batchId}
            className="border-t border-line pt-3 first:border-0 first:pt-0"
          >
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-xs text-ink-muted">
                Queued {fmtDateTime(batch.createdAt)}
              </span>
              {waiting > 0 && (
                <Button
                  variant="ghost"
                  className="ml-auto min-w-[144px]"
                  onClick={() => onCancel(batch.batchId)}
                  disabled={busy}
                >
                  Cancel {waiting} waiting
                </Button>
              )}
            </div>

            <ol>
              {batch.items.map((item, i) => (
                <QueueStep
                  key={item.id}
                  item={item}
                  ahead={ahead.get(item.id) ?? 0}
                  last={i === batch.items.length - 1}
                />
              ))}
            </ol>
          </section>
        );
      })}
    </Card>
  );
}

function SkeletonBar({ className = "" }: { className?: string }) {
  return <div className={`h-3 rounded-full bg-line ${className}`} />;
}

/** Placeholder rows in the real grid, so nothing jumps when the read lands. */
function SkeletonRows() {
  return (
    <>
      {["a", "b", "c"].map((key) => (
        <Tr key={key}>
          <Td aria-hidden="true">
            <SkeletonBar className="w-4" />
          </Td>
          <Td aria-hidden="true">
            <SkeletonBar className="w-16" />
          </Td>
          <Td aria-hidden="true">
            <SkeletonBar className="w-[54%]" />
            <SkeletonBar className="mt-3 w-[34%]" />
          </Td>
          <Td aria-hidden="true">
            <SkeletonBar className="w-16" />
          </Td>
          <Td aria-hidden="true">
            <SkeletonBar className="w-12" />
          </Td>
          <Td aria-hidden="true">
            <SkeletonBar className="ml-auto w-6" />
          </Td>
          <Td aria-hidden="true">
            <SkeletonBar className="ml-auto w-16" />
          </Td>
          <Td aria-hidden="true">
            <SkeletonBar className="ml-auto w-20" />
          </Td>
        </Tr>
      ))}
    </>
  );
}

export default function Branches() {
  const [data, setData] = useState<BranchInventoryDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  // The one row a purge is armed for. Destroying committed work takes two
  // presses, and arming a second row disarms the first.
  const [armedPurge, setArmedPurge] = useState<string | null>(null);
  // Selection order is the merge order, so this is a list and not a Set.
  const [selected, setSelected] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<"merge" | "squash">("merge");
  const [autoResolve, setAutoResolve] = useState(true);
  const [queue, setQueue] = useState<MergeQueueDTO | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);

  /**
   * Both reads used to drop a non-ok answer on the floor and neither had a
   * `catch`. A signed-out session or a restarting container therefore left the
   * inventory frozen — indistinguishable from a machine with no branches on it
   * — and left the queue's last known state standing while it advanced behind
   * the page's back. One message for both: they fail together far more often
   * than separately, and both mean the same thing to the person reading it.
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/branches", { cache: "no-store" });
      // Parsed before the status check: a 500 carries no JSON, and letting that
      // throw would report a reachable server as an unreachable one.
      const json = (await res.json().catch(() => ({}))) as Partial<
        BranchInventoryDTO & { error: string }
      >;
      if (!res.ok || !json.branches) {
        const detail =
          json.error ?? (res.ok ? "no branches in the response" : null);
        setReadError(pollFailureMessage(res.status, detail));
        return;
      }
      setData(json as BranchInventoryDTO);
      setStrategy(json.defaultStrategy ?? "merge");
      setReadError(null);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      setReadError(pollFailureMessage(null, cause));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadQueue = useCallback(async () => {
    try {
      const res = await fetch("/api/branches/queue", { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as Partial<
        MergeQueueDTO & { error: string }
      >;
      if (!res.ok || !json.batches) {
        const detail =
          json.error ?? (res.ok ? "no queue in the response" : null);
        setReadError(pollFailureMessage(res.status, detail));
        return;
      }
      setQueue(json as MergeQueueDTO);
      setReadError(null);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      setReadError(pollFailureMessage(null, cause));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadQueue();
  }, [load, loadQueue]);

  const queueItems = useMemo(
    () => (queue?.batches ?? []).flatMap((b) => b.items),
    [queue],
  );

  const queueActive =
    !!queue &&
    (queue.working || queueItems.some((i) => ITEM_ACTIVE.includes(i.status)));

  useEffect(() => {
    if (!queueActive) return;
    const t = setInterval(() => void loadQueue(), 3000);
    return () => clearInterval(t);
  }, [queueActive, loadQueue]);

  // Every state in the inventory can have moved by the time the queue stops, and
  // it is far too expensive to poll alongside it. Re-read it once, on the edge.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !queueActive) void load();
    wasActive.current = queueActive;
  }, [queueActive, load]);

  /**
   * Runs the queue still expects to touch. A branch of one of these is not
   * offered for selection again — `enqueue` refuses it by name, and finding
   * that out from a red banner after pressing Land is a worse way to learn it.
   */
  const inQueue = useMemo(
    () =>
      new Set(
        queueItems
          .filter((i) => ITEM_ACTIVE.includes(i.status))
          .map((i) => i.runId),
      ),
    [queueItems],
  );

  /**
   * One row, one action.
   *
   * `commit` sends no message: the run's own task becomes the subject, which is
   * what the run page's field defaults to as well. `purge` echoes the branch
   * name back, which is what the API compares against the row before it deletes
   * anything.
   *
   * Through `jsonRequest` rather than a bare `fetch` for the reason the two
   * reads above have a `catch`: a rejection out of this handler rendered
   * nothing, re-enabled the button and left the table as it was, which is
   * exactly what a press that did nothing looks like — and one of these three
   * destroys committed work, so a second press is a real hazard.
   */
  async function act(b: BranchSummaryDTO, action: "delete" | "commit" | "purge") {
    setBusy(b.runId);
    setNote(null);
    setError(null);
    try {
      const res = await jsonRequest<{ message?: string }>(
        `/api/runs/${b.runId}/land`,
        { method: "POST", body: { action, confirmBranch: b.branch } },
      );
      if (res.ok) setNote(res.data.message ?? "Done.");
      else setError(actionFailureMessage(res, "That did not work."));
      setArmedPurge(null);
      // Re-read either way: a request that never came back may still have been
      // carried out, and the table is where the operator finds out.
      await load();
    } finally {
      setBusy(null);
    }
  }

  function toggle(runId: string) {
    setSelected((prev) =>
      prev.includes(runId) ? prev.filter((id) => id !== runId) : [...prev, runId],
    );
  }

  async function queueSelected() {
    setQueueBusy(true);
    setNote(null);
    setError(null);
    try {
      const res = await jsonRequest<{ queued?: number }>("/api/branches/queue", {
        method: "POST",
        body: { runIds: selected, strategy, autoResolve },
      });
      // The selection survives every failure, transport included: it is the
      // merge order, and clearing it after a press that may not have gone
      // through is a set of branches the operator has to pick out again.
      if (res.ok) {
        const { queued } = res.data;
        setNote(`Queued ${queued} branch${queued === 1 ? "" : "es"}.`);
        setSelected([]);
      } else {
        setError(actionFailureMessage(res, "Could not queue those."));
      }
      await loadQueue();
    } finally {
      setQueueBusy(false);
    }
  }

  // Takes the batch it is cancelling rather than reading the newest one off the
  // queue: several presses of Land can be outstanding at once, and each group
  // has its own button.
  async function cancelQueue(batchId: string) {
    setQueueBusy(true);
    setNote(null);
    setError(null);
    try {
      const res = await jsonRequest<{ cancelled?: number }>("/api/branches/queue", {
        method: "DELETE",
        body: { batchId },
      });
      // The answer used to be dropped whole, so a cancel that failed left the
      // queue panel standing with every row still in it and nothing said.
      if (!res.ok) setError(actionFailureMessage(res, "Could not cancel that."));
      await loadQueue();
    } finally {
      setQueueBusy(false);
    }
  }

  const branches = data?.branches ?? [];

  return (
    <>
      <div className="mb-6">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">Branches</h1>
        <p className="max-w-[68ch] text-ink-muted">
          One row per branch, listed against the last run on it. Pick several to
          land them one after another, or open a run to preview its merge first
          — each landing changes the base for the one behind it, so they go
          through in the order you choose them.
        </p>
      </div>

      {/* Both regions are in the DOM whether or not they hold anything, so the
          sentence is announced when it arrives rather than only when something
          else moves focus. */}
      <div role="status" aria-live="polite">
        {note && <Notice tone="info">{note}</Notice>}
      </div>
      <div role="alert">
        {readError && <Notice tone="danger">{readError}</Notice>}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>

      {queue && queue.batches.length > 0 && (
        <QueuePanel queue={queue} onCancel={cancelQueue} busy={queueBusy} />
      )}

      {data && data.notShown > 0 && (
        <Notice tone="warn">
          <strong>{data.notShown} older branches are not listed.</strong> Working
          out how far each one is ahead costs a git call, so this page stops at
          the most recent 60.
        </Notice>
      )}

      <Card>
        <CardTitle>
          {branches.length} branch{branches.length === 1 ? "" : "es"}
          <Button
            variant="secondary"
            className="ml-auto min-w-[104px]"
            onClick={load}
            disabled={loading}
          >
            {loading ? "Reading…" : "Refresh"}
          </Button>
        </CardTitle>

        {loading && !data ? (
          <div aria-busy="true">
            <span className="sr-only">Reading repositories…</span>
            <BranchTable branches={[]} loading />
          </div>
        ) : !data ? (
          // "No branches yet" is a claim about the machine, and making it off
          // the back of a failed read is the same lie the notice above exists
          // to stop.
          <Empty>
            <span className="text-ink-muted">
              Nothing could be read from the repositories.
            </span>
          </Empty>
        ) : branches.length === 0 ? (
          <Empty>
            <div className="font-medium text-ink">No branches yet</div>
            <div className="mx-auto mt-1 max-w-[52ch] text-ink-muted">
              A run given its own checkout puts its work on a branch, and it
              appears here for you to land. A run that works directly in your
              folder never makes one.
            </div>
            <div className="mt-3">
              <Link href="/runs/new">Start a run</Link>
            </div>
          </Empty>
        ) : (
          <BranchTable
            branches={branches}
            selected={selected}
            inQueue={inQueue}
            busy={busy}
            armedPurge={armedPurge}
            onToggle={toggle}
            onArm={setArmedPurge}
            onAct={act}
          />
        )}
      </Card>

      {selected.length > 0 && (
        <>
          {/* The bar is fixed, so nothing above it moves as rows are ticked —
              the row you are aiming at stays where your eye left it. This
              reserves the height it covers at the foot of the page. */}
          <div aria-hidden="true" className="h-28" />
          <div
            role="region"
            aria-label="Selected branches"
            // Fixed, so it is positioned against the viewport rather than the
            // content pane — which means it has to step around the source list
            // itself. `--sidebar-w` follows the collapse, so this does too.
            className="fixed right-0 bottom-0 left-[var(--sidebar-w)] z-30 border-t border-line bg-surface shadow-bar"
          >
            <div className="mx-auto flex max-w-shell flex-wrap items-center gap-x-5 gap-y-3 px-5 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink">
                  {selected.length} branch{selected.length === 1 ? "" : "es"}{" "}
                  selected
                </div>
                <div className="text-xs text-ink-muted">
                  They land one after another, in the order you picked
                </div>
              </div>

              <div className="w-[34ch] max-w-full">
                <Toggle
                  id="auto-resolve"
                  checked={autoResolve}
                  onChange={setAutoResolve}
                  label="Have Claude resolve conflicts"
                />
                <div
                  className={`mt-1 text-xs leading-snug ${
                    autoResolve ? "text-warn" : "text-ink-muted"
                  }`}
                >
                  {autoResolve
                    ? "Spends against the same 5-hour window your runs do, unattended — on the run's branch, never in yours"
                    : "A branch that conflicts is left alone and the queue carries on to the next"}
                </div>
              </div>

              <ButtonRow className="ml-auto">
                <select
                  className="w-auto rounded-sm border border-line bg-inset px-2.5 py-2 text-sm text-ink"
                  value={strategy}
                  onChange={(e) =>
                    setStrategy(e.target.value as "merge" | "squash")
                  }
                  aria-label="How to land them"
                >
                  <option value="merge">Merge, keeping their commits</option>
                  <option value="squash">Squash each into one commit</option>
                </select>
                <Button
                  onClick={queueSelected}
                  disabled={queueBusy}
                  className="min-w-[140px]"
                >
                  {queueBusy
                    ? "Queueing…"
                    : `Land ${selected.length} branch${selected.length === 1 ? "" : "es"}`}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setSelected([])}
                  disabled={queueBusy}
                >
                  Clear
                </Button>
              </ButtonRow>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/**
 * The inventory.
 *
 * State leads, because it is the question the page is opened with; the branch
 * and the task it came from identify the row; the two mono columns and the two
 * figures are what get compared across rows. Every width but the branch's is
 * fixed, and the branch column absorbs the slack — so a value that grows on a
 * re-read cannot move a column edge.
 */
function BranchTable({
  branches,
  loading = false,
  selected = [],
  inQueue,
  busy = null,
  armedPurge = null,
  onToggle,
  onArm,
  onAct,
}: {
  branches: BranchSummaryDTO[];
  loading?: boolean;
  selected?: string[];
  inQueue?: Set<string>;
  busy?: string | null;
  armedPurge?: string | null;
  onToggle?: (runId: string) => void;
  onArm?: (runId: string | null) => void;
  onAct?: (b: BranchSummaryDTO, action: "delete" | "commit" | "purge") => void;
}) {
  return (
    <TableWrap>
      <Table>
        <caption className="sr-only">
          Every branch an isolated run has made, newest first
        </caption>
        <thead>
          <tr>
            <Th scope="col" className="w-[56px]">
              <span className="sr-only">Land</span>
            </Th>
            <Th scope="col" className="w-[140px]">
              State
            </Th>
            <Th scope="col" className="w-full">
              Branch
            </Th>
            <Th scope="col" className="w-[120px]">
              Repository
            </Th>
            <Th scope="col" className="w-[120px]">
              Lands into
            </Th>
            <Th
              scope="col"
              num
              className="w-[76px]"
              title="Commits this branch has that the branch it lands into does not"
            >
              Ahead
            </Th>
            <Th scope="col" num className="w-[112px]">
              Created
            </Th>
            <Th scope="col" num className="w-[176px]">
              Actions
            </Th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <SkeletonRows />
          ) : (
            branches.map((b) => {
              const order = selected.indexOf(b.runId);
              const queued = inQueue?.has(b.runId) ?? false;
              const working = busy === b.runId;

              return (
                <Tr
                  key={b.branch}
                  className="transition-colors duration-150 hover:bg-inset focus-within:bg-inset"
                >
                  <Td className="align-top">
                    {queueable(b) ? (
                      // The negative margin buys a 32px hit target without
                      // changing what the cell occupies.
                      <label
                        className={`-m-2 flex w-max items-center gap-1.5 p-2 ${
                          queued ? "cursor-not-allowed" : "cursor-pointer"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-50"
                          checked={order >= 0}
                          disabled={queued}
                          onChange={() => onToggle?.(b.runId)}
                          aria-label={
                            queued
                              ? `${b.branch} is already in the merge queue`
                              : `Land ${b.branch}`
                          }
                          title={
                            queued ? "Already in the merge queue" : undefined
                          }
                        />
                        {/* Fixed width whether or not it holds a number, so
                            ticking a box moves nothing. */}
                        <span
                          aria-hidden="true"
                          className="w-3 text-right text-2xs font-semibold tabular-nums text-accent"
                        >
                          {order >= 0 ? order + 1 : ""}
                        </span>
                      </label>
                    ) : null}
                  </Td>

                  <Td className="align-top">
                    <StateBadge b={b} />
                    {/* Work in the checkout, not on the branch. A run that could
                        not commit reads as "unmerged, 0 ahead", which looks like
                        a run that did nothing. */}
                    {!!b.uncommitted && (
                      <div
                        className="mt-1 text-2xs font-semibold uppercase tracking-wide text-warn"
                        title="Changed paths in the run's own checkout, not on the branch"
                      >
                        {b.uncommitted} uncommitted
                      </div>
                    )}
                  </Td>

                  <Td className="align-top">
                    <Link
                      href={`/runs/${b.runId}`}
                      className="mono block max-w-[40ch] truncate font-medium"
                      title={b.branch}
                    >
                      {b.branch}
                    </Link>
                    <div
                      className="mt-0.5 max-w-[40ch] truncate text-xs text-ink-muted"
                      title={b.prompt}
                    >
                      {b.prompt}
                    </div>
                  </Td>

                  <Td className="align-top">
                    <div className="mono max-w-[16ch] truncate" title={b.repoLabel}>
                      {b.repoLabel}
                    </div>
                  </Td>

                  <Td className="align-top">
                    <div
                      className="mono max-w-[16ch] truncate"
                      title={b.target ?? "This branch has no recorded target"}
                    >
                      {b.target ?? "—"}
                    </div>
                  </Td>

                  <Td num className="align-top">
                    {b.exists ? b.ahead : "—"}
                  </Td>

                  <Td num className="whitespace-nowrap align-top text-ink-muted">
                    {fmtDateTime(b.createdAt)}
                  </Td>

                  <Td className="align-top">
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      {/* Puts what the agent wrote onto the branch, under the
                          run's own task as the subject. Also what frees the
                          checkout slot: one with work in it is not reusable. */}
                      {b.exists && !b.active && !!b.uncommitted && (
                        <Button
                          variant="secondary"
                          className="min-w-[92px]"
                          onClick={() => onAct?.(b, "commit")}
                          disabled={working}
                        >
                          {working ? "Working…" : "Commit"}
                        </Button>
                      )}

                      {/* Delete is the safe door — git can see the work is in
                          the target. Purge is the other one, and it takes a
                          second press that names what goes with it. */}
                      {b.exists && (b.merged || b.landedUnchanged) && !b.active ? (
                        <Button
                          variant="ghost"
                          className="min-w-[92px]"
                          onClick={() => onAct?.(b, "delete")}
                          disabled={working}
                        >
                          {working ? "Deleting…" : "Delete"}
                        </Button>
                      ) : b.exists && !b.active ? (
                        armedPurge === b.runId ? (
                          <>
                            <Button
                              variant="ghost"
                              onClick={() => onArm?.(null)}
                              disabled={working}
                            >
                              Cancel
                            </Button>
                            <Button
                              variant="danger"
                              className="min-w-[136px]"
                              title="Deletes the branch and its checkout. Nothing on it is recoverable afterwards."
                              onClick={() => onAct?.(b, "purge")}
                              disabled={working}
                            >
                              {working
                                ? "Purging…"
                                : `Purge ${b.ahead} commit${b.ahead === 1 ? "" : "s"}`}
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="ghost"
                            onClick={() => onArm?.(b.runId)}
                            disabled={working}
                          >
                            Purge
                          </Button>
                        )
                      ) : (
                        <Link
                          href={`/runs/${b.runId}`}
                          className="inline-flex items-center rounded-sm px-3 py-2 text-sm font-medium text-ink-muted no-underline transition-colors duration-150 hover:bg-inset hover:text-ink hover:no-underline"
                        >
                          Open run
                        </Link>
                      )}
                    </div>
                  </Td>
                </Tr>
              );
            })
          )}
        </tbody>
      </Table>
    </TableWrap>
  );
}
