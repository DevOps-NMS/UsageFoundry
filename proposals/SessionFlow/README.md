# Session flow

**The question:** an operator asked for "a new tab on the left that records what
the session touched and creates a VISUAL FLOW TYPE representation of what the
flow touched and changed". Should this app draw what a run touched, where, and as
what?

**The state:** open. Nine options across two independent axes, one recommended,
five refused by name, one deferred. **Nothing here is a decision and no product
code changed.**

---

## The recommendation, in one sentence

**Do not build the flow graph** — the only relations in the stored data are
"a tool touched a file" (a bipartite star around a dozen tool names) and "a
sub-agent was delegated to" (a two-level tree), so the honest picture is a table
— and **build instead a touched/changed reconciliation as a sorted list with
counts under the run page's existing Changes tab**, which answers three questions
nothing answers today and costs one route handler and one component.

Full argument: [12-recommendation.md](12-recommendation.md). The first shippable
slice, written as eleven acceptance criteria an agent with no memory of this
survey can implement and verify, is at the foot of that file.

**What would overturn it:** one number — the distinct-file count of a real run's
tool events. Every argument here against a picture is an argument about node
counts, made from an empty database. If a typical run touches 200–800 distinct
files *and they cluster by directory*, a treemap over the path hierarchy becomes
a serious option this survey never weighed, because it could not know its premise
held. The query is one line ([13-validation.md](13-validation.md#the-one-number-that-decides-everything))
and the first slice prints the answer in its own header.

---

## The row for `proposals/README.md`

> Not pasted into that file, which is shared and read alongside other branches.
> It belongs in the summary table, after the `ContinuousImprovement` row.

| Proposal | Question | State |
|---|---|---|
| [SessionFlow](SessionFlow/README.md) | An operator asked for a new left-hand tab drawing a visual flow of what a session touched and changed. Should this app draw that, where, and as what? | Open; one recommendation, and it is **against the graph** — build a touched/changed reconciliation as a sorted list with counts under the run page's existing Changes tab, and refuse five options by name. **Both placements the request named are banned by written invariants and neither is a close call**: a tenth pane is named in `docs/agent/ui-density-audit.md:159-161` ("A tenth destination has no digit"), and it fails the `/knowledge` test — a run's flow *is* about an existing pane — in the same paragraph that granted the only exception ever granted; a sixth tab exceeds `docs/agent/conventions.md:50`'s two-to-five cap and contradicts `ui-density-audit.md:1122`, which froze this strip at "five labels, the order" as part of a redesign of that page. So the fork resolves to neither, and the ban's own sentence names the replacement: "New destinations are sub-routes under an existing pane." The graph is refused on the **data**, not on cost: every candidate edge is a hub spoke (tool→file is bipartite with ~12 hubs), a clique (co-occurrence per cycle is 780 edges for 40 files) or a timeline, `capGraph` prunes **by degree, largest first** so the one nearly-generic piece of graph plumbing keeps the tool hubs and drops the files, and an edge cannot carry the hedge every touch needs — **success is never recorded** (`orchestrator.ts:7343-7344`) and a failure joins to its call only by a whitespace-flattened 160-character command string, because the `tool` row stores no `tool_use` id. The data is in better shape than the brief assumed: `clipToolInput` is field-aware rather than a byte slice, `command` is first and `file_path` second in `HEADLINE_FIELDS`, and **the extraction query already runs in production** — `readCountsFor` (`fileCostNotice.ts:328-363`) pulls `$.input.file_path` out of `run_events` with `json_extract` today, for a prompt rather than for a person. Two brief leads corrected: `clipToolInput` is in `logLine.ts:145-189`, not `retention.ts`; and a failed `Read` *is* distinguishable from a successful one, by a separate `tool_error` row — the real problem is that the two rows share no key. **Refused by name:** a tenth pane, a sixth tab, a node-and-edge canvas (whose true cost is a second copy of a 450-line private canvas, since `canvasView.ts` — claimed to exist at `forceLayout.ts:7` — **does not**), a fleet-wide view (the full scan `fileCostNotice.ts:303-308` already refused an index for, with no `base..branch` to reconcile against), and a per-call failure mark. **Deferred rather than refused:** the file × work-cycle grid, the only visual that survives its own scrutiny and the only one with direction in it, held back solely because both its axes are unmeasured — which the first slice fixes. Three findings against the tree, none blocking: `orchestrator.ts:9876` asserts "`run_events` has no retention" and `retention.ts:145-151` deletes it on 30 days; `forceLayout.ts:7` names a module that was never written; and three documents disagree about the pane ceiling — `panes.ts:15-16` says "Knowledge is the ninth" when Knowledge is seventh and Settings is ninth, and `conventions.md:50` still says "closed at eight" while `conventions.md:57` counts nine. Unverified: **every count of anything** — `/data` is empty, no `*.db` exists in the checkout, and **no `run_events` row was ever quoted because none was reachable**; no browser was opened and no container started, so "hairball" is an argument from node counts and pruning rules rather than from having seen one |

---

## The fork, resolved

The brief named this as the central design decision and asked for it to be
resolved rather than split. It is, and it resolves against both branches.

| Placement | Legal? | Why |
|---|---|---|
| **A tenth pane** (what was asked for) | **No** | `docs/agent/ui-density-audit.md:159-161` bans it by name. ⌘1–⌘9 has nine digits and nine rows use them. The ban was waived exactly once, for `/knowledge`, on the ground that "nine rows still have one" — and the same paragraph gives the test the waiver turned on: `/knowledge` earned a row "because it is not *about* any existing pane". A run's flow is about a run |
| **A sixth run-page tab** | **No** | `docs/agent/conventions.md:50` caps a `SegmentedControl` tab strip at "two to five mutually exclusive views of one subject"; the strip has five (`src/app/runs/[id]/page.tsx:958-970`). `ui-density-audit.md:1122` froze it — "Five labels, the order" — in the list of what a redesign of that page deliberately left alone. `:178` closes the sub-strip escape |
| **A sub-route** `/runs/[id]/touched` | Yes | Named as the replacement by the ban itself. `activePane` matches on a path segment (`panes.ts:48-56`), so it costs ~2 lines. **Right at the second step**, wrong at the first: a destination holding one table is something to learn in order to read what fitted where you already were |
| **Inside the existing Changes tab** | Yes | **Recommended.** Keeps both halves of a reconciliation on one screen, adds no segment and no destination, and the mounting cost is already paid there |
| **Fleet-wide instead of per-run** | — | Refused. Different subject, the full scan an index was already refused for, and no `base..branch` to reconcile against ([10](10-option-i-fleet-wide.md)) |

---

## The findings at a glance

| | |
|---|---|
| Tool-call data already recorded per run | **all of it** — `run_events(run_id, ts, kind, payload)`, `src/lib/db.ts:167-173` |
| New writers this feature needs | **0.** Everything is a reader |
| Does a `file_path` survive storage? | **Yes.** `clipToolInput` is field-aware; `file_path` is 2nd in `HEADLINE_FIELDS`, `command` is 1st |
| Is the extraction query already written? | **Yes, and shipped** — `readCountsFor`, `src/lib/fileCostNotice.ts:328-363` |
| Is a successful tool result stored? | **Never.** `orchestrator.ts:7343-7344`, by decision |
| Can a failure be joined to its call? | **Not by key.** No `tool_use` id on the `tool` row; only a flattened 160-char command string |
| Distinct 2D canvases in the app | **1** (`KnowledgeGraphCanvas.tsx:734`, the only `<canvas>`) |
| Of `canvasGraph.ts`, reusable for a file graph | **~2 lines.** It draws nothing, lays out DAG columns and emits SVG path strings |
| Of `forceLayout.ts`, reusable | **all of it** — no `import` statement in the file |
| Shared canvas plumbing available to a third consumer | **none.** ~450 lines, private and unexported; `canvasView.ts` is documented at `forceLayout.ts:7` and **does not exist** |
| Drawable node ceiling | **2500** (`knowledgeGraph.ts:705`), not the 4000 in `forceLayout.ts`'s prose |
| Horizon on "touched" | **30 days** (`settings.ts:819`, swept at `retention.ts:145-151`) |
| Horizon on "changed" | **none** — retention removes directories, never refs (`docs/agent/retention.md:22`) |
| Events reaching the page over SSE | newest **2,000**, inside **4 MB** (`stream/route.ts:17,31`) |
| Existing phrasings of "some events are missing" | **3.** A fourth would be one too many |
| Things with a tool-call log other than a run | **0.** `grep -c "run_events\|emit(" src/lib/chat.ts` → 0 |
| `run_events` rows quoted in this survey | **0.** `/data` is empty |
| Browsers driven | **0** |

---

## The three questions nothing answers today

The brief asked for a question an operator would answer in five seconds with the
new view and two minutes without it. There are three, and **none of them is a
flow** — all three are set differences, which is why the recommendation is a
table:

1. **"Did this run change a file it never read?"** An `Edit` or `Write` with no
   preceding `Read` is an agent editing blind.
2. **"What did it read and then not use?"** The context that was paid for and
   discarded.
3. **"Did it touch anything outside the checkout?"** `readCountsFor` already
   computes this predicate and throws the answer away at its `ELSE NULL`
   (`fileCostNotice.ts:343`).

A fourth question *is* shape-shaped — **"where did this run start going in
circles?"** — and it is the entire case for
[08-option-g](08-option-g-cycle-heatmap.md), the one visual not refused.

---

## Files

| | |
|---|---|
| [00-problem.md](00-problem.md) | Nine findings about what the data actually holds, two brief leads corrected, and what could not be checked |
| [01-constraints.md](01-constraints.md) | C1–C11, every invariant and property that bounds the field |
| [02-option-a-change-nothing.md](02-option-a-change-nothing.md) | The null at its strongest. Beats three of the five things that could be built |
| [03-option-b-tenth-pane.md](03-option-b-tenth-pane.md) | **Refused.** What was asked for, and the cost of overruling it stated plainly |
| [04-option-c-sixth-tab.md](04-option-c-sixth-tab.md) | **Refused.** The other half of the brief's fork, banned by three sources |
| [05-option-d-sub-route.md](05-option-d-sub-route.md) | The placement that survives. Right at the second step, premature at the first |
| [06-option-e-file-tool-graph.md](06-option-e-file-tool-graph.md) | **Refused.** The literal request. Why no edge in this data makes a graph |
| [07-option-f-delegation-tree.md](07-option-f-delegation-tree.md) | The only real tree here. Folded into the table as one column |
| [08-option-g-cycle-heatmap.md](08-option-g-cycle-heatmap.md) | **Deferred, not refused.** The only visual that survives, and what it is waiting on |
| [09-option-h-reconciliation-table.md](09-option-h-reconciliation-table.md) | **Recommended.** The four groups, the query, the empty states, and where it renders |
| [10-option-i-fleet-wide.md](10-option-i-fleet-wide.md) | **Refused**, with the finding that a third of it already exists and feeds a prompt instead of a person |
| [11-comparison.md](11-comparison.md) | Two axes, six weighted criteria, and where the table misleads |
| [12-recommendation.md](12-recommendation.md) | The recommendation, six refusals, two corrections to file, and the first shippable slice |
| [13-validation.md](13-validation.md) | The one number that decides everything, what was verified and how, and four ways this could be wrong |

---

## Neighbours

[GapRegister](../GapRegister/) surveyed where this app's gaps are and **did not
find this one** — no row on its register of twenty names a touch or flow view,
which is weak evidence that the question is new rather than previously refused.
Its **F4** row is the closest neighbour and it shipped: the run log's text filter
and kind picker, with the truncated-replay count stated when a filter is on. That
is the surface an operator uses for these questions today and it is what
[02-option-a](02-option-a-change-nothing.md) scores.

[OperatorInterface](../OperatorInterface/) is why nothing here is a claim about
how anything looks: it establishes that no browser can be driven from a work
cycle, and its finding that `--fg-faint` has no repair as a token bears on any
table with a count column drawn in the explanatory weight.

[ContextControl](../ContextControl/) reaches the same conclusion from the other
direction — that the expensive-looking thing is usually already accounted for
somewhere — and its recommendation to build a **readout** rather than a mechanism
is structurally the same move this one makes.

---

## Verification

Prose only. No file outside `proposals/SessionFlow/` was touched, so a green tree
says nothing about whether this is right — only that it is inert.

Run on the tree this was written against (branch head at the time,
`05f13cb` plus this directory):

| Command | Result |
|---|---|
| `NODE_ENV=development npm ci --include=dev` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm test` | **1,796 tests / 265 suites / 0 failures** in 16.5 s |

`NODE_ENV=development` is load-bearing: this environment sets
`NODE_ENV=production`, under which a bare `npm ci` exits 0 having silently
skipped devDependencies, and both scripts then fail with exit 127 for a reason
unrelated to the change — the trap `CLAUDE.md` records.

**Docker is unavailable in this container and no browser can be driven**, so
every claim here about appearance, legibility or timing is unverified and says so
in the sentence that makes it.
