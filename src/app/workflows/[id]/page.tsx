"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type {
  RunTemplateDTO,
  WorkflowDTO,
  WorkflowInstanceDTO,
} from "@/lib/apiTypes";
import { fmtDateTime, fmtPct, fmtUSD, pollFailureMessage } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty, SkeletonText } from "@/components/ui/Card";
import { Notice } from "@/components/ui/Notice";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/Table";

const POLL_MS = 10_000;

const CONDITION_LABEL: Record<"on-success" | "on-finish", string> = {
  "on-success": "only if it completes",
  "on-finish": "once it finishes",
};

export default function WorkflowPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();

  const [workflow, setWorkflow] = useState<WorkflowDTO | null>(null);
  const [instances, setInstances] = useState<WorkflowInstanceDTO[]>([]);
  const [templates, setTemplates] = useState<RunTemplateDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"run" | "duplicate" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workflows/${id}`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as {
        workflow?: WorkflowDTO;
        instances?: WorkflowInstanceDTO[];
        error?: string;
      };
      if (!res.ok || !data.workflow) {
        setPollError(
          pollFailureMessage(res.status, data.error ?? "no workflow in the response"),
        );
        return;
      }
      setWorkflow(data.workflow);
      setInstances(data.instances ?? []);
      setPollError(null);
    } catch (err) {
      setPollError(
        pollFailureMessage(null, err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setLoaded(true);
    }
  }, [id]);

  useEffect(() => {
    load();
    const poll = setInterval(load, POLL_MS);
    return () => clearInterval(poll);
  }, [load]);

  useEffect(() => {
    fetch("/api/templates", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setTemplates((d.templates ?? []) as RunTemplateDTO[]))
      .catch(() => {
        /* the block list falls back to naming the id — see `guardLabel` */
      });
  }, []);

  const waitsFor = useMemo(() => {
    const map = new Map<
      string,
      Array<{ from: string; name: string; edge: string; branch: boolean }>
    >();
    if (!workflow) return map;
    const names = new Map(workflow.nodes.map((n) => [n.id, n.name]));
    for (const e of workflow.edges) {
      const list = map.get(e.to) ?? [];
      list.push({
        from: e.from,
        name: names.get(e.from) ?? e.from,
        edge: CONDITION_LABEL[e.edge],
        branch: e.continueBranch,
      });
      map.set(e.to, list);
    }
    return map;
  }, [workflow]);

  /**
   * Which guard set a block runs under, in the operator's words.
   *
   * A template that has been deleted is called out here rather than left to the
   * refusal at Run: this page is where the graph is read, and "the guards this
   * block names are gone" is the one thing on it that stops the whole workflow.
   */
  function guardLabel(templateId: string | null): {
    text: string;
    missing: boolean;
  } {
    if (templateId === null) return { text: "Settings guards", missing: false };
    const found = templates.find((t) => t.id === templateId);
    return found
      ? { text: found.name, missing: false }
      : { text: "template deleted", missing: true };
  }

  async function act(
    kind: "run" | "duplicate" | "delete",
    path: string,
    method: string,
  ) {
    setBusy(kind);
    setActionError(null);
    try {
      const res = await fetch(path, { method });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        instance?: WorkflowInstanceDTO;
        workflow?: WorkflowDTO;
      };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);

      if (kind === "run" && data.instance) {
        router.push(`/workflows/${id}/instances/${data.instance.id}`);
        return;
      }
      if (kind === "duplicate" && data.workflow) {
        router.push(`/workflows/${data.workflow.id}`);
        return;
      }
      if (kind === "delete") {
        router.push("/workflows");
        return;
      }
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (!loaded) {
    return (
      <Card emphasis="quiet">
        <span className="sr-only">Reading this workflow…</span>
        <SkeletonText lines={4} />
      </Card>
    );
  }

  if (!workflow) {
    return (
      <>
        <div role="alert">
          {pollError && <Notice tone="danger">{pollError}</Notice>}
        </div>
        <Card emphasis="quiet">
          <Empty>
            <div className="font-medium text-ink">No such workflow</div>
            <div className="mt-3">
              <Link href="/workflows">Back to workflows</Link>
            </div>
          </Empty>
        </Card>
      </>
    );
  }

  return (
    <>
      <div className="mb-6">
        <Link href="/workflows" className="text-sm text-ink-muted">
          ← Workflows
        </Link>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{workflow.name}</h1>
          <ButtonRow>
            <Button
              onClick={() => act("run", `/api/workflows/${id}/run`, "POST")}
              busy={busy === "run"}
              disabled={busy !== null}
            >
              Run
            </Button>
            <Link
              href={`/workflows/${id}/edit`}
              className="ui-transition inline-flex min-h-[var(--control-h-lg)] items-center rounded-sm border border-line-strong bg-inset px-3.5 py-1.5 text-sm font-medium text-ink no-underline hover:border-ink-faint hover:bg-surface hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Edit
            </Link>
            <Button
              variant="secondary"
              onClick={() =>
                act("duplicate", `/api/workflows/${id}/duplicate`, "POST")
              }
              busy={busy === "duplicate"}
              disabled={busy !== null}
            >
              Duplicate
            </Button>
            <Button
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              disabled={busy !== null || confirmDelete}
            >
              Delete
            </Button>
          </ButtonRow>
        </div>
      </div>

      <div role="alert">
        {pollError && <Notice tone="danger">{pollError}</Notice>}
        {actionError && (
          <Notice tone="danger" live>
            {actionError}
          </Notice>
        )}
      </div>

      {confirmDelete && (
        <Notice tone="danger" live>
          <div className="mb-2">
            Deleting “{workflow.name}” removes the graph and the record of what
            it started. The runs themselves are untouched.
          </div>
          <ButtonRow>
            <Button
              variant="danger"
              size="compact"
              onClick={() => act("delete", `/api/workflows/${id}`, "DELETE")}
              busy={busy === "delete"}
            >
              Delete workflow
            </Button>
            <Button
              variant="ghost"
              size="compact"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
          </ButtonRow>
        </Notice>
      )}

      {(workflow.liveRunCount ?? 0) > 0 && (
        <Notice tone="info">
          {workflow.liveRunCount} run(s) from this workflow have not finished. It
          cannot be started again until they do.
        </Notice>
      )}

      {/* Above the blocks, because it is the one thing on this page that bounds
          all of them, and because Run is the next thing pressed. */}
      <CardTitle>Limits for the whole workflow</CardTitle>
      <Card emphasis="quiet">
        <ul className="m-0 list-none space-y-1 p-0 text-sm text-ink-muted">
          <li>
            {workflow.instanceBudget.maxInstanceCostUSD === null
              ? "No spending limit across the blocks"
              : `Stops after ${fmtUSD(workflow.instanceBudget.maxInstanceCostUSD)} across the blocks`}
          </li>
          <li>
            {workflow.instanceBudget.maxSessionFraction === null
              ? "No 5-hour window guard"
              : `Stops at ${fmtPct(workflow.instanceBudget.maxSessionFraction)} of the 5-hour window`}
          </li>
          <li>
            {workflow.instanceBudget.maxWeeklyFraction === null
              ? "No weekly window guard"
              : `Stops at ${fmtPct(workflow.instanceBudget.maxWeeklyFraction)} of the weekly window`}
          </li>
        </ul>
      </Card>

      <CardTitle className="mt-8">Blocks</CardTitle>
      <Card emphasis="primary">
        <TableWrap>
          <Table>
            <caption className="sr-only">
              The blocks of this workflow, and what each one waits for
            </caption>
            <thead>
              <tr>
                <Th scope="col" className="w-[40px]" />
                <Th scope="col" className="w-full">
                  Block
                </Th>
                <Th scope="col" className="w-[180px]">
                  Guards
                </Th>
                <Th scope="col" className="w-[260px]">
                  Starts after
                </Th>
              </tr>
            </thead>
            <tbody>
              {workflow.nodes.map((n, i) => {
                const guards = guardLabel(n.templateId);
                const waits = waitsFor.get(n.id) ?? [];
                return (
                  <Tr key={n.id}>
                    <Td num className="align-top text-ink-faint">
                      {i + 1}
                    </Td>
                    <Td className="align-top">
                      <div className="font-medium text-ink">{n.name}</div>
                      <div className="mono mt-0.5 text-ink-muted">
                        {n.mountId} / {n.folder || "."}
                      </div>
                      <div className="mt-1 max-w-[56ch] truncate text-ink-muted" title={n.task}>
                        {n.task}
                      </div>
                    </Td>
                    <Td className="align-top">
                      <Badge tone={guards.missing ? "danger" : "neutral"}>
                        {guards.text}
                      </Badge>
                    </Td>
                    <Td className="align-top text-ink-muted">
                      {waits.length === 0 ? (
                        "nothing — starts immediately"
                      ) : (
                        <ul className="m-0 list-none p-0">
                          {/* Keyed by the source block's id: two blocks may
                              carry the same name, and only the id is unique. */}
                          {waits.map((w) => (
                            <li key={w.from}>
                              {w.name} ({w.edge})
                              {w.branch && (
                                <span className="text-accent">
                                  {" "}
                                  · carries on its branch
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      </Card>

      <div className="mt-8">
        <CardTitle>Runs of this workflow</CardTitle>
        <Card emphasis="quiet">
          {instances.length === 0 ? (
            <Empty>
              <div className="text-ink-muted">This workflow has not been run.</div>
            </Empty>
          ) : (
            <TableWrap>
              <Table>
                <caption className="sr-only">
                  Every press of Run, newest first
                </caption>
                <thead>
                  <tr>
                    <Th scope="col" className="w-[180px]">
                      Started
                    </Th>
                    <Th scope="col" className="w-full">
                      Outcome
                    </Th>
                    <Th scope="col" num className="w-[88px]">
                      Blocks
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {instances.map((inst) => (
                    <Tr key={inst.id}>
                      <Td className="whitespace-nowrap align-top">
                        <Link
                          href={`/workflows/${id}/instances/${inst.id}`}
                          className="font-medium text-ink hover:text-accent"
                        >
                          {fmtDateTime(inst.createdAt)}
                        </Link>
                      </Td>
                      <Td className="align-top text-ink-muted">
                        {inst.status === "failed" && (
                          <>
                            <Badge tone="danger">not started</Badge>{" "}
                            {inst.error}
                          </>
                        )}
                        {inst.status === "started" && (
                          <Badge tone="ok">started</Badge>
                        )}
                        {inst.status === "stopping" && (
                          <>
                            <Badge tone="warn">stopping</Badge>{" "}
                            {inst.liveRunCount} block(s) still finishing
                          </>
                        )}
                        {inst.status === "stopped" && (
                          <>
                            <Badge tone="warn">stopped</Badge>{" "}
                            {inst.stopCause === "guard"
                              ? "by its budget guard"
                              : "by you"}
                          </>
                        )}
                      </Td>
                      <Td num className="align-top text-ink-muted">
                        {inst.nodes.length}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </Card>
      </div>
    </>
  );
}
