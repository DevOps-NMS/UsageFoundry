# Option E — a node-and-edge graph of tools and files

**This is the "VISUAL FLOW TYPE representation" as asked for**, and it is
refused. Not on cost, and not because a canvas is hard — the app has one and its
decisions are written down. It is refused because **the data contains no edge
that makes a graph**, and that is a fact about `run_events` rather than an
opinion about drawing.

## The strongest case for it

**The machinery is two thirds present and genuinely good.**
`src/lib/forceLayout.ts` is a Barnes-Hut quadtree force layout with **no `import`
statement at all** — `SimNode` is `{id,x,y,vx,vy,fx,fy,degree}` (`:37-55`) and
`SimEdge` is a pair of indices (`:59-62`). It is domain-free and reusable
verbatim. `capGraph` (`src/lib/knowledgeGraph.ts:714-729`) needs only
`{id, inDegree, outDegree}`. The hard parts — the quadtree, `THETA`, the alpha
schedule, the reduced-motion burst — are solved.

**A picture is the right instrument for some questions.** "Where did the work
cluster" is a shape question, and a table answers it badly. The operator's
instinct that a run's activity has a *shape* is not wrong.

**And the app has already accepted a canvas once**, so the precedent for the cost
exists (`docs/agent/conventions.md:64`).

## Why it is refused

### 1. Every candidate edge is either a hub spoke or a clique

A graph needs a relation between nodes. `run_events` offers exactly three
candidates and each collapses.

**(a) Tool → file.** Nodes are file paths plus tool names; an edge is "this tool
touched this file". This is **bipartite**, and the left side has roughly a dozen
members — `Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`, `Task`, `WebFetch`
and a handful of MCP tools. Every file has degree 1 to 3. Every tool has degree
in the hundreds. A force layout of that is a dozen stars, and the picture says
"this run did a lot of Reads", which is what `toolComposition.ts` already prints
as a number.

It is worse than uninformative under the cap. `capGraph` prunes **by degree,
largest first** (`knowledgeGraph.ts:719-722`) — it keeps hubs. In a bipartite
tool→file graph the hubs *are* the tool names, so the cap retains the dozen
nodes carrying no information and drops the files that answer the question.
**The one piece of graph plumbing that is nearly generic is generic in the wrong
direction for this data.**

**(b) File → file, by co-occurrence in a work cycle.** The only way to get an
edge between two files is "both were touched in the same cycle", which is a
**clique per cycle**: a cycle touching 40 files is 780 edges. Ten such cycles are
thousands of edges over tens of nodes. That is the definition of a hairball, and
it is one produced by construction rather than by a run being unusually busy.

**(c) File → file, by sequence.** "`Read` A then `Edit` B" gives a directed edge
per adjacent pair. This is a path through the tool call sequence, so its edge
count equals the call count — hundreds — and its shape is a tangle whose only
real structure is time. **Time is an axis, not a topology.** Drawn on an axis it
is [08-option-g](08-option-g-cycle-heatmap.md); drawn as a graph it is the same
information with the one legible dimension thrown away.

**The single genuinely tree-shaped relation in the data is
`parentToolUseId`** (`orchestrator.ts:7586-7588`), and it is a delegation tree
two or three levels deep with a handful of nodes —
[07-option-f](07-option-f-delegation-tree.md), where it is drawn as a list
because that is what a shallow tree is.

### 2. The node count is unverifiable here and hostile at both ends

