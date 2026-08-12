"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  RunTemplateDTO,
  SettingsDTO,
  WorkflowDTO,
  WorkflowEdgeDTO,
  WorkflowNodeDTO,
  WorkflowNodeKind,
  WorkspaceFolderDTO,
  WorkspaceMountDTO,
} from "@/lib/apiTypes";
import {
  MAX_FAN_OUT,
  MAX_WORKFLOW_NAME,
  MAX_WORKFLOW_NODES,
} from "@/lib/apiTypes";
import { pctField } from "@/lib/format";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import {
  Field,
  Input,
  LimitField,
  Select,
  Subsection,
  Textarea,
} from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";

/**
 * The form a workflow is written in.
 *
 * **An ordered list, where a block may wait for any block above it.** That is
 * the whole interaction, and it is not a simplification of the graph — it is
 * the graph: several blocks waiting for nothing is the parallel case, one block
 * waiting for two is a fan-in, and the ordering makes a loop unwritable rather
 * than something to be refused after the fact. The server still checks for one,
 * because the API is reachable without this form.
 *
 * A block names a template for its guards, or names none and takes the guard
 * set in Settings. There is deliberately no permission-mode, per-block budget or
 * isolation control here: those decide what an agent may do, and a workflow
 * decides what work to do.
 *
 * The one exception is the workflow-wide budget at the top, and it is an
 * exception because it bounds something no per-block guard can see: ten blocks
 * under a $5 block limit is a $50 workflow. It is saved with the graph, so the
 * form a person types it into is the only thing that can set it.
 */

/** How a block is held while it is being edited. Edges are per block. */
interface BlockDraft {
  id: string;
  name: string;
  kind: WorkflowNodeKind;
  /** "" means no template: the guard set in Settings. */
  templateId: string;
  mountId: string;
  folder: string;
  task: string;
  promptOverride: string;
  /** Orchestrator blocks only. Held as a string, as every number field here is. */
  fanOut: string;
  waitsFor: Array<{
    from: string;
    edge: WorkflowEdgeDTO["edge"];
    continueBranch: boolean;
  }>;
}

const CONDITIONS: Array<{ id: "" | WorkflowEdgeDTO["edge"]; label: string }> = [
  { id: "", label: "No" },
  { id: "on-success", label: "Only if it completes" },
  { id: "on-finish", label: "Once it finishes, either way" },
];

const DEFAULT_FAN_OUT = "3";

function emptyBlock(id: string, mountId: string): BlockDraft {
  return {
    id,
    name: "",
    kind: "run",
    templateId: "",
    mountId,
    folder: "",
    task: "",
    promptOverride: "",
    fanOut: DEFAULT_FAN_OUT,
    waitsFor: [],
  };
}

function toDrafts(workflow: WorkflowDTO): BlockDraft[] {
  return workflow.nodes.map((n) => ({
    id: n.id,
    name: n.name,
    kind: n.kind ?? "run",
    templateId: n.templateId ?? "",
    mountId: n.mountId,
    folder: n.folder,
    task: n.task,
    promptOverride: n.promptOverride ?? "",
    fanOut: n.fanOut?.toString() ?? DEFAULT_FAN_OUT,
    waitsFor: workflow.edges
      .filter((e) => e.to === n.id)
      .map((e) => ({
        from: e.from,
        edge: e.edge,
        continueBranch: e.continueBranch,
      })),
  }));
}

function toGraph(blocks: BlockDraft[]): {
  nodes: WorkflowNodeDTO[];
  edges: WorkflowEdgeDTO[];
} {
  const nodes: WorkflowNodeDTO[] = blocks.map((b) => ({
    id: b.id,
    name: b.name.trim(),
    kind: b.kind,
    templateId: b.templateId || null,
    mountId: b.mountId,
    folder: b.folder,
    task: b.task,
    promptOverride: b.promptOverride.trim() || null,
    // Null on a run block, and the server refuses a missing one on an
    // orchestrator block rather than defaulting it. A blank field goes over as
    // `NaN`, which is exactly the refusal the operator needs to see.
    fanOut: b.kind === "orchestrator" ? Number(b.fanOut) : null,
  }));
  const edges: WorkflowEdgeDTO[] = blocks.flatMap((b) =>
    b.waitsFor.map((w) => ({
      from: w.from,
      to: b.id,
      edge: w.edge,
      continueBranch: w.continueBranch,
    })),
  );
  return { nodes, edges };
}

