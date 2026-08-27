# What bounds the field

Eleven constraints. Nine are documented invariants somebody already decided and
wrote down; two are properties of the data established in
[00-problem.md](00-problem.md). An option that violates one of C1–C9 without
naming it is not an option, and two of the four placements the brief asked to be
weighed violate one each.

---

## C1 — A tenth pane is banned by name, with the precedent that shows when an exception was granted

`docs/agent/ui-density-audit.md:159-170`, §1.2 "What may never be used", item 1,
verbatim:

> 1. **A tenth pane.** `panes.ts` is nine rows bound to ⌘1–⌘9 and four readers
>    (`panes.ts:3-16`). A tenth destination has no digit. New destinations are
>    sub-routes under an existing pane.
>
>    *This read "a ninth pane" until `/knowledge` was built.* The ban's whole
>    ground was the digit — "a ninth destination has no digit" — and nine rows
>    still have one, so the ninth was allowed and the sentence moved up by one
>    rather than being waived. Ten is where it stops, and there it stops for the
>    reason it always gave. `/knowledge` earned a row rather than a sub-route
>    because it is not *about* any existing pane: a vault is neither a run, a
>    workflow nor a setting, and filing it under Settings would have made a
>    destination out of a configuration page.

This is unusually strong for an invariant because it **documents its own
exception**. The ban was waived once; the waiver's grounds are written down; and
the same paragraph names the mechanism a new destination should use instead.

The source it cites, `src/components/shell/panes.ts:11-16`:

> The digit follows the row's position rather than the pane's age: a shortcut
> that names the fifth row and lands on the sixth is worse than one somebody has
> to relearn, so inserting a pane renumbers the ones under it. Nine is the
> ceiling and Knowledge is the ninth — a tenth destination has no digit, and a
> row without one is a row two of the four readers cannot describe.

The four readers are the sidebar, the toolbar title, the ⌘-digit handler and
quick open (`panes.ts:6-10`).

**Two corrections to the sources, neither of which weakens the constraint:**

- `panes.ts:15-16` says "Knowledge is the ninth". It is not. `panes.ts:36` gives
  Knowledge `shortcut: "7"`, and the comment two lines above at `:33-35` records
  deliberately moving it *above* Account and Settings. **Settings is the ninth**
  (`panes.ts:38`). The docblock sentence was not updated when its own subject
  moved. The ceiling — nine — is unaffected.
