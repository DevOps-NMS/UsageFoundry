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
  CheckoutStoreDTO,
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
import {
  Card,
  type CardEmphasis,
  CardTitle,
  Empty,
  SkeletonText,
} from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Log";
import { Field, Select, Toggle } from "@/components/ui/Field";
import {
  TBody,
  THead,
  Table,
  TableWrap,
  Td,
  Th,
  Tr,
} from "@/components/ui/Table";

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
 * polled, and the inventory is re-read once when it stops — which is exactly
 * when every state in it may have moved.
 *
 * The queue is polled **whatever it last said**, slowly while it is idle and
 * every few seconds while it is working. Gating the interval on "something in
 * the last answer was active" made an idle queue an absorbing state: with no
 * interval running nothing fetched a newer answer, so nothing could ever say
 * the queue had started again, and the only thing that could restart it was a
 * press of Land in *this* tab. A merge block in a workflow queues branches
 * directly, and so does a second tab — both of those advanced, failed and
 * landed with this page frozen on whatever it happened to be showing, which is
 * the shape of "the statuses never update even when the merge succeeds". The
 * same freeze followed a single failed read on load, since the mount effect
 * runs once. The idle tick is what makes the answer eventually true rather than
 * eventually stale; it is one `GROUP BY` and no git.
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

/** How often the queue is re-read while the worker is on it. */
const QUEUE_POLL_MS = 3_000;
/**
 * And while it is not.
 *
 * Slower rather than absent, because what this tick is for is queue activity
 * this tab did not start — a workflow's merge block, another tab, another
 * server sharing the table. Nothing here costs a git process; the inventory
 * beside it does, and is still read only on the edge.
 */
const QUEUE_IDLE_POLL_MS = 15_000;

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
 * How many branches each row is waiting behind — across every batch, within its
 * own repository.
 *
 * Both halves are load-bearing and they were arrived at separately. One press of
 * Land is one batch, so counting within the batch would tell the second press it
 * was next when five merges stood in front of it. And the queue is drained one
 * worker *per repository*, so counting across repositories would say the
 * opposite — sixth in line for a branch that is about to land.
 */
function aheadByItem(batches: MergeQueueBatchDTO[]): Map<string, number> {
  const ahead = new Map<string, number>();
  const unfinished = new Map<string, number>();
  for (const batch of batches) {
    for (const item of batch.items) {
      const repo = item.repo ?? "";
      ahead.set(item.id, unfinished.get(repo) ?? 0);
      if (ITEM_ACTIVE.includes(item.status)) {
        unfinished.set(repo, (unfinished.get(repo) ?? 0) + 1);
      }
    }
  }
  return ahead;
}

/**
 * One press of Land: when it was queued, what it is doing, and the button that
 * stops it.
 *
 * Shared by the panel and the history below it so a past batch reads exactly
 * like a present one — the difference between the two is which list it is in,
 * not how it is drawn. `onCancel` is absent for a finished batch because there
 * is nothing left in it to cancel, which is also why the history never needs
 * `aheadByItem`: nothing in it is waiting behind anything.
 */
function QueueBatchSection({
  batch,
  ahead,
  summary = true,
  onCancel,
  busy = false,
}: {
  batch: MergeQueueBatchDTO;
  ahead?: Map<string, number>;
  /**
   * Off where the card's own line above already says it. That line covers every
   * batch on the panel, so with one batch there the two are the same sentence
   * twice, six pixels apart.
   */
  summary?: boolean;
  onCancel?: (batchId: string) => void;
  busy?: boolean;
}) {
  const waiting = batch.items.filter((i) => i.status === "queued").length;
  return (
    // A div, not a <section> — the same rule Card records being bitten by. The
    // legacy layer still carries `section + section { margin-top: 24px }`
    // (globals.css:621), which fired between two sibling batches and added 24px
    // nobody wrote on top of the hairline and padding this row states itself.
    <div className="border-t border-line pt-3 first:border-0 first:pt-0">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs text-ink-muted">
          Queued {fmtDateTime(batch.createdAt)}
        </span>
        {summary && (
          <span className="text-xs text-ink-faint">
            {queueSummary(batch.items)}
          </span>
        )}
        {onCancel && waiting > 0 && (
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
            ahead={ahead?.get(item.id) ?? 0}
            last={i === batch.items.length - 1}
          />
        ))}
      </ol>
    </div>
  );
}

