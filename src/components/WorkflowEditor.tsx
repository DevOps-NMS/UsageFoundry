"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  MergeStrategyDTO,
  RunTemplateDTO,
  SettingsDTO,
  WorkflowDTO,
  WorkflowNodeKind,
  WorkspaceFolderDTO,
  WorkspaceMountDTO,
} from "@/lib/apiTypes";
import {
  MAX_FAN_OUT,
  MAX_WORKFLOW_NAME,
  MAX_WORKFLOW_NODES,
} from "@/lib/apiTypes";
import {
  draftToGraph,
  linkKey,
  resolveLayout,
  type BlockDraft,
  type LinkDraft,
  type Point,
} from "@/lib/canvasGraph";
import { pctField, pollFailureMessage } from "@/lib/format";
import {
  KIND_LABEL,
  WorkflowCanvas,
  type CanvasSelection,
} from "@/components/WorkflowCanvas";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty, SkeletonText } from "@/components/ui/Card";
import {
  Field,
  Input,
  LimitField,
  Select,
  Textarea,
  Toggle,
} from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";

/**
 * The canvas a workflow is drawn on, and the panel its selection is edited in.
 *
 * **The graph is the whole interaction and nothing stands in for it.** Blocks
 * with nothing in front of them start at once, and several of them is the
 * parallel case — there is no separate thing to model and nothing to call it in
 * the copy. A link carries the two answers the wire needs, and the picker starts
 * on neither: `on-success` terminates a chain the operator meant to run
 * regardless and `on-finish` starts a run on top of a dependency that crashed,
 * so a pre-selected condition is wrong half the time in both directions.
 *
 * **Nothing here decides what a workflow may be.** A loop, a template that has
 * been deleted, a workspace that is not mounted, a folder that cannot be
 * resolved, a block with no task: every one of those is
 * `normalizeWorkflowInput`'s answer, asked over `/api/workflows/validate` while
 * the graph is being drawn and shown in its own words. A second copy of those
 * rules here would be a second set to keep in step, and the day one of them
 * changed the canvas would be confidently wrong about what Save would do.
 *
 * A block names a template for its guards, or names none and takes the guard set
 * in Settings. There is deliberately no permission-mode, per-block budget or
 * isolation control: those decide what an agent may do, and a workflow decides
 * what work to do. The one exception is the workflow-wide budget, which bounds
 * something no per-block guard can see — ten blocks under a $5 block limit is a
 * $50 workflow.
 */

/* ------------------------------------------------------------------ */
/* Where a block sits, which is not part of the graph                  */
/* ------------------------------------------------------------------ */

/**
 * Positions live in this browser, keyed by workflow id, and never in the graph.
 *
 * The alternative — an `x`/`y` on `WorkflowNode` — makes dragging a block a
 * change to the object `topologicalOrder` reads and `normalizeWorkflowInput`
 * rebuilds, so a cosmetic gesture would bump `updated_at` and land in the same
 * blob as what runs. It also would not survive the trip: the normalizer builds
 * each node from a fixed list of fields, so the coordinates would be dropped in
 * passing and the drag would silently not persist.
 *
 * What that costs is stated rather than absorbed: an arrangement someone made
 * by hand does not follow them to another browser. What does follow is the
 * *layout*, because `autoLayout` derives one from the edges — so a graph saved
 * before this existed opens readable, with no migration in front of it and
 * therefore nothing that could lose an edge on the way in.
 */
const LAYOUT_KEY = "uf.workflow-layout.";

function readLayout(id: string): Record<string, Point> | null {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY + id);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    // Shape-checked loosely and used defensively: `resolveLayout` drops an
    // entry it cannot use, so a stale or hand-edited value costs the derived
    // position rather than a block nobody can find.
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, Point>)
      : null;
  } catch {
    // Disabled storage, a quota, or a private window. A layout is a nicety and
    // its absence is the derived one.
    return null;
  }
}

function writeLayout(id: string, at: Record<string, Point>): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY + id, JSON.stringify(at));
  } catch {
    /* see readLayout */
  }
}

