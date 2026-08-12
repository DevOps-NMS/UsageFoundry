"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { WorkflowInstanceDTO } from "@/lib/apiTypes";
import {
  STATUS_TONE,
  fmtCycles,
  fmtDateTime,
  fmtPct,
  fmtUSD,
  pollFailureMessage,
} from "@/lib/format";
import { Meter } from "@/components/Meter";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty, SkeletonText } from "@/components/ui/Card";
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/Table";

const POLL_MS = 10_000;

/** Who halted it, in the same words the member runs' own reasons use. */
const CAUSE_LABEL: Record<"operator" | "guard", string> = {
  operator: "You stopped this run",
  guard: "Its budget guard stopped this run",
};

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
      setConfirmStop(false);
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  }

  const nodeName = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of instance?.nodes ?? []) map.set(n.nodeId, n.nodeName);
    return map;
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
          {instance.status === "started" && instance.liveRunCount > 0 && (
            <Button
              variant="danger"
              onClick={() => setConfirmStop(true)}
              disabled={confirmStop || stopping}
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

      {confirmStop && (
        <Notice tone="danger" live>
          <div className="mb-2">
            Ends {instance.liveRunCount} unfinished block(s). A block working now
            is interrupted mid-cycle, so what that cycle spent is estimated
            rather than measured. Committed work stays on its branch; anything
            uncommitted stays in the checkout, to commit from the run page.
            Finished blocks are untouched.
          </div>
          <ButtonRow>
            <Button
              variant="danger"
              size="compact"
              onClick={stopAll}
              busy={stopping}
            >
              Stop all blocks
            </Button>
            <Button
              variant="ghost"
              size="compact"
              onClick={() => setConfirmStop(false)}
              disabled={stopping}
            >
              Cancel
            </Button>
          </ButtonRow>
        </Notice>
      )}

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

        <ul className="m-0 mt-4 list-none space-y-1 p-0 text-sm text-ink-muted">
          <li>
            {budget.maxSessionFraction === null
              ? "No 5-hour window guard"
              : `Stops the workflow at ${fmtPct(budget.maxSessionFraction)} of the 5-hour window`}
          </li>
          <li>
            {budget.maxWeeklyFraction === null
              ? "No weekly window guard"
              : `Stops the workflow at ${fmtPct(budget.maxWeeklyFraction)} of the weekly window`}
          </li>
        </ul>

        <Hint>
          {noLimits
            ? "Nothing bounds this workflow as a whole — each block is bounded only by its own guards"
            : "Checked before a block starts a work cycle, never during one — a block already working carries on until some block reaches a cycle boundary, so the total can overshoot by up to one work cycle per block running at the time, and blocks running at once multiply that"}
        </Hint>
        {instance.liveRunCount > 0 && (
          <Hint>
            {instance.liveRunCount} block(s) working — a cycle in flight reports
            nothing until it ends, so the measured figure is a floor and the
            guard&rsquo;s is what telemetry has seen so far
          </Hint>
        )}
      </Card>

      <CardTitle className="mt-8">Blocks</CardTitle>
      <Card emphasis="primary">
        {instance.nodes.length === 0 ? (
          <Empty>
            <div className="text-ink-muted">No runs were created.</div>
          </Empty>
        ) : (
          <TableWrap>
            <Table>
              <caption className="sr-only">
                Each block of the workflow and the run it created
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
                    Cycles
                  </Th>
                  <Th scope="col" num className="w-[96px]">
                    Spent
                  </Th>
                </tr>
              </thead>
              <tbody>
                {instance.nodes.map((n) => {
                  const waits = n.waitsFor.map(
                    (from) => nodeName.get(from) ?? from,
                  );
                  return (
                    <Tr key={n.nodeId}>
                      <Td className="align-top">
                        {n.run ? (
                          <Badge tone={STATUS_TONE[n.run.status]}>
                            {n.run.status}
                          </Badge>
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
                          {waits.length === 0
                            ? "started immediately"
                            : `after ${waits.join(", ")}`}
                        </div>
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
                        {n.run
                          ? fmtCycles(n.run.iterations, n.run.maxIterations)
                          : "—"}
                      </Td>
                      <Td num className="whitespace-nowrap align-top">
                        {n.run ? fmtUSD(n.run.spentUSD) : "—"}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
