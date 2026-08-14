"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { WorkflowInstanceDTO } from "@/lib/apiTypes";
import type { BadgeTone } from "@/lib/format";
import {
  STATUS_TONE,
  fmtCycleInFlight,
  fmtCycles,
  fmtDateTime,
  fmtPct,
  fmtUSD,
  pollFailureMessage,
} from "@/lib/format";
import { Markdown } from "@/components/Markdown";
import { Meter } from "@/components/Meter";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle, Empty, SkeletonText } from "@/components/ui/Card";
import { Hint } from "@/components/ui/Hint";
import { ListGroup, ListRow } from "@/components/ui/List";
import { Notice } from "@/components/ui/Notice";
import { Sheet } from "@/components/ui/Sheet";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/Table";

const POLL_MS = 10_000;

/** Who halted it, in the same words the member runs' own reasons use. */
const CAUSE_LABEL: Record<"operator" | "guard", string> = {
  operator: "You stopped this run",
  guard: "Its budget guard stopped this run",
};

type BlockStatus = WorkflowInstanceDTO["blocks"][number]["status"];

/**
 * What a block's status is called on the page.
 *
 * `emitted` is deliberately not "completed": a block that decided there was
 * nothing to start is emitted with zero runs, and the row beside this says how
 * many — so the word has to leave room for none rather than imply work.
 *
 * Per kind as well as per status, because the column holds one lifecycle for
 * every kind of block — see `BlockStatus`, which says why it is one vocabulary
 * and not three — and "deciding" is the wrong word for a merge in flight.
 */
const BLOCK_LABEL: Record<BlockStatus, string> = {
  waiting: "waiting",
  thinking: "deciding",
  emitted: "decided",
  failed: "failed",
  blocked: "blocked",
};

const MERGE_LABEL: Partial<Record<BlockStatus, string>> = {
  thinking: "merging",
  emitted: "landed",
};

const blockLabel = (b: { kind: string; status: BlockStatus }) =>
  (b.kind === "merge" ? MERGE_LABEL[b.status] : null) ?? BLOCK_LABEL[b.status];

const BLOCK_TONE: Record<BlockStatus, BadgeTone> = {
  waiting: "neutral",
  thinking: "accent",
  emitted: "ok",
  failed: "danger",
  blocked: "neutral",
};

type BlockDTO = WorkflowInstanceDTO["blocks"][number];
type NodeDTO = WorkflowInstanceDTO["nodes"][number];

/** Where the run is working. Absolute when its mount has since been removed. */
function folderLabel(run: NonNullable<NodeDTO["run"]>): string {
  return run.mountLabel ? `${run.mountLabel} / ${run.relPath || "."}` : run.relPath;
}

/**
 * The rows of a run table, for both of the tables on this page.
 *
 * Two tables rather than one because the runs a block decided on were started
 * with nobody approving them, and separating them is the whole of what this
 * page can say about that — but a run is a run, so there is one row and one
 * header, and only the heading and the caption differ.
 */