`MAX_DRAWN_NODES = 2500` (`knowledgeGraph.ts:705`) is the drawable ceiling
([C9](01-constraints.md#c9--graph-scale-has-a-number-and-it-is-not-the-one-in-the-layouts-docblock)).
The brief's premise is a $16 run over a repository with thousands of files.

Both outcomes are bad and neither can be checked from here — `/data` is empty
([00-problem.md](00-problem.md#what-this-survey-could-not-do)), so **the touched-file
count of a real run is unmeasured**:

- **Under ~50 touched files**, a graph is a dozen dots and a table is strictly
  better: sortable, searchable, countable, and it fits in the pane beside the
  diff.
- **Over ~500**, it is a hairball, the cap starts dropping nodes by the wrong
  rule, and `forceLayout`'s own docblock is about the cost of the case nobody can
  drag (`forceLayout.ts:18-26`).

There is no band where this is the best instrument, because the band where a
force graph earns its keep is "hundreds of nodes with real community structure",
and the structure here is a dozen stars.

### 3. An edge would mean "attempted", and could not say so per edge

[C10](01-constraints.md#c10--an-edge-means-attempted-not-succeeded-f3-f4): success is
never recorded (`orchestrator.ts:7343-7344`), and a failure cannot be joined to
its call except by a whitespace-flattened 160-character command string
([F3](00-problem.md#f3)). So a red edge for "this failed" is a fuzzy match, and
it is least reliable in a retry loop — which is precisely the run whose picture
an operator would open.

A table can carry a column saying "1 failure recorded, matched by command text",
with the hedge in the header. An edge is a line; it is drawn or it is not, and a
hedge has nowhere to live on it.

### 4. The cost is a canvas the tree cannot share

Per [C7](01-constraints.md#c7--there-is-one-2d-canvas-in-this-app-and-its-450-lines-of-plumbing-are-private):
the app's one 2D canvas is `src/components/KnowledgeGraphCanvas.tsx` (the only
`<canvas>`, `:734`; the only `getContext("2d")`, `:203`), and everything
reusable in it is inline and unexported — the palette probe and its theme
re-probe, the view transform and `fitView`, `nodeAt`, the DPR `ResizeObserver`,
the wheel-zoom with `deltaMode` normalisation, the rAF discipline and unmount
cancel, the reduced-motion `FREEZE_BUDGET` burst, and the drag/pin handlers.
Roughly **450 lines of a 788-line file**.

`docs/agent/conventions.md:64` says the next canvas is "where the next one should
look" — *look*, not import. And `src/lib/canvasView.ts`, which
`src/lib/forceLayout.ts:7` claims holds exactly this shared half, **does not
exist** ([F9](00-problem.md#f9)).

The other candidate for reuse does not survive contact.
**`src/lib/canvasGraph.ts` is not a renderer and does not generalise**: it draws
nothing, its layout is a DAG longest-path column pass, its `edgeGeometry` emits
an **SVG path string** rather than canvas operations, and its node geometry is
unparameterised module constants — `NODE_W` of 232, independently cited at
`docs/agent/conventions.md:38`. A caller with different node sizes silently gets
232 wide. It would have to be replaced, not extended.

So the honest cost is **a fourth renderer written as a second copy of the third**,
and a recommendation that quietly does that is a finding against itself. If a
canvas is ever wanted here, the first commit is extracting `canvasView.ts` — the
module the tree already documents — so there are two consumers of one
implementation rather than two implementations. **That refactor is worth doing on
its own merits and is not worth doing for this feature**, because this feature
should not be a canvas.

### 5. It is not, in fact, a flow

The word in the request is "flow". A flow has direction and sequence. A
force-directed graph of co-occurrence has neither: the layout is symmetric, the
positions are an artefact of the seed (`seedPositions`, `forceLayout.ts:128`) and
the alpha schedule, and nothing in the picture reads left-to-right as earlier-to-
later. **The operator asked for a flow and a force graph is the one picture that
cannot show one.** The two options that genuinely have direction in them are the
delegation tree ([07](07-option-f-delegation-tree.md)) and the cycle grid
([08](08-option-g-cycle-heatmap.md)).

## What would overturn this

One number: **the distinct-file count of a real run's tool events**, and the
distribution of it across runs. If a typical run touches 200 to 800 distinct
files with genuine clustering by directory — and if directory nesting is used as
the edge relation rather than any of the three above — the shape argument in §1
weakens, because a file tree *is* a real hierarchy and it is in the paths
themselves. That is a treemap or an indented tree rather than a force graph, and
it is a different option than the one being refused here.

The query is one line and it is stated in
[13-validation.md](13-validation.md#the-one-number-that-decides-everything).

## Verdict

**Refused.** The data has no edge that is not a hub spoke, a clique or a
timeline; the one real tree in it is three nodes deep; the cap prunes in the
wrong direction for the only bipartite reading; an edge cannot say whether it
succeeded; and the cost is a second copy of a canvas whose shareable half was
documented and never built.
