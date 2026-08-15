"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type {
  RunTemplateDTO,
  WorkflowDTO,
  WorkflowInstanceDTO,
} from "@/lib/apiTypes";
import {
  fmtDateTime,
  fmtPct,
  fmtUSD,
  guardBadge,
  pollFailureMessage,
} from "@/lib/format";
import { jsonRequest } from "@/lib/jsonRequest";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty, SkeletonText } from "@/components/ui/Card";
import { ListGroup, ListRow } from "@/components/ui/List";
import { Notice } from "@/components/ui/Notice";
import { Sheet } from "@/components/ui/Sheet";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/Table";
import { WorkflowSchedule } from "@/components/WorkflowSchedule";

const POLL_MS = 10_000;

const CONDITION_LABEL: Record<"on-success" | "on-finish", string> = {
  "on-success": "only if it completes",
  "on-finish": "once it finishes",
};

/**
 * A limit's value at the right edge of its row.
 *
 * "No limit" is dimmed and a configured one is not, because the difference
 * between them is the whole reason this list is on the page a press of Run
 * happens from — and a row of three identically-weighted sentences does not
 * carry it.
 */
function LimitValue({ set, children }: { set: boolean; children: ReactNode }) {
  return (
    <span className={`text-sm ${set ? "text-ink" : "text-ink-faint"}`}>
      {children}
    </span>
  );
}

