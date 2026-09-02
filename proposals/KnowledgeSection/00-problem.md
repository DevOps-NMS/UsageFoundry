# The problem, measured

The operator's words: **the Knowledge section is overwhelming, the node view is
difficult to navigate, and it is not visible at first look what they are looking
at as an operator.**

Three complaints, and they are not one complaint in three sentences. "Overwhelming"
is about how much is on screen at once. "Difficult to navigate" is about the
canvas as an instrument. "Not visible what I am looking at" is about the canvas
as a *picture* — it is the only one of the three that no amount of moving
controls around can touch. This file separates them, because the options later
close different ones and a survey that treats them as one will recommend
something that closes two.

Everything below carries a file and a line, or the command whose output it
quotes. Where something could not be checked, the sentence says so.

---

## K1. One route, four unrelated blocks, one scroll, no navigation

`src/app/knowledge/page.tsx` is **1,017 lines** (`wc -l`). Its render is four
blocks stacked vertically in a single `<div>` (`page.tsx:390`), in this order:

| # | Block | Lines | Height |
|---|---|---|---|
| 1 | The open-note reader — title, path, tags, frontmatter table, full body, Links out, Backlinks | `:405-508` | The note's own, unbounded |
| 2 | **Notes** — 4 filter controls, a sort strip, a table, pagination | `:510-694` | Capped at `max-h-80` above `md`, **uncapped below it** |
| 3 | The graph region | `:696-709` | 4:3 of the canvas column, or taller |
| 4 | **Health** — three cards, each a count and a capped table | `:711-792` | Three cards |

There is no navigation between them: no tab strip, no anchor row, no fold.
`grep -rln Disclosure src/` returns 18 files — the primitive, its test,
`Markdown.test.tsx`, and **15 call-site files** across `/account`, `/branches`,
`/chat`, `/runs`, `/settings`, the workflow instance page, `Markdown.tsx` and
seven `Run*` components. **None of them is `/knowledge`.** The sanctioned fold
exists, is used widely, and has never been used here.

A reader who came for the graph reaches it by scrolling past 1 and 2. A reader
who came for Health reaches it by scrolling past 1, 2 and 3.

## K2. The browse table is fifty rows, and on a phone it is fifty rows tall

The complaint's "25-row table" is an undercount and the direction of the error
matters.

`KNOWLEDGE_PAGE_SIZE = 50` (`src/lib/knowledge.ts:1447`), and `loadBrowse`
sends `sort` and `offset` and **no `limit`** (`page.tsx:166-170`), so the server
default applies: **50 rows per page**.

Above `md` those 50 rows sit inside `ListView box="capped"`, which is
`max-h-80 overflow-auto` — a 320px scroll box (`src/components/ui/ListView.tsx:46-48`).
That is the good case, and it is why the desktop page is not as long as the row
count suggests.

**Below `md` the cap is deliberately released**: the same class string carries
`max-md:max-h-none max-md:overflow-visible`, for the reason `ListView.tsx:41-45`
gives — a nested scroller on a phone reads as the end of the page. So on a phone
the table renders at its full height, and each row is not a row: `Table stack`
(`page.tsx:619`, `src/components/ui/Table.tsx:63`) turns every `<Tr>` into a
block and every `<Td>` into a labelled line (`Table.tsx:160-162`, `:245-246`).
Five cells per note (`page.tsx:643-662`) means roughly **250 labelled lines**
between the top of the table and the graph under it.

This is not a defect in `ListView`. It is what happens when a block that was
correctly designed to release its cap on a phone is the block that sits
*above* the one the operator came for.

## K3. The graph panel is sixty-four focusable controls on a first visit, not twenty-five

The complaint counts "roughly 25 always-visible controls". That is the count for
an operator who has **removed every colour group**. The count a first-time
operator gets is different, because the panel seeds itself.

`KnowledgeGraphView.tsx:161-167` seeds colour groups on the first visit and only
then — `seedable.current` is true only when `localStorage` held nothing
(`:122`), which is a decision documented in full at `:99-108` and is a good one.
The seed is `tagGroups(graphTags(expanded))`, which takes the vault's most-used
tags **capped at `MAX_GROUPS`** (`src/lib/knowledgeGraph.ts:282-288`), and
`MAX_GROUPS = 7` (`:682`). `docs/verification.md:776` measures the real vault at
**95 tag nodes**, so the cap binds: a first visit writes **seven** groups.

Each group row is five focusable controls — a `ColorSwatch`, a query `Input`,
and Up / Down / Remove (`KnowledgeGraphView.tsx:659-713`). Each of the three
`ui/Field` primitives involved is exactly one tab stop (`Field.tsx:558` a range
input, `:423` a `role="switch"` button, `:624` a colour input).

The inventory, top to bottom, in the panel's own order:

