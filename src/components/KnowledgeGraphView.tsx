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
  MAX_TAG_CHOICES,
  capGraph,
  coerceGraphSettings,
  defaultGraphSettings,
  expandGraph,
  filterGraph,
  graphTags,
  localGraph,
  noteNodeId,
  parseGraphQuery,
  tagGroupId,
  tagGroupQuery,
  tagGroups,
  type GraphGroup,
  type GraphTag,
  type GraphView,
  type KnowledgeGraph,
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

const EMPTY_GRAPH: KnowledgeGraph = {
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
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<KnowledgeGraphSettings>(defaultGraphSettings);
  /** Nothing is written back until the stored value has been read in. */
  const hydrated = useRef(false);
  /**
   * Whether the colour groups are still owed their tag seed.
   *
   * Decided by whether anything was *stored*, not by whether the list is empty:
   * an operator who removed every group has an entry, and putting the tags back
   * on their next visit would be undoing an edit for them. The first visit is
   * the one moment nobody has expressed a preference yet. Cleared when the
   * fetch settles, whichever way it settles — see both branches below.
   */
  const seedable = useRef(false);

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
    seedable.current = stored === null;
    hydrated.current = true;
  }, []);

  useEffect(() => {
    // Held back while a seed is still owed, or the defaults would be written
    // the moment this mounts and the *next* visit would find an entry — which
    // is what says somebody has been here — and never seed at all.
    if (!hydrated.current || seedable.current) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await jsonRequest<KnowledgeGraphDTO>(GRAPH_URL);
      if (!live) return;
      if (res.ok) {
        /* The edges arrive as positions in `nodes` — see `KnowledgeGraphEdgeDTO`
           — and `expandGraph` throws on one that is out of range. Reported here
           as the fetch failing, because a graph this browser cannot make sense
           of and a graph it could not fetch leave the operator in the same
           place, and the alternative is an unhandled rejection under a panel
           that goes on saying it is loading. */
        let expanded: KnowledgeGraph;
        try {
          expanded = expandGraph(res.data);
        } catch (err) {
          setError(pollFailureMessage(null, err instanceof Error ? err.message : String(err)));
          seedable.current = false;
          return;
        }
        setGraph(expanded);
        setError(null);
        /* The seed, and the one moment it can happen: nobody has been here
           before and this is the first sight of the vault. Both halves are
           needed — seeding off an empty `graph` would write "no groups" as a
           preference nobody expressed, and seeding on a later visit would put
           back groups somebody had removed. */
        if (seedable.current) {
          seedable.current = false;
          const seeded = tagGroups(graphTags(expanded));
          if (seeded.length > 0) {
            setSettings((s) => (s.groups.length > 0 ? s : { ...s, groups: seeded }));
          }
        }
      } else {
        setError(pollFailureMessage(res.status, res.error));
        // Settled, unseeded, and that releases the hold above: a vault this
        // browser cannot reach must not cost the operator their slider
        // positions for as long as it stays unreachable.
        seedable.current = false;
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

  /* Off the whole graph rather than off `shown`: a colour group paints a note
     by the tags it carries whether or not tag *nodes* are drawn, and
     `showTags` is off by default — a tag list that emptied when somebody
     turned the nodes off would look like a vault that had lost its tags. */
  const tags = useMemo(() => graphTags(graph ?? EMPTY_GRAPH), [graph]);

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

      {/* No `className="mb-3"` on either: `Notice` already states `mb-4`, and
          two margin utilities on one element resolve by stylesheet order rather
          than by what the caller wrote: `.mb-3` is emitted at byte 11483 of
          the sheet against `.mb-4` at 11578, so the caller's 12px was a silent
          no-op that read as a decision. */}
      {error && <Notice tone="warn">{error}</Notice>}

      {graph?.truncated && (
        <Notice tone="warn" quiet>
          The vault walk hit its cap, so this graph is drawn from part of the
          vault rather than all of it.
        </Notice>
      )}

      {/* The canvas is the wide half at every width the panel can sit beside it
          — below `lg` the panel goes underneath, because a 19rem column of
          sliders next to a 12rem canvas is neither.

          4:3 is the box's *floor*, not its size, and that is what the sizer
          below is for. A ratio is what a viewport is for a graph — the height
          follows the width the pane actually has, where a figure like `32rem`
          was a portrait window on a phone and a letterbox on a wide one, and
          the shape of the box decides how much of a force layout is on screen
          at a given zoom. It is deliberately not a `vh`: a box inside the pane
          is never sized in viewport units, because the pane is the window less
          the toolbar less its own padding. But the panel beside it is taller
          than 4:3 of the canvas column at every width that fits the two side by
          side, so a fixed ratio left a few hundred pixels of empty card under
          the graph and the row's height was decided by a column of sliders.

          Both children sit in the same single grid cell: the sizer, which is
          `self-start` so it contributes its ratio to the row and never takes
          the row's height back, and the graph, which stretches to whatever the
          row ends up being. `align-content` on a grid is `stretch`, so a lone
          auto row grows to fill the card — and the card is itself a stretched
          item of the outer grid, so what it fills is the taller of the two
          columns. Stacked below `lg` there is no second column and the ratio is
          all there is, which is where it belongs. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,19rem)]">
        <Card emphasis="quiet" className="grid">
          <div
            aria-hidden
            className="pointer-events-none col-start-1 row-start-1 aspect-[4/3] self-start"
          />
          {localUnavailable ? (
            <div className="col-start-1 row-start-1 flex items-center justify-center">
              <Empty>Open a note to see the graph around it.</Empty>
            </div>
          ) : shown.nodes.length === 0 ? (
            <div className="col-start-1 row-start-1 flex items-center justify-center">
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
              className="col-start-1 row-start-1 rounded-sm border border-line"
            />
          )}
        </Card>

        <GraphPanel
          settings={settings}
          tags={tags}
          onChange={update}
          onReset={() => setSettings(defaultGraphSettings())}
          hasNote={focusId !== null}
        />
      </div>

      <p className="mt-2 text-xs text-ink-muted">
        {/* The count is gated on the fetch, not defaulted to 0: "0 of 0 drawn"
            under a loading skeleton is a measurement of an empty vault, and a
            reader who saw it before the walk finished had no way to tell it
            apart from the real thing. */}
        {graph !== null && (
          <>
            {shown.nodes.length.toLocaleString()} of {graph.nodes.length.toLocaleString()} drawn.
            {shown.dropped > 0 && (
              <>
                {" "}
                {shown.dropped.toLocaleString()} past the {MAX_DRAWN_NODES.toLocaleString()}-node
                drawing cap were left out, least-linked first. Narrow the filters to see them.
              </>
            )}{" "}
          </>
        )}
        Drag to pan, scroll to zoom, drag a node to place it, click one to open the note.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

function GraphPanel({
  settings,
  tags,
  onChange,
  onReset,
  hasNote,
}: {
  settings: KnowledgeGraphSettings;
  /** The vault's tags, most-used first, for the colour groups to be built from. */
  tags: GraphTag[];
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
          {/* The width is on the wrapper, not on the control: `Input` puts a
              caller's class on the `<input>` beside its own `w-full`, and the
              sheet emits `w-full` after `w-44`, so `w-44` never applied. */}
          <div className="w-44">
            <Input
              id="graph-query"
              type="search"
              value={filters.query}
              onChange={(e) => setFilters({ query: e.currentTarget.value })}
              placeholder="tag:#project -archive"
            />
          </div>
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

      <GroupList groups={groups} tags={tags} onChange={setGroups} />

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
  tags,
  onChange,
}: {
  groups: GraphGroup[];
  tags: GraphTag[];
  onChange: (next: GraphGroup[]) => void;
}) {
  const nextId = useRef(0);
  const full = groups.length >= MAX_GROUPS;

  /* A chip finds its group by the query it would write rather than by the id
     it minted, so a group typed out by hand lights the chip too — and a seeded
     one whose query has since been edited stops lighting it, which is the
     honest answer: it no longer paints that tag. */
  const byQuery = new Map(groups.map((g) => [g.query, g] as const));
  const offered = tags.slice(0, MAX_TAG_CHOICES);
  const beyond = tags.length - offered.length;

  /** Unique among siblings, which is all a React key and a colour input need. */
  function freshId(base: string): string {
    if (!groups.some((g) => g.id === base)) return base;
    nextId.current += 1;
    return `${base}-${nextId.current}`;
  }

  function toggleTag(tag: GraphTag) {
    const query = tagGroupQuery(tag.name);
    const at = groups.findIndex((g) => g.query === query);
    if (at >= 0) {
      onChange(groups.filter((_, i) => i !== at));
      return;
    }
    onChange([
      ...groups,
      {
        id: freshId(tagGroupId(tag.name)),
        query,
        color: GROUP_PALETTE[groups.length % GROUP_PALETTE.length],
      },
    ]);
  }

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
      <ListGroup label="Colour groups">
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
              {/* Grows on the wrapper rather than on the control: `Input`'s own
                  `w-full` outranks anything a caller writes about width. */}
              <div className="min-w-0 flex-1">
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
                />
              </div>
              <ButtonRow>
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
      </ListGroup>

      {/* The vault's own tags, already here rather than something to be typed
          out: `tag:` is the one query somebody wants often enough that spelling
          it seven times was the whole friction. Bounded at MAX_TAG_CHOICES
          rather than scrolled — see the constant for why a scroll box would be
          the wrong shape here — and what is past it is still one `tag:` away. */}
      {offered.length > 0 && (
        <div className="mt-2">
          <GroupLabel>Most-used tags</GroupLabel>
          <ButtonRow>
            {offered.map((tag) => {
              const group = byQuery.get(tagGroupQuery(tag.name));
              return (
                <Button
                  key={tag.name}
                  variant={group ? "secondary" : "ghost"}
                  size="compact"
                  aria-pressed={group !== undefined}
                  // An unlit chip is an eighth group; a lit one still turns off.
                  disabled={!group && full}
                  onClick={() => toggleTag(tag)}
                >
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full border border-line-strong"
                    // The one colour here that cannot come from a token: it is
                    // the operator's own hex, out of the colour input above.
                    style={
                      group
                        ? { backgroundColor: group.color, borderColor: group.color }
                        : undefined
                    }
                  />
                  #{tag.name}
                  <span className="tabular-nums text-ink-faint">{tag.count}</span>
                </Button>
              );
            })}
          </ButtonRow>
          {beyond > 0 && (
            <p className="mt-1.5 px-1 text-xs text-ink-faint">
              {beyond.toLocaleString()} more — put <code>tag:</code> in a group to reach one
            </p>
          )}
        </div>
      )}

      <ButtonRow className="mt-1.5">
        <Button variant="secondary" size="compact" disabled={full} onClick={add}>
          Add group
        </Button>
        {full && <span className="text-xs text-ink-faint">{MAX_GROUPS} is the most</span>}
      </ButtonRow>
    </div>
  );
}