/* ------------------------------------------------------------------ */
/* Drafts                                                              */
/* ------------------------------------------------------------------ */

const DEFAULT_FAN_OUT = "3";

/** The condition picker, with the unanswered state as a real option. */
const CONDITIONS: Array<{ id: LinkDraft["edge"]; label: string }> = [
  { id: "", label: "Choose a condition" },
  { id: "on-success", label: "Only if it completes" },
  { id: "on-finish", label: "Once it finishes, either way" },
];

/**
 * How a merge block lands, before anyone picks.
 *
 * `merge` rather than `settings.landStrategy`: what the graph records has to be
 * what the operator was shown, and this editor does not read settings. Of the
 * two, this is also the one git can still see afterwards — a squash rewrites the
 * commits, so the branch is never an ancestor of its target and `deleteBranch`
 * has to fall back to `-D`.
 */
const DEFAULT_MERGE_STRATEGY: MergeStrategyDTO = "merge";

function emptyBlock(id: string, mountId: string, kind: WorkflowNodeKind): BlockDraft {
  return {
    id,
    name: "",
    kind,
    templateId: "",
    mountId,
    folder: "",
    task: "",
    promptOverride: "",
    fanOut: DEFAULT_FAN_OUT,
    mergeStrategy: DEFAULT_MERGE_STRATEGY,
    mergeAutoResolve: false,
  };
}

function toBlocks(workflow: WorkflowDTO): BlockDraft[] {
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
    mergeStrategy: n.mergeStrategy ?? DEFAULT_MERGE_STRATEGY,
    mergeAutoResolve: n.mergeAutoResolve ?? false,
  }));
}

