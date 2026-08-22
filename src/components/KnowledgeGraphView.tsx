"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeGraphDTO } from "@/lib/apiTypes";
import { pollFailureMessage } from "@/lib/format";
import { jsonRequest } from "@/lib/jsonRequest";
import {
  GRAPH_RANGES,
  GROUP_PALETTE,
  MAX_DRAWN_NODES,
  MAX_GROUPS,
  capGraph,
  coerceGraphSettings,
  defaultGraphSettings,
  filterGraph,
  localGraph,
  noteNodeId,
  parseGraphQuery,
  type GraphGroup,
  type GraphView,
  type KnowledgeGraphSettings,
} from "@/lib/knowledgeGraph";
import { KnowledgeGraphCanvas } from "@/components/KnowledgeGraphCanvas";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { ColorSwatch, Input, Slider, Switch } from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { GroupLabel, ListGroup, ListRow } from "@/components/ui/List";
import { Notice } from "@/components/ui/Notice";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";

/**
 * The graph region: the canvas, the panel that drives it, and the one fetch
 * both are built from.
 *
 * **One fetch, every kind, no server-side query.** `/api/knowledge/graph`
 * accepts `kinds`, `tag` and `q`, and none of them is used here beyond asking
 * for all four kinds at once. Every control in the panel then narrows what was
 * fetched, in `knowledgeGraph.ts`, in the browser. That is the difference
 * between a toggle that answers in a frame and one that answers in a round
 * trip over a vault walk — and the whole panel is built to be *swept* through,
 * because what it is for is finding the setting that makes a shape appear.
 *
 * **The panel's search is not the page's.** The list above this has its own
 * folder / tag / type / text filters, and the graph deliberately does not read
 * them: the graph's query is the one Obsidian's graph view has, over the whole
 * vault, and a graph silently showing the twenty notes the list happened to be
 * filtered to would be a second view of the vault that disagrees with the first
 * about what is in it. They narrow the same vault from two places on purpose.
 *
 * **Settings live in the browser, not in `Settings`.** This is presentation
 * state for one operator at one screen size — the same class of thing as the
 * sidebar's docked width, the theme and the workflow editor's saved layout,
 * all three of which are already `localStorage`. Putting it on the server would
 * make one person's force sliders everybody's.
 */

const STORAGE_KEY = "uf.knowledge-graph";

/** Every kind, once, and narrowed here rather than on the server. */
const GRAPH_URL = `/api/knowledge/graph?kinds=note,phantom,tag,attachment&limit=${MAX_DRAWN_NODES * 2}`;

const VIEW_OPTIONS: readonly SegmentedOption<GraphView>[] = [
  { value: "global", label: "Whole vault" },
  { value: "local", label: "This note" },
];

const EMPTY_GRAPH: KnowledgeGraphDTO = {
  nodes: [],
  edges: [],
  truncated: false,
  capped: false,
};

/** Two decimals for the sliders that move in hundredths, none for the rest. */
const decimals = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2));