export function WorkflowEditor({
  workflow,
}: {
  /** Null for a new workflow; a saved one is edited in place. */
  workflow: WorkflowDTO | null;
}) {
  const router = useRouter();

  const [name, setName] = useState(workflow?.name ?? "");
  const [blocks, setBlocks] = useState<BlockDraft[]>(() =>
    workflow ? toDrafts(workflow) : [emptyBlock("block-1", "")],
  );

  // The workflow-wide limits. Held as strings for the same reason the run
  // form's are: "" is how a number input says "off", and `normalizeInstanceBudget`
  // reads "", 0 and null identically.
  const [costCapped, setCostCapped] = useState(
    (workflow?.instanceBudget.maxInstanceCostUSD ?? null) !== null,
  );
  const [maxInstanceCostUSD, setMaxInstanceCostUSD] = useState(
    workflow?.instanceBudget.maxInstanceCostUSD?.toString() ?? "20",
  );
  const [maxSessionFraction, setMaxSessionFraction] = useState(
    pctField(workflow?.instanceBudget.maxSessionFraction),
  );
  const [maxWeeklyFraction, setMaxWeeklyFraction] = useState(
    pctField(workflow?.instanceBudget.maxWeeklyFraction),
  );
  /**
   * Whether a fraction guard would have anything to measure against.
   *
   * A configured ceiling is one source; the provider's own utilisation is the
   * other, and `windows.ts` prefers it — so "nothing typed in Settings" is not
   * the same as "no reading", and warning on the ceiling alone would nag every
   * install that reads its percentage from Anthropic. Null until Settings
   * answers, which is why the warning renders on `false` rather than on
   * `!ceilings`. The exact answer is the door refusal at Run, which reads a real
   * snapshot.
   */
  const [ceilings, setCeilings] = useState<{
    session: boolean;
    weekly: boolean;
  } | null>(null);
  const [templates, setTemplates] = useState<RunTemplateDTO[]>([]);
  const [mounts, setMounts] = useState<WorkspaceMountDTO[]>([]);
  const [folders, setFolders] = useState<WorkspaceFolderDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Ids are minted on a click, never during render: a value from
  // `crypto.randomUUID()` in a state initialiser differs between the server
  // pass and hydration, and React would silently keep one of them. Seeded past
  // the highest suffix already in the graph rather than from the block count,
  // because a saved workflow that has had blocks removed has gaps — `block-1`
  // and `block-3` would otherwise mint `block-3` again, and the save would come
  // back refusing two blocks with one id.
  const nextId = useRef(
    Math.max(
      0,
      ...blocks.map((b) => Number(/^block-(\d+)$/.exec(b.id)?.[1] ?? 0)),
    ) + 1,
  );

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch("/api/templates", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/folders", { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(([t, f]) => {
        if (!live) return;
        setTemplates((t.templates ?? []) as RunTemplateDTO[]);
        const scanned = (f.mounts ?? []) as WorkspaceMountDTO[];
        setMounts(scanned);
        setFolders((f.folders ?? []) as WorkspaceFolderDTO[]);
        // A new workflow's first block has no workspace yet; give it the first
        // usable one so the folder picker below it is not dead on arrival.
        const first = scanned.find((m) => m.available) ?? scanned[0];
        if (first) {
          setBlocks((prev) =>
            prev.map((b) => (b.mountId ? b : { ...b, mountId: first.id })),
          );
        }
      })
      .catch(() => {
        if (live) setError("The workspace and templates could not be read.");
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, []);

  // Separate from the pair above, and deliberately not blocking `loaded`: this
  // only decides whether one warning renders, so a slow or failed read must not
  // hold the form back or turn into an error banner over it.
  useEffect(() => {
    let live = true;
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const s = d.settings as SettingsDTO | undefined;
        if (!live || !s) return;
        setCeilings({
          session:
            s.planUsageFromApi ||
            s.sessionCostLimit !== null ||
            s.sessionTokenLimit !== null,
          weekly:
            s.planUsageFromApi ||
            s.weeklyCostLimit !== null ||
            s.weeklyTokenLimit !== null,
        });
      })
      .catch(() => {
        /* the warning stays unrendered; Run still refuses by name */
      });
    return () => {
      live = false;
    };
  }, []);

  const templateName = useCallback(
    (id: string) => templates.find((t) => t.id === id)?.name ?? null,
    [templates],
  );

  const update = useCallback((id: string, patch: Partial<BlockDraft>) => {
    setBlocks((prev) =>
      prev.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    );
  }, []);

  const addBlock = useCallback(() => {
    setBlocks((prev) => {
      const id = `block-${nextId.current++}`;
      const mountId = prev.at(-1)?.mountId ?? mounts[0]?.id ?? "";
      return [...prev, emptyBlock(id, mountId)];
    });
  }, [mounts]);

  const removeBlock = useCallback((id: string) => {
    setBlocks((prev) =>
      prev
        .filter((b) => b.id !== id)
        // A link to a block that is gone is a link to nothing, and the server
        // refuses one — so it goes with the block rather than waiting to be
        // discovered at Save.
        .map((b) => ({
          ...b,
          waitsFor: b.waitsFor.filter((w) => w.from !== id),
        })),
    );
  }, []);

  /**
   * Moving a block past one it waits for would make the link point forwards,
   * which this form has no way to show and the graph has no way to satisfy in
   * that order. The link is dropped with the move rather than silently kept.
   */
  const move = useCallback((index: number, delta: number) => {
    setBlocks((prev) => {
      const to = index + delta;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[to]] = [next[to], next[index]];
      const seen = new Set<string>();
      return next.map((b) => {
        const kept = {
          ...b,
          waitsFor: b.waitsFor.filter((w) => seen.has(w.from)),
        };
        seen.add(b.id);
        return kept;
      });
    });
  }, []);

  const setLink = useCallback(
    (blockId: string, from: string, edge: "" | WorkflowEdgeDTO["edge"]) => {
      setBlocks((prev) =>
        prev.map((b) => {
          if (b.id !== blockId) return b;
          if (edge === "") {
            return { ...b, waitsFor: b.waitsFor.filter((w) => w.from !== from) };
          }
          const existing = b.waitsFor.find((w) => w.from === from);
          if (existing) {
            return {
              ...b,
              waitsFor: b.waitsFor.map((w) =>
                w.from === from ? { ...w, edge } : w,
              ),
            };
          }
          return {
            ...b,
            waitsFor: [...b.waitsFor, { from, edge, continueBranch: false }],
          };
        }),
      );
    },
    [],
  );

  /** At most one link per block hands its branch over — the server refuses two. */
  const setContinue = useCallback(
    (blockId: string, from: string, on: boolean) => {
      setBlocks((prev) =>
        prev.map((b) =>
          b.id === blockId
            ? {
                ...b,
                waitsFor: b.waitsFor.map((w) => ({
                  ...w,
                  continueBranch: w.from === from ? on : false,
                })),
              }
            : b,
        ),
      );
    },
    [],
  );

  const foldersFor = useCallback(
    (mountId: string) => folders.filter((f) => f.mountId === mountId),
    [folders],
  );

  const blockName = useMemo(() => {
    const map = new Map<string, string>();
    blocks.forEach((b, i) => map.set(b.id, b.name.trim() || `Block ${i + 1}`));
    return map;
  }, [blocks]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // The three limits go over as typed. `normalizeInstanceBudget` reads "",
      // 0 and a negative all as off, so an emptied field switches a guard off
      // rather than becoming a cap of zero — the rule every budget field here
      // follows.
      const body = JSON.stringify({
        name,
        graph: toGraph(blocks),
        instanceBudget: {
          maxInstanceCostUSD: costCapped ? maxInstanceCostUSD : "",
          maxSessionFraction: maxSessionFraction,
          maxWeeklyFraction: maxWeeklyFraction,
        },
      });
      const res = await fetch(
        workflow ? `/api/workflows/${workflow.id}` : "/api/workflows",
        {
          method: workflow ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body,
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        workflow?: WorkflowDTO;
        error?: string;
      };
      if (!res.ok || !data.workflow) {
        throw new Error(data.error ?? `Save failed (${res.status})`);
      }
      router.push(`/workflows/${data.workflow.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  const full = blocks.length >= MAX_WORKFLOW_NODES;

  return (
    <>
      <div role="alert">{error && <Notice tone="danger" live>{error}</Notice>}</div>

      <Card emphasis="primary">
        <CardTitle>{workflow ? "Edit workflow" : "New workflow"}</CardTitle>

        <Field label="Name" htmlFor="wf-name">
          <Input
            id="wf-name"
            value={name}
            maxLength={MAX_WORKFLOW_NAME}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nightly maintenance"
          />
        </Field>

        <Subsection title="Limits for the whole workflow">
          <Field label="Spending limit" htmlFor="wf-cost">
            <LimitField
              id="wf-cost"
              modeLabel="Workflow spending limit mode"
              enabled={costCapped}
              onEnabledChange={setCostCapped}
              value={maxInstanceCostUSD}
              onValueChange={setMaxInstanceCostUSD}
              unit="USD"
              offLabel="No workflow spending limit"
              min={0}
              step="0.5"
            />
            <Hint>
              {costCapped
                ? "Everything every block spends, together — each block still has its own limits from its guards"
                : "Only the per-block guards bound this workflow, so ten blocks under a $5 block limit is a $50 workflow"}
            </Hint>
          </Field>

          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="Stop at 5-hour usage" htmlFor="wf-sess">
              <div className="flex items-center gap-2">
                <Input
                  id="wf-sess"
                  type="number"
                  min={1}
                  max={100}
                  placeholder="off"
                  value={maxSessionFraction}
                  onChange={(e) => setMaxSessionFraction(e.target.value)}
                  className="min-w-0 flex-1 tabular-nums"
                />
                <span className="whitespace-nowrap text-xs text-ink-muted">
                  %
                </span>
              </div>
              {maxSessionFraction && ceilings?.session === false && (
                <Hint tone="warn">
                  No 5-hour ceiling is set and the account&rsquo;s own percentage
                  is switched off, so this guard has nothing to measure and Run
                  will refuse the workflow
                </Hint>
              )}
            </Field>

            <Field label="Stop at weekly usage" htmlFor="wf-week">
              <div className="flex items-center gap-2">
                <Input
                  id="wf-week"
                  type="number"
                  min={1}
                  max={100}
                  placeholder="off"
                  value={maxWeeklyFraction}
                  onChange={(e) => setMaxWeeklyFraction(e.target.value)}
                  className="min-w-0 flex-1 tabular-nums"
                />
                <span className="whitespace-nowrap text-xs text-ink-muted">
                  %
                </span>
              </div>
              {maxWeeklyFraction && ceilings?.weekly === false && (
                <Hint tone="warn">
                  No weekly ceiling is set and the account&rsquo;s own percentage
                  is switched off, so this guard has nothing to measure and Run
                  will refuse the workflow
                </Hint>
              )}
            </Field>
          </div>

          <Hint>
            Checked before a block starts a work cycle, never during one — a
            block already working carries on until some block reaches a cycle
            boundary, so the total can overshoot by up to one work cycle per
            block running at the time, and blocks running at once multiply that
          </Hint>
          <Hint>
            Blocks that all start at once have no boundary between them, so the
            maximum concurrent runs in Settings is what bounds this
          </Hint>
        </Subsection>

        {blocks.map((block, index) => {
          const earlier = blocks.slice(0, index);
          const mount = mounts.find((m) => m.id === block.mountId);
          const missingTemplate =
            block.templateId !== "" &&
            loaded &&
            templateName(block.templateId) === null;

          return (
            <Subsection
              key={block.id}
              title={
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {index + 1}. {blockName.get(block.id)}
                  </span>
                  <ButtonRow>
                    <Button
                      variant="ghost"
                      size="compact"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move ${blockName.get(block.id)} up`}
                    >
                      Up
                    </Button>
                    <Button
                      variant="ghost"
                      size="compact"
                      onClick={() => move(index, 1)}
                      disabled={index === blocks.length - 1}
                      aria-label={`Move ${blockName.get(block.id)} down`}
                    >
                      Down
                    </Button>
                    <Button
                      variant="ghost"
                      size="compact"
                      onClick={() => removeBlock(block.id)}
                      disabled={blocks.length === 1}
                      aria-label={`Remove ${blockName.get(block.id)}`}
                    >
                      Remove
                    </Button>
                  </ButtonRow>
                </div>
              }
            >
              <div className="grid gap-x-4 sm:grid-cols-2">
                <Field label="Name" htmlFor={`${block.id}-name`}>
                  <Input
                    id={`${block.id}-name`}
                    value={block.name}
                    onChange={(e) => update(block.id, { name: e.target.value })}
                    placeholder="Update dependencies"
                  />
                </Field>

                <Field label="Block" htmlFor={`${block.id}-kind`}>
                  <Select
                    id={`${block.id}-kind`}
                    value={block.kind}
                    onChange={(e) =>
                      update(block.id, {
                        kind: e.target.value as WorkflowNodeKind,
                        // A hand-over needs a branch at both ends and an
                        // orchestrator block has none, so the link goes with
                        // the change rather than being refused at Save.
                        waitsFor: block.waitsFor.map((w) => ({
                          ...w,
                          continueBranch: false,
                        })),
                      })
                    }
                  >
                    <option value="run">Runs a task</option>
                    <option value="orchestrator">Decides what to run</option>
                  </Select>
                </Field>
              </div>

              {block.kind === "orchestrator" && (
                <Field
                  label="Most runs it may start"
                  htmlFor={`${block.id}-fanout`}
                >
                  <Input
                    id={`${block.id}-fanout`}
                    type="number"
                    min={1}
                    max={MAX_FAN_OUT}
                    className="tabular-nums"
                    value={block.fanOut}
                    onChange={(e) =>
                      update(block.id, { fanOut: e.target.value })
                    }
                  />
                  <Hint tone="warn">
                    What this block decides on starts with no approval — this
                    number is the whole of what you are agreeing to
                  </Hint>
                </Field>
              )}

              <Field
                label={block.kind === "orchestrator" ? "Guards for the runs it starts" : "Guards"}
                htmlFor={`${block.id}-template`}
                hint={
                  missingTemplate
                    ? "That template has been deleted — pick another"
                    : block.templateId === ""
                      ? "Budget, permission mode and isolation come from Settings"
                      : undefined
                }
                hintTone={missingTemplate ? "danger" : "neutral"}
              >
                <Select
                  id={`${block.id}-template`}
                  value={block.templateId}
                  onChange={(e) =>
                    update(block.id, { templateId: e.target.value })
                  }
                >
                  <option value="">Guards from Settings</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                  {missingTemplate && (
                    <option value={block.templateId}>
                      {block.templateId} (deleted)
                    </option>
                  )}
                </Select>
              </Field>

              <div className="grid gap-x-4 sm:grid-cols-2">
                <Field label="Workspace" htmlFor={`${block.id}-mount`}>
                  <Select
                    id={`${block.id}-mount`}
                    value={block.mountId}
                    onChange={(e) =>
                      // The folder belongs to the mount, so it cannot survive
                      // the mount changing under it.
                      update(block.id, {
                        mountId: e.target.value,
                        folder: "",
                      })
                    }
                    disabled={!loaded}
                  >
                    {!loaded && <option value="">Loading…</option>}
                    {mounts.map((m) => (
                      <option key={m.id} value={m.id} disabled={!m.available}>
                        {m.label}
                        {m.available ? "" : "  (not mounted)"}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field
                  label="Folder"
                  htmlFor={`${block.id}-folder`}
                  hint={
                    block.kind === "orchestrator"
                      ? "Where it looks; the runs it starts must be in this workspace"
                      : block.folder === ""
                        ? "The whole workspace — no other run in it can start meanwhile"
                        : undefined
                  }
                  hintTone={
                    block.kind === "run" && block.folder === "" ? "warn" : "neutral"
                  }
                >
                  <Select
                    id={`${block.id}-folder`}
                    value={block.folder}
                    onChange={(e) => update(block.id, { folder: e.target.value })}
                    disabled={!mount}
                  >
                    <option value="">
                      {mount ? `${mount.label} — the whole workspace` : "—"}
                    </option>
                    {foldersFor(block.mountId).map((f) => (
                      <option key={f.path} value={f.path}>
                        {f.path}
                        {f.isGitRepo ? "  (git)" : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <Field
                label={block.kind === "orchestrator" ? "What to decide" : "Task"}
                htmlFor={`${block.id}-task`}
              >
                <Textarea
                  id={`${block.id}-task`}
                  value={block.task}
                  onChange={(e) => update(block.id, { task: e.target.value })}
                  placeholder={
                    block.kind === "orchestrator"
                      ? "What this block should look at, and what makes a piece of work worth starting."
                      : "What this block asks the agent to do."
                  }
                />
              </Field>

              <Field
                label={
                  block.kind === "orchestrator"
                    ? "Standing instructions for the runs it starts"
                    : "Standing instructions"
                }
                htmlFor={`${block.id}-prompt`}
                hint="Replaces the template's own prompt"
              >
                <Textarea
                  id={`${block.id}-prompt`}
                  value={block.promptOverride}
                  onChange={(e) =>
                    update(block.id, { promptOverride: e.target.value })
                  }
                  className="min-h-[64px]"
                />
              </Field>

              {earlier.length === 0 ? (
                <p className="text-xs text-ink-muted">
                  {block.kind === "orchestrator"
                    ? "Decides as soon as the workflow starts."
                    : "Starts as soon as its folder is free."}
                </p>
              ) : (
                <fieldset className="border-0 p-0">
                  <legend className="mb-2 text-xs font-medium text-ink-muted">
                    Starts after
                  </legend>
                  {earlier.map((other) => {
                    const link = block.waitsFor.find((w) => w.from === other.id);
                    return (
                      <div
                        key={other.id}
                        className="mb-2 flex flex-wrap items-center gap-2"
                      >
                        <span className="min-w-[12ch] flex-1 truncate text-sm">
                          {blockName.get(other.id)}
                        </span>
                        <Select
                          className="w-auto shrink-0"
                          value={link?.edge ?? ""}
                          onChange={(e) =>
                            setLink(
                              block.id,
                              other.id,
                              e.target.value as "" | WorkflowEdgeDTO["edge"],
                            )
                          }
                          aria-label={`Start ${blockName.get(block.id)} after ${blockName.get(other.id)}`}
                        >
                          {CONDITIONS.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                            </option>
                          ))}
                        </Select>
                        {link &&
                          block.kind === "run" &&
                          other.kind === "run" && (
                          <label className="flex min-h-[var(--control-h)] cursor-pointer items-center gap-1.5 text-xs text-ink-muted">
                            <input
                              type="checkbox"
                              checked={link.continueBranch}
                              onChange={(e) =>
                                setContinue(
                                  block.id,
                                  other.id,
                                  e.target.checked,
                                )
                              }
                            />
                            Carry on its branch
                          </label>
                        )}
                      </div>
                    );
                  })}
                </fieldset>
              )}
            </Subsection>
          );
        })}

        <div className="mt-4 border-t border-line pt-3.5">
          <ButtonRow>
            <Button variant="secondary" onClick={addBlock} disabled={full}>
              Add block
            </Button>
            {full && (
              <span className="text-xs text-ink-muted">
                A workflow runs at most {MAX_WORKFLOW_NODES} blocks
              </span>
            )}
          </ButtonRow>
        </div>
      </Card>

      <ButtonRow className="mt-4">
        <Button onClick={save} busy={saving}>
          {workflow ? "Save changes" : "Create workflow"}
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            router.push(workflow ? `/workflows/${workflow.id}` : "/workflows")
          }
        >
          Cancel
        </Button>
      </ButtonRow>
    </>
  );
}