function toLinks(workflow: WorkflowDTO): LinkDraft[] {
  return workflow.edges.map((e) => ({
    from: e.from,
    to: e.to,
    edge: e.edge,
    continueBranch: e.continueBranch,
  }));
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

export function WorkflowEditor({
  workflow,
}: {
  /** Null for a new workflow; a saved one is edited in place. */
  workflow: WorkflowDTO | null;
}) {
  const router = useRouter();

  const [name, setName] = useState(workflow?.name ?? "");
  const [blocks, setBlocks] = useState<BlockDraft[]>(() =>
    workflow ? toBlocks(workflow) : [],
  );
  const [links, setLinks] = useState<LinkDraft[]>(() =>
    workflow ? toLinks(workflow) : [],
  );
  const [dragged, setDragged] = useState<Record<string, Point>>({});
  const [selection, setSelection] = useState<CanvasSelection | null>(null);

  // The workflow-wide limits. Held as strings for the reason the run form's
  // are: "" is how a number input says "off", and `normalizeInstanceBudget`
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
   * `!ceilings`.
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

  /** What `normalizeWorkflowInput` says about the graph as it stands. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** Why the question could not be asked, which is not the same as an answer. */
  const [unchecked, setUnchecked] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // Ids are minted on an action, never during render: `crypto.randomUUID()` in
  // a state initialiser differs between the server pass and hydration and React
  // silently keeps one of them. Seeded past the highest suffix already in the
  // graph rather than from the block count, because a saved workflow that has
  // had blocks removed has gaps.
  const nextId = useRef(
    Math.max(
      0,
      ...blocks.map((b) => Number(/^block-(\d+)$/.exec(b.id)?.[1] ?? 0)),
    ) + 1,
  );

  /* ---------------------------------------------------------------- */
  /* Layout                                                            */
  /* ---------------------------------------------------------------- */

  // Read after mount rather than in a state initialiser: there is no
  // localStorage during the server render of /workflows/new, and a value that
  // differs between the two passes is a hydration mismatch.
  const hydrated = useRef(false);
  useEffect(() => {
    if (workflow) setDragged(readLayout(workflow.id) ?? {});
    hydrated.current = true;
  }, [workflow]);

  useEffect(() => {
    if (!workflow || !hydrated.current) return;
    // Coalesced, because a drag writes a position per pointer move and this is
    // synchronous storage on the same thread as the canvas.
    const timer = setTimeout(() => writeLayout(workflow.id, dragged), 400);
    return () => clearTimeout(timer);
  }, [workflow, dragged]);

  const positions = useMemo(
    () => resolveLayout(blocks, links, dragged),
    [blocks, links, dragged],
  );

  /* ---------------------------------------------------------------- */
  /* What the install offers                                           */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch("/api/templates", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/folders", { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(([t, f]) => {
        if (!live) return;
        setTemplates((t.templates ?? []) as RunTemplateDTO[]);
        setMounts((f.mounts ?? []) as WorkspaceMountDTO[]);
        setFolders((f.folders ?? []) as WorkspaceFolderDTO[]);
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

  // Separate from the pair above and deliberately not blocking `loaded`: this
  // decides whether one warning renders, so a slow or failed read must not hold
  // the editor back or turn into an error banner over it.
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

  const defaultMount = useCallback(
    () => (mounts.find((m) => m.available) ?? mounts[0])?.id ?? "",
    [mounts],
  );

  const templateName = useCallback(
    (id: string) => templates.find((t) => t.id === id)?.name ?? null,
    [templates],
  );

  const foldersFor = useCallback(
    (mountId: string) => folders.filter((f) => f.mountId === mountId),
    [folders],
  );

  /* ---------------------------------------------------------------- */
  /* Editing the graph                                                 */
  /* ---------------------------------------------------------------- */

  const addBlock = useCallback(
    (kind: WorkflowNodeKind, at: Point) => {
      const id = `block-${nextId.current++}`;
      setBlocks((prev) => [...prev, emptyBlock(id, defaultMount(), kind)]);
      setDragged((prev) => ({ ...prev, [id]: at }));
      setSelection({ kind: "block", id });
    },
    [defaultMount],
  );

  const updateBlock = useCallback((id: string, patch: Partial<BlockDraft>) => {
    setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }, []);

  const removeBlock = useCallback((id: string) => {
    setBlocks((prev) => prev.filter((b) => b.id !== id));
    // A link to a block that has gone is a link to nothing, and the server
    // refuses one — so it goes with the block rather than waiting to be
    // discovered at Save.
    setLinks((prev) => prev.filter((l) => l.from !== id && l.to !== id));
    setDragged((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSelection((prev) =>
      prev?.kind === "block" && prev.id === id ? null : prev,
    );
  }, []);

  const moveBlock = useCallback((id: string, at: Point) => {
    setDragged((prev) => ({ ...prev, [id]: at }));
  }, []);

  const connect = useCallback((from: string, to: string) => {
    setLinks((prev) =>
      prev.some((l) => l.from === from && l.to === to)
        ? prev
        : // Drawn with no condition, and it stays that way until the operator
          // answers: see `CONDITIONS`.
          [...prev, { from, to, edge: "", continueBranch: false }],
    );
    setSelection({ kind: "link", from, to });
  }, []);

  const updateLink = useCallback(
    (from: string, to: string, patch: Partial<LinkDraft>) => {
      setLinks((prev) =>
        prev.map((l) =>
          l.from === from && l.to === to ? { ...l, ...patch } : l,
        ),
      );
    },
    [],
  );

  const removeLink = useCallback((from: string, to: string) => {
    setLinks((prev) => prev.filter((l) => !(l.from === from && l.to === to)));
    setSelection((prev) =>
      prev?.kind === "link" && prev.from === from && prev.to === to
        ? null
        : prev,
    );
  }, []);

  /* ---------------------------------------------------------------- */
  /* What the server says about it                                     */
  /* ---------------------------------------------------------------- */

  const body = useMemo(
    () => ({
      name,
      graph: draftToGraph({ blocks, links }),
      instanceBudget: {
        maxInstanceCostUSD: costCapped ? maxInstanceCostUSD : "",
        maxSessionFraction,
        maxWeeklyFraction,
      },
    }),
    [
      name,
      blocks,
      links,
      costCapped,
      maxInstanceCostUSD,
      maxSessionFraction,
      maxWeeklyFraction,
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    setChecking(true);
    // Debounced rather than per keystroke: the check reads every template and
    // resolves every block's folder, which is a syscall per block.
    const timer = setTimeout(() => {
      fetch("/api/workflows/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            error?: string;
          };
          if (!res.ok) {
            setUnchecked(pollFailureMessage(res.status, data.error));
            return;
          }
          setUnchecked(null);
          setRefusal(data.ok ? null : (data.error ?? null));
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          // Not a refusal: the graph has not been judged at all, and saying
          // nothing here would read as "this is fine".
          setUnchecked(
            pollFailureMessage(null, err instanceof Error ? err.message : null),
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setChecking(false);
        });
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [body]);

  /* ---------------------------------------------------------------- */
  /* Saving                                                            */
  /* ---------------------------------------------------------------- */

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        workflow ? `/api/workflows/${workflow.id}` : "/api/workflows",
        {
          method: workflow ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        workflow?: WorkflowDTO;
        error?: string;
      };
      if (!res.ok || !data.workflow) {
        throw new Error(data.error ?? `Save failed (${res.status})`);
      }
      // A new workflow's id only exists now, and the arrangement was made
      // against it — written before the navigation so the detail page's Edit
      // link opens on the layout that was just drawn.
      writeLayout(data.workflow.id, dragged);
      router.push(`/workflows/${data.workflow.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  const selectedBlock =
    selection?.kind === "block"
      ? blocks.find((b) => b.id === selection.id)
      : undefined;
  const selectedLink =
    selection?.kind === "link"
      ? links.find((l) => l.from === selection.from && l.to === selection.to)
      : undefined;

  const nameOf = useCallback(
    (id: string) => {
      const block = blocks.find((b) => b.id === id);
      return block?.name.trim() || id;
    },
    [blocks],
  );

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

        <WorkflowCanvas
          blocks={blocks}
          links={links}
          positions={positions}
          selection={selection}
          full={blocks.length >= MAX_WORKFLOW_NODES}
          onSelect={setSelection}
          onMove={moveBlock}
          onAddBlock={addBlock}
          onConnect={connect}
          onRemoveLink={removeLink}
        />
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>
            {selectedBlock
              ? KIND_LABEL[selectedBlock.kind]
              : selectedLink
                ? "Link"
                : "Nothing selected"}
          </CardTitle>

          {!selectedBlock && !selectedLink && (
            <Empty>
              <div className="text-ink-muted">
                Choose a block or a link on the canvas
              </div>
            </Empty>
          )}

          {selectedBlock && !loaded && (
            <>
              <span className="sr-only">Reading workspaces and templates…</span>
              <SkeletonText lines={4} />
            </>
          )}

          {selectedBlock && loaded && (
            <BlockPanel
              block={selectedBlock}
              templates={templates}
              templateName={templateName}
              mounts={mounts}
              folders={foldersFor(selectedBlock.mountId)}
              onChange={(patch) => updateBlock(selectedBlock.id, patch)}
              onRemove={() => removeBlock(selectedBlock.id)}
            />
          )}

          {selectedLink && (
            <LinkPanel
              link={selectedLink}
              fromName={nameOf(selectedLink.from)}
              toName={nameOf(selectedLink.to)}
              onChange={(patch) =>
                updateLink(selectedLink.from, selectedLink.to, patch)
              }
              onRemove={() => removeLink(selectedLink.from, selectedLink.to)}
            />
          )}
        </Card>

        <Card emphasis="quiet">
          <CardTitle>Limits for the whole workflow</CardTitle>

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
              <Input
                id="wf-sess"
                type="number"
                min={1}
                max={100}
                placeholder="off"
                value={maxSessionFraction}
                onChange={(e) => setMaxSessionFraction(e.target.value)}
                className="tabular-nums"
                unit="%"
              />
              {maxSessionFraction && ceilings?.session === false && (
                <Hint tone="warn">
                  No 5-hour ceiling is set and the account&rsquo;s own percentage
                  is switched off, so this guard has nothing to measure and Run
                  will refuse the workflow
                </Hint>
              )}
            </Field>

            <Field label="Stop at weekly usage" htmlFor="wf-week">
              <Input
                id="wf-week"
                type="number"
                min={1}
                max={100}
                placeholder="off"
                value={maxWeeklyFraction}
                onChange={(e) => setMaxWeeklyFraction(e.target.value)}
                className="tabular-nums"
                unit="%"
              />
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
        </Card>
      </div>

      {/* The server's own sentence, asked while the graph is being drawn. Save
          is deliberately left enabled: this check is advisory and can itself be
          unreachable, and a disabled Save behind a failed advisory check strands
          the operator with no way to find out what the authority thinks. */}
      <div className="mt-4" role="status" aria-live="polite">
        {unchecked ? (
          <Notice tone="warn">{unchecked}</Notice>
        ) : refusal ? (
          <Notice tone="warn" className={checking ? "opacity-70" : ""}>
            {refusal}
          </Notice>
        ) : null}
      </div>

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

/* ------------------------------------------------------------------ */
/* The panel beside the canvas                                         */
/* ------------------------------------------------------------------ */

function BlockPanel({
  block,
  templates,
  templateName,
  mounts,
  folders,
  onChange,
  onRemove,
}: {
  block: BlockDraft;
  templates: RunTemplateDTO[];
  templateName: (id: string) => string | null;
  mounts: WorkspaceMountDTO[];
  folders: WorkspaceFolderDTO[];
  onChange: (patch: Partial<BlockDraft>) => void;
  onRemove: () => void;
}) {
  const mount = mounts.find((m) => m.id === block.mountId);
  const missingTemplate =
    block.templateId !== "" && templateName(block.templateId) === null;
  const orchestrator = block.kind === "orchestrator";
  // A merge block holds none of the fields below the kind picker: no guards,
  // because it starts no agent; no workspace or folder, because it works in
  // whichever repository each branch came from; and no task, because what it
  // lands is whatever the blocks in front of it left behind.
  const merge = block.kind === "merge";

  return (
    <>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Name" htmlFor={`${block.id}-name`}>
          <Input
            id={`${block.id}-name`}
            value={block.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="Update dependencies"
          />
        </Field>

        <Field label="Block" htmlFor={`${block.id}-kind`}>
          <Select
            id={`${block.id}-kind`}
            value={block.kind}
            onChange={(e) =>
              onChange({ kind: e.target.value as WorkflowNodeKind })
            }
          >
            {(Object.keys(KIND_LABEL) as WorkflowNodeKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {orchestrator && (
        <Field label="Most runs it may start" htmlFor={`${block.id}-fanout`}>
          <Input
            id={`${block.id}-fanout`}
            type="number"
            min={1}
            max={MAX_FAN_OUT}
            className="tabular-nums"
            value={block.fanOut}
            onChange={(e) => onChange({ fanOut: e.target.value })}
          />
          <Hint tone="warn">
            What this block decides on starts with no approval — this number is
            the whole of what you are agreeing to
          </Hint>
        </Field>
      )}

      {merge && (
        <>
          <Field label="How to land" htmlFor={`${block.id}-strategy`}>
            <Select
              id={`${block.id}-strategy`}
              value={block.mergeStrategy}
              onChange={(e) =>
                onChange({ mergeStrategy: e.target.value as MergeStrategyDTO })
              }
            >
              <option value="merge">Merge commit</option>
              <option value="squash">Squash</option>
            </Select>
            <Hint>
              Each branch goes onto the target its own run recorded, not one
              named here
            </Hint>
          </Field>

          <Field label="Conflicts">
            <Toggle
              id={`${block.id}-autoresolve`}
              checked={block.mergeAutoResolve}
              onChange={(next) => onChange({ mergeAutoResolve: next })}
              label="Let Claude resolve a conflict"
            />
            <Hint tone={block.mergeAutoResolve ? "warn" : "neutral"}>
              {block.mergeAutoResolve
                ? "Saving this is the authorisation — a conflict is reconciled on the run's own branch, and it is billed"
                : "A conflicting branch is reported and left alone"}
            </Hint>
          </Field>

          <Hint tone="warn">
            Your own checkout must be clean and on the target branch, or this
            block refuses that repository
          </Hint>
        </>
      )}

      {!merge && (
        <>
      <Field
        label={orchestrator ? "Guards for the runs it starts" : "Guards"}
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
          onChange={(e) => onChange({ templateId: e.target.value })}
        >
          <option value="">Guards from Settings</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          {missingTemplate && (
            <option value={block.templateId}>{block.templateId} (deleted)</option>
          )}
        </Select>
      </Field>

      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Workspace" htmlFor={`${block.id}-mount`}>
          <Select
            id={`${block.id}-mount`}
            value={block.mountId}
            // The folder belongs to the mount, so it cannot survive the mount
            // changing under it.
            onChange={(e) => onChange({ mountId: e.target.value, folder: "" })}
          >
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
            orchestrator
              ? "Where it looks; the runs it starts must be in this workspace"
              : block.folder === ""
                ? "The whole workspace — no other run in it can start meanwhile"
                : undefined
          }
          hintTone={!orchestrator && block.folder === "" ? "warn" : "neutral"}
        >
          <Select
            id={`${block.id}-folder`}
            value={block.folder}
            onChange={(e) => onChange({ folder: e.target.value })}
            disabled={!mount}
          >
            <option value="">
              {mount ? `${mount.label} — the whole workspace` : "—"}
            </option>
            {folders.map((f) => (
              <option key={f.path} value={f.path}>
                {f.path}
                {f.isGitRepo ? "  (git)" : ""}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        label={orchestrator ? "What to decide" : "Task"}
        htmlFor={`${block.id}-task`}
      >
        <Textarea
          id={`${block.id}-task`}
          value={block.task}
          onChange={(e) => onChange({ task: e.target.value })}
          placeholder={
            orchestrator
              ? "What this block should look at, and what makes a piece of work worth starting."
              : "What this block asks the agent to do."
          }
        />
      </Field>

      <Field
        label={
          orchestrator
            ? "Standing instructions for the runs it starts"
            : "Standing instructions"
        }
        htmlFor={`${block.id}-prompt`}
        hint="Replaces the template's own prompt"
      >
        <Textarea
          id={`${block.id}-prompt`}
          value={block.promptOverride}
          onChange={(e) => onChange({ promptOverride: e.target.value })}
          className="min-h-[64px]"
        />
      </Field>
        </>
      )}

      <ButtonRow className="mt-4 border-t border-line pt-3.5">
        <Button variant="ghost" size="compact" onClick={onRemove}>
          Remove block
        </Button>
      </ButtonRow>
    </>
  );
}

function LinkPanel({
  link,
  fromName,
  toName,
  onChange,
  onRemove,
}: {
  link: LinkDraft;
  fromName: string;
  toName: string;
  onChange: (patch: Partial<LinkDraft>) => void;
  onRemove: () => void;
}) {
  const id = linkKey(link).replace(/[^A-Za-z0-9_-]/g, "-");
  return (
    <>
      <p className="mb-3.5 text-sm text-ink">
        <strong className="font-semibold">{toName}</strong> starts after{" "}
        <strong className="font-semibold">{fromName}</strong>
      </p>

      <Field
        label="Condition"
        htmlFor={`${id}-edge`}
        hint={
          link.edge === ""
            ? "Neither answer is a safe default, so this one is yours to make"
            : undefined
        }
        hintTone={link.edge === "" ? "warn" : "neutral"}
      >
        <Select
          id={`${id}-edge`}
          value={link.edge}
          onChange={(e) =>
            onChange({ edge: e.target.value as LinkDraft["edge"] })
          }
        >
          {CONDITIONS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>

      {/* No `label` on the Field: the Toggle carries its own, and a second one
          above it would leave the switch with two names and no clear one. */}
      <Field
        hint={`${toName} commits onto ${fromName}'s branch instead of cutting its own`}
      >
        <Toggle
          id={`${id}-branch`}
          checked={link.continueBranch}
          onChange={(next) => onChange({ continueBranch: next })}
          label="Carry on its branch"
        />
      </Field>

      <ButtonRow className="mt-4 border-t border-line pt-3.5">
        <Button variant="ghost" size="compact" onClick={onRemove}>
          Remove link
        </Button>
      </ButtonRow>
    </>
  );
}