/**
 * The card rises while the worker is on it, and settles back afterwards.
 *
 * No card on this page declared an emphasis, so the one thing here that is
 * changing on its own — branches being merged into somebody's target, right
 * now — read as a peer of a static pressure gauge beside it. The chat's
 * proposal card already makes exactly this conditional, so this is that
 * decision applied a second time rather than a new one.
 */
const QUEUE_EMPHASIS: Record<"working" | "idle", CardEmphasis> = {
  working: "primary",
  idle: "default",
};

/**
 * The queue, one group per press of Land — and the earlier presses behind a
 * disclosure.
 *
 * Grouped rather than run together because Cancel is per batch — `cancelBatch`
 * is scoped by `batch_id`, and a button that stopped some other press of Land's
 * branches would be worse than the one that could only reach the newest. The
 * summary above the groups is the whole queue's, since that is the number the
 * operator is actually waiting on; each group carries only what identifies it
 * and the button that stops it.
 *
 * **What is open and what is closed is a safety rule, not a preference.** The
 * card carried every outstanding batch plus the last three that finished, and a
 * batch is as many rows as branches were selected — thirty rows of finished work
 * standing over the branch table on a live install, permanently, and the fourth
 * batch back gone for good. So the finished ones moved behind `<details>`. What
 * did *not* move is every batch the worker still owes an answer for: it drains
 * the whole table rather than one batch, so one it is still merging must be on
 * screen without anybody opening anything — that is `selectQueueBatches`' whole
 * reason to exist, and putting it one press away would be the same defect with a
 * disclosure in front of it.
 */
function QueuePanel({
  queue,
  history,
  historyOpen,
  onToggleHistory,
  onCancel,
  busy,
}: {
  queue: MergeQueueDTO;
  history: MergeQueueBatchDTO[] | null;
  historyOpen: boolean;
  onToggleHistory: (open: boolean) => void;
  onCancel: (batchId: string) => void;
  busy: boolean;
}) {
  const items = queue.batches.flatMap((b) => b.items);
  const spent = items.reduce((n, i) => n + i.resolveCostUSD, 0);
  const active = items.some((i) => ITEM_ACTIVE.includes(i.status));
  const ahead = aheadByItem(queue.batches);
  const notListed = history ? queue.historyCount - history.length : 0;

  return (
    <Card emphasis={QUEUE_EMPHASIS[active ? "working" : "idle"]} className="mb-4">
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

      {queue.batches.map((batch) => (
        <QueueBatchSection
          key={batch.batchId}
          batch={batch}
          ahead={ahead}
          summary={queue.batches.length > 1}
          onCancel={onCancel}
          busy={busy}
        />
      ))}

      {/* The one controlled fold in the app, and the reason the pair exists:
          opening it fetches. This card polls every three seconds while the
          worker runs, so the *closed* case has to stay the cheap one — an
          always-rendered-and-hidden history would make an idle install pay for
          it on every tick. `count` is deliberately not used: the summary is a
          sentence about presses of Land rather than a phrase with a number
          after it. */}
      {queue.historyCount > 0 && (
        <Disclosure
          className="mt-3 border-t border-line pt-3"
          summaryClassName="text-sm text-ink-muted"
          open={historyOpen}
          onToggle={onToggleHistory}
          summary={
            queue.historyCount === 1
              ? "1 earlier press of Land"
              : `${queue.historyCount} earlier presses of Land`
          }
        >
          {/* Newest first here and drain order above: what is at the top of the
              panel is what lands next, and nothing in this list is going to
              land. */}
          <div className="mt-3">
            {history === null ? (
              <SkeletonText lines={2} />
            ) : (
              history.map((batch) => (
                <QueueBatchSection key={batch.batchId} batch={batch} />
              ))
            )}
            {notListed > 0 && (
              <p className="mt-3 text-xs text-ink-faint">
                {notListed} older {notListed === 1 ? "batch is" : "batches are"}{" "}
                recorded and not listed here.
              </p>
            )}
          </div>
        </Disclosure>
      )}
    </Card>
  );
}