function RunRows({
  nodes,
  nodeName,
}: {
  nodes: NodeDTO[];
  nodeName: Map<string, string>;
}) {
  return (
    <tbody>
      {nodes.map((n) => {
        const waits = n.waitsFor.map((from) => nodeName.get(from) ?? from);
        // Reads the run's own `fmtCycleInFlight`, in that function's argument
        // shape rather than a second copy of its rules: what counts as a cycle
        // in flight is one definition, and the DTO here is simply camelCase.
        const inFlight = n.run
          ? fmtCycleInFlight({
              status: n.run.status,
              max_iterations: n.run.maxIterations,
              active_iteration: n.run.activeIteration,
            })
          : null;
        return (
          <Tr key={n.nodeId}>
            <Td className="align-top">
              {n.run ? (
                <Badge tone={STATUS_TONE[n.run.status]}>{n.run.status}</Badge>
              ) : (
                <Badge tone="neutral">gone</Badge>
              )}
            </Td>
            <Td className="align-top">
              <Link
                href={`/runs/${n.runId}`}
                className="block font-medium text-ink hover:text-accent"
              >
                {n.nodeName}
              </Link>
              <div className="mt-0.5 text-ink-muted">
                {n.emittedBy
                  ? `started by ${nodeName.get(n.emittedBy) ?? n.emittedBy}`
                  : waits.length === 0
                    ? "started immediately"
                    : `after ${waits.join(", ")}`}
              </div>
              {n.run && (
                // Under the name because a block a model wrote chose this
                // folder itself, within the mount the operator fixed — it is
                // not readable off the saved graph.
                <div
                  className="mono mt-0.5 max-w-[56ch] truncate text-ink-muted"
                  title={folderLabel(n.run)}
                >
                  {folderLabel(n.run)}
                </div>
              )}
              {inFlight && <div className="mt-0.5 text-accent">{inFlight}</div>}
              {n.run?.stopReason && (
                <div className="mt-0.5 max-w-[56ch] text-ink-muted">
                  {n.run.stopReason}
                </div>
              )}
              {!n.run && (
                <div className="mt-0.5 text-ink-muted">
                  The run row is no longer there.
                </div>
              )}
            </Td>
            <Td num className="whitespace-nowrap align-top text-ink-muted">
              {n.run ? fmtCycles(n.run.iterations, n.run.maxIterations) : "—"}
            </Td>
            <Td num className="whitespace-nowrap align-top">
              {n.run ? fmtUSD(n.run.spentUSD) : "—"}
            </Td>
            <Td num className="whitespace-nowrap align-top text-ink-muted">
              {n.run?.startedAt ? fmtDateTime(n.run.startedAt) : "—"}
            </Td>
          </Tr>
        );
      })}
    </tbody>
  );
}

function RunTableHead() {
  return (
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
        <Th scope="col" num className="w-[128px]">
          Started
        </Th>
      </tr>
    </thead>
  );
}

/**
 * The one line under a block's name.
 *
 * A deciding block that started nothing is what this exists to separate. Zero
 * runs is three different endings — it called emit_runs and named nothing, it
 * never called it, or it failed before it got there — and all three stop the
 * branch of the graph behind them, so "which of the three" is the operator's
 * whole question. The block's own reply sits under this and answers *why*;
 * this says *what*.
 */
function blockSummary(b: BlockDTO, waits: string[]): string {
  const ran = b.status === "emitted" || b.status === "failed";
  if (b.kind === "merge") {
    const branches = b.branchesLanded + b.branchesFailed;
    if (branches > 0) return `landed ${b.branchesLanded} of ${branches} branch(es)`;
    // Only for a merge that finished: one that failed with nothing queued has
    // not established that there was nothing to land, and its error says more.
    if (b.status === "emitted") return "no branches to land";
  } else if (ran) {
    if (b.emitted > 0) return `started ${b.emitted} run(s)`;
    if (b.kind === "orchestrator") {
      if (b.decided) return "decided there was nothing to start";
      return b.status === "failed"
        ? "failed without emitting anything"
        : "ended without emitting anything";
    }
  }
  if (b.kind === "run" && b.status !== "waiting") return "never started";
  return waits.length === 0 ? "decides immediately" : `after ${waits.join(", ")}`;
}

/**
 * One press of Run: every block, and what became of the run it created.
 *
 * Read off the instance's own snapshot of the graph rather than the live
 * workflow, so editing the workflow afterwards cannot rewrite what this says
 * happened. The run statuses are live; the shape of the graph is history.
 */
