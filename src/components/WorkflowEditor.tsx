"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import type {
  AgentDTO,
  AmbientAgentDTO,
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
  MAX_LOOP_PASSES,
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
import {
  describeAmbientAgents,
  fmtUSD,
  pctField,
  pctSubmit,
  pollFailureMessage,
} from "@/lib/format";
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
  Switch,
  Textarea,
} from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { ListGroup, ListRow } from "@/components/ui/List";
import { Notice } from "@/components/ui/Notice";

/**
 * The canvas a workflow is drawn on, and the inspector its selection is edited
 * in.
 *
 * **The graph is the whole interaction and nothing stands in for it.** Blocks
 * with nothing in front of them start at once, and several of them is the
 * parallel case — there is no separate thing to model and nothing to call it in
 * the copy. A link carries the two answers the wire needs, and the picker starts
 * on neither: `on-success` terminates a chain the operator meant to run
 * regardless and `on-finish` starts a run on top of a dependency that crashed,
 * so a pre-selected condition is wrong half the time in both directions.
 *
 * **Nothing here decides what a workflow may be.** A cycle, a template that has
 * been deleted, a workspace that is not mounted, a folder that cannot be
 * resolved, a block with no task, a loop block whose guards give it no checkout
 * of its own to carry between passes: every one of those is
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
 *
 * The agent picker is not a second exception, and its placement says so: it
 * sits with the work rather than in the guards group, because a saved agent
 * holds no tool list and no permission mode — it decides who the block's child
 * *is* and never what it may do. That is a larger claim than it was while the
 * flag was `--agents`, and it survives the move for the same reason it was made:
 * `--agent` sets a system prompt and a fallback model, and every guard on the
 * block is argued somewhere else. It is the block's own and never its
 * template's, for the reason the workspace picker is; `WorkflowNode.agentId`
 * has it in full. Beside it is the sentence the run form also carries: the
 * registry is a *part* of the set of agents in play and never the whole of it,
 * because the mounted `~/.claude` reaches every child this app spawns.
 *
 * The inspector is a sticky column beside the canvas rather than a form under
 * it, which is what a canvas app on this platform does — but the reason it
 * matters here is that the operator is reading the graph and the block's guards
 * at the same time. `BlockStatement` is that pairing made explicit: every block
 * says in one sentence which guard set applies, where it runs, how many runs it
 * may start and whether it may pay to reconcile a conflict. That sentence is
 * what a press of Run is approved against, so it is prose rather than a row of
 * controls to be read off.
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
const DEFAULT_MAX_PASSES = "3";

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

/** The width a control takes in the inspector's rows. See `ui/Field`'s note:
 *  a width never goes on the control, because two width utilities on one
 *  element resolve by stylesheet order rather than class order. */