| Group | Lines | Controls | Changed how often |
|---|---|---|---|
| View scope — `Whole vault` / `This note` | `:348-353` | **1** (one roving tab stop) | Constantly |
| `Around this note` — Depth, Incoming, Outgoing, Neighbour links | `:358-399` | **4**, *only when scope is `This note`* | Often, in local view |
| `Filters` — Search, Tags, Attachments, Existing files only, Orphans | `:401-462` | **5** | Constantly |
| `Colour groups` — 7 seeded rows × 5 | `:651-716` | **35** | Once, then rarely |
| Most-used tags — up to `MAX_TAG_CHOICES` = 12 chips (`knowledgeGraph.ts:694`) | `:723-761` | **12** | Occasionally |
| `Add group` | `:764-769` | **1** | Rarely |
| `Display` — Arrows, Label fade, Node size, Link thickness, Animate | `:466-519` | **5** | Once, if ever |
| `Forces` — Center, Repel, Link, Link distance | `:521-561` | **4** | Once, if ever |
| `Reset to defaults` | `:565-569` | **1** | Rarely |

**64 in `Whole vault`. 68 in `This note`.** All of it in a `minmax(0,19rem)`
grid column beside the canvas (`:252`), at one visual weight, with no fold
anywhere.

Two things follow that the raw count hides:

- **The largest block is the one changed least often after the first minute.**
  Colour groups plus the chip row plus Add is **48 of the 64**, three quarters
  of the panel, and it is the block whose whole job — pick the seven tags worth
  a colour — is done once.
- **The panel's own order is already common-above-rare, except for that block.**
  Scope, then local, then filters is right. Display, then forces, then reset is
  right. Colour groups sitting fourth, at 48 controls, is the one thing out of
  order, and it is out of order by three quarters of the panel.

## K4. The canvas has no orientation layer — and one thing it is accused of missing is drawn

The complaint says nothing on screen says what a colour means, what a size
means, which node is the open note, or how to get back to a readable zoom. Three
of those four are exactly right. The fourth is not, and the correction is worth
more than the original claim.

**The open-note marker exists.** `KnowledgeGraphCanvas.tsx:303-310` strokes a
2px ring in `--tint` at radius + 3 around the node whose id is `focusId`, and
the prop is documented as "The note open in the reader, ringed so it can be
found again" (`:143`). It is drawn. Nothing on screen says it is drawn, or what
it means.

**And in light mode it is the same colour as the hover highlight.** `--tint` is
`light-dark(#0069d9, #0a6cd8)` (`src/app/globals.css:89`) and `--accent` is
`light-dark(#0069d9, #4a9bff)` (`:70`) — **the same hex in light mode**. A
hovered node with no colour group is *filled* `--accent` (`KnowledgeGraphCanvas.tsx:292-294`).
So on a light-mode screen the mark that means "this is the note you are reading"
and the mark that means "your cursor is here" are the same colour, told apart
only by ring versus fill. Nobody has looked at this; it is arithmetic on two
declared values.

The rest of the orientation layer is genuinely absent:

- **No legend of any kind.** `grep -n Legend src/components/KnowledgeGraph*.tsx`
  returns nothing. The app has two legends already, both written for canvases
  that landed *after* this one: `src/app/runs/[id]/conflicts/page.tsx:354-403`
  and `src/app/runs/[id]/touched/page.tsx:326-410`.
- **Colour means two different things and nothing says which is winning.** A
  node's fill is the first colour group whose query claims it, or its kind if
  none does (`KnowledgeGraphCanvas.tsx:288-294`, `knowledgeGraph.ts:205-215`).
  With seven groups seeded, most notes are painted by group, so the kind
  colouring is true only of what is left over.
- **A note and an attachment are the same colour.** `colourFor`
  (`KnowledgeGraphCanvas.tsx:669-675`) returns `--fg-muted` for `attachment`
  and `--fg-muted` for everything else. With `showAttachments` on there is no
  drawn difference between an attachment and a note. **A legend cannot
  truthfully say what a colour means until this is fixed**, which is why it is
  named here rather than in an option file.
- **Size is the degree in the *drawn* graph, not in the vault.**
  `radiusOf` uses `node.degree` (`:128-130`), which `countDegrees(sim.nodes, sim.edges)`
  computes over the filtered, capped slice (`:434`, `src/lib/forceLayout.ts:175-183`).
  The wire carries `inDegree`/`outDegree` over the whole vault
  (`src/lib/apiTypes.ts:2761-2762`). Turn `Orphans` off and a surviving node
  shrinks without the vault having changed. `src/components/RunConflictMap.tsx:31`
  records the same trap on another canvas and answers it with a legend line.
- **`fitView` exists and cannot be reached.** `KnowledgeGraphCanvas.tsx:336-344`
  frames the whole graph, and `:356-359` calls it exactly once — on the first
  layout to go cold, and only while `touchedRef.current` is false. `touchedRef`
  is set by the first pan (`:561`) and the first wheel (`:619`). **After one
  drag there is no route back to a framed view except reloading the page.**
