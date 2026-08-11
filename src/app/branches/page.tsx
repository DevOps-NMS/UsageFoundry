"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  BranchInventoryDTO,
  BranchSummaryDTO,
  MergeQueueDTO,
  MergeQueueItemDTO,
} from "@/lib/apiTypes";
import { fmtDateTime, fmtUSD } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { Hint } from "@/components/ui/Hint";
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

function StateBadge({ b }: { b: BranchSummaryDTO }) {
  if (!b.exists) return <Badge>gone</Badge>;
  if (b.active) return <Badge tone="accent">still running</Badge>;
  if (b.merged) return <Badge tone="ok">merged</Badge>;
  // Squashing rewrites the commits, so git sees no ancestry — this is the only
  // thing that distinguishes "landed as one commit" from "never landed".
  if (b.landedUnchanged) return <Badge tone="ok">squashed in</Badge>;
  if (!b.target) return <Badge tone="warn">no target</Badge>;
  return <Badge tone="warn">unmerged</Badge>;
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

const ITEM_ACTIVE: MergeQueueItemDTO["status"][] = ["queued", "landing", "resolving"];

const ITEM_TONE: Record<MergeQueueItemDTO["status"], "ok" | "warn" | "danger" | "accent" | "neutral"> = {
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

function QueuePanel({
  queue,
  onCancel,
  busy,
}: {
  queue: MergeQueueDTO;
  onCancel: () => void;
  busy: boolean;
}) {
  const waiting = queue.items.filter((i) => i.status === "queued").length;
  const spent = queue.items.reduce((n, i) => n + i.resolveCostUSD, 0);
  const active = queue.items.some((i) => ITEM_ACTIVE.includes(i.status));

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
        {waiting > 0 && (
          <Button variant="ghost" className="ml-auto" onClick={onCancel} disabled={busy}>
            Cancel the {waiting} still waiting
          </Button>
        )}
      </CardTitle>

      <div>
        {queue.items.map((item) => (
          <div key={item.id} className="border-b border-line py-1.5 last:border-b-0">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="tabular-nums text-xs text-ink-faint">
                {item.position + 1}
              </span>
              <Link href={`/runs/${item.runId}`} className="mono min-w-0 flex-1 break-all">
                {item.branch ?? item.runId.slice(0, 8)}
              </Link>
              {item.target && (
                <span className="mono text-xs text-ink-faint">→ {item.target}</span>
              )}
              {item.resolveCostUSD > 0 && (
                <span className="tabular-nums text-xs text-ink-muted">
                  {fmtUSD(item.resolveCostUSD)}
                </span>
              )}
              <Badge tone={ITEM_TONE[item.status]}>{ITEM_LABEL[item.status]}</Badge>
            </div>
            {item.message && (
              <div className="mt-0.5 text-xs leading-snug text-ink-muted">
                {item.message}
              </div>
            )}
          </div>
        ))}
      </div>

      {active && (
        <Hint>
          One at a time, each re-checked against git at its own turn — a landing
          changes the base for the one behind it
        </Hint>
      )}
    </Card>
  );
}

export default function Branches() {
  const [data, setData] = useState<BranchInventoryDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Selection order is the merge order, so this is a list and not a Set.
  const [selected, setSelected] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<"merge" | "squash">("merge");
  const [autoResolve, setAutoResolve] = useState(true);
  const [queue, setQueue] = useState<MergeQueueDTO | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/branches", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as BranchInventoryDTO;
      setData(json);
      setStrategy(json.defaultStrategy);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadQueue = useCallback(async () => {
    const res = await fetch("/api/branches/queue", { cache: "no-store" });
    if (res.ok) setQueue((await res.json()) as MergeQueueDTO);
  }, []);

  useEffect(() => {
    void load();
    void loadQueue();
  }, [load, loadQueue]);

  const queueActive =
    !!queue && (queue.working || queue.items.some((i) => ITEM_ACTIVE.includes(i.status)));

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

  async function remove(runId: string) {
    setBusy(runId);
    setNote(null);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/land`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "delete" }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      if (res.ok) setNote(json.message ?? "Deleted.");
      else setError(json.error ?? "Could not delete that branch.");
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
      const res = await fetch("/api/branches/queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runIds: selected, strategy, autoResolve }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        queued?: number;
        error?: string;
      };
      if (res.ok) {
        setNote(`Queued ${json.queued} branch${json.queued === 1 ? "" : "es"}.`);
        setSelected([]);
      } else {
        setError(json.error ?? "Could not queue those.");
      }
      await loadQueue();
    } finally {
      setQueueBusy(false);
    }
  }

  async function cancelQueue() {
    if (!queue?.batchId) return;
    setQueueBusy(true);
    try {
      await fetch("/api/branches/queue", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchId: queue.batchId }),
      });
      await loadQueue();
    } finally {
      setQueueBusy(false);
    }
  }

  const branches = data?.branches ?? [];

  return (
    <>
      <h1>Branches</h1>
      <p className="lede">
        One branch per isolated run. Pick several to land them one after another,
        or open a run to preview its merge first — each landing changes the base
        for the one behind it, so they go through in the order you choose them.
      </p>

      {note && <Notice tone="info">{note}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}

      {queue && queue.items.length > 0 && (
        <QueuePanel queue={queue} onCancel={cancelQueue} busy={queueBusy} />
      )}

      {selected.length > 0 && (
        <Card className="mb-4">
          <CardTitle>
            {selected.length} branch{selected.length === 1 ? "" : "es"} selected
          </CardTitle>
          <ButtonRow>
            <select
              className="w-auto rounded-sm border border-line bg-inset px-2.5 py-2 text-sm text-ink"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as "merge" | "squash")}
              aria-label="How to land them"
            >
              <option value="merge">Merge, keeping their commits</option>
              <option value="squash">Squash each into one commit</option>
            </select>
            <Button onClick={queueSelected} disabled={queueBusy}>
              {queueBusy ? "Queueing…" : `Land ${selected.length} in this order`}
            </Button>
            <Button variant="ghost" onClick={() => setSelected([])} disabled={queueBusy}>
              Clear
            </Button>
          </ButtonRow>

          <div className="mt-3">
            <Toggle
              id="auto-resolve"
              checked={autoResolve}
              onChange={setAutoResolve}
              label="Have Claude resolve conflicts as they come up"
            />
            <Hint tone={autoResolve ? "warn" : "neutral"}>
              {autoResolve
                ? "Each conflict spends against the same 5-hour window your runs do, unattended. It is resolved on the run's branch in a throwaway checkout, never in yours"
                : "A branch that conflicts is left alone and the queue carries on to the next"}
            </Hint>
          </div>
        </Card>
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
            className="ml-auto"
            onClick={load}
            disabled={loading}
          >
            {loading ? "Reading…" : "Refresh"}
          </Button>
        </CardTitle>

        {branches.length === 0 ? (
          <Empty>
            {loading ? "Reading repositories…" : "No isolated run has made a branch yet."}
          </Empty>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th />
                  <Th>Branch</Th>
                  <Th>Repository</Th>
                  <Th>Lands into</Th>
                  <Th num>Ahead</Th>
                  <Th>State</Th>
                  <Th>Created</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {branches.map((b) => (
                  <Tr key={b.branch}>
                    <Td>
                      {/* The number is the point: it is the order these land in,
                          and it is the only place that order is visible before
                          the queue exists. */}
                      {queueable(b) ? (
                        <label className="flex cursor-pointer items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={selected.includes(b.runId)}
                            onChange={() => toggle(b.runId)}
                            aria-label={`Queue ${b.branch}`}
                          />
                          {selected.includes(b.runId) && (
                            <span className="tabular-nums text-xs text-accent">
                              {selected.indexOf(b.runId) + 1}
                            </span>
                          )}
                        </label>
                      ) : null}
                    </Td>
                    <Td>
                      <Link href={`/runs/${b.runId}`} className="mono">
                        {b.branch}
                      </Link>
                      <div
                        className="mt-0.5 max-w-[38ch] truncate text-xs text-ink-faint"
                        title={b.prompt}
                      >
                        {b.prompt}
                      </div>
                    </Td>
                    <Td className="mono">{b.repoLabel}</Td>
                    <Td className="mono">{b.target ?? "—"}</Td>
                    <Td num>{b.exists ? b.ahead : "—"}</Td>
                    <Td>
                      <StateBadge b={b} />
                    </Td>
                    <Td>{fmtDateTime(b.createdAt)}</Td>
                    <Td>
                      {/* Merged branches only. Deleting one with commits of its
                          own is the single action here with no undo, so it is
                          not offered at all rather than offered with a warning. */}
                      {b.exists && (b.merged || b.landedUnchanged) && !b.active ? (
                        <Button
                          variant="ghost"
                          onClick={() => remove(b.runId)}
                          disabled={busy === b.runId}
                        >
                          {busy === b.runId ? "Deleting…" : "Delete"}
                        </Button>
                      ) : (
                        <Link href={`/runs/${b.runId}`} className="text-xs">
                          open run
                        </Link>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