export function KnowledgeGraphView({
  /** The note open in the reader, as a vault-relative path. */
  notePath,
  onOpenNote,
}: {
  notePath: string | null;
  onOpenNote: (path: string) => void;
}) {
  const [graph, setGraph] = useState<KnowledgeGraphDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<KnowledgeGraphSettings>(defaultGraphSettings);
  /** Nothing is written back until the stored value has been read in. */
  const hydrated = useRef(false);

  useEffect(() => {
    // After mount, never during render: the server has no localStorage, so a
    // first paint that read it would disagree with the HTML it is hydrating.
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        setSettings(coerceGraphSettings(JSON.parse(stored)));
      } catch {
        // A corrupt entry is not worth telling anybody about — it is one
        // operator's slider positions, and the defaults are already on screen.
      }
    }
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await jsonRequest<KnowledgeGraphDTO>(GRAPH_URL);
      if (!live) return;
      if (res.ok) {
        setGraph(res.data);
        setError(null);
      } else {
        setError(pollFailureMessage(res.status, res.error));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const focusId = notePath === null ? null : noteNodeId(notePath);

  /* One memo per stage, so a slider that changes nothing upstream of it does
     not re-run the traversal — and so the canvas sees a stable `graph` object
     and does not rebuild its simulation on every keystroke elsewhere. */
  const scoped = useMemo(() => {
    const source = graph ?? EMPTY_GRAPH;
    if (settings.view === "global" || focusId === null) return source;
    return localGraph(source, focusId, settings.local);
  }, [graph, settings.view, settings.local, focusId]);

  const filtered = useMemo(() => filterGraph(scoped, settings.filters), [scoped, settings.filters]);
  const shown = useMemo(() => capGraph(filtered), [filtered]);

  const update = useCallback(
    (patch: (previous: KnowledgeGraphSettings) => KnowledgeGraphSettings) => {
      setSettings(patch);
    },
    [],
  );

  const localUnavailable = settings.view === "local" && focusId === null;

  return (
    <div className="mb-8">
      <CardTitle>Graph</CardTitle>

      {error && (
        <Notice tone="warn" className="mb-3">
          {error}
        </Notice>
      )}

      {graph?.truncated && (
        <Notice tone="warn" quiet className="mb-3">
          The vault walk hit its cap, so this graph is drawn from part of the
          vault rather than all of it.
        </Notice>
      )}

      {/* The canvas is the wide half at every width the panel can sit beside it
          — below `lg` the panel goes underneath, because a 19rem column of
          sliders next to a 12rem canvas is neither. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,19rem)]">
        <Card emphasis="quiet">
          {localUnavailable ? (
            <div className="flex h-[20rem] items-center justify-center">
              <Empty>Open a note to see the graph around it.</Empty>
            </div>
          ) : shown.nodes.length === 0 ? (
            <div className="flex h-[20rem] items-center justify-center">
              <Empty>
                {graph === null ? "Reading the vault's links…" : "Nothing matches these filters."}
              </Empty>
            </div>
          ) : (
            <KnowledgeGraphCanvas
              graph={shown}
              focusId={focusId}
              groups={settings.groups}
              display={settings.display}
              forces={settings.forces}
              onOpenNote={onOpenNote}
              // No background of its own: the canvas is transparent over the
              // card, which is `--bg-raised` — the colour the phantom ring is
              // drawn in so that a hollow node reads as a hole.
              className="h-[32rem] max-md:h-[20rem] rounded-sm border border-line"
            />
          )}
        </Card>

        <GraphPanel
          settings={settings}
          onChange={update}
          onReset={() => setSettings(defaultGraphSettings())}
          hasNote={focusId !== null}
        />
      </div>

      <p className="mt-2 text-xs text-ink-muted">
        {shown.nodes.length.toLocaleString()} of {(graph?.nodes.length ?? 0).toLocaleString()}{" "}
        drawn
        {shown.dropped > 0 && (
          <>
            {" "}
            — {shown.dropped.toLocaleString()} past the {MAX_DRAWN_NODES.toLocaleString()}-node
            drawing cap were left out, least-linked first. Narrow the filters to see them.
          </>
        )}
        . Drag to pan, scroll to zoom, drag a node to place it, click one to open the note.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

function GraphPanel({
  settings,
  onChange,
  onReset,
  hasNote,
}: {
  settings: KnowledgeGraphSettings;
  onChange: (patch: (previous: KnowledgeGraphSettings) => KnowledgeGraphSettings) => void;
  onReset: () => void;
  hasNote: boolean;
}) {
  const { local, filters, groups, display, forces } = settings;

  const setLocal = (patch: Partial<typeof local>) =>
    onChange((s) => ({ ...s, local: { ...s.local, ...patch } }));
  const setFilters = (patch: Partial<typeof filters>) =>
    onChange((s) => ({ ...s, filters: { ...s.filters, ...patch } }));
  const setDisplay = (patch: Partial<typeof display>) =>
    onChange((s) => ({ ...s, display: { ...s.display, ...patch } }));
  const setForces = (patch: Partial<typeof forces>) =>
    onChange((s) => ({ ...s, forces: { ...s.forces, ...patch } }));
  const setGroups = (next: GraphGroup[]) => onChange((s) => ({ ...s, groups: next }));

  return (
    <Card emphasis="default" className="flex flex-col gap-4">
      <SegmentedControl
        options={VIEW_OPTIONS}
        value={settings.view}
        onChange={(view) => onChange((s) => ({ ...s, view }))}
        label="What the graph covers"
      />
      {settings.view === "local" && !hasNote && (
        <Hint tone="warn">Open a note above and the graph follows it</Hint>
      )}

      {settings.view === "local" && (
        <ListGroup label="Around this note">
          <ListRow
            label="Depth"
            description="How many links out from the open note to follow"
            htmlFor="graph-depth"
          >
            <Slider
              id="graph-depth"
              value={local.depth}
              onChange={(depth) => setLocal({ depth })}
              {...GRAPH_RANGES.depth}
              className="w-40"
            />
          </ListRow>
          <ListRow label="Incoming links" htmlFor="graph-incoming">
            <Switch
              id="graph-incoming"
              checked={local.incoming}
              onChange={(incoming) => setLocal({ incoming })}
            />
          </ListRow>
          <ListRow label="Outgoing links" htmlFor="graph-outgoing">
            <Switch
              id="graph-outgoing"
              checked={local.outgoing}
              onChange={(outgoing) => setLocal({ outgoing })}
            />
          </ListRow>
          <ListRow
            label="Neighbour links"
            description="Draw links between the notes around it, not only to it"
            htmlFor="graph-neighbours"
          >
            <Switch
              id="graph-neighbours"
              checked={local.neighbourLinks}
              onChange={(neighbourLinks) => setLocal({ neighbourLinks })}
            />
          </ListRow>
        </ListGroup>
      )}

      <ListGroup
        label="Filters"
        footnote={
          <>
            The search takes <code>-term</code>, <code>&quot;a phrase&quot;</code>,{" "}
            <code>path:</code>, <code>file:</code>, <code>tag:</code> and <code>OR</code>. It
            matches a note&apos;s title, path, tags and aliases — not its body, which is not
            part of the graph.
          </>
        }
      >
        <ListRow label="Search" htmlFor="graph-query">
          <Input
            id="graph-query"
            type="search"
            value={filters.query}
            onChange={(e) => setFilters({ query: e.currentTarget.value })}
            placeholder="tag:#project -archive"
            className="w-44"
          />
        </ListRow>
        <ListRow label="Tags" description="Draw each tag as a node" htmlFor="graph-tags">
          <Switch
            id="graph-tags"
            checked={filters.showTags}
            onChange={(showTags) => setFilters({ showTags })}
          />
        </ListRow>
        <ListRow label="Attachments" htmlFor="graph-attachments">
          <Switch
            id="graph-attachments"
            checked={filters.showAttachments}
            onChange={(showAttachments) => setFilters({ showAttachments })}
          />
        </ListRow>
        <ListRow
          label="Existing files only"
          description="Hide a link's target where no note has been written yet"
          htmlFor="graph-existing"
        >
          <Switch
            id="graph-existing"
            checked={filters.existingOnly}
            onChange={(existingOnly) => setFilters({ existingOnly })}
          />
        </ListRow>
        <ListRow
          label="Orphans"
          description="Notes nothing links to and which link to nothing"
          htmlFor="graph-orphans"
        >
          <Switch
            id="graph-orphans"
            checked={filters.showOrphans}
            onChange={(showOrphans) => setFilters({ showOrphans })}
          />
        </ListRow>
      </ListGroup>

      <GroupList groups={groups} onChange={setGroups} />

      <ListGroup label="Display">
        <ListRow label="Arrows" htmlFor="graph-arrows">
          <Switch
            id="graph-arrows"
            checked={display.arrows}
            onChange={(arrows) => setDisplay({ arrows })}
          />
        </ListRow>
        <ListRow
          label="Label fade"
          description="The zoom a title appears at. 0 shows every label always"
          htmlFor="graph-textfade"
        >
          <Slider
            id="graph-textfade"
            value={display.textFade}
            onChange={(textFade) => setDisplay({ textFade })}
            format={decimals}
            {...GRAPH_RANGES.textFade}
            className="w-40"
          />
        </ListRow>
        <ListRow label="Node size" htmlFor="graph-nodesize">
          <Slider
            id="graph-nodesize"
            value={display.nodeSize}
            onChange={(nodeSize) => setDisplay({ nodeSize })}
            format={decimals}
            {...GRAPH_RANGES.nodeSize}
            className="w-40"
          />
        </ListRow>
        <ListRow label="Link thickness" htmlFor="graph-thickness">
          <Slider
            id="graph-thickness"
            value={display.linkThickness}
            onChange={(linkThickness) => setDisplay({ linkThickness })}
            format={decimals}
            {...GRAPH_RANGES.linkThickness}
            className="w-40"
          />
        </ListRow>
        <ListRow
          label="Animate"
          description="Off freezes the layout where it stands"
          htmlFor="graph-animate"
        >
          <Switch
            id="graph-animate"
            checked={display.animate}
            onChange={(animate) => setDisplay({ animate })}
          />
        </ListRow>
      </ListGroup>

      <ListGroup label="Forces">
        <ListRow label="Center force" htmlFor="graph-center">
          <Slider
            id="graph-center"
            value={forces.center}
            onChange={(center) => setForces({ center })}
            format={decimals}
            {...GRAPH_RANGES.center}
            className="w-40"
          />
        </ListRow>
        <ListRow label="Repel force" htmlFor="graph-repel">
          <Slider
            id="graph-repel"
            value={forces.repel}
            onChange={(repel) => setForces({ repel })}
            format={decimals}
            {...GRAPH_RANGES.repel}
            className="w-40"
          />
        </ListRow>
        <ListRow label="Link force" htmlFor="graph-link">
          <Slider
            id="graph-link"
            value={forces.link}
            onChange={(link) => setForces({ link })}
            format={decimals}
            {...GRAPH_RANGES.link}
            className="w-40"
          />
        </ListRow>
        <ListRow label="Link distance" htmlFor="graph-distance">
          <Slider
            id="graph-distance"
            value={forces.linkDistance}
            onChange={(linkDistance) => setForces({ linkDistance })}
            {...GRAPH_RANGES.linkDistance}
            className="w-40"
          />
        </ListRow>
      </ListGroup>

      {/* At the level of what it resets — the whole panel — rather than inside
          one of the groups, where it would read as resetting that group. */}
      <ButtonRow>
        <Button variant="secondary" size="compact" onClick={onReset}>
          Reset to defaults
        </Button>
      </ButtonRow>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Colour groups                                                       */
/* ------------------------------------------------------------------ */

/**
 * A list rather than a set of rows, because the *order* is the behaviour: the
 * first group whose query a node matches is the colour it gets, so a group that
 * cannot be moved is a rule that cannot be given precedence. The position is
 * drawn as a number for the same reason — with two identical-looking swatches,
 * nothing else on screen says which one wins.
 */
function GroupList({
  groups,
  onChange,
}: {
  groups: GraphGroup[];
  onChange: (next: GraphGroup[]) => void;
}) {
  const nextId = useRef(0);
  const full = groups.length >= MAX_GROUPS;

  function add() {
    nextId.current += 1;
    onChange([
      ...groups,
      {
        // Time-free and collision-free within a session: the list is at most
        // seven long and an id only has to be unique among its siblings.
        id: `group-${groups.length}-${nextId.current}`,
        query: "",
        color: GROUP_PALETTE[groups.length % GROUP_PALETTE.length],
      },
    ]);
  }

  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= groups.length) return;
    const next = [...groups];
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next);
  }

  return (
    <div>
      <GroupLabel>Colour groups</GroupLabel>
      <div className="divide-y divide-line rounded-lg border border-line bg-grouped">
        {groups.length === 0 ? (
          <p className="px-3 py-2 text-xs text-ink-muted">
            A group paints every node its search matches. The first match wins.
          </p>
        ) : (
          groups.map((group, index) => (
            <div key={group.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="w-4 shrink-0 text-xs tabular-nums text-ink-faint">{index + 1}</span>
              <ColorSwatch
                value={group.color}
                onChange={(color) =>
                  onChange(groups.map((g, i) => (i === index ? { ...g, color } : g)))
                }
                label={`Colour for group ${index + 1}`}
              />
              <Input
                value={group.query}
                onChange={(e) =>
                  onChange(
                    groups.map((g, i) =>
                      i === index ? { ...g, query: e.currentTarget.value } : g,
                    ),
                  )
                }
                placeholder="path:Areas"
                aria-label={`Search for group ${index + 1}`}
                aria-invalid={
                  group.query.trim() !== "" && parseGraphQuery(group.query).clauses.length === 0
                }
                className="w-32 min-w-0 flex-1"
              />
              <ButtonRow className="gap-1">
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  Up
                </Button>
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={index === groups.length - 1}
                  onClick={() => move(index, 1)}
                >
                  Down
                </Button>
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => onChange(groups.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              </ButtonRow>
            </div>
          ))
        )}
      </div>
      <ButtonRow className="mt-1.5">
        <Button variant="secondary" size="compact" disabled={full} onClick={add}>
          Add group
        </Button>
        {full && <span className="text-xs text-ink-faint">{MAX_GROUPS} is the most</span>}
      </ButtonRow>
    </div>
  );
}