const ROW_CONTROL = "w-44";
const ROW_CONTROL_NARROW = "w-24";

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
    agentId: "",
    fanOut: DEFAULT_FAN_OUT,
    mergeStrategy: DEFAULT_MERGE_STRATEGY,
    mergeAutoResolve: false,
    maxPasses: DEFAULT_MAX_PASSES,
    maxLoopCostUSD: "",
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
    agentId: n.agentId ?? "",
    fanOut: n.fanOut?.toString() ?? DEFAULT_FAN_OUT,
    mergeStrategy: n.mergeStrategy ?? DEFAULT_MERGE_STRATEGY,
    mergeAutoResolve: n.mergeAutoResolve ?? false,
    maxPasses: n.maxPasses?.toString() ?? DEFAULT_MAX_PASSES,
    // Null is "no cap", and a number field says that with "" — never a 0, which
    // `normalizeWorkflowInput` reads as off but a reader would take for a limit.
    maxLoopCostUSD: n.maxLoopCostUSD?.toString() ?? "",
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
  // The saved registry and the definitions on disk this app did not write, off
  // one payload so no two surfaces can describe the set differently.
  // `agentsLoaded` is what tells "this block names an agent that is gone" from
  // "the list has not arrived yet" — the second must not raise the first.
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [ambientAgents, setAmbientAgents] = useState<AmbientAgentDTO[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
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

  // Separate from the pair above for that pair's reason, and it decides what a
  // picker offers rather than only a warning: a failed read leaves the list
  // empty and `agentsLoaded` false, so a block naming an agent is never
  // reported as naming a missing one on the strength of a list that never
  // arrived. Save still refuses it by name, which is the answer that guards
  // anything.
  useEffect(() => {
    let live = true;
    fetch("/api/agents", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        setAgents((d.agents ?? []) as AgentDTO[]);
        setAmbientAgents((d.ambient ?? []) as AmbientAgentDTO[]);
        setAgentsLoaded(true);
      })
      .catch(() => {
        /* see above; the picker stays empty and the server still decides */
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

  // The sentence the run form's picker carries too, from one place — see
  // `describeAmbientAgents`.
  const ambientLine = useMemo(
    () => describeAmbientAgents(ambientAgents),
    [ambientAgents],
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
        // Sent as 0–1 fractions rather than the 0–100 the fields show, the
        // same conversion the run form makes: normalizeInstanceBudget's frac()
        // reads a bare 1 as 100%, so a "1" typed into a field labelled % would
        // otherwise be stored as the whole window.
        maxSessionFraction: pctSubmit(maxSessionFraction),
        maxWeeklyFraction: pctSubmit(maxWeeklyFraction),
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
      {/* No heading here: the page that mounts this carries its own <h1>, the
          same division the rest of the shell keeps. */}
      <div role="alert">{error && <Notice tone="danger" live>{error}</Notice>}</div>

      {/* The split. The canvas is the pane — it is what this page is for — and
          the inspector beside it holds whatever is selected plus the one limit
          that bounds the whole graph. Column and row are placed explicitly
          rather than left to source order, so on a narrow window the canvas
          leads and the inspector follows it. */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_26rem] lg:items-start">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
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
            onRemoveBlock={removeBlock}
          />

          {/* The server's own sentence, asked while the graph is being drawn.
              Save is deliberately left enabled: this check is advisory and can
              itself be unreachable, and a disabled Save behind a failed
              advisory check strands the operator with no way to reach the
              authority at all. */}
          <div className="mt-4" role="status" aria-live="polite">
            {unchecked ? (
              <Notice tone="warn">{unchecked}</Notice>
            ) : refusal ? (
              <Notice tone="warn" className={checking ? "opacity-70" : ""}>
                {refusal}
              </Notice>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:col-start-2 lg:row-start-1 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(var(--pane-h)-6rem)] lg:overflow-y-auto">
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
                agents={agents}
                agentsLoaded={agentsLoaded}
                ambientLine={ambientLine}
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
                offLabel="No limit"
                min={0}
                step="0.5"
              />
              <Hint>
                {costCapped
                  ? "Everything every block spends, together — each block still has its own limits from its guards"
                  : "Only the per-block guards bound this workflow, so ten blocks under a $5 block limit is a $50 workflow"}
              </Hint>
            </Field>

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

            <Hint>
              Checked before a block starts a work cycle and again as each block
              finishes, never during one — a block already working carries on
              until it or another reaches one of those boundaries, so the total
              can overshoot by up to one work cycle per block running at the
              time, and blocks running at once multiply that
            </Hint>
          </Card>
        </div>
      </div>

      {/* The pane's footer, in the run form's and Settings' shape: the default
          action at the right edge of the pane it belongs to, and one line
          saying what pressing it does. */}
      <div className="sticky bottom-0 z-10 -mx-4 -mb-12 mt-5 border-t border-line bg-canvas px-4 py-3 shadow-bar sm:-mx-5 sm:px-5">
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <p
            role="status"
            aria-atomic="true"
            className="mr-auto min-h-5 basis-full text-xs leading-5 text-ink-faint sm:basis-auto"
          >
            {saving
              ? "Saving the graph…"
              : "Saves the graph. Nothing starts until you press Run on it."}
          </p>
          <Button
            variant="secondary"
            onClick={() =>
              router.push(workflow ? `/workflows/${workflow.id}` : "/workflows")
            }
          >
            Cancel
          </Button>
          <Button onClick={save} busy={saving}>
            {workflow ? "Save changes" : "Create workflow"}
          </Button>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* The inspector                                                       */
/* ------------------------------------------------------------------ */

/**
 * What this block is, in a sentence.
 *
 * The controls under it are how it is changed; this is what it *says*, and it
 * is the copy a press of Run is approved against — which guard set applies (or
 * that it is the untemplated one from Settings), where it runs, which saved
 * agent its child is started as, how many runs a deciding block may start with
 * nobody looking, how many times a repeating one may start one and what those
 * passes may spend together, and whether a merge block may pay a model to
 * reconcile a conflict. Every one of those is a fact somebody would otherwise
 * have to assemble by reading five separate pickers.
 *
 * It is deliberately not a warning: an orchestrator block's fan-out, a loop
 * block's pass cap and a merge block's authorisation are ordinary properties of
 * a block that was configured that way. The tone is on the number itself, where
 * it belongs.
 */
function BlockStatement({
  block,
  guards,
  where,
  asAgent,
}: {
  block: BlockDraft;
  guards: ReactNode;
  where: ReactNode;
  /**
   * The agent this block's own child is started as, or null.
   *
   * Stated rather than implied, because this sentence is what a press of Run is
   * approved against — and stated *outside* the guard clause, because an agent
   * bounds nothing: it holds no tool list and no permission mode, and a phrase
   * inside "under …" would claim it does. That placement was re-decided when
   * the flag became `--agent`, not carried over: being the run rather than a
   * helper inside it makes this a bigger fact and not a different *kind* of
   * fact, so it belongs in its own clause and still not under "under".
   */
  asAgent: ReactNode | null;
}) {
  if (block.kind === "merge") {
    return (
      <p className="mb-3.5 text-sm leading-normal text-ink-muted">
        Lands every branch in front of it onto the target that branch&rsquo;s own
        run recorded,{" "}
        <strong className="font-semibold text-ink">
          {block.mergeStrategy === "squash" ? "squashed" : "as a merge commit"}
        </strong>
        .{" "}
        {block.mergeAutoResolve ? (
          <span className="text-warn">
            A conflict is reconciled by Claude on the run&rsquo;s own branch, and
            billed.
          </span>
        ) : (
          "A conflicting branch is reported and left alone."
        )}
      </p>
    );
  }

  if (block.kind === "orchestrator") {
    const cap = Number(block.fanOut);
    return (
      <p className="mb-3.5 text-sm leading-normal text-ink-muted">
        Decides in {where}, and starts{" "}
        {Number.isFinite(cap) && cap > 0 ? (
          <strong className="font-semibold text-warn">
            up to {cap} run{cap === 1 ? "" : "s"}
          </strong>
        ) : (
          <strong className="font-semibold text-danger">
            an unstated number of runs
          </strong>
        )}{" "}
        with no approval — each under {guards}.
        {asAgent && <> It decides as {asAgent}.</>}
      </p>
    );
  }

  if (block.kind === "loop") {
    const passes = Number(block.maxPasses);
    const spend = Number(block.maxLoopCostUSD);
    // "" is off, so the sentence names the spending cap only where there is one
    // — a clause saying "and no limit on what they spend together" would put a
    // permanent alarm on the ordinary loop, whose pass cap already ends it.
    const capped =
      block.maxLoopCostUSD !== "" && Number.isFinite(spend) && spend > 0;
    return (
      <p className="mb-3.5 text-sm leading-normal text-ink-muted">
        Repeats in {where}, each pass a whole run under {guards}
        {asAgent ? <>, as {asAgent}</> : null}. It stops when the agent reports
        the work complete, when a pass does not complete,{" "}
        {capped ? "after " : "or after "}
        {Number.isInteger(passes) && passes > 0 ? (
          <strong className="font-semibold text-warn">
            {passes} pass{passes === 1 ? "" : "es"}
          </strong>
        ) : (
          <strong className="font-semibold text-danger">
            an unstated number of passes
          </strong>
        )}
        {capped && (
          <>
            , or once they have spent{" "}
            <strong className="font-semibold text-warn">{fmtUSD(spend)}</strong>{" "}
            between them
          </>
        )}
        .
      </p>
    );
  }

  return (
    <p className="mb-3.5 text-sm leading-normal text-ink-muted">
      Runs in {where}, under {guards}
      {asAgent ? <>, as {asAgent}</> : null}.
    </p>
  );
}

function BlockPanel({
  block,
  templates,
  templateName,
  agents,
  agentsLoaded,
  ambientLine,
  mounts,
  folders,
  onChange,
  onRemove,
}: {
  block: BlockDraft;
  templates: RunTemplateDTO[];
  templateName: (id: string) => string | null;
  agents: AgentDTO[];
  agentsLoaded: boolean;
  ambientLine: string | null;
  mounts: WorkspaceMountDTO[];
  folders: WorkspaceFolderDTO[];
  onChange: (patch: Partial<BlockDraft>) => void;
  onRemove: () => void;
}) {
  const mount = mounts.find((m) => m.id === block.mountId);
  const missingTemplate =
    block.templateId !== "" && templateName(block.templateId) === null;
  const agent = agents.find((a) => a.id === block.agentId) ?? null;
  // Only once the registry has answered — see `agentsLoaded`.
  const missingAgent = block.agentId !== "" && agentsLoaded && agent === null;
  const orchestrator = block.kind === "orchestrator";
  // A loop block holds every field a run block does — it *is* a run block
  // repeated — plus the two caps that make the repetition finite.
  const loop = block.kind === "loop";
  // A merge block holds none of the fields below the kind picker: no guards,
  // because it starts no agent; no workspace or folder, because it works in
  // whichever repository each branch came from; and no task, because what it
  // lands is whatever the blocks in front of it left behind.
  const merge = block.kind === "merge";

  const guards: ReactNode = missingTemplate ? (
    <strong className="font-semibold text-danger">
      a template that has been deleted
    </strong>
  ) : block.templateId === "" ? (
    <strong className="font-semibold text-ink">
      the default guard set in Settings
    </strong>
  ) : (
    <>
      the guards of{" "}
      <strong className="font-semibold text-ink">
        {templateName(block.templateId)}
      </strong>
    </>
  );

  const where: ReactNode = (
    <strong className="mono font-semibold text-ink">
      {mount?.label ?? (block.mountId || "no workspace")}
      {block.folder ? ` / ${block.folder}` : " — the whole workspace"}
    </strong>
  );

  // Null on a block that names none, which is the ordinary block: a sentence
  // saying "and as no agent" would put a permanent phrase on every graph in the
  // app to describe the absence of an option most of them never take.
  const asAgent: ReactNode | null =
    block.agentId === "" ? null : missingAgent ? (
      <strong className="font-semibold text-danger">
        an agent that has been deleted
      </strong>
    ) : agent && !agent.usable ? (
      <strong className="font-semibold text-danger">
        {agent.name}, which Claude Code will not register
      </strong>
    ) : (
      <strong className="font-semibold text-ink">
        {agent?.name ?? "a saved agent"}
      </strong>
    );

  return (
    <>
      <BlockStatement
        block={block}
        guards={guards}
        where={where}
        asAgent={asAgent}
      />

      <ListGroup className="mb-4">
        <ListRow label="Name" htmlFor={`${block.id}-name`}>
          <div className={ROW_CONTROL}>
            <Input
              id={`${block.id}-name`}
              value={block.name}
              onChange={(e) => onChange({ name: e.target.value })}
              placeholder="Update dependencies"
            />
          </div>
        </ListRow>

        <ListRow label="Block" htmlFor={`${block.id}-kind`}>
          <div className={ROW_CONTROL}>
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
          </div>
        </ListRow>
      </ListGroup>

      {orchestrator && (
        <ListGroup
          className="mb-4"
          footnote={
            <span className="text-warn">
              What this block decides on starts with no approval — this number is
              the whole of what you are agreeing to
            </span>
          }
        >
          <ListRow label="Most runs it may start" htmlFor={`${block.id}-fanout`}>
            <div className={ROW_CONTROL_NARROW}>
              <Input
                id={`${block.id}-fanout`}
                type="number"
                min={1}
                max={MAX_FAN_OUT}
                className="tabular-nums"
                value={block.fanOut}
                onChange={(e) => onChange({ fanOut: e.target.value })}
              />
            </div>
          </ListRow>
        </ListGroup>
      )}

      {loop && (
        <ListGroup
          className="mb-4"
          footnote={
            <span className="text-warn">
              Each pass is a whole run, with its own work cycles and its own
              spend — the pass cap is the whole of what you are agreeing to
            </span>
          }
        >
          <ListRow label="Most passes" htmlFor={`${block.id}-passes`}>
            <div className={ROW_CONTROL_NARROW}>
              <Input
                id={`${block.id}-passes`}
                type="number"
                min={1}
                max={MAX_LOOP_PASSES}
                className="tabular-nums"
                value={block.maxPasses}
                onChange={(e) => onChange({ maxPasses: e.target.value })}
              />
            </div>
          </ListRow>

          {/* On the row for the guards picker's reason: it is a fact about what
              this control does, and only a row's description reaches it. */}
          <ListRow
            label="Spending limit across passes"
            htmlFor={`${block.id}-loopcost`}
            description="Checked between passes; it never widens the limit for the whole workflow"
          >
            <div className={ROW_CONTROL}>
              <Input
                id={`${block.id}-loopcost`}
                type="number"
                min={0}
                step="0.5"
                placeholder="off"
                unit="USD"
                className="tabular-nums"
                value={block.maxLoopCostUSD}
                onChange={(e) => onChange({ maxLoopCostUSD: e.target.value })}
              />
            </div>
          </ListRow>
        </ListGroup>
      )}

      {merge && (
        <ListGroup
          className="mb-4"
          footnote={
            <>
              Each branch goes onto the target its own run recorded, not one
              named here. Your own checkout must be clean and on that branch, or
              this block refuses that repository.
            </>
          }
        >
          <ListRow label="How to land" htmlFor={`${block.id}-strategy`}>
            <div className={ROW_CONTROL}>
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
            </div>
          </ListRow>

          <ListRow
            label="Let Claude resolve a conflict"
            htmlFor={`${block.id}-autoresolve`}
            description={
              block.mergeAutoResolve
                ? "Saving this is the authorisation, and it is billed"
                : "A conflicting branch is reported and left alone"
            }
          >
            <Switch
              id={`${block.id}-autoresolve`}
              checked={block.mergeAutoResolve}
              onChange={(next) => onChange({ mergeAutoResolve: next })}
            />
          </ListRow>
        </ListGroup>
      )}

      {!merge && (
        <>
          {/* The conditional sentences ride the *row's* description rather than
              the group's footnote, because that is the one `ListRow` wires to
              the control as `aria-describedby` — a footnote is an unlabelled
              paragraph, so a screen reader hears the picker and not what is
              wrong with what is in it. The standing explanation stays a
              footnote, where it belongs to the group. */}
          <ListGroup
            className="mb-4"
            footnote={
              missingTemplate
                ? undefined
                : block.templateId === ""
                  ? "Budget, permission mode and isolation come from Settings"
                  : "Budget, permission mode and isolation come from that template"
            }
          >
            <ListRow
              label={
                orchestrator
                  ? "Guards for the runs it starts"
                  : loop
                    ? "Guards for each pass"
                    : "Guards"
              }
              htmlFor={`${block.id}-template`}
              description={
                missingTemplate ? (
                  <span role="alert" className="text-danger">
                    That template has been deleted, so Save will refuse this
                    graph — pick another
                  </span>
                ) : undefined
              }
            >
              <div className={ROW_CONTROL}>
                <Select
                  id={`${block.id}-template`}
                  value={block.templateId}
                  aria-invalid={missingTemplate || undefined}
                  onChange={(e) => onChange({ templateId: e.target.value })}
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
              </div>
            </ListRow>
          </ListGroup>

          <ListGroup className="mb-4">
            <ListRow label="Workspace" htmlFor={`${block.id}-mount`}>
              <div className={ROW_CONTROL}>
                <Select
                  id={`${block.id}-mount`}
                  value={block.mountId}
                  // The folder belongs to the mount, so it cannot survive the
                  // mount changing under it.
                  onChange={(e) =>
                    onChange({ mountId: e.target.value, folder: "" })
                  }
                >
                  {mounts.map((m) => (
                    <option key={m.id} value={m.id} disabled={!m.available}>
                      {m.label}
                      {m.available ? "" : "  (not mounted)"}
                    </option>
                  ))}
                </Select>
              </div>
            </ListRow>

            {/* On the row, not in a footnote: this is a fact about what is in
                the picker, and only a row's description reaches the control. */}
            <ListRow
              label="Folder"
              htmlFor={`${block.id}-folder`}
              description={
                orchestrator ? (
                  "Where it looks; the runs it starts must be in this workspace"
                ) : block.folder === "" ? (
                  <span className="text-warn">
                    The whole workspace — no other run in it can start meanwhile
                  </span>
                ) : undefined
              }
            >
              <div className={ROW_CONTROL}>
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
              </div>
            </ListRow>
          </ListGroup>

          {/* A group of its own rather than a row in the guards one, because an
              agent is not a guard: it holds no tool list and no permission
              mode, so a row inside that group would claim it bounds something.
              Shown when there is something to offer — or when this block
              already names one, so a registry that has emptied out cannot hide
              the control that is about to refuse the save. */}
          {(agents.length > 0 || block.agentId !== "") && (
            <ListGroup
              className="mb-4"
              footnote={
                ambientLine ? (
                  <>
                    {ambientLine}. An agent changes what this block&rsquo;s child
                    is, never what it may do.
                  </>
                ) : (
                  "An agent changes what this block's child is, never what it may do"
                )
              }
            >
              <ListRow
                label={
                  orchestrator
                    ? "This turn is"
                    : loop
                      ? "Each pass is"
                      : "This run is"
                }
                htmlFor={`${block.id}-agent`}
                description={
                  missingAgent ? (
                    <span role="alert" className="text-danger">
                      That agent has been deleted, so Save will refuse this
                      graph — pick another, or none
                    </span>
                  ) : agent && !agent.usable ? (
                    <span role="alert" className="text-danger">
                      {agent.name} is missing its description or its prompt, so
                      Claude Code will not register it and the spawn would fail
                    </span>
                  ) : agent ? (
                    agent.description
                  ) : orchestrator ? (
                    "What this block's own deciding turn is started as — the runs it starts name their own"
                  ) : undefined
                }
              >
                <div className={ROW_CONTROL}>
                  <Select
                    id={`${block.id}-agent`}
                    value={block.agentId}
                    aria-invalid={missingAgent || undefined}
                    onChange={(e) => onChange({ agentId: e.target.value })}
                  >
                    <option value="">No agent</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                        {a.usable ? "" : "  (incomplete)"}
                      </option>
                    ))}
                    {/* An id the registry no longer has still selects
                        something, so the control cannot read as "none" while
                        the graph is about to be refused for naming one. */}
                    {missingAgent && (
                      <option value={block.agentId}>
                        {block.agentId} (deleted)
                      </option>
                    )}
                  </Select>
                </div>
              </ListRow>
            </ListGroup>
          )}

          {/* Label above the control rather than beside it, which is the same
              exception the run form and Settings make: a nine-line text region
              has nothing to align a right edge against. */}
          <Field
            label={
              orchestrator ? "What to decide" : loop ? "Task to repeat" : "Task"
            }
            htmlFor={`${block.id}-task`}
            // How the loop *ends*, and it belongs on the field that decides it:
            // `reported_done` is set by the agent printing DONE on a line of its
            // own, so a task that never asks for it can only stop on a cap.
            hint={
              loop
                ? "Every pass gets this same text — ask for DONE when the work is complete, which is what ends the loop"
                : undefined
            }
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
                : loop
                  ? "Standing instructions for every pass"
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
        <span className="text-xs text-ink-faint">or press Delete</span>
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
      <p className="mb-3.5 text-sm leading-normal text-ink-muted">
        <strong className="font-semibold text-ink">{toName}</strong> starts after{" "}
        <strong className="font-semibold text-ink">{fromName}</strong>
        {link.edge === ""
          ? ", once you have said when."
          : link.edge === "on-success"
            ? ", only if it completes."
            : ", once it finishes either way."}
        {link.continueBranch &&
          ` ${toName} commits onto ${fromName}'s branch rather than cutting its own.`}
      </p>

      <ListGroup className="mb-4">
        <ListRow
          label="Condition"
          htmlFor={`${id}-edge`}
          // On the row rather than in a footnote, so it reaches the picker it
          // is about — see the guards group in `BlockPanel`.
          description={
            link.edge === "" ? (
              <span className="text-warn">
                Neither answer is a safe default, so this one is yours to make —
                until it is answered, Save refuses this graph
              </span>
            ) : undefined
          }
        >
          <div className={ROW_CONTROL}>
            <Select
              id={`${id}-edge`}
              value={link.edge}
              aria-invalid={link.edge === "" || undefined}
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
          </div>
        </ListRow>

        <ListRow label="Carry on its branch" htmlFor={`${id}-branch`}>
          <Switch
            id={`${id}-branch`}
            checked={link.continueBranch}
            onChange={(next) => onChange({ continueBranch: next })}
          />
        </ListRow>
      </ListGroup>

      <ButtonRow className="mt-4 border-t border-line pt-3.5">
        <Button variant="ghost" size="compact" onClick={onRemove}>
          Remove link
        </Button>
        <span className="text-xs text-ink-faint">or press Delete</span>
      </ButtonRow>
    </>
  );
}