export default function WorkflowPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();

  const [workflow, setWorkflow] = useState<WorkflowDTO | null>(null);
  const [instances, setInstances] = useState<WorkflowInstanceDTO[]>([]);
  // Null until the list has been read, and null for good if it cannot be:
  // `guardBadge` reads that as "unknown", where `[]` reads as "every template
  // this graph names has been deleted".
  const [templates, setTemplates] = useState<RunTemplateDTO[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
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
    // Through `jsonRequest` because a 401 or a 500 with a body resolves
    // `r.json()` perfectly happily: read with a bare `.catch`, a refusal landed
    // on the success branch as an empty list, which is the reading that called
    // every block's template deleted. There is no retry here, so the sentence
    // says what to do about it.
    let live = true;
    void jsonRequest<{ templates?: RunTemplateDTO[] }>("/api/templates").then((res) => {
      if (!live) return;
      if (!res.ok) {
        setTemplatesError(
          `The guard sets could not be read — ${
            res.error ??
            (res.status === null
              ? "the server could not be reached"
              : `the server answered ${res.status}`)
          }. Reload to check them.`,
        );
        return;
      }
      setTemplates(res.data.templates ?? []);
      setTemplatesError(null);
    });
    return () => {
      live = false;
    };
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
      // The sheet closes however this ended. `actionError` renders behind the
      // modal, so one left open over a failure shows an enabled, un-busy
      // "Delete workflow" and nothing saying the last press did not work.
      setConfirmDelete(false);
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
            {/* `ButtonLink`, not a hand-rolled anchor: this one wore --bg-inset,
                which is the recess a text field sits in, so it read as the same
                object as an input at a glance. A bezeled control is --bezel. */}
            <ButtonLink href={`/workflows/${id}/edit`} variant="secondary">
              Edit
            </ButtonLink>
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
            {/* Not disabled by `confirmDelete`: that lands in the same commit
                that opens the sheet, so the button is blurred to <body> before
                `showModal()` records what to restore focus to — and Esc would
                then drop the operator at the top of the page. The sheet is
                modal, so a second press is impossible anyway. */}
            <Button
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              disabled={busy !== null}
            >
              Delete
            </Button>
          </ButtonRow>
        </div>
      </div>

      <div role="alert">
        {pollError && <Notice tone="danger">{pollError}</Notice>}
        {/* Warn rather than danger: the graph and Run are unaffected, and the
            only thing lost is the check on whether a block's template is still
            there. */}
        {templatesError && <Notice tone="warn">{templatesError}</Notice>}
        {actionError && (
          <Notice tone="danger" live>
            {actionError}
          </Notice>
        )}
      </div>

      {/* A sheet rather than a panel under the toolbar, for the reason the
          branch purge is one: the browser gives the top layer, the inert page
          behind it and the focus trap, and a destructive sheet opens with
          Cancel focused so one Return is not a confirmation. */}
      <Sheet
        open={confirmDelete}
        onDismiss={() => setConfirmDelete(false)}
        title={`Delete “${workflow.name}”?`}
        confirmLabel="Delete workflow"
        confirmVariant="danger"
        busy={busy === "delete"}
        onConfirm={() => act("delete", `/api/workflows/${id}`, "DELETE")}
      >
        This removes the graph and the record of what it started. The runs
        themselves are untouched.
      </Sheet>

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
        {/* Three rows of a grouped list rather than three sentences in a
            bulleted block: the value is what is being checked, so it belongs at
            the right edge where the eye can run down it. */}
        <ListGroup>
          <ListRow label="Spending across the blocks">
            <LimitValue set={workflow.instanceBudget.maxInstanceCostUSD !== null}>
              {workflow.instanceBudget.maxInstanceCostUSD === null
                ? "No limit"
                : `Stops after ${fmtUSD(workflow.instanceBudget.maxInstanceCostUSD)}`}
            </LimitValue>
          </ListRow>
          <ListRow label="5-hour window">
            <LimitValue set={workflow.instanceBudget.maxSessionFraction !== null}>
              {workflow.instanceBudget.maxSessionFraction === null
                ? "No guard"
                : `Stops at ${fmtPct(workflow.instanceBudget.maxSessionFraction)}`}
            </LimitValue>
          </ListRow>
          <ListRow label="Weekly window">
            <LimitValue set={workflow.instanceBudget.maxWeeklyFraction !== null}>
              {workflow.instanceBudget.maxWeeklyFraction === null
                ? "No guard"
                : `Stops at ${fmtPct(workflow.instanceBudget.maxWeeklyFraction)}`}
            </LimitValue>
          </ListRow>
        </ListGroup>
      </Card>

      {/* Directly under the limits it depends on, and above the blocks, for the
          reason those limits are above them: this is the control that presses
          Run, and what it may spend is the sentence immediately before it. */}
      <WorkflowSchedule
        workflowId={id}
        schedule={workflow.schedule ?? null}
        onChanged={load}
      />

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
                const guards = guardBadge(n.templateId, templates);
                const waits = waitsFor.get(n.id) ?? [];
                return (
                  <Tr key={n.id}>
                    <Td num className="align-top text-ink-faint">
                      {i + 1}
                    </Td>
                    <Td className="align-top">
                      <div className="font-medium text-ink">{n.name}</div>
                      {n.kind === "orchestrator" && (
                        // Said on the row rather than only in the editor: this
                        // is the page an operator presses Run from, and a block
                        // that starts up to N agents on its own judgement is
                        // not something to find out about afterwards.
                        <div className="mt-0.5 text-warn">
                          Decides what to run — starts up to {n.fanOut} run(s)
                          with no approval
                        </div>
                      )}
                      {n.kind === "merge" && (
                        // Same reasoning: this is the one block that writes into
                        // the operator's own checkout, and the one that can bill
                        // for a resolution nobody is watching.
                        <div
                          className={`mt-0.5 ${n.mergeAutoResolve ? "text-warn" : "text-accent"}`}
                        >
                          Lands every branch in front of it
                          {n.mergeStrategy === "squash" ? ", squashed" : ""}
                          {n.mergeAutoResolve
                            ? " — a conflict is resolved by Claude, and billed"
                            : " — a conflicting branch is left alone"}
                        </div>
                      )}
                      {n.kind !== "merge" && (
                        <>
                          <div className="mono mt-0.5 text-ink-muted">
                            {n.mountId} / {n.folder || "."}
                          </div>
                          <div
                            className="mt-1 max-w-[56ch] truncate text-ink-muted"
                            title={n.task}
                          >
                            {n.task}
                          </div>
                        </>
                      )}
                    </Td>
                    <Td className="align-top">
                      <Badge tone={guards.tone}>{guards.text}</Badge>
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
                    {/* Runs, not blocks: an orchestrator block's own runs are
                        in here too, and they are not in the saved graph. */}
                    <Th scope="col" num className="w-[88px]">
                      Runs
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
                          <>
                            <Badge tone="ok">started</Badge>{" "}
                            {/* An instance with nothing live has finished in
                                every sense the machinery has — there is no
                                `completed` status to write, so the count is
                                what says which of the two this is. */}
                            {inst.liveRunCount > 0
                              ? `${inst.liveRunCount} block(s) working`
                              : "nothing still working"}
                          </>
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
                              : inst.stopCause === "fleet"
                                ? "with everything in flight"
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