- `docs/agent/conventions.md:50` still reads "the list is closed at eight,
  because ⌘1…⌘8 has eight digits" and still bans "a ninth pane", while
  `conventions.md:57` in the same file says "The set covers the nine panes — the
  count the same closed vocabulary states above." **conventions.md contradicts
  itself**, one paragraph stale from before `/knowledge` and one updated. The
  density audit (C1's primary source) is internally consistent and is the file
  that carries the reasoning, so it governs.

Three documents describe this ceiling and two of them are wrong in a detail. That
is worth knowing before proposing to move it: the last move cost a correction in
three places and two of them did not get one.

## C2 — The run page's tab strip is frozen at five, twice over

`docs/agent/ui-density-audit.md:1122-1124`, under "**C12 — What does not
change**":

> - **The tab strip.** Five labels, the order, the conditions each is offered
>   under, the log leading, only the active tab mounted, and nothing switching
>   tabs on its own.

And `docs/agent/ui-density-audit.md:144-147`:

> **A tab strip is a view switcher, never a navigation device.** Moving between
> different *subjects* is the sidebar's job. `/runs/[id]` has the app's one
> five-segment tab strip and `/chat`'s side card has a two-or-three-segment one;
> both stay.

The closed grouping vocabulary caps it independently — `docs/agent/conventions.md:50`
allows "a **`SegmentedControl` tab strip**, for two to five mutually exclusive
views of one subject, one strip per page". **Five is the cap and the strip is at
it.**

The strip in code, `src/app/runs/[id]/page.tsx:958-970`, is conditional: `log`
always, `report` only when `cycles.length > 0`, `changes` always, `review` and
`land` only when `isolated`. So five is the maximum and the common isolated case
already hits it. A sixth label would exceed the vocabulary's cap on every
isolated run with output, which is most of them.

`docs/agent/ui-density-audit.md:178` also bans "**A tab strip inside a tab**",
which closes the obvious escape of putting a sub-strip inside Changes.

## C3 — The reader must not be the page's event array

Per [F8](00-problem.md#f8): the SSE replay is capped at the newest
`REPLAY_LIMIT = 2_000` events (`src/app/api/runs/[id]/stream/route.ts:17`) inside
`REPLAY_BYTE_BUDGET = 4 MB` (`:31`). Anything derived client-side from what the
page holds is derived from a truncated tail, silently.

Any view here reads the database through its own route handler, which by
`docs/agent/conventions.md:11` must export `runtime = "nodejs"` and
`dynamic = "force-dynamic"`.

## C4 — A narrowing control says what it left out

`docs/agent/conventions.md:17`:

> **A control that narrows what is on screen narrows the *data*, never the way
> the data is drawn — and it says what it left out.** […] a filter that hides a
> line is indistinguishable from a run that never wrote one.

and

> **Each of the three says what it narrowed and what it could not reach.** […] a
> filter over a *truncated* replay carries a warning hint naming the
> dropped-event count […] because a filter that finds nothing in a knowingly
> incomplete log otherwise reads as proof of absence.

This binds directly. A touch view over a swept run shows nothing, and nothing is
exactly what a run that touched nothing shows. The existing wording for the same
problem is at `src/components/RunTasks.tsx:102-104` and should be adopted rather
than a fourth phrasing invented — three already exist ([F8](00-problem.md#f8)).

## C5 — A route that costs seconds is fetched on demand, never polled

`src/app/api/runs/[id]/diff/route.ts:11-21` establishes the pattern and the
reason:

> Not folded into `GET /api/runs/[id]`: that route is polled every three seconds
> by every open run page, and a diff costs several git processes and can run to
> megabytes. This one is fetched when the operator asks to see it.

and its empty state is a reason, not a failure: "'Nothing to show' is a 200 with
`kind: "none"` and a reason, never a 404 or a 500."

`src/lib/fileCostNotice.ts:296-308` establishes the cost of the other half and
its answer:

> The query underneath is a full scan of `run_events` — 38ms against 131,572
> rows here […] Staleness costs nothing here, which is what makes a cache the
> right answer rather than an index: […] An index would move the cost onto every
> `run_events` insert instead, and that table is written on every tool call of
> every cycle — far the busier side of the trade.

**A touch view may not add an index to `run_events`.** That trade is decided and
the reasoning is about the write side, which a read feature does not get to
reopen. It may scan, and it should cache the way `readCountsFor` does
(`READ_COUNTS_TTL_MS = 60_000`, `fileCostNotice.ts:310`).

The per-run case is cheaper than the measured one: `idx_run_events_run(run_id,
id)` (`src/lib/db.ts:624-625`) covers a single run's rows, so a per-run query is
an index scan where `readCountsFor`'s fleet-wide, folder-keyed one is not. There
is **no index on `kind`** and none on `ts` — `fileCostNotice.ts:119` says so in
as many words — so a fleet-wide variant inherits the full scan.

## C6 — The pane shows one thing at a time, and only the active tab is mounted

`docs/agent/conventions.md:20`:

> **A tab is offered only when there is something behind it** […] **Only the
> active tab is mounted**, so Changes re-reads the repository each time it is
> opened — the same cost as loading the page, against four polling cards alive
> behind the one being looked at.

Two consequences. A surface that would be empty is not offered — which for a
swept run means the offer itself must be decidable without doing the work. And
mounting cost is paid per open, so a second expensive reader inside Changes
doubles what an operator pays to look at the diff.

## C7 — There is one 2D canvas in this app, and its ~450 lines of plumbing are private

`docs/agent/conventions.md:64`:

> **A `<canvas>` settles three things the DOM already answered, and both of this
> app's canvases answer them the same way.** `WorkflowCanvas` draws with
> absolutely-positioned elements; `KnowledgeGraphCanvas` is the first real 2D
> context here, and what it decided is where the next one should look.

Four requirements follow, each stated as a silent failure: **colour cannot be
read from a custom property** (every token is `light-dark()` or `color-mix()`,
which a 2D context rejects silently, so a throwaway span is probed and re-probed
on both a `data-theme` mutation and a `prefers-color-scheme` change); **the
backing store is device pixels and the element is CSS pixels** (`ResizeObserver`,
`devicePixelRatio`, transform reset every frame); **the loop ends** (rAF re-armed
only while `step()` reports alpha above `ALPHA_MIN`, and `prefers-reduced-motion`
removes the animation rather than slowing it — one synchronous burst to a
300-step cap); and **the element is out of flow**, without which the box
ratchets upward silently.

The doc says the next canvas "should look" at `KnowledgeGraphCanvas`. It cannot
*import* from it: all of that is inline and unexported inside
`src/components/KnowledgeGraphCanvas.tsx` — the palette probe, the view
transform, `fitView`, `nodeAt`, the DPR resize, the wheel-zoom with `deltaMode`
normalisation, the rAF discipline, the reduced-motion burst and the drag/pin
pointer handlers. That is roughly 450 lines of a 788-line file.

And the module that was supposed to hold the shareable half **does not exist**:
`src/lib/forceLayout.ts:7` claims the world/screen transform and hit testing
"lives in `canvasView.ts` and is imported by both", and `canvasView.ts` is
nowhere in the tree ([F9](00-problem.md#f9)).

## C8 — Below a threshold, the answer is inline SVG and not a canvas

`docs/agent/conventions.md:65`:

> **A chart small enough to read at a glance is inline SVG, and it takes its
> colours as classes rather than as probed values.** `ContextOccupancy`'s
> sparkline is the precedent, and it is deliberately not the canvas above: at a
> few hundred points in a 21rem column there is no frame loop to end and no
> backing store to scale, and the whole reason a canvas has to probe
> `getComputedStyle` for a colour […] does not exist for an SVG element.

with three rules for the SVG route: `preserveAspectRatio` stays at its default;
the height comes from the viewBox (`h-auto w-full`); coordinates are rounded,
because the markup re-renders on a three-second poll. And: "There is no charting
dependency in `package.json` and adding one for a picture this size is not the
trade."

**This constraint is what decides between two of the visual options**, and the
threshold it draws is "a few hundred points" against the canvas's thousands.

## C9 — Graph scale has a number, and it is not the one in the layout's docblock

`src/lib/forceLayout.ts:18-26`:

> `MAX_GRAPH_NODES` is 4000, so the honest worst case is 16 million pair
> distances per frame — about a tenth of a second of arithmetic, which is a
> graph nobody can drag. The quadtree makes that O(n log n) […]

That 4000 is **prose in this file and enforced nowhere in it**. `forceLayout.ts`
has no `import` statement at all and never references the constant in code. The
real numbers are two, in two different modules, for two different jobs
(`src/lib/knowledgeGraph.ts:699-704`):

- `MAX_GRAPH_NODES = 4000` (`src/lib/knowledge.ts:109`) — what the **API will
  send**, "so an answer is not enormous";
- `MAX_DRAWN_NODES = 2500` (`src/lib/knowledgeGraph.ts:705`) — what is **drawn**,
  "so a tab does not go unresponsive", applied by `capGraph`
  (`:714-729`), which prunes **by degree, largest first** and reports `dropped`.

`capGraph` needs only `{id, inDegree, outDegree}` (`:720-723`) and so is close to
generic. The layout settles in "roughly 250 frames — about four seconds"
(`forceLayout.ts:93`).

**2500 is the drawable ceiling and 4000 is the wire ceiling.** Any option
claiming a graph is affordable is claiming its node count sits under 2500 *and*
that the picture at that count is legible, which is a separate claim nothing
here can test.

## C10 — An edge means "attempted", not "succeeded" ([F3](00-problem.md#f3), [F4](00-problem.md#f4))

No success is recorded; failures are recorded but cannot be joined to their call
except by a flattened 160-character command string. Any mark distinguishing a
successful touch from a failed one is a fuzzy match, and it is least reliable in
a retry loop.

## C11 — The two sources have different lifetimes ([F6](00-problem.md#f6))

Touch events expire at `eventRetentionDays: 30` (`src/lib/settings.ts:819`,
swept at `src/lib/retention.ts:145-151`). The branch diff does not expire, because
`docs/agent/retention.md:22` removes directories and never refs. A view holding
both must survive its own halves ageing out at different rates, and must not let
the older half's absence read as a fact about the run.
