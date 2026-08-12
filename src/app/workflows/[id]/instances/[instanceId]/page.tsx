"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { WorkflowInstanceDTO } from "@/lib/apiTypes";
import {
  STATUS_TONE,
  fmtCycles,
  fmtDateTime,
  fmtUSD,
  pollFailureMessage,
} from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle, Empty, SkeletonText } from "@/components/ui/Card";
import { Notice } from "@/components/ui/Notice";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/Table";

const POLL_MS = 10_000;

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

  return (
    <>
      <div className="mb-6">
        <Link href={`/workflows/${id}`} className="text-sm text-ink-muted">
          ← {instance.workflowName}
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">
          Run of {fmtDateTime(instance.createdAt)}
        </h1>
      </div>

      <div role="alert">
        {pollError && <Notice tone="danger">{pollError}</Notice>}
      </div>

      {instance.status === "failed" && (
        <Notice tone="danger">
          <strong>Nothing from this workflow is running.</strong> {instance.error}
        </Notice>
      )}

      <CardTitle>Blocks</CardTitle>
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
