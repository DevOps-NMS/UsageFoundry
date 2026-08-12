"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { WorkflowDTO } from "@/lib/apiTypes";
import { fmtDateTime, pollFailureMessage } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle, Empty, SkeletonText } from "@/components/ui/Card";
import { Notice } from "@/components/ui/Notice";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/Table";

/** The dashboard's cadence. Nothing here moves faster than a run's status. */
const POLL_MS = 10_000;

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<WorkflowDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/workflows", { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as {
        workflows?: WorkflowDTO[];
        error?: string;
      };
      if (!res.ok || !data.workflows) {
        const detail = data.error ?? (res.ok ? "no workflows in the response" : null);
        setPollError(pollFailureMessage(res.status, detail));
        return;
      }
      setWorkflows(data.workflows);
      setPollError(null);
    } catch (err) {
      setPollError(
        pollFailureMessage(null, err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    const poll = setInterval(load, POLL_MS);
    return () => clearInterval(poll);
  }, [load]);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-xl font-semibold tracking-tight">Workflows</h1>
          <p className="max-w-[68ch] text-ink-muted">
            A <strong className="font-semibold text-ink">workflow</strong> is a
            saved graph of blocks. Running it starts one run per block, each
            waiting for the blocks it was told to follow.
          </p>
        </div>
        <Link
          href="/workflows/new"
          className="rounded-sm border border-transparent bg-accent px-3.5 py-2 text-sm font-medium text-white no-underline transition-[filter] duration-150 hover:brightness-110 hover:no-underline"
        >
          New workflow
        </Link>
      </div>

      <div role="alert">
        {pollError && <Notice tone="danger">{pollError}</Notice>}
      </div>

      <CardTitle>Saved</CardTitle>
      <Card emphasis="primary">
        {!loaded ? (
          <div aria-busy="true">
            <span className="sr-only">Reading workflows…</span>
            <SkeletonText lines={3} />
          </div>
        ) : workflows.length === 0 ? (
          <Empty>
            <div className="font-medium text-ink">No workflows yet</div>
            <div className="mx-auto mt-1 max-w-[46ch] text-ink-muted">
              A workflow saves the blocks of a job and how they follow each
              other, so the whole thing is one press of Run.
            </div>
            <div className="mt-3">
              <Link href="/workflows/new">Create one</Link>
            </div>
          </Empty>
        ) : (
          <TableWrap>
            <Table>
              <caption className="sr-only">Saved workflows, by name</caption>
              <thead>
                <tr>
                  <Th scope="col" className="w-full">
                    Workflow
                  </Th>
                  <Th scope="col" num className="w-[88px]">
                    Blocks
                  </Th>
                  <Th scope="col" className="w-[168px]">
                    Last run
                  </Th>
                </tr>
              </thead>
              <tbody>
                {workflows.map((w) => (
                  <Tr key={w.id}>
                    <Td className="align-top">
                      <Link
                        href={`/workflows/${w.id}`}
                        className="block max-w-[56ch] truncate font-medium text-ink hover:text-accent"
                      >
                        {w.name}
                      </Link>
                      {(w.liveRunCount ?? 0) > 0 && (
                        <div className="mt-1">
                          <Badge tone="accent">
                            {w.liveRunCount} run(s) in flight
                          </Badge>
                        </div>
                      )}
                    </Td>
                    <Td num className="align-top text-ink-muted">
                      {w.nodes.length}
                    </Td>
                    <Td className="whitespace-nowrap align-top text-ink-muted">
                      {w.lastRunAt ? fmtDateTime(w.lastRunAt) : "never"}
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