export default function WorkflowInstancePage() {
  const params = useParams<{ id: string; instanceId: string }>();
  const { id, instanceId } = params;

  const [instance, setInstance] = useState<WorkflowInstanceDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/workflows/${id}/instances/${instanceId}`,
        { cache: "no-store" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        instance?: WorkflowInstanceDTO;
        error?: string;
      };
      if (!res.ok || !data.instance) {
        setPollError(
          pollFailureMessage(res.status, data.error ?? "no instance in the response"),
        );
        return;
      }
      setInstance(data.instance);
      setPollError(null);
    } catch (err) {
      setPollError(
        pollFailureMessage(null, err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setLoaded(true);
    }
  }, [id, instanceId]);

  useEffect(() => {
    load();
    const poll = setInterval(load, POLL_MS);
    return () => clearInterval(poll);
  }, [load]);

  /**
   * Halt every block at once.
   *
   * Guarded by `chatRequest`'s rule rather than a bare `fetch`: an unguarded
   * rejection out of a handler that sets a busy flag leaves the button disabled
   * with no cue and no way back but a reload — and this is the button that stops
   * unattended agents from spending.
   */
  async function stopAll() {
    setStopping(true);
    setStopError(null);
    try {
      const res = await fetch(
        `/api/workflows/${id}/instances/${instanceId}/stop`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        instance?: WorkflowInstanceDTO;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      if (data.instance) setInstance(data.instance);
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
      // Closed however this ended. `stopError` renders behind the modal, so a
      // sheet left open over a failure shows an enabled, un-busy "Stop all
      // blocks" and no sign that the agents are still spending.
      setConfirmStop(false);
    }
  }

  const nodeName = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of instance?.nodes ?? []) map.set(n.nodeId, n.nodeName);
    for (const b of instance?.blocks ?? []) map.set(b.nodeId, b.nodeName);
    return map;
  }, [instance]);

  /**
   * The graph's own runs, and the ones a block decided on.
   *
   * A boolean per node, so every run lands in exactly one table — a run missing
   * from both would be an unattended agent this page has no other mention of.
   * Emitted runs keep their `position` order, which is the order the block
   * emitted them in.
   */
  const { savedRuns, emittedRuns } = useMemo(() => {
    const savedRuns: NodeDTO[] = [];
    const emittedRuns: NodeDTO[] = [];
    for (const n of instance?.nodes ?? []) {
      if (n.emittedBy) emittedRuns.push(n);
      else savedRuns.push(n);
    }
    return { savedRuns, emittedRuns };
  }, [instance]);

  if (!loaded) {
    return (
      <Card emphasis="quiet">
        <span className="sr-only">Reading this run of the workflow…</span>
        <SkeletonText lines={4} />
      </Card>
    );
  }

  if (!instance) {
    return (
      <>
        <div role="alert">
          {pollError && <Notice tone="danger">{pollError}</Notice>}
        </div>
        <Card emphasis="quiet">
          <Empty>
            <div className="font-medium text-ink">No such workflow run</div>
            <div className="mt-3">
              <Link href={`/workflows/${id}`}>Back to the workflow</Link>
            </div>
          </Empty>
        </Card>
      </>
    );
  }

  const budget = instance.instanceBudget;
  const noLimits =
    budget.maxInstanceCostUSD === null &&
    budget.maxSessionFraction === null &&
    budget.maxWeeklyFraction === null;

  return (
    <>
      <div className="mb-6">
        <Link href={`/workflows/${id}`} className="text-sm text-ink-muted">
          ← {instance.workflowName}
        </Link>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            Run of {fmtDateTime(instance.createdAt)}
          </h1>
          {/* Not disabled by `confirmStop`: that lands in the same commit that
              opens the sheet, so the button is blurred to <body> before
              `showModal()` records what to restore focus to, and Esc would drop
              the operator at the top of the page. */}
          {instance.status === "started" && instance.liveRunCount > 0 && (
            <Button
              variant="danger"
              onClick={() => setConfirmStop(true)}
              disabled={stopping}
            >
              Stop all
            </Button>
          )}
        </div>
      </div>

      <div role="alert">
        {pollError && <Notice tone="danger">{pollError}</Notice>}
        {stopError && (
          <Notice tone="danger" live>
            {stopError}
          </Notice>
        )}
      </div>

      {/* A sheet: the pane behind it goes inert, and Cancel takes the focus, so
          one Return on the control that ends unattended agents mid-cycle is not
          a confirmation. */}
      <Sheet
        open={confirmStop}
        onDismiss={() => setConfirmStop(false)}
        title={`Stop ${instance.liveRunCount} unfinished block(s)?`}
        confirmLabel="Stop all blocks"
        confirmVariant="danger"
        busy={stopping}
        onConfirm={stopAll}
      >
        A block working now is interrupted mid-cycle, so what that cycle spent is
        estimated rather than measured. Committed work stays on its branch;
        anything uncommitted stays in the checkout, to commit from the run page.
        Finished blocks are untouched.
      </Sheet>

      {instance.status === "failed" && (
        <Notice tone="danger">
          <strong>Nothing from this workflow is running.</strong> {instance.error}
        </Notice>
      )}

      {(instance.status === "stopping" || instance.status === "stopped") && (
        <Notice tone={instance.status === "stopping" ? "warn" : "info"}>
          <strong>
            {instance.status === "stopping"
              ? `Stopping — ${instance.liveRunCount} block(s) still finishing.`
              : "Stopped."}
          </strong>{" "}
          {instance.stoppedAt !== null && (
            <>
              {CAUSE_LABEL[instance.stopCause ?? "operator"]} at{" "}
              {fmtDateTime(instance.stoppedAt)}.{" "}
            </>
          )}
          {instance.stopReason}
        </Notice>
      )}

      <CardTitle>Limits for the whole workflow</CardTitle>
      <Card emphasis="quiet">
        {/* `fraction === null` when no spending limit was set, which renders
            hatched rather than as an empty bar: an instance whose share of a
            limit is unknown and one that has spent nothing must not look alike.
            The solid fill is what the blocks' own CLIs measured; the hatched
            band past it is the figure the guard acts on, which adds reconciled
            estimates for killed cycles and what telemetry has seen of the
            cycles in flight. Same split, same rendering, as an unpriced model
            widens a window meter. */}
        <Meter
          label="Spent across blocks"
          fraction={
            budget.maxInstanceCostUSD === null
              ? null
              : instance.spentUSD / budget.maxInstanceCostUSD
          }
          upperFraction={
            budget.maxInstanceCostUSD === null
              ? null
              : instance.spentGuardUSD / budget.maxInstanceCostUSD
          }
          value={fmtUSD(instance.spentUSD)}
          unknownHint="no workflow spending limit"
          detail={
            budget.maxInstanceCostUSD === null
              ? `${fmtUSD(instance.spentUSD)} measured so far`
              : `of ${fmtUSD(budget.maxInstanceCostUSD)}; the guard reads ${fmtUSD(
                  instance.spentGuardUSD,
                )}`
          }
        />

        <ListGroup className="mt-4">
          <ListRow label="5-hour window">
            <span
              className={`text-sm ${budget.maxSessionFraction === null ? "text-ink-faint" : "text-ink"}`}
            >
              {budget.maxSessionFraction === null
                ? "No guard"
                : `Stops the workflow at ${fmtPct(budget.maxSessionFraction)}`}
            </span>
          </ListRow>
          <ListRow label="Weekly window">
            <span
              className={`text-sm ${budget.maxWeeklyFraction === null ? "text-ink-faint" : "text-ink"}`}
            >
              {budget.maxWeeklyFraction === null
                ? "No guard"
                : `Stops the workflow at ${fmtPct(budget.maxWeeklyFraction)}`}
            </span>
          </ListRow>
        </ListGroup>

        <Hint>
          {noLimits
            ? "Nothing bounds this workflow as a whole — each block is bounded only by its own guards"
            : "Checked before a block starts a work cycle and again as each block finishes, never during one — a block already working carries on until it or another reaches one of those boundaries, so the total can overshoot by up to one work cycle per block running at the time, and blocks running at once multiply that"}
        </Hint>
        {instance.liveRunCount > 0 && (
          <Hint>
            {instance.liveRunCount} block(s) working — a cycle in flight reports
            nothing until it ends, so the measured figure is a floor and the
            guard&rsquo;s is what telemetry has seen so far
          </Hint>
        )}
      </Card>

      {instance.blocks.length > 0 && (
        <>
          <CardTitle className="mt-8">Blocks not yet runs</CardTitle>
          <Card emphasis="quiet">
            <TableWrap>
              <Table>
                <caption className="sr-only">
                  Blocks that decide what to run, blocks that land branches, and
                  blocks waiting on one
                </caption>
                <thead>
                  <tr>
                    <Th scope="col" className="w-[116px]">
                      Status
                    </Th>
                    <Th scope="col" className="w-full">
                      Block
                    </Th>
                    <Th scope="col" num className="w-[104px]">
                      Started
                    </Th>
                    <Th scope="col" num className="w-[96px]">
                      Spent
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {instance.blocks.map((b) => {
                    const waits = b.waitsFor.map(
                      (from) => nodeName.get(from) ?? from,
                    );
                    return (
                      <Tr key={b.nodeId}>
                        <Td className="align-top">
                          <Badge tone={BLOCK_TONE[b.status]}>
                            {blockLabel(b)}
                          </Badge>
                        </Td>
                        <Td className="align-top">
                          <div className="font-medium text-ink">{b.nodeName}</div>
                          <div className="mt-0.5 text-ink-muted">
                            {blockSummary(b, waits)}
                          </div>
                          {b.error && (
                            <div className="mt-0.5 max-w-[56ch] text-ink-muted">
                              {b.error}
                            </div>
                          )}
                          {/* This app's account before the block's own, because
                              a refused emission explains a reply that says it
                              gave up, and the reply read first does not. */}
                          {b.notes.map((note, i) => (
                            <div key={i} className="mt-0.5 max-w-[56ch] text-warn">
                              {note}
                            </div>
                          ))}
                          {b.reply && (
                            <div className="mt-2 max-w-[80ch] rounded-sm border-l-[3px] border-line-strong bg-inset px-3 py-2">
                              <Markdown text={b.reply} />
                            </div>
                          )}
                        </Td>
                        <Td num className="whitespace-nowrap align-top text-ink-muted">
                          {b.startedAt === null ? "—" : fmtDateTime(b.startedAt)}
                        </Td>
                        <Td num className="whitespace-nowrap align-top">
                          {b.kind === "run" ? "—" : fmtUSD(b.costUSD)}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableWrap>
            <Hint>
              What a deciding block starts is created without an approval — the
              folder, the guards and the most runs it may start were fixed when
              the workflow was saved
            </Hint>
            <Hint>
              A deciding block&rsquo;s own spend is counted against this
              workflow&rsquo;s limit and never against a run
            </Hint>
            {instance.blocks.some((b) => b.kind === "merge") && (
              <Hint>
                A merge block&rsquo;s branches are in the merge queue on
                Branches, one row each, with git&rsquo;s own answer for every one
              </Hint>
            )}
          </Card>
        </>
      )}

      {/* Whichever table holds the runs leads. A workflow that is one
          orchestrator block has no saved-graph run at all, and an empty primary
          card above the runs the operator came for is the wrong emphasis. */}
      <CardTitle className="mt-8">Blocks</CardTitle>
      <Card emphasis={savedRuns.length > 0 ? "primary" : "quiet"}>
        {savedRuns.length === 0 ? (
          <Empty>
            <div className="text-ink-muted">
              No block of the saved graph became a run.
            </div>
          </Empty>
        ) : (
          <TableWrap>
            <Table>
              <caption className="sr-only">
                Each block of the workflow and the run it created
              </caption>
              <RunTableHead />
              <RunRows nodes={savedRuns} nodeName={nodeName} />
            </Table>
          </TableWrap>
        )}
      </Card>

      {/* Only when there are any: a graph with no orchestrator block never
          reaches this, and an empty section under that heading would suggest
          one could have. */}
      {emittedRuns.length > 0 && (
        <>
          <CardTitle className="mt-8">Runs a block started</CardTitle>
          <Card emphasis={savedRuns.length > 0 ? "default" : "primary"}>
            <TableWrap>
              <Table>
                <caption className="sr-only">
                  Runs an orchestrator block decided on, and where each has got to
                </caption>
                <RunTableHead />
                <RunRows nodes={emittedRuns} nodeName={nodeName} />
              </Table>
            </TableWrap>
            {/* One line, and it leads with what is not already said a card
                up: these count against the same limit and the same Stop. */}
            <Hint>
              Counted against this workflow&rsquo;s limit and ended by Stop all,
              like every other block — started with no approval, under the
              guards and fan-out cap the saved workflow fixed
            </Hint>
          </Card>
        </>
      )}
    </>
  );
}