/**
 * Checkout slots, which is what decides whether the next isolated run starts.
 *
 * A run that asks for its own checkout and cannot have one is **refused** — it
 * is not quietly moved into your own checkout, which is what it used to do —
 * so the number that matters on this page is not the branch count but the slots
 * behind it. A checkout holding uncommitted work is retired until somebody
 * deals with it and nothing reclaims one on its own, so this is a figure that
 * only goes one way.
 *
 * Shown only when there is something to act on: every slot free or in use is
 * the healthy state and needs no row. One retired checkout brings the table up,
 * which is a long way before the last slot goes.
 */
function CheckoutStores({ stores }: { stores: CheckoutStoreDTO[] }) {
  const notable = stores.filter(
    (s) => s.dirty.length > 0 || s.free === 0 || s.free === null,
  );
  if (notable.length === 0) return null;
  const exhausted = notable.filter((s) => s.free === 0);

  return (
    // Quiet: a pressure gauge, read once when a run is refused a checkout. The
    // queue above it is the card this page is opened for.
    <Card emphasis="quiet" className="mb-4">
      <CardTitle>Checkout slots</CardTitle>
      {exhausted.length > 0 && (
        <Notice tone="danger">
          <strong>
            {exhausted.length === 1
              ? `${exhausted[0].repoLabel} has no checkout left.`
              : `${exhausted.length} repositories have no checkout left.`}
          </strong>{" "}
          An isolated run there is refused rather than started in your own
          checkout. Commit or purge what the checkouts below hold to free them.
        </Notice>
      )}
      <TableWrap>
        <Table stack>
          <THead>
            <Tr>
              <Th>Repository</Th>
              <Th num>Free</Th>
              <Th num>In use</Th>
              <Th>Holding uncommitted work</Th>
            </Tr>
          </THead>
          <TBody>
            {notable.map((s) => (
              <Tr key={s.repoRoot}>
                <Td>
                  <div className="font-medium text-ink">{s.repoLabel}</div>
                  {/* A store path has no space to wrap at, so below the
                      breakpoint it is what would push the pane sideways. */}
                  <div className="mono mt-0.5 text-xs text-ink-muted max-md:break-all">
                    {s.store}
                  </div>
                </Td>
                <Td num label="Free">
                  {s.free === null ? (
                    // Not zero. The probe cap stopped the walk, so this says
                    // nothing about how many are left.
                    <span className="text-ink-muted">not counted</span>
                  ) : (
                    <span className={s.free === 0 ? "font-medium text-danger" : ""}>
                      {s.free} of {s.ceiling}
                    </span>
                  )}
                </Td>
                <Td num label="In use">
                  {s.heldByRuns}
                </Td>
                {/* Above the value: this one is a list of checkout names, and
                    the label is four words wide before it starts. */}
                <Td label="Holding uncommitted work" labelPlacement="above">
                  {s.dirty.length === 0 ? (
                    <span className="text-ink-muted">none</span>
                  ) : (
                    <ul className="space-y-0.5">
                      {s.dirty.map((d) => (
                        <li key={d.name} className="text-xs">
                          <span className="mono">{d.name}</span>{" "}
                          <span className="text-ink-muted">
                            {d.uncommitted === null
                              ? "— could not be read"
                              : `— ${d.uncommitted} path${d.uncommitted === 1 ? "" : "s"}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </TableWrap>
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
  // Only ever true on the paid path — see the press handler on Land.
  const [confirmLand, setConfirmLand] = useState(false);
  const [queue, setQueue] = useState<MergeQueueDTO | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);

  // Held apart from `queue` rather than read off it, because the queue is
  // re-fetched every three seconds while the worker is running and that answer
  // deliberately carries no history: folded in, every poll would blank an open
  // disclosure and it would flicker back a request later.
  const [history, setHistory] = useState<MergeQueueBatchDTO[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Which slice of the inventory is being asked for. Held here rather than read
  // back off the answer so pressing Next twice in a row is two pages forward
  // and not two requests for the same one.
  const [repo, setRepo] = useState<string>("");
  const [offset, setOffset] = useState(0);

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
      const query = new URLSearchParams();
      if (repo) query.set("repo", repo);
      if (offset > 0) query.set("offset", String(offset));
      const res = await fetch(`/api/branches?${query}`, { cache: "no-store" });
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
  }, [repo, offset]);

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

  /**
   * The earlier presses of Land, read only while somebody is looking at them.
   *
   * A read failure here is deliberately *not* `setReadError`: that banner says
   * the page's own state may be stale, and this list is a log of merges that
   * already happened. Reporting it there would put a warning about the live
   * queue on screen because a history nobody is waiting on did not arrive.
   */
  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/branches/queue?history=1", {
        cache: "no-store",
      });
      const json = (await res.json().catch(() => ({}))) as Partial<MergeQueueDTO>;
      if (res.ok && json.history) setHistory(json.history);
    } catch {
      // Leaves the skeleton standing rather than claiming there is nothing
      // earlier. Opening the disclosure again asks for it again.
    }
  }, []);

  // Two effects rather than one: `load` changes identity whenever the filter or
  // the page does, and re-reading the queue for a page change would poll a route
  // this page is deliberately careful about.
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  // Keyed on the count as well as the switch, so a batch that finishes while the
  // disclosure is open moves into the list it now belongs to instead of being
  // in neither until somebody closes and reopens it.
  useEffect(() => {
    if (!historyOpen) return;
    void loadHistory();
  }, [historyOpen, queue?.historyCount, loadHistory]);

  const queueItems = useMemo(
    () => (queue?.batches ?? []).flatMap((b) => b.items),
    [queue],
  );

  const queueActive =
    !!queue &&
    (queue.working || queueItems.some((i) => ITEM_ACTIVE.includes(i.status)));

  useEffect(() => {
    const t = setInterval(
      () => void loadQueue(),
      queueActive ? QUEUE_POLL_MS : QUEUE_IDLE_POLL_MS,
    );
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
        <QueuePanel
          queue={queue}
          history={history}
          historyOpen={historyOpen}
          onToggleHistory={setHistoryOpen}
          onCancel={cancelQueue}
          busy={queueBusy}
        />
      )}

      {/* Above the table rather than in it: a repository with no slot left
          refuses the next isolated run on it, which is a fact about the machine
          and not about any branch on this page. The count of branches this page
          does not show is the pager's job now — it says which sixty of how many
          are listed, where this notice could only say that some were missing. */}
      {data && <CheckoutStores stores={data.checkouts ?? []} />}

      {/* Stated rather than left to the component's own fallback, so the three
          cards on this page read as one decision about which of them leads. */}
      <Card emphasis="default">
        <CardTitle>
          {data ? `${data.total} branch${data.total === 1 ? "" : "es"}` : "Branches"}
          <Button
            variant="secondary"
            className="ml-auto min-w-[104px]"
            onClick={load}
            disabled={loading}
          >
            {loading ? "Reading…" : "Refresh"}
          </Button>
        </CardTitle>

        {/* The filter and the pager together, because they answer one question:
            which sixty of them this request pays git for. The count in the title
            is the whole set — it is counted over every branch-bearing run rather
            than over a page, which is the difference between a page that stops
            at sixty and a page that has stopped counting. */}
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            Repository
            {/* The width is on this wrapper, exactly as the land-strategy
                picker below states its own: `Select` already carries `w-full`,
                and two width utilities on one element resolve by *stylesheet*
                order rather than by what the caller wrote — so the `w-[34ch]`
                that used to sit on the control was a no-op and this picker
                rendered at 155px where 34ch is 284. Measured in a browser, not
                deduced. The `max-md:min-h-11` beside it was `CONTROL_LINE`'s
                own figure repeated, which is the same rule one property over. */}
            <div className="w-[34ch] max-w-full">
              <Select
                value={repo}
                onChange={(e) => {
                  setRepo(e.target.value);
                  setOffset(0);
                  // The selection is the merge order and it survives everything
                  // else, but a branch the operator can no longer see is one they
                  // cannot take back out — so changing what is on screen clears it.
                  setSelected([]);
                }}
              >
                <option value="">All repositories</option>
                {(data?.repos ?? []).map((r) => (
                  <option key={r.repoRoot} value={r.repoRoot}>
                    {r.repoLabel} ({r.branches})
                  </option>
                ))}
              </Select>
            </div>
          </label>

          {data && data.total > 0 && (
            <div className="ml-auto flex items-center gap-3">
              <span className="text-sm tabular-nums text-ink-muted">
                {data.offset + 1}–{data.offset + branches.length} of {data.total}
              </span>
              <ButtonRow>
                <Button
                  variant="secondary"
                  disabled={loading || data.offset === 0}
                  onClick={() => {
                    setOffset(Math.max(0, data.offset - data.limit));
                    setSelected([]);
                  }}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    loading || data.offset + data.limit >= data.total
                  }
                  onClick={() => {
                    setOffset(data.offset + data.limit);
                    setSelected([]);
                  }}
                >
                  Next
                </Button>
              </ButtonRow>
            </div>
          )}
        </div>

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
        ) : branches.length === 0 && data.total > 0 ? (
          // The selection found branches and none of them could be listed, which
          // means their repositories no longer resolve inside a configured
          // mount. Saying "no branches yet" here would be the same lie the
          // notice above exists to stop, one step further in.
          <Empty>
            <div className="font-medium text-ink">
              {data.total} branch{data.total === 1 ? "" : "es"} could not be read
            </div>
            <div className="mx-auto mt-1 max-w-[52ch] text-ink-muted">
              Their repositories are no longer inside a configured workspace
              mount, so nothing here can look at them.
            </div>
          </Empty>
        ) : branches.length === 0 ? (
          <Empty>
            <div className="font-medium text-ink">
              {repo ? "No branches in this repository" : "No branches yet"}
            </div>
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
              reserves the height it covers at the foot of the page. The three
              groups sit on one line above the breakpoint and stack below it, so
              the reservation has to as well; it deliberately over-reserves
              rather than under-, because the cost of guessing high is blank
              space past the last row and the cost of guessing low is a row that
              cannot be reached. */}
          <div aria-hidden="true" className="h-28 max-md:h-80" />
          <div
            role="region"
            aria-label="Selected branches"
            // Fixed, so it is positioned against the viewport rather than the
            // content pane — which means it has to step around the source list
            // itself. `--sidebar-w` follows the collapse, so this does too.
            //
            // Below the breakpoint there is no source list to step around: it
            // is a drawer, which absorbs none of the window's left edge — the
            // same distinction `--sidebar-w-absorbed` exists to make for the
            // toolbar. Left at `--sidebar-w` this bar would start 224px in on a
            // 390px window and show about a third of itself.
            className="fixed right-0 bottom-0 left-[var(--sidebar-w)] max-md:left-0 z-30 border-t border-line bg-surface shadow-bar"
            // A `fixed` element is outside AppShell's box and so outside the
            // padding it applies, which is why the drawer pads itself too. 0px
            // in a browser tab and on the desktop; on an iOS home-screen install
            // it is the home indicator, which would otherwise sit on Land.
            //
            // `bottom` is the same argument one property over: AppShell shrinks
            // its own box by `--keyboard-inset` so the pane's sticky footers
            // clear a software keyboard, and this bar is not in that box. The
            // picker iOS opens for the strategy `select` below is an
            // interactive widget like the keyboard, and it is this bar's own
            // control — so without this the operator picks a strategy behind
            // the thing they are picking it with. Inline rather than a
            // `bottom-[var(…)]` class so the `bottom-0` above stays the
            // readable default and the override is unambiguous; both are 0px
            // wherever there is no keyboard, which is every pointer device.
            style={{
              bottom: "var(--keyboard-inset, 0px)",
              paddingBottom: "env(safe-area-inset-bottom, 0px)",
            }}
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
                {/* The size is part of the statement, which is why both halves
                    of the ternary carry it rather than one sitting in a shared
                    string beside them. This is the only line on the page that
                    says a press of Land will spend money, and at 12px in a
                    muted row it was the same weight as "they land one after
                    another". Switched off it is describing what will *not*
                    happen, and goes back to a footnote. */}
                <div
                  className={`mt-1 leading-snug ${
                    autoResolve
                      ? "text-sm text-warn"
                      : "text-xs text-ink-muted"
                  }`}
                >
                  {autoResolve
                    ? "Spends against the same 5-hour window your runs do, unattended — on the run's branch, never in yours"
                    : "A branch that conflicts is left alone and the queue carries on to the next"}
                </div>
              </div>

              {/* Full width below the breakpoint rather than pushed right: at
                  390px "ml-auto" is the left edge anyway, and a picker whose
                  longest option is "Merge, keeping their commits" is the widest
                  thing in the bar. */}
              <ButtonRow className="ml-auto max-md:w-full">
                {/* On the kit, so `CONTROL_BASE` supplies the 16px floor that
                    stops iOS Safari zooming the page in on focus and never
                    zooming back out — this was the last hand-written control in
                    the app repeating that figure itself. `Field` also gives it
                    the visible label the `aria-label` was standing in for: the
                    repository picker two hundred lines up has one, and a bar
                    holding the page's most expensive button is not where a
                    control is identified by its current value alone.
                    `Field`'s own `mb-3.5` is cancelled on a wrapper and not
                    with an `mb-0` on the Field, for the reason `ui/Field`
                    states about width: two utilities for one property on one
                    element resolve by *stylesheet* order, and Tailwind emits
                    `mb-*` ascending, so `mb-0` loses to every larger one. This
                    is a bar, and the row is centred on the buttons. */}
                {/* `self-end` because `ButtonRow` centres its line and this
                    item is a label plus a control where the others are a
                    control: centred, the picker would sit half a label below
                    the buttons it is pressed with. `align-self` is a different
                    property from the row's `align-items`, so this is an
                    override rather than a second declaration of one. */}
                <div className="-mb-3.5 w-auto self-end max-md:w-full">
                  <Field label="How to land them" htmlFor="land-strategy">
                    {/* No width here: `Select` already states `w-full` and a
                        second width utility on one element resolves by
                        stylesheet order. The wrapper above is where this
                        caller's width is stated, exactly once. */}
                    <Select
                      id="land-strategy"
                      value={strategy}
                      onChange={(e) =>
                        setStrategy(e.target.value as "merge" | "squash")
                      }
                    >
                      <option value="merge">Merge, keeping their commits</option>
                      <option value="squash">
                        Squash each into one commit
                      </option>
                    </Select>
                  </Field>
                </div>
                <Button
                  onClick={() => {
                    // The confirmation is on the paid path only. Auto-resolve
                    // on means one press starts unattended model work against
                    // the same 5-hour window the runs use, and it defaults to
                    // on — where a single dead branch takes two presses to
                    // delete. Off, this button behaves exactly as it always
                    // has, because there is then nothing to confirm.
                    if (autoResolve) setConfirmLand(true);
                    else void queueSelected();
                  }}
                  disabled={queueBusy}
                  className="min-w-[140px] max-md:flex-1"
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

      {/* Outside the bar's own conditional, because a `<dialog>` is always
          rendered and never conditionally mounted — mounting one in the same
          commit that calls `showModal()` is a race. `danger`, so it opens with
          Cancel focused: one Return is not a confirmation for a press that
          starts billed model work.

          The count is the one already on the button, so the sheet and the
          control that opened it cannot come to disagree about how many
          branches this is. */}
      <Sheet
        open={confirmLand}
        onDismiss={() => setConfirmLand(false)}
        title={`Land ${selected.length} branch${selected.length === 1 ? "" : "es"}?`}
        confirmLabel="Land them"
        confirmVariant="danger"
        busy={queueBusy}
        onConfirm={() => {
          setConfirmLand(false);
          void queueSelected();
        }}
      >
        A branch that conflicts is reconciled by Claude on that branch, in a
        throwaway checkout — billed, unattended, and against the same 5-hour
        window your runs use. Your own checkout is not involved.
      </Sheet>
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
    <>
      <TableWrap>
        <Table stack>
          <caption className="sr-only">
            Every branch an isolated run has made, newest first
          </caption>
          <THead>
            {/* Every fixed column is a floor and not a width. Auto table layout
                treats a `width` on a cell as a preference and hands it back to
                the column that asked for `w-full`, which is exactly what the
                branch column does — measured, the 176px Actions column rendered
                at 77 and the 56px tick box at 20, so the row of buttons wrapped
                onto three lines and the order number sat under its checkbox. A
                `min-w` is the only thing the algorithm has to honour, and none of
                it reaches the stacked layout: `THead` is `max-md:hidden` on a
                `stack` table, so below the breakpoint these cells do not render
                and each `Td` names its own field instead. */}
            <tr>
              <Th scope="col" className="min-w-[56px]">
                <span className="sr-only">Land</span>
              </Th>
              <Th scope="col" className="min-w-[140px]">
                State
              </Th>
              <Th scope="col" className="w-full">
                Branch
              </Th>
              <Th scope="col" className="min-w-[120px]">
                Repository
              </Th>
              <Th scope="col" className="min-w-[120px]">
                Lands into
              </Th>
              <Th scope="col" num className="min-w-[76px]">
                Ahead
              </Th>
              <Th scope="col" num className="min-w-[112px]">
                Created
              </Th>
              <Th scope="col" num className="min-w-[176px]">
                Actions
              </Th>
            </tr>
          </THead>
          <TBody>
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
                        // changing what the cell occupies; below the breakpoint
                        // the app's own floor is 44px and the box grows to it,
                        // which costs nothing because the row is a block there
                        // and the cell no longer sets a column's width.
                        <label
                          className={`-m-2 flex w-max items-center gap-1.5 p-2 max-md:min-h-11 ${
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
                          {/* The column head is `sr-only` because a tick box under
                              the word "Land" needs no second label — but below the
                              breakpoint the head is gone entirely, and a bare
                              checkbox at the top of a card says nothing about what
                              ticking it does. The word is what the head was. */}
                          <span
                            aria-hidden="true"
                            className="text-sm text-ink-muted md:hidden"
                          >
                            Land
                          </span>
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
                          a run that did nothing.

                          That distinction is the whole reason the line is here,
                          so it is in the words rather than in a `title` a
                          finger cannot reach. The three words added are the
                          hover's own — it read "changed paths in the run's own
                          checkout, not on the branch" — and not a fourth name
                          for the state: the storage table above says "holding
                          uncommitted work" and `RunLand` says "uncommitted
                          paths", and both are about the same checkout this is.
                          C10 cut three wordings to two and this must not make
                          it three again, so anything reworded here is reworded
                          in all of them. */}
                      {!!b.uncommitted && (
                        <div className="mt-1 text-2xs font-semibold uppercase tracking-wide text-warn">
                          {b.uncommitted} uncommitted in the checkout
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

                    <Td label="Repository" className="align-top">
                      <div className="mono max-w-[16ch] truncate" title={b.repoLabel}>
                        {b.repoLabel}
                      </div>
                    </Td>

                    <Td label="Lands into" className="align-top">
                      <div
                        className="mono max-w-[16ch] truncate"
                        title={b.target ?? "This branch has no recorded target"}
                      >
                        {b.target ?? "—"}
                      </div>
                    </Td>

                    <Td num label="Ahead" className="align-top">
                      {b.exists ? b.ahead : "—"}
                    </Td>

                    <Td
                      num
                      label="Created"
                      className="whitespace-nowrap align-top text-ink-muted"
                    >
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
                              {/* What the second press costs, where the second
                                  press is. It was a `title` on the button, and
                                  the one consequence in this app with no undo
                                  is the last one that may be hover-only — this
                                  row only draws it once the purge is armed, so
                                  it costs nothing until it is the sentence the
                                  operator is deciding against. */}
                              <p className="w-full text-right text-xs leading-snug text-warn">
                                Deletes the branch and its checkout. Nothing on
                                it is recoverable afterwards.
                              </p>
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
                            className="inline-flex max-md:min-h-11 items-center rounded-sm px-3 py-2 text-sm font-medium text-ink-muted no-underline transition-colors duration-150 hover:bg-inset hover:text-ink hover:no-underline"
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
          </TBody>
        </Table>
      </TableWrap>
      {/* The one column whose head is not its own definition, said on the page
          rather than in a `title` on that head. A hover has no touch
          equivalent, and this table stacks: below the breakpoint `THead` is
          hidden outright, so the column head the sentence hung off did not
          render at all and the number stood alone under the word "Ahead". */}
      <p className="mt-2 text-xs text-ink-muted">
        Ahead counts the commits this branch has that the branch it lands into
        does not.
      </p>
    </>
  );
}