- **The canvas carries no accessible name and no role.** `:645-664` is a bare
  `<canvas>` with five pointer handlers. The app's other canvas —
  `PathMapCanvas.tsx:789-807` — carries `role="img"` and an `aria-label`, given
  to it at `RunTouchedMap.tsx:156` and written to name the *table* that holds
  the same content. That canvas is newer than this one.

The entire explanation of the surface is one line of 12px `--fg-muted`
(`KnowledgeGraphView.tsx:293-311`): *"Drag to pan, scroll to zoom, drag a node
to place it, click one to open the note."* Which is four gestures and nothing
about what is drawn.

## K5. This route is two days younger than the density audit, and was never one of its surfaces

This is the structural fact the whole survey turns on.

```
git log --reverse --format='%ad %h %s' --date=short --diff-filter=A -- <path>
```

| | Added |
|---|---|
| `docs/agent/ui-density-audit.md` | **2026-08-19**, `ac09621` |
| `src/app/knowledge/page.tsx` | **2026-08-21**, `079bc7b` |
| `src/components/KnowledgeGraphView.tsx` | **2026-08-22**, `a4f3442` |

The audit's §3 covers eleven surfaces in six build runs — 3.A the shell and
primitives, 3.B `/settings`, 3.C `/runs/new` and `/runs/[id]`, 3.D the workflow
surfaces, 3.E dashboard / runs / branches / chat / agents / account, 3.F every
dialog and drawer. `/knowledge` is in none of them. Across all 2,774 lines it
appears **twice**, both in the same paragraph (`:163`, `:167`), noting that the
pane ban read "a ninth pane" until this route was built and that it earned a row
rather than a sub-route.

So the audit's §1.0 order of moves — **Delete, Group, Reorder, Hide** — has never
been applied to this route. That is precisely the difference between this survey
and `proposals/OperatorInterface/09-option-h-progressive-disclosure.md`, which
refused progressive disclosure on `/settings` on the ground that "Option H is the
fourth move on a page where the first three have already been made". Here they
have not.

## K6. There is no `docs/agent/` doc for this route

`ls docs/agent/` is 18 files and none of them is about the knowledge base.
`CLAUDE.md`'s routing table — the one that says "if you are about to touch
anything named on a line, open that line's doc before you edit" — has no line
for `/knowledge`, `knowledge.ts`, `knowledgeGraph.ts` or either component.

The reasoning is instead in four file-header block comments, read in full for
this survey:

| File | Header | What it settles |
|---|---|---|
| `src/app/knowledge/page.tsx` | `:29-69` | Read-only and says so; the note is state and the URL follows it; every note link is a real `<a href>` behind one delegated handler; **why the note leads the page** |
| `src/components/KnowledgeGraphView.tsx` | `:40-64` | One fetch, every kind, narrowed in the browser; the panel is built to be *swept*; **the panel's search is not the page's**; settings live in `localStorage` |
| `src/components/KnowledgeGraphCanvas.tsx` | `:48-76` | What a node looks like and what that means; the simulation must stop; **the pointer is the only input here and that is deliberate** |
| `src/lib/knowledgeGraph.ts` | `:1-21` | Where a graph decision can be tested; what "matching Obsidian" means and where it stops (content search) |

Four of those sentences are load-bearing enough that an option contradicting one
has to argue against it by name. They are restated as constraints in
[01-constraints.md](01-constraints.md).

---

## What each complaint actually maps to

| The operator said | It is | Closed by |
|---|---|---|
| "overwhelming" | K1 (four blocks, one scroll) and K3 (64 controls at one weight) | A move, a fold, or a split — three different options |
| "the node view is difficult to navigate" | K4's `fitView` and the missing readout; and the deliberate absence of a keyboard route | The orientation layer, partly. Not fully — see C4 |
| "not visible at first look what I am looking at" | K4 in its entirety | **Only** the orientation layer. Nothing else in this survey touches it |

The third row is why no option here is recommended alone.

---

## What was not inspected

Stated so it cannot be read as covered.

- **No browser was driven.** There is none in this container, and `CLAUDE.md`
  and `docs/verification.md:806-808` both say so. Nothing below has been *seen*.
  Every claim about what is on screen is read out of source, and every claim
  about a colour is arithmetic on a declared value.
- **No vault was mounted.** The graph's real shape — 893 nodes, 19,995 edges, 95
  tags, largest hub 1,082 — is quoted from `docs/verification.md:771-804`, which
  measured it on 2026-08-22 against `/workspace2`. It has not been re-measured
  here and the vault has changed since.
- **Nothing was timed.** The frame-budget figures in the same entry are that
  entry's, not this survey's.
- **No screen reader was used**, so K4's accessible-name gap is an inference
  from markup — a `<canvas>` with no `role` and no `aria-label` — and not a
  recording of what anything announces.
- **`ui-density-audit.md` was read in the parts §1.0, §1.1, §1.2, §2.1, §2.2 and
  §2.3, plus its section index.** The 2,300 lines of per-surface specification in
  §3 and §8 were not read, on the ground that none of them is about this route
  (K5). If one of them contains a rule that generalises, this survey has missed
  it.
