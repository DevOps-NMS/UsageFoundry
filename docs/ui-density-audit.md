# UI density audit and restructure specification

> This document is the specification for five build runs. It decides, once, the
> things those runs would otherwise each decide differently. Where it names a
> control it names it by its exact current string, so a build run can grep for
> it. Where it is silent or self-contradictory, **stop and report** rather than
> inventing an answer — that is the contract this document was written under.
>
> **Nothing here is a feature cull.** Every control that exists today exists in
> the target structure too. Section 6 lists the handful I would remove, and
> those are recommendations for a person, not instructions for a build run.

## Contents

| § | | Read it if |
|---|---|---|
| 0 | How this was produced, and what was verified | you want to know how much to trust a claim |
| 1 | **The density vocabulary** — seven affordances, the closed "never" list, and the one primitive to build | **always, before you group anything** |
| 2 | **The promotion and demotion rule** — three tiers, four anti-rules | **always, before you fold anything** |
| 3 | Per-surface target structures, ordered by build run | your own subsection, and only yours |
| 3.A | run (a) — the shell and the shared primitives | |
| 3.B | run (b) — `/settings` | |
| 3.C | run (c) — `/runs/new` and `/runs/[id]` | |
| 3.D | run (d) — the workflow surfaces | |
| 3.E | run (e) — dashboard, runs list, branches, chat, agents, account | |
| 3.F | Every dialog and every drawer | you are touching a `Sheet` or the drawer |
| 4 | The five build runs: file ownership and what each must not touch | before your first edit |
| 5 | **What must not change** | **always, first** |
| 6 | Recommend removing — needs a human decision | never act on it |
| 7 | Additions to `docs/agent/conventions.md` | |

---

## 0. How this was produced, and what was actually verified

### 0.1 What I could see

**There is no browser in this container.** No Chromium, no Playwright, nothing
that renders a page. I did not look at pixels and nothing in this document is a
judgement about how something looks.

What I did do:

- Installed dev dependencies (`NODE_ENV=development npm ci --include=dev`) and
  booted `next dev`. The app compiles and serves: `/api/login` answers 200 and
  `/settings` and `/runs/new` return 200 with a session cookie.
- Fetched the server-rendered HTML of those pages. This is worth almost nothing
  as evidence and I am saying so rather than implying otherwise: every page in
  this app is a client component that fetches on mount, so the SSR pass of
  `/settings` contains exactly one heading (`<h1>Settings</h1>`) and none of its
  seven sections. `/runs/new` renders its four card titles and nothing under
  them.
- Read the source of every surface named below, in full, and counted.

So **every finding in this document is a source finding**: peers counted in a
section, controls counted in a card, each control followed to what it does. Any
claim that reads like a visual judgement ("this is cramped") is not here.

### 0.2 What grounds each decision

- `CLAUDE.md` and every file under `docs/agent/` that it gates.
- `git log --follow` per file, to attribute each part of a page to the feature
  it arrived with. That attribution is the evidence for the diagnosis: this app's
  pages are fuzzy because **fourteen months of features were each appended to
  whichever page was nearest**, and no commit has ever removed or regrouped one.
- The landed narrow-viewport work at `2c43b27` and the four runs behind it.
  **That work is not the problem and this document does not touch it.** See §5.9.

### 0.3 Reading order for a build run

1. §5, *What must not change*. Read it before you open a file.
2. §1 and §2, the vocabulary and the promotion rule. These are the whole of the
   design language you are allowed to use.
3. Your own subsection of §3, and only yours.
4. §4, your run's file ownership and acceptance criteria.

---

## 1. The density vocabulary

This app already has a design language (`docs/agent/conventions.md`). What it
does not have is a rule for **grouping** — so every feature that landed picked
its own answer, and the answers do not compose. This section fixes the set.

### 1.0 The order of moves

Before reaching for any affordance below, apply these in order. This ordering is
deliberate and it is the opposite of what a restructure usually does.

1. **Delete redundancy.** A lede that restates its heading, a hint that repeats
   the label, a second name for a concept the page already named. This costs
   nothing and it is the only move that makes a page shorter without making
   anything harder to find.
2. **Group.** Give the peers a named parent. This is where most of the work is.
3. **Reorder.** Common above rare, within the group.
4. **Hide.** Last, and only under §2.

Hiding is not the default fix for a crowded page, and treating it as one is how
a page becomes fuzzy in a second way: a reader who cannot find a control assumes
it does not exist. Every fold in §3 is justified individually.

### 1.1 The affordances, and when each is correct

Seven, and no eighth without a change to this document.

| # | Affordance | Correct when | Cap |
|---|---|---|---|
| 1 | **Pane** (a row in `panes.ts`) | The reader arrives here *from the sidebar* to do a distinct job with its own primary action. | **Eight. The list is closed** — see §1.2. |
| 2 | **Sub-route** (a page below a pane) | A group is both *large* (a screen's worth) and *rare* (used once a week or less), and has its own primary action. | — |
| 3 | **Card** (`Card`, `emphasis`) | The contents are read together and answer **one** question a reader could ask out loud. | ≤ 7 cards **as peers at one level**; ≤ 9 controls in one card without an inner `ListGroup`; **exactly one `primary` per page**. |
| 4 | **Group** (`ListGroup` with `label`) | Rows inside a card share a subject that the card's own title does not name. | 3–9 rows, more than 9 is two. Fewer than 3 only where the **label** states something neither row does. |
| 5 | **Disclosure** (new `Disclosure` primitive, §1.3) | The content is *evidence* (a log, a diff, an older list, a preflight report) or a setting whose default is right for nearly everyone. | Never nested. Never around a fact a decision is approved against. |
| 6 | **Tab strip** (a `SegmentedControl` that switches **which pane is shown**) | Two to five mutually exclusive views of one subject, where the reader wants one at a time and the page can tell whether there is anything behind each. | ≤ 5 segments. **One strip per page.** |
| 7 | **Sheet** (`Sheet`, native `<dialog>`) | A decision that must be answered before anything else proceeds; or an action that is destructive, irreversible, or handles a credential. | One default action + Cancel. Never nested. |

Notes that are part of the rule, not commentary:

- **Card `emphasis` is the hierarchy, not a border.** `primary` is the one card
  the page exists to show; `default` is what the reader came for; `quiet` is
  scaffolding — a form section, a picker, a footnote table. A page with two
  `primary` cards has none. `Card.tsx:11-17`.
- **A `ListGroup` without a `label` is not a group**, it is a box. `ListGroup`'s
  `label` prop already exists (`List.tsx:24`) and is the cheapest grouping move
  available anywhere in this app. Most of §3 is spending it.
- **`ListGroup`'s `footnote` is where a group's explanation goes** — under the
  box, not as a paragraph above it (`List.tsx:25`, `List.tsx:40-44`). A
  paragraph above a group is a lede for a heading that is already there.
- **The card cap is on *peers*, not on the page.** Seven cards side by side with
  nothing between them is the fuzziness this document is about; seven cards
  under three named regions is a structure. `/` keeps all eight of its cards and
  gets regions (§3.E.1) rather than losing one.
- **A group of two is legitimate where its label is the information.** Settings'
  `Raw-token ceilings` holds two rows whose labels are the same two words as the
  `Cost ceilings` group above it; the group label is the only thing telling them
  apart, so it is doing work. A group of two whose label merely restates its
  rows is not — which is why §3.B merges the two single-row guard groups.
- **A tab strip is a view switcher, never a navigation device.** Moving between
  different *subjects* is the sidebar's job. `/runs/[id]` has the app's one
  five-segment tab strip and `/chat`'s side card has a two-or-three-segment one;
  both stay.
- **A `SegmentedControl` used to pick a *value* is not a tab strip** and none of
  rule 6's caps reach it. The runs list's six-option status filter, the
  dashboard's three pickers (`Period length`, `Breakdown dimension`, `Span`),
  Settings' four and the run form's three are all form controls, governed by
  `conventions.md`'s own rule for the component and by its `max-md:flex-wrap`.
  **Do not "fix" the six-option filter to satisfy rule 6.**

### 1.2 What may never be used

Each of these is a thing a build run would plausibly reach for. None is allowed.

1. **A ninth pane.** `panes.ts` is eight rows bound to ⌘1–⌘8 and four readers
   (`panes.ts:3-14`). A ninth destination has no digit. New destinations are
   sub-routes under an existing pane.
2. **An accordion where more than one panel can be open.** That is cards with
   extra clicks and a lost scroll position.
3. **Nested disclosure.** A fact two clicks deep is a fact nobody has read.
4. **A tab strip inside a tab.**
5. **A page-level drawer.** The app has exactly one drawer — the sidebar below
   `md` — and it is a `<dialog>` in the top layer sharing Esc routing with
   `Sheet` (`conventions.md` mobile subsection). A second drawer is a second
   focus trap competing for the same key. **A drawer is the shell's, not a
   page's.** If a page wants a drawer it wants a `Sheet` or a sub-route.
6. **A tooltip carrying anything the reader needs.** No touch equivalent, and
   WCAG 1.4.13 wants dismissable/hoverable/persistent, which a hover title is
   not. If it matters it goes on the page; `Field`'s `hint` and `ListRow`'s
   `description` are where it goes.
7. **A hover-reveal of any kind.** `ListRow` is deliberately inert with no hover
   tint (`List.tsx:51-56`), and a control that appears on hover does not exist
   on a phone.
8. **`data-[…]` Tailwind variants** for any of this. Typed props with
   `Record<Union, string>` lookup maps, per `conventions.md`. Three silent
   failure modes are documented there; this document adds no exceptions.
9. **A second Save.** Where a page has one global Save (Settings), it keeps one.
   Splitting Save per section would make "unsaved" a per-section state and the
   sticky bar's `role="status"` line a lie.
10. **Undoing anything from §5.9** — the landed narrow-viewport work.

### 1.3 The one primitive that has to be built

#### `Disclosure` — `src/components/ui/Disclosure.tsx`

**Why it must exist.** There are seven hand-rolled `<summary>` elements in the
app and they do not agree:

| Call site | Has the 44px touch recipe? |
|---|---|
| `src/app/chat/page.tsx:649` | yes (`max-md:py-3.5`) |
| `src/app/branches/page.tsx:525` | yes |
| `src/app/runs/page.tsx:753` | yes |
| `src/components/ui/Patch.tsx:150` | **no** |
| `src/components/RunLand.tsx:55` | **no** |
| `src/components/RunReview.tsx:152` | **no** |
| `src/components/RunOutput.tsx:58` | **no** |

`conventions.md` names those four as "the one gap this leaves". They are a gap
because the recipe lives at call sites instead of in the kit — a `<summary>` is
`display: list-item`, so a `min-height` leaves the word at the top of the box a
finger aims at the middle of, and the answer is `max-md:py-3.5` instead. That is
exactly the kind of decision that belongs in one file. §3 also adds folds, and
adding them as an eighth, ninth and tenth hand-rolled `<details>` would make
this worse rather than better.

**Contract.**

```tsx
export type DisclosureTone = "default" | "quiet";
export type DisclosureSize = "default" | "compact";

export function Disclosure({
  summary,      // ReactNode — the always-visible line. Never a full sentence.
  count,        // number | undefined — rendered as a muted "(n)" after summary.
  tone,         // DisclosureTone = "default"
  size,         // DisclosureSize = "default"
  defaultOpen,  // boolean = false — uncontrolled, native.
  children,
  className,
}: { ... })
```

- **Native `<details>`/`<summary>`.** Not a hand-rolled show/hide. The browser
  gives keyboard operation, the disclosure triangle, find-in-page expansion in
  engines that support it, and correct semantics with no ARIA at all. Do **not**
  add `role`, `aria-expanded` or `aria-controls`: on a native `<details>` those
  are wrong or redundant in at least one engine.
- **Uncontrolled by default.** `defaultOpen` sets the `open` attribute at mount
  and the component never reads it again. A controlled disclosure invites a page
  to *close* one in response to a poll, which is this app's own "nothing
  switches tabs on its own" rule (`conventions.md`, the run-page paragraph) one
  component over.
- **One controlled mode, for one reason: opening has to fetch.** `open` and
  `onToggle` are accepted **together or not at all** — a lone `open` throws in
  development. There is exactly one call site entitled to them today, and a
  build run may not add a second without changing this document:
  `src/app/branches/page.tsx:515-529`, the *earlier presses of Land* history,
  which reads `/api/branches/queue?history=1` on open. `isolation-and-landing.md`
  says why that is not optional: the card polls every three seconds while the
  worker runs, so **the closed case has to stay the cheap one** — an
  always-render-and-hide-with-CSS disclosure would make an idle install pay for
  queue history on every tick. When `open` is supplied the component still
  renders a native `<details>` and still lets the browser drive the toggle; it
  reports the new state and never forces it.
- **Variants are `Record<Union, string>` maps** — `TONE` and `SIZE` — with the
  `max-md:py-3.5` in the same map entry as the pointer padding, because both
  candidates carry the same variant and Tailwind's sort order decides otherwise
  (`conventions.md`, the co-location rule).
- **Five interaction states with no layout shift**, and the focus ring comes
  from `@layer base` — this component states no outline width or offset.
- `count` exists because a fold that does not say how much is behind it is a
  fold nobody opens. `(0)` renders as nothing behind it — a caller with zero
  items should render an `Empty`, not a fold.

**What it must NOT do:**

- **Must not accept a `nested` prop or render a `Disclosure` in its own
  `children` without this document being changed.** Nesting is banned in §1.2.
- **Must not animate its own height.** `ui-transition` deliberately omits
  `height` and `transform`; an animated fold is content moving under a pointer.
- **Must not close on outside click, on route change, or on a poll.**
- **Must not take an `onOpen` that fetches.** Every fold in §3 wraps content
  that is already loaded. `/runs/[id]`'s "only the active tab is mounted" is a
  tab-strip decision that is documented and stays a tab-strip decision; do not
  generalise it to folds.
- **Must not be used above `md` for something that is visible below it, or vice
  versa.** A fold is the same fold at every width. Anything width-conditional is
  the landed mobile work's business, not this document's.

#### Nothing else is new

I considered and rejected three other primitives:

- **`Section`.** The settings page already has a local `Section` component
  (`settings/page.tsx:422-475`) that wraps `Card` + heading + lede. It is used
  by one page and should stay there. Promoting it to `ui/` would invite every
  other page to grow a lede, and §1.0 says the ledes are what to cut.
- **`Tabs`.** `SegmentedControl` plus the page's own conditional rendering is
  the existing pattern on `/runs/[id]` and it carries decisions (which tab is
  offered, what is mounted) that belong to the page, not to a primitive.
- **`Accordion`.** Banned in §1.2.

---

## 2. The promotion and demotion rule

### 2.1 What the operator actually does

Grounded in what the app is for, and in what each surface polls: the dashboard
polls every 120s (60s while runs are working), a run's own page every 3s, and
`/api/plugins`, `/api/calibrate` and `/api/claude-auth` are pressed by hand.

| Cadence | What it is |
|---|---|
| **Many times a day** | Read the 5-hour and weekly meters. Start a run. Watch a run's log. Read the runs list. |
| **A few times a day** | A run's spend and guards. Land a branch. Read a diff. Answer the orchestrator chat. |
| **Weekly** | Edit a workflow. Edit an agent. Save or reuse a template. Look at the API account. |
| **Once per repository** | Isolation copy globs, per-repository overrides, land strategy. |
| **Once per install, or after an incident** | Every ceiling, every retention horizon, prompts, plugins, sign-in, calibration, telemetry, silent-cycle limits. |

The single largest mismatch in the app today: **`/settings` is 38 always-visible
controls of which roughly 30 are pressed once per install**, laid out at exactly
the same weight as the two that are touched weekly.

### 2.2 The three tiers

**Tier 1 — top level, visible with no interaction.**

A control or figure is Tier 1 if **any** of these is true:

- a. It is read or changed on more than half of visits to that surface;
- b. Its value changes between two visits without the operator changing it;
- c. **A decision taken on this surface is approved against it.** This is a
  safety floor and it outranks (a) and (b) both ways: a rarely-read fact that a
  press of Run is approved against is Tier 1 no matter how rare. `BlockStatement`'s
  five facts, the chat proposal card's facts, and the new-run form's guard
  summary are all Tier 1 by this clause and none of them may be folded.

**Tier 2 — one click away, on the same surface (a `Disclosure`).**

- Set once per run, per repository or per install, **and** not covered by (c);
- or consulted only when something looks wrong (evidence: a log, a preflight
  report, an older list, a raw path).

**And the rule that makes a fold safe:**

> **A fold whose contents differ from their defaults opens by default, and its
> summary says how many differ.**

This is the generalisation of the settings page's existing "edited rail"
(`settings/page.tsx:555-564`) and it is the whole answer to the standard fold
failure — a setting hidden at a value the reader does not expect. Where a build
run cannot compute "differs from default" cheaply, it does not get to fold; it
groups instead.

**Tier 3 — behind a link to a sub-route, or inside a `Sheet`.**

- Used once per install **and** large enough to be its own screen; or
- destructive, irreversible, or handling a credential — regardless of frequency.

### 2.3 The four anti-rules

1. **Rarity never demotes a control below the thing it modifies.** If a rare
   control is the only way to undo, correct or override a common one, it sits at
   the same level as the common one. (Example: `Discard` next to `Save`.)
2. **Never fold something whose consequence is not visible from where it sits.**
   A fold hides the control; it must not also hide the sentence that says what
   the control does to money, to a branch, or to a running agent.
3. **Two names for one concept is a defect, not a layout problem.** Fix the
   name before deciding where the control goes. §3 lists every pair I found.
4. **A group with one member is not a group.** If applying this rule leaves a
   `ListGroup` with a single row, the row belongs in the group above it.

---

## 3. Per-surface target structures

Each subsection has the same five parts: **what it holds**, **what it arrived
with** (from `git log --follow`, because the provenance *is* the diagnosis),
**what the reader is doing**, **what is fuzzy** (counted, not felt), and the
**target structure**, in which every existing control is accounted for.

Subsections are ordered by build run (§4), so a run reads only its own.

**Two numbering schemes, deliberately.** `§3.C.2` is a *section* (the run detail
page). `C6` is a *change* inside it. Sections are cited with `§`, changes never
are — so `§3.E.1` is the dashboard and `E1` is the change that gives it regions.
Every change identifier is unique across the document.

### 3.0 The diagnosis, in one paragraph

Every page in this app grew the same way. A feature landed, and its controls
were appended to whichever card or section was nearest — `git log --follow -S`
on any heading shows it. `/runs/[id]`'s inspector is eleven blocks from eight
separate commits; its ButtonRow is five buttons from five commits; and its
"In your own terminal" card (`6c1a270`) is still rendering directly underneath
the Land tab (`36a0dbf`) that replaced it. `/settings` is thirty-eight
always-visible controls of which roughly thirty are pressed once per install,
laid out at exactly the weight of the two touched weekly. `/runs/new` is
twenty-one form controls that reach fifty-six interactive elements once the
reset markers, notice buttons and links are counted, and it names one concept
with three words in three adjacent rows. **Nothing was ever moved out or
grouped, and this document is that pass.**

---

## 3.A — Build run (a): the shell and the shared primitives

### 3.A.1 The shell: verified, and it does not change

`panes.ts` (8 rows, ⌘1–⌘8), `AppShell.tsx` (373), `Sidebar.tsx` (312),
`Toolbar.tsx` (154), `QuickOpen.tsx` (285).

**What it holds.** The sidebar is a brand strip (inert, deliberately not a link
home — `Sidebar.tsx:117`) and one `<nav aria-label="Primary">` of eight rows.
Each row is an icon, a truncating label and nothing else: no badge, no count,
no second line, no submenu. The collapse control is on the toolbar, not here.
The toolbar is, left to right: collapse-or-drawer (mutually exclusive by media
query), a route-derived title that is a `<div>` and not a heading, then a
right-hand group of Quick open, `ThemeToggle` (three segments) and — on `/`
only — a `New run` `ButtonLink`. Quick open searches panes, runs and workflows
into one flat two-slot list, and its footer says
`Navigation only — nothing here starts, approves or stops a run`.

**Verdict: no change.** Four runs rebuilt this for narrow viewports at
`2c43b27` and it is the least fuzzy surface in the app — eight peers with one
grouping (the `<nav>`), one action, and a closed destination list. Two things a
build run will be tempted to do and must not:

- **Do not add a badge or a count to a sidebar row.** That is a feature, not a
  rearrangement, and it puts a polling read behind every page. It is in §6.
- **Do not remove the toolbar title as a duplicate of the page's `<h1>`.** The
  duplication is deliberate and documented — the title is what truncates when
  `ThemeToggle` grows below the breakpoint, precisely because it is a duplicate.

The one thing worth recording as fuzzy and left alone: `Orchestrator` is the
pane label, the page's `<h1>`, and the assistant's speaker name in the
transcript. Three uses, one word, all correct.

### 3.A.2 `Disclosure` — build it

Specified in §1.3. Run (a) builds `src/components/ui/Disclosure.tsx` and
migrates **only the one call site inside the kit**:

- `src/components/ui/Patch.tsx:139-150` (`DiffFileRow`) — currently a raw
  `<details>` with a sticky `<summary>` and **no** `max-md:py-3.5`. Migrating
  it closes one of the four touch-target gaps `conventions.md` names.

The other six call sites are migrated by whichever run owns their page
(§3.B–§3.E). Run (a) does **not** touch them.

`Icon.tsx:33-34` carries `chevron-right` and `chevron-down` under a comment at
`:32` reading exactly `// Disclosure.`. **`chevron-right` has no consumer
anywhere in `src/`; `chevron-down` has exactly one** — the chat's
jump-to-latest button at `chat/page.tsx:746`. So the disclosure glyph was
drawn for a component that was never built, and the comment above it has been
wrong ever since. `Disclosure` may use those glyphs or leave the native
`<summary>` marker alone; either way **run (a) owns `Icon.tsx`** and corrects
that comment so it names what the glyphs are actually for. Use them, or use the native
`<summary>` marker and delete the comment — but do not leave both.

### 3.A.3 `ListView` — extract it, and make the difference typed

Five files define a `LIST_VIEW` const. **Four distinct strings, none exported:**

| File:line | String |
|---|---|
| `src/app/page.tsx:151-153` | `max-h-80 overflow-auto max-md:max-h-none max-md:overflow-visible rounded-sm border border-line` |
| `src/components/RepoSpendCard.tsx:51-53` | identical to the above |
| `src/components/UsagePeriods.tsx:103-105` | identical **plus a leading `mt-4`** |
| `src/components/LiveTelemetry.tsx:27-28` | `overflow-auto max-md:overflow-visible rounded-sm border border-line` — **no `max-h-80`** |
| `src/app/runs/page.tsx:112` | `rounded-lg border border-line bg-surface` — **no cap, no scroll at all** |

A matching `STICKY_HEAD` is defined five times beside them. **Four are the
same string character for character** — `page.tsx:160-161`,
`UsagePeriods.tsx:112-113`, `LiveTelemetry.tsx:30-31` and
`runs/page.tsx:114-115`, all `"sticky top-0 z-10 bg-surface
shadow-[inset_0_-1px_0_var(--border)]"`. The fifth, `RepoSpendCard.tsx:54`, is
`"sticky top-0 z-10 bg-surface"` — the same string **without the hairline
shadow**.

The last two differences are *deliberate and documented* — the runs list is
not a scroll container because its sticky header must pin to the content pane
(`runs/page.tsx:100`, and `conventions.md`'s paragraph on it) — but nothing in
the code says so where a reader would look, and four copies of one string is
how the fifth one drifts.

**Build `src/components/ui/ListView.tsx`:**

```tsx
export type ListViewCap = "capped" | "uncapped";

export function ListView({
  cap,        // ListViewCap = "capped"
  children,
  className,  // spacing only; the caller's own margin, never a cap
}: { ... })

export const STICKY_HEAD: string;  // the one string, exported
```

- `capped` = `max-h-80 overflow-auto max-md:max-h-none max-md:overflow-visible`
  plus the box. This is `conventions.md`'s released-below-the-breakpoint rule
  and it is now stated once instead of three times.
- `uncapped` = the box and nothing else. Its doc comment carries the runs
  list's reason verbatim: a sticky header inside a scroll container pins to a
  box that never moves.
- `className` is for the caller's margin (`UsagePeriods`' `mt-4`), never for a
  cap. A caller that passes a `max-h-*` here is a bug; say so in the comment.

**Migration, exactly, with no behaviour change:**

| Call site | Passes |
|---|---|
| `src/app/page.tsx:1016`, `:1085` | `cap="capped"` |
| `src/components/RepoSpendCard.tsx:114` | `cap="capped"` |
| `src/components/UsagePeriods.tsx:237` | `cap="capped" className="mt-4"` |
| `src/components/LiveTelemetry.tsx:81` | `cap="uncapped"` |
| `src/app/runs/page.tsx:269` | `cap="uncapped"` |

`LiveTelemetry` gets `uncapped` because that is what it does today. Whether the
missing `max-h-80` there was a decision or an omission is **unverified** and it
is in §6 — a build run must not answer it by changing the class.

### 3.A.4 `Field.tsx` — move the one thing in it that is not a form control

`Field.tsx` is 508 lines and the task's suspicion is correct, but only once:

- **`Subsection` (`Field.tsx:285-300`)** is a page-composition primitive — a top
  border, a rule and a heading, documented as "A labelled group of related
  fields inside a card". It is not a form control and it sits between `Textarea`
  and `LimitField`. **Move it to `src/components/ui/Card.tsx`, beside
  `CardTitle`, unchanged**, and update every import. No markup change, no class
  change.

Three other things in that file are layout decisions and **stay**, because
moving them would change pixels above the breakpoint, which §5.9 forbids:

- `Field`'s unconditional `mb-3.5` (`:179`) — the app's field-to-field rhythm.
- `Textarea`'s `max-w-[100ch]`, `min-h-[90px]` and forced `font-mono` (`:279`).
- `Toggle` (`:479-508`), which is `ListRow`'s arrangement mirrored. The
  duplication is documented at `:473-478`.

All three are in §6 as questions for a person.

### 3.A.5 Acceptance criteria for run (a)

1. `src/components/ui/Disclosure.tsx` exists, matches §1.3's contract, uses a
   native `<details>`/`<summary>`, carries `max-md:py-3.5` in its `SIZE` map,
   and adds no ARIA.
2. `ui/Patch.tsx`'s `DiffFileRow` uses it. The sticky `z-10` summary behaviour
   is preserved.
3. `src/components/ui/ListView.tsx` exists with the typed `cap` and an exported
   `STICKY_HEAD`; all five call sites use it; all five `LIST_VIEW` and five
   `STICKY_HEAD` local consts are deleted.
4. `Subsection` is exported from `ui/Card.tsx` and no longer from `ui/Field.tsx`.
5. `npm run typecheck` passes. `npm test` passes — including
   `src/components/ui/Table.test.tsx` and `src/components/Meter.test.tsx`.
6. Nothing under `src/app/` is modified except imports.
7. The emitted CSS is checked for the `max-md:` variant on the new component —
   Tailwind emits nothing for a spelling it does not know, silently
   (`conventions.md`).

**Run (a) must not touch:** `src/app/settings/`, `src/app/runs/`,
`src/components/Workflow*`, `src/app/page.tsx`'s structure (only its
`LIST_VIEW` import), `src/app/branches/`, `src/app/chat/`, `src/app/agents/`,
`src/app/account/`. Later runs own all of those.

---

## 3.B — Build run (b): `/settings`

**File:** `src/app/settings/page.tsx` (2850).

### What it holds

Seven sections — not eight. `SECTIONS` at `:84-92` and seven rendered
`<Section>`s. Above them an un-anchored `<dl>` of environment facts
(`:1394-1450`) carrying the Claude sign-in buttons; between them a `<nav
aria-label="Settings sections">` of seven plain anchors (`:1457-1470`); below
them a sticky footer with `Discard` and one `Save` (`:2798-2847`).

| Section | Lines | Emphasis | Settings controls |
|---|---|---|---|
| `Subscription limits` | 1472–1961 | **`primary`** | 10, one conditional |
| `Runs` | 1963–2228 | `default` | 10 |
| `Default guard set` | 2230–2427 | `default` | 7 |
| `Unattended runs` | 2429–2536 | `default` | 5 |
| `Plugins` | 2538–2606 | `default` | *n*, one switch per plugin, saved on press |
| `Storage` | 2608–2692 | `default` | 3 (+ a read-only `ListGroup`) |
| `Prompts` | 2694–2773 | `default` | 4 `Textarea`s |

**39 always-visible settings controls** (23 `Input`, 5 `Textarea`, 5 `Switch`,
2 `Select`, 4 `SegmentedControl`) against `EDITABLE_PATHS`' **38** paths — the
two differ because `weeklyAnchor` is written by two controls, the `Select` at
`:1712` and the conditional UTC-hour `Input` at `:1740`. Plus 7 chips, 2
footer buttons and up to 3 account buttons. **≈50 interactive elements on one
flat scroll.** (Counts exclude the per-plugin `Switch` at `:2596`, which is
data-dependent, and the `Input` at `:968`, which is inside a `Sheet`.)

### What arrived with what

- `1ac708d` *Restructure settings into sections with a sticky save bar* — the
  section machinery and `Prompts`.
- `2b1c1a7` *Group Settings around decisions and mark unsaved fields
  individually* — `Subscription limits`, `Runs`, `Default guard set`,
  `Unattended runs`, and the edited rail.
- `b748b55` *Bound run_events…* — `Storage`.
- `e2220e2` *Let an install choose which Claude Code plugins its agents load* —
  `Plugins`.
- `3b718d5` / `939939a` — the two Claude sign-in sheets, appended to the
  environment `<dl>` at the top.

### What the reader is doing

Almost nothing, almost never. This is the page's defining fact and the source
of its fuzziness: roughly thirty of thirty-eight controls are pressed **once
per install**, and they are drawn at exactly the weight of `Default model` and
`Runs at the same time`, which are touched weekly.

### What is fuzzy — counted

1. **Seven sections at one weight with an inert map.** The chips are plain
   `<a href="#…">` with no `aria-current`, no active state and no scroll-spy
   (grep: neither appears in the file). Seven more peers, not a map.
2. **A chip that does not say what it lands on.** Chip `Default guards`
   (`:87`), heading `Default guard set` (`:2232`).
3. **Two labels used twice each in one section.** `5-hour ceiling` at `:1539`
   and `:1656`; `Weekly ceiling` at `:1568` and `:1681` — told apart only by
   their `ListGroup` label and their `unit`.
4. **Two single-row `ListGroup`s in a row.** `What one chat message may spend`
   (`:2372`) and `What this whole install may spend` (`:2400`). §2.3 anti-rule 4.
5. **Four `Textarea`s with `min-h` of 130/130/110/110px** in `Prompts` — about
   500px of edit surface for the four strings edited least often on the page.
6. **`discard()` (`:1229-1234`) resets `copyGlobsText` and not
   `copyGlobsByRepoText` or `verifyToolsText`.** Not a layout defect; recorded
   because a build run touching these rows will see it.

### Target structure

Seven sections, same names, **same order**. A reader relearns nothing. Four
changes, in increasing size.

**B1 — Make the chip nav a map (required).**
Add an active state driven by the location hash: the chip whose `id` matches
`location.hash` carries `aria-current="true"` and the selected chip styling.
Update on click and on `hashchange`. Keep plain anchors — the comment at
`:1452-1456` says why, and it is right.
**Explicitly out of scope: an `IntersectionObserver` scroll-spy.** The pane is
its own scroll region, so the observer needs a `root` that is not the viewport;
that is a second mechanism with a second failure mode for a marginal gain.

**B2 — Fix the three naming defects (required).**
- Chip label `Default guards` → `Default guard set`.
- `Raw-token ceilings`' rows: `5-hour ceiling` → `5-hour token ceiling`,
  `Weekly ceiling` → `Weekly token ceiling`. The `ListGroup` label stays.
- Merge the two single-row groups into one `ListGroup label="Spending ceilings
  for this install"` holding both `Orchestrator chat limit` and
  `Install limit, rolling 24 hours`, keeping both hints verbatim.

**B3 — Fold what is set once, using `Disclosure` (required).**

Four folds, and no others:

| Section | Fold summary | What goes in | Why |
|---|---|---|---|
| `Subscription limits` | `When a window turns over` | the existing `ListGroup` of that name — `Weekly reset`, `Reset hour, UTC`, `5-hour window reset` | Hand-corrections for a boundary that could not be observed; `metering.md` calls the override "the one number a user supplies about a window". |
| `Subscription limits` | `Estimate a ceiling from your own history` | the `Where a ceiling can come from` group: `Scan history`, the result `Table`, the `<dl>`, the caveat `Notice`, `Copy peaks into the fields above` | A tool, pressed once. Nothing in it is stored until Save. |
| `Runs` | `Isolated runs` | the existing group — `Files copied into a new checkout`, `Per-repository overrides`, `Landing a branch`, `Checks a conflict resolution may run` | Once per repository. |
| `Prompts` | one fold **per prompt**, summary = the field's own label | each `FormField` | Four strings, ~500px, edited least on the page. |

**The open-by-default rule from §2.2 applies to all four**, and it is what makes
this safe rather than a way to hide a surprise:

> `GET /api/settings` gains a `nonDefaultKeys: string[]` field, computed
> server-side with the **existing** `sameValue` in `src/lib/settings.ts:706`
> (export it; do not write a second definition — the structural-not-`JSON.stringify`
> reasoning in the doc comment above it is load-bearing). A `Disclosure` whose
> fold contains any key in that list renders `defaultOpen` and its `count` is
> the number of such keys.

Three details of that, because run (b) would otherwise have to guess and the
wrong guess is silent:

- **`nonDefaultKeys` is a third top-level key on the GET response, beside
  `settings` and `env`.** Not inside `env` — that object is about the
  environment the container was given, and this is about the stored blob.
  `src/app/api/settings/route.ts:32-64`.
- **`PUT` returns it too.** `:388` currently answers `{ settings: saveSettings(patch) }`
  and the page sets both `s` and `savedS` from that response
  (`settings/page.tsx:1252-1253`). Without the field on the PUT, every fold's
  `count` is stale the moment the operator saves.
- **`defaultOpen` is read from the *first* GET and never again; `count` follows
  the latest response.** `Disclosure` is uncontrolled precisely so that a fold
  cannot close under the reader — and a fold snapping shut in the same frame as
  a successful Save, because the value it holds just became the default, is that
  failure in its most confusing form. The badge may change; the open state may
  not.

This is also the answer to the objection already recorded in the file. The
comment at `:1645-1647` says the raw-token ceilings are
`"On screen rather than behind the disclosure this used to be: the two fields
are what a scan writes into, and an unsaved edit the operator cannot see is
worse than one they did not ask for."` That objection is correct and the
open-by-default rule is what retires it — **but `Raw-token ceilings` is still
not folded**, because `Copy peaks into the fields above` writes into it and a
fold whose contents another control writes to is a fold that opens while you
are not looking. Leave that group on screen.

**B4 — What deliberately does not change.**

- **`Unattended runs` is not folded.** Five rows is not a crowd, and a section
  whose entire body is behind one summary reads as an empty section.
- **`Storage` is not folded.** Three retention rows plus a read-only figure
  group, already the smallest section.
- **`Plugins` is untouched.** Its switches POST on press and its lede says so;
  a fold around a control that saves itself is a fold that hides a write.
- **No lede is deleted.** I checked all seven against §1.0 rule 1: none
  restates its heading, and each names something the heading does not.
- **The `Subscription limits` card keeps `emphasis="primary"` and it stays the
  only one.**
- **One Save.** §1.2 rule 9.
- **The two sign-in `Sheet`s stay inside the row's `<dd>`** — `939939a` moved
  them there and a `<dl>` may hold only `dt`/`dd`/`div`.
- **The calibration result table keeps no `stack` and no `Td label`s.** That is
  correct rather than an oversight: it is a three-column suggestion table
  (`Ceiling` / `Set now` / `Observed peak`), not a presentation of a record, and
  after B3 it lives inside a fold. `conventions.md` used to name the *storage
  report* as the settings page's un-stacked table; that sentence has already
  been corrected — see §7 — so run (b) does not need to touch it.

### Every control, accounted for

Nothing is deleted. Of the 38 settings controls: 3 move into the
`When a window turns over` fold, 4 into `Isolated runs`, 4 into the four prompt
folds, 2 change `ListGroup`, 2 are renamed, and the remaining 23 do not move.
The 7 chips, 2 footer buttons, the calibration `Button`s and every account
button stay, in place, with the same labels — except the one chip renamed in B2.

### Acceptance criteria for run (b)

1. The seven section headings and their order are byte-identical to today.
2. Exactly one chip carries `aria-current` at a time, and it tracks
   `location.hash` across click and `hashchange`.
3. `Default guards` no longer appears anywhere in the file.
4. `sameValue` is exported from `src/lib/settings.ts` and used — not
   reimplemented — by whatever computes `nonDefaultKeys`.
5. A prompt whose stored value differs from the shipped default renders its
   `Disclosure` open on load, with a non-zero `count`. Saving that prompt back
   to its default updates the `count` and **leaves the fold open**.
6. Every one of the 38 `EDITABLE_PATHS` is still reachable and still writes the
   same key. Save still commits every field in one press.
7. `blocked` still refuses Save for both existing reasons (`:1290-1302`), and
   the refusal is still readable when the control it names is inside a fold —
   **a fold containing a control named by a `blocked` reason opens.**
8. `npm run typecheck` and `npm test` pass; `src/lib/settings.test.ts`
   still asserts on the stored blob.

**Run (b) must not touch:** anything outside `src/app/settings/page.tsx`,
`src/app/api/settings/route.ts`, `src/lib/settings.ts` (export only) and
`docs/agent/conventions.md`'s stale line.

---

## 3.C — Build run (c): `/runs/new` and `/runs/[id]`

### 3.C.1 `/runs/new`

**File:** `src/app/runs/new/page.tsx` (2383).

**What it holds.** Four cards — `What to work on` (`primary`), `What the agent
may do`, `When it stops`, `Save for next time` (`quiet`) — inside one `<form>`
committed by a `Start run` button and ⌘↩. **Nineteen form controls** (6
`Input`, 1 `Textarea`, 5 `Switch`, 4 `Select`, 3 `SegmentedControl`); twelve
`ResetToBaseline` markers; two buttons in the templates card; four buttons
inside two carried-template notices; two footer buttons; eight `<Link>`s; up
to nine focus buttons in the validation list. **Up to 54 simultaneously
reachable interactive elements.**

**What arrived with what.** `ca50657` split the form out of the runs page with
the three limit rows. `28e4f4b` *Make the new-run form say what each guard will
cost* added three of the four card titles, the sticky footer and `GUARD_ROWS`.
`791a83f` put it on the grouped list and added every `SegmentedControl` and
`ResetToBaseline`. `f362497` added the templates card. `ddbe231` / `f3f59a6` /
`9f02047` / `17d8d6a` each added or reworded the agent picker. `b84b382` added
the live spend guard and its hint. Four separate commits appended to
`When it stops`.

**What the reader is doing.** Answering four questions in order, then pressing
one button that starts an unattended agent that spends money. The four card
titles are a genuinely good sequence and they stay.

**What is fuzzy — counted.**

1. **`When it stops` holds 10 of the 19 form controls**, three `ListGroup`s, a
   computed summary paragraph, seven reset markers, one conditional warn
   notice (`:1820`) and three trailing hints — about **20 interactive elements
   in one card**, against 5 / 2 / 2 form controls in the other three. The
   `bypassPermissions` danger notice is at `:2276`, below the last card, not
   in this one.
2. **Three decisions cost six controls.** `Work cycles` + `Cap the work
   cycles`, `Spending limit for this run` + `Cap what this run may spend`,
   `Time limit` + `Cap how long this run may take` — a `Switch` whose label is
   different from the row it governs, and an `Input` that vanishes when it is
   off.
3. **Eight conditional blocks after the last row of controls** — three
   trailing hints still inside `When it stops` (`:2161`, `:2168`, `:2174`; the
   card closes at `:2180`) and five below the last card (`:2258`, `:2268`,
   `:2276`, `:2291`, `:2299`). Five of the eight are about one specific
   control higher up the page.
4. **Ten concept-synonym pairs.** The worst three:
   - *cycle / iteration / pass*: `Work cycles` (`:1884`) beside
     `1 means one pass and then stop` (`:1888`) beside `id="iters"` (`:1910`).
   - *guard / ceiling / limit*: `Window guards` (`:2032`),
     `No 5-hour ceiling is set` (`:2045`), `Spending limit for this run`
     (`:1932`) — **and one genuine misuse**, `each cycle carries what is left
     of it as a ceiling` (`:1938-1939`), which applies the subscription-side
     word to a per-run cap.
   - *checkout / worktree / branch / this folder*: `Own branch` (`:258`),
     `Its own checkout` (`:264`), `ROW_LABEL.isolate = "isolation"` (`:139`),
     under a row labelled `Where Claude writes` (`:1750`).
5. **One control with two names.** Visible label `What it may do without
   asking` (`:1781`); accessible label `What the agent may do without asking`
   (`:1806`).

**Target structure.**

**C1 — Settle the three words, app-wide (required, and it lands here first).**

| Word | Means | Never means |
|---|---|---|
| **ceiling** | A number set in Settings that a window percentage is measured against. | A cap on one run. |
| **guard** | A threshold on a window (5-hour or weekly) that steps a run aside or ends it. | A number of dollars or minutes. |
| **limit** | A cap on this run: work cycles, spend, time. | Anything about the subscription. |

The page is already 90% consistent with this. Fix exactly one phrase, and note
that it occurs **twice** — once in each branch of the same ternary, at
`runs/new/page.tsx:1938` (the `live` branch) and `:1939` (the other):

- `Read mid-cycle too, and each cycle carries what is left of it as a ceiling,
  so the run stops near this figure`
- `Each cycle carries what is left of it as a ceiling, so the run stops near
  this figure`

In both, `as a ceiling` → `as its own cap`. Nothing else on the page changes
wording. The same three-word table is added to `docs/agent/conventions.md` (§7).

**C2 — Promote the stop summary (required).**
`summaryLead` + `windowLines` + the no-terminus sentence (`:1853-1871`) is
what a press of `Start run` is approved against. It is Tier 1 by §2.2 clause
(c). Today it is unstyled text between the card title and the first group.
Draw it as a `Notice tone="info" quiet` at the top of the card — the same
treatment the chat's standing safety line already uses
(`chat/page.tsx:638`) — and **state in a comment that it may never be folded.**

**C3 — Collapse the three switch-plus-input pairs into `LimitField` (required).**
`LimitField` (`Field.tsx:315-374`) is exactly this shape and is already used by
`WorkflowEditor`. Three rows replace six controls, with no capability lost:

| Row | `modeLabel` | `onLabel` | `offLabel` | `unit` |
|---|---|---|---|---|
| `Work cycles` | `Whether the work cycles are capped` | `Stop after…` | `No cycle limit` | `cycles` |
| `Spending limit for this run` | `Whether this run's spend is capped` | `Stop near…` | `No spending limit` | `USD` |
| `Time limit` | `Whether this run's time is capped` | `Stop after…` | `No time limit` | `minutes` |

**Two behaviours must survive and a build run has to check both:** a limit
switched off **keeps whatever number is in its box** (`:1089-1098`), and
`htmlFor` on the row points at a control only when one exists (`:1883`,
`:1931`, `:1977`). The three `restoreRow` markers (`cycles`, `cost`, `time`)
stay on their rows.

**C4 — Move five trailing blocks to the control they are about (required).**

| Today | Moves to |
|---|---|
| `:2161` telemetry hint | the `Spending limit for this run` row's hint |
| `:2168` no 5-hour percentage | the `Step aside at 5-hour usage` row's description |
| `:2174` keeps editing after DONE | the `Keep going after DONE` row's description |
| `:2258` rolling weekly window | the `When a limit is reached` row's group footnote |
| `:2268` a waiting run keeps its checkout | the same footnote |

Their conditions, tones and text are unchanged — only their position.

**Three stay exactly where they are**, immediately above the footer, because
they are about the *submission* and not about a control: `:2276` (the
`bypassPermissions` danger notice — Tier 1 clause (c), and it must be the last
thing read before `Start run`), `:2291` (`formError`), `:2299` (`started`) and
`:2317` (the validation list).

**C5 — What does not change.**
- The four card titles, their order, and `primary`/`default`/`default`/`quiet`.
- All twelve `ResetToBaseline` markers. They are the only route back to a
  template's value, so §2.3 anti-rule 1 keeps them at row level.
- The four buttons inside the two carried-template notices. Tier 1 clause (c).
- Nothing on this page is folded. Every control here is answered once per run,
  which is the definition of Tier 1 clause (a) on this surface.
- The visible/accessible label mismatch at `:1781` vs `:1806` is **left alone**:
  the accessible name is deliberately the fuller one because a screen-reader
  user has no card title in earshot. Recorded so nobody "fixes" it.

### 3.C.2 `/runs/[id]`

**Files:** `src/app/runs/[id]/page.tsx` (1449), `RunLand.tsx` (634),
`RunDiff.tsx` (195), `RunReview.tsx` (164), `RunOutput.tsx` (70),
`RunAgentCost.tsx` (221).

`LiveTelemetry.tsx` and `RestartClosed.tsx` are **not on this page** — the
first is the dashboard's (`app/page.tsx:856`), the second the runs list's
(`runs/page.tsx:652`). Run (c) does not touch either.

**What it holds.** A split view: a 21rem `lg:sticky` inspector on the right
(source-ordered first, so it leads at one column) and a pane on the left behind
a five-segment `SegmentedControl` — `Log`, `Report`, `Changes`, `Review`,
`Land`. The inspector is **eleven blocks, seven unconditional and four conditional** —
the conditional four are the reopen form (`{reopenOpen &&`, `:972`), `Agent`
(`{run.agent &&`, `:1202`), `Telemetry — first-party` (`{telemetry &&`,
`:1245`) and `Checkout` (`{isolated &&`, `:1267`).

**What arrived with what — this is the diagnosis.**

- `7164d04` *Put the run on a split view with an inspector* created the column
  and the tab strip and moved `Guards`, `Checkout` and `Task` into it.
- `2cc61c1` added `Telemetry — first-party`, and retitled the handoff card.
- `f3b425c` added `Agent work` / `RunAgentCost`. `ddbe231` and `17d8d6a` added
  the `Agent` section and its two rows.
- The ButtonRow at `:925-959` collects five buttons from five commits:
  `f1f73f8` (`Try now`), `0d88856` (`Resume run`), `a84506b` (`Ask for more`),
  `d193868` (`Set aside` / `Put back`), `1bdd7ff` (the not-owner branch).
- **`6c1a270` *Run several agents on one project at once* added this card, as
`Where the work landed`; `2cc61c1` retitled it `In your own terminal`.
`36a0dbf` *Let a run's work be reviewed and landed* added the Land tab that
does the same job in the UI. Both still render, together, at `:1381-1444`.** That is the single clearest artefact of
  the problem this document exists to fix: two generations of one feature
  stacked, neither ever removed.

**What is fuzzy — counted.**

1. **Eleven inspector blocks, six heading strings, one weight.** Every
   `Section` heading is `text-xs font-semibold text-ink` (`:293`), and so are
   the two labels of the headingless stat grid. `Telemetry — first-party`
   (only when an OTLP row exists) is set identically to `Guards` (always).
2. **Twelve outcomes on one `<h2>`.** `describeRun` (`:114-265`) sets all
   twelve headlines at the same typography. They are not undifferentiated —
   each carries a `tone` that `STATE_ACCENT` (`:86-92`) turns into a left
   border, so `Working` is `info`/`border-l-accent` and `Refused to start` is
   `warn`/`border-l-warn` — but a 3px edge is the whole of the difference
   between a state you see constantly and one most operators never see.
3. **Three cost readings adjacent and unlabelled as such.** The `Spent` stat
      (`runs.spent_usd`), `Agent work` (transcript-derived, `RunAgentCost`) and
   `Telemetry — first-party` (OTLP). **Two of the three say in user-visible
   copy that they must not be added** — `RunAgentCost.tsx:211` ("never added
   to either") and `:1256-1257` ("Kept apart from the figure above rather than
   added to it") — while the `Spent` block says it only in a source comment
   (`:1091-1093`). Nothing in the *structure* says it at all.
4. **A superseded card inside the tab that superseded it** — the `Card` is
   `:1386-1441`; the Land branch that renders both is `:1381-1444`.
5. **Five names for one action.** The same button reads `Resume` / `Try again`
   / `Ask for more` (`:931-935`) and its submit reads `Resume run` (`:1078`);
   the page elsewhere says `picked up again` and `Try now`.
6. **Three headings for one list.** `Left uncommitted in the checkout`
   (`RunDiff.tsx:174`), `Uncommitted in this folder` (`:175`),
   `Uncommitted in its checkout` (`RunLand.tsx:124`).
7. **Tab noun versus card title.** Tab `Changes`, card `What changed`, button
   `Show changes`, and the adjacent Review tab says `diff` twice.

**Target structure.**

**C6 — Give the inspector four regions (required).**
Eleven blocks become a headingless top plus three named regions. Nothing leaves
the column, nothing is folded, and every block keeps its own heading.

| Region | Heading | Blocks, in order |
|---|---|---|
| 1 | *(none — the state headline is the heading)* | state headline + detail + stop reason + `needs_review_reason` + workflow/set-aside sentences; the ButtonRow; the feedback region; the reopen form |
| 2 | **`Against its limits`** | `Guards` (the up-to-three meters and the five rows) |
| 3 | **`What it has spent`** | the `Spent` / `Work cycles` stat grid; `Agent work`; `Telemetry — first-party` |
| 4 | **`How it was set up`** | `Agent`; `Checkout`; `Task` |

> **Region 4 is what keeps the agent *beside* the guards rather than among
> them.** `agents-and-templates.md` forbids an agent row inside a guard group,
> because a row there would claim it bounds something and an agent bounds
> strictly nothing. `Agent` sits in its own region, two regions away from
> `Against its limits`. A build run that "tidies" it into region 2 has broken
> that rule and nothing will say so. See §5.8.

Region headings are `<h2>` styled as `CardTitle` (`text-sm font-semibold`);
block headings stay `<h3>` at `text-xs font-semibold`. That is the existing
two-step in `conventions.md`, not a new token, and it is what stops a rare
block reading as a peer of a constant one. The inspector `Card` has no
`CardTitle` today (`:864`) and the state headline is already an `<h2>`
(`:885`), so the region headings are its siblings.

> **Region 3 carries a prohibition, and it is the reason the region exists.**
> The three blocks under it are the three cost sources `CLAUDE.md` says are
> never summed or mixed. **No figure, meter, badge or total may be drawn at the
> region level**, and every one of the three keeps its own footnote verbatim —
> `:1098-1101`, `RunAgentCost.tsx:208-217`, `:1255-1263`. A build run that adds
> a region subtotal has broken a correctness invariant that will not throw and
> will not fail typecheck. See §5.1.

**C7 — Fold the superseded terminal card (required).**
`In your own terminal` (the `Card` at `:1386-1441`), with its `Review it` and
`Bring it in` sub-headings, its uncommitted-changes `Notice` and its `Empty`, moves **whole
and unchanged** into a `Disclosure summary="Do it in your own terminal"` at the
foot of the Land tab, below `RunLand`. It is Tier 2 evidence: an escape hatch
consulted when the in-app path will not do. **Nothing in it is deleted** — its
outright removal is a question for a person and is in §6.

**C8 — One primary action in the ButtonRow (required).**
Up to four buttons render together. Assign variants so the row says which one
the page is for:

| Button | Variant |
|---|---|
| `Stop run` / `Give up` (`:940`) | `danger` |
| `Resume` / `Try again` / `Ask for more` (`:931`) | `primary` |
| `Try now` (`:926`) | `secondary` |
| `Put back` (`:949`) | `secondary` |
| `Set aside` / `Stop and set aside` (`:956`) | `ghost` — it is documented at `:647-654` as the one control that does not change what the run *is* |

Order is fixed: the action on the run's state first, `Set aside` last.

**C9 — Make the reopen form's submit agree with the button that opened it
(required).** `Resume run` (`:1078`) takes whichever of `Resume` / `Try again`
/ `Ask for more` was pressed. §2.3 anti-rule 3.

**C10 — One name for the uncommitted list (required).**
`RunDiff.tsx:174`, `RunDiff.tsx:175` and `RunLand.tsx:124` all become
**`Uncommitted in the checkout`** for an isolated run and **`Uncommitted in
this folder`** for a direct one. The two-branch distinction at `RunDiff:174/175`
is real and stays; what goes is the third wording.

**C11 — Migrate the three remaining `<details>` in run (c)'s files to
`Disclosure`** — `RunOutput.tsx:57`, `RunReview.tsx:151`, `RunLand.tsx:54`;
`runs/[id]/page.tsx` itself contains none — which is what closes the
touch-target gap `conventions.md` names. (`ui/Patch.tsx` is run
(a)'s.) Summaries and `count`s:
`{n} earlier work cycle{s}`, `{n} earlier review{s}`, and `RunLand`'s
per-file conflict summary unchanged.

**C12 — What does not change.**
- **The tab strip.** Five labels, the order, the conditions each is offered
  under, the log leading, only the active tab mounted, and nothing switching
  tabs on its own. See §5.4.
- **The split's geometry**: `lg:grid-cols-[minmax(0,1fr)_21rem]`, the explicit
  `lg:col-start-*`/`lg:row-start-1` placement, and the inspector's
  `lg:sticky` cap. §5.9.
- The three `Guards` meters staying absent when their limit is unset. A meter
  for an unset limit would be an unknown reading, and §5.2 governs those.
- `RunAgentCost`'s poll cadence (30s) and its own route.
- The `Task` box's `tabIndex={0} role="group"`.
- The `Report` tab's dependence on `cycleOutputs` running on the *page*.

### Acceptance criteria for run (c)

1. `/runs/new`: `LimitField` replaces the three switch-plus-input pairs; a
   limit switched off still keeps its number; all twelve reset markers still
   render on the same rows; `Start run` and ⌘↩ both still submit.
2. `/runs/new`: the stop summary is drawn as a `Notice tone="info" quiet` at
   the top of `When it stops`, with a comment forbidding a fold.
3. `/runs/new`: `grep -c 'as a ceiling' src/app/runs/new/page.tsx` returns 0
   (it is 2 today); `docs/agent/conventions.md` carries the three-word table.
4. `/runs/new`: exactly four blocks remain between the last card and the
   footer — the `bypassPermissions` notice, `formError`, `started`, and the
   validation list.
5. `/runs/[id]`: three region headings exist, at `text-sm font-semibold`, and
   every one of the eleven blocks is under exactly one of them or in region 1.
   **No region is a `<section>` element** — see §5.11.
6. `/runs/[id]`: **no figure is rendered at the level of `What it has spent`**,
   and the three footnotes are byte-identical to today.
7. `/runs/[id]`: `In your own terminal` renders inside a `Disclosure`, with
   every string it holds today.
8. `/runs/[id]`: at most one `primary` button renders in the ButtonRow in
   every reachable state — check `running`, `paused`, `queued`, `waiting`,
   `completed`, `failed`, `blocked`, `needs-review`, and set-aside.
9. No `<details>` element remains in `runs/[id]/page.tsx`, `RunOutput.tsx`,
   `RunReview.tsx` or `RunLand.tsx`.
10. `npm run typecheck` and `npm test` pass.

**Run (c) must not touch:** `LiveTelemetry.tsx`, `RestartClosed.tsx`,
`src/app/runs/page.tsx` (run (e)), `src/app/page.tsx`, `src/app/settings/`,
`src/components/Workflow*`, `ui/Patch.tsx` (run (a) owns it).

---

## 3.D — Build run (d): the workflow surfaces

**Files:** `src/components/WorkflowEditor.tsx` (1558), `WorkflowCanvas.tsx`
(912), `WorkflowSchedule.tsx` (479), `src/app/workflows/page.tsx` (167),
`src/app/workflows/[id]/page.tsx` (596),
`src/app/workflows/[id]/instances/[instanceId]/page.tsx` (722).

### What it holds

Four surfaces for one object. `/workflows` lists saved graphs (3 columns).
`/workflows/[id]` shows one graph as four cards — `Limits for the whole
workflow`, the schedule, `Blocks` (a read-only table), `Runs of this workflow`
— with a four-button row (`Run`, `Edit`, `Duplicate`, `Delete`).
`/workflows/[id]/edit` mounts `WorkflowEditor`: a canvas pane on the left and a
sticky 26rem inspector on the right holding the selected block or link plus
`Limits for the whole workflow`. The instance page shows one press of Run as
four cards — `Limits for the whole workflow`, `Blocks not yet runs`, `Blocks`,
`Runs a block started`.

**Nineteen kit controls are declared in the editor** (7 `Input`, 7 `Select`, 2
`Textarea`, 2 `Switch`, 1 `LimitField`); fewer render at once, because most of
`BlockPanel` is gated on the selected block's kind.

### What arrived with what

`754f43f` created the editor, the list, `[id]` and the instance page as one
feature. Then, one block kind at a time: `41b4302` the orchestrator block,
`e809652` the merge block, `d37aedf` the loop block, `db525a3` the schedule,
`b399ca3`/`5f3f928` the canvas and the canvas-plus-inspector split. Each kind
appended its own fields to `BlockPanel`, its own status words to the instance
page, and its own explanatory `Hint` to the foot of a card.

### What the reader is doing

Two different jobs on four surfaces: **arranging** a graph (the editor, on a
screen — the canvas says so itself below `md`) and **watching** one run (the
instance page). `/workflows/[id]` is the hinge between them.

### What is fuzzy — counted

1. **Seven stacked `Hint` paragraphs on the instance page** (`:539`, `:545`,
   `:640`, `:645`, `:650`, `:658`, `:712`). Two sit under the meter they are
   about; four more are stacked at the foot of the `Blocks not yet runs` card
   explaining what a deciding block, a repeating block and a merge block are —
   and **two of those four are unconditional** (`:640`, `:645`) while two are
   kind-conditional (`kind === "loop"` at `:650`, `kind === "merge"` at
   `:658`). Each was appended by the commit that added its kind.
2. **One 55-word sentence, duplicated verbatim** in
`WorkflowEditor.tsx:821-825`
   and the instance page `:542` (the "checked before a block starts a work
   cycle" paragraph).
3. **Four phrasings of two edge conditions, in three constant maps in three
   files**: `CONDITIONS` (editor `:164-166`, whose first entry is the `""` one),
`CONDITION_CHIP` (canvas
   `:139-143`), `CONDITION_LABEL` (`[id]/page.tsx:41-42`), plus `LinkPanel`'s
   own inline sentence (`:1501-1503`).
4. **`KIND_LABEL` is two unrelated exported/local maps** — block-kind display
   names (`WorkflowCanvas.tsx:72`) and per-kind status overrides (instance page
   `:70`) — used in the same feature area.
5. **`Limits for the whole workflow` is one heading on three surfaces** with
   three different bodies (editor `:756`, `[id]` `:371`, instance `:485`).
6. **A loop block draws no badge on its canvas card** (`WorkflowCanvas.tsx:794-804`
   gives orchestrator and merge a `Badge` and run and loop an empty `<span/>`),
   so `maxPasses` — the number a press of Run is approved against for that kind
   — is not on the card. Whether that is deliberate is **unverified**.

### Target structure

**D1 — One home for the shared copy (required).**
Move to `src/lib/format.ts` — client-safe, and what `tsconfig.test.json`
compiles, which is the same reason the shared tone unions live there:

- `WORKFLOW_LIMIT_TIMING_NOTE` — the 63-word sentence, verbatim. Both call
  sites import it. **The words do not change.**
- `EDGE_OPTION_LABEL: Record<"" | "on-success" | "on-finish", string>` —
  `"Choose a condition"`, `"Only if it completes"`, `"Once it finishes, either
  way"`.
- `EDGE_CHIP_LABEL` — same keys — `"needs a condition"`, `"if it completes"`,
  `"either way"`.

**All three existing maps are deleted** — `CONDITIONS`, `CONDITION_CHIP` and
`CONDITION_LABEL` — and their call sites read these two.
**`LinkPanel`'s prose sentence keeps its own wording** (`", only if it
completes."` reads inside a sentence; the chip does not) — this is a
consolidation of *maps*, not of every string.

> **The `""` key is not optional and must not be removed.** `workflows-and-schedules.md`:
> a drawn link "carries `edge: ""` all the way onto the wire and is refused by
> name … so the picker offers the unanswered state as a real option rather than
> pre-selecting one", and `dependencies.md` says both conditions are named
> explicitly on the wire and neither is defaulted. A form-hygiene pass that
> drops the empty option is a silent break. See §5.6.

**D2 — Rename the colliding map (required).**
The instance page's local `KIND_LABEL` (`:70`) becomes `STATUS_BY_KIND`. No
behaviour change.

**D3 — The instance page's eight hints become two visible and one fold
(required).**

- The two at `:539-550` — what bounds the workflow, and the cycle-in-flight
  floor — **stay visible**. They are about the meter directly above them.
- The four kind-conditional ones at `:640-662` move, whole and unchanged, into
  a single `Disclosure summary="What these block kinds do"` at the foot of the
  `Blocks not yet runs` card, with `count` = the number rendered.

> **This applies to the instance page only.** `BlockStatement` in the editor
> and every sentence on `/workflows/[id]`'s `Blocks` table stay exactly where
> they are and are never folded — see §5.5. The distinction is that on the
> instance page the press of Run already happened; in the editor it has not.

**D4 — Label the editor's block-inspector groups (required).**
`BlockPanel` already renders `ListGroup`s, several with a `footnote` and no
`label`. Give each a label, in this fixed order, so the panel reads as three
questions rather than thirteen rows:

| Group label | Rows |
|---|---|
| *(unlabelled, first)* | `Name`, `Block` |
| `What it does` | the per-kind rows (`Most runs it may start` / `Most passes` + `Spending limit across passes` / `How to land` + `Let Claude resolve a conflict`), then `Task` (per-kind wording) and `Standing instructions` (per-kind wording) |
| `Where it runs, and under what` | `Guards` (per-kind wording), `Workspace`, `Folder` |
| `What it is started as` | the agent row (per-kind wording) |

> **The agent row keeps its own group and never joins `Where it runs, and under
> what`.** `agents-and-templates.md`: "A row inside the guard group would claim
> it bounds something, and it bounds strictly nothing … So the run page keeps it
> beside the guards and never among them." The existing footnote declaring the
> ambient set stays on that group. See §5.7.

Every existing group `footnote` stays on whichever group now holds its rows.

**D4b — `/workflows` (the list) and the two editor wrappers: no change.**
`src/app/workflows/page.tsx` is three columns, one `Saved` card, one
`New workflow` button and a designed empty state — the smallest well-formed
page in the app. `src/app/workflows/new/page.tsx` and
`src/app/workflows/[id]/edit/page.tsx` are thin wrappers that mount
`WorkflowEditor` with an `<h1>` and a back link. All three are verified and
left alone.

**D5 — `/workflows/[id]`: one primary action (required).**
Four buttons in one row today. Assign: `Run` `primary`, `Edit` `secondary`
(already a `ButtonLink`), `Duplicate` `secondary`, `Delete` `danger`. Card
emphasis: `Limits for the whole workflow` → `quiet`, the schedule card →
`quiet`, `Blocks` → `default`, `Runs of this workflow` → `default`. **No card
on this page becomes `primary`** — the page's subject is the graph and the
graph lives on the canvas one route over.

**D6 — What does not change.**

- **`BlockStatement`, whole, unfolded, at every width.** §5.5.
- **The canvas.** The palette-as-toolbar, the `md:hidden` narrow-viewport
  sentence, the halo-not-border selection, `touch-none` on the three drag
  targets, the Delete key handling and the `22rem` capped scroll region below
  the breakpoint. §5.8 and §5.9.
- **The block cards' per-kind border tone.** The orchestrator's warn edge is a
  permanent safety statement, which is exactly why selection is a ring.
- **The schedule surface.** Three plain choices, no cron, and the next fire
  time stated as an **absolute** instant. §5.6.
- **Save stays enabled behind a failed validate.** `/api/workflows/validate`
  answers 200 for a refusal on purpose. §5.6.
- **`"Blocks"` on the list versus `"Runs"` on `/workflows/[id]`** counting
  `.nodes.length` in both places. These are different arrays: the comment at
  `[id]/page.tsx:551-552` says an orchestrator block's own runs are in the
  instance's list and not in the saved graph. **Not a defect; do not unify.**
- **The loop card's missing badge** is left as it is and is in §6.

### Acceptance criteria for run (d)

1. `WORKFLOW_LIMIT_TIMING_NOTE`, `EDGE_OPTION_LABEL` and `EDGE_CHIP_LABEL` are
   exported from `src/lib/format.ts`;    the three local maps and the duplicated 55-word string literal are gone; `grep -c` for that sentence in `src/`
   returns 1.
2. `EDGE_OPTION_LABEL[""]` still renders as a selectable option and a link with
   `edge: ""` still reaches the wire and is still refused by name.
3. No file declares a symbol named `KIND_LABEL` twice across the feature.
4. The instance page renders at most three `Hint` paragraphs outside a
   `Disclosure`.
5. `BlockStatement`'s output string is byte-identical for every block kind —
   diff it before and after.
6. `/workflows/[id]` renders exactly one `primary` button and no `primary` card.
7. `npm run typecheck` and `npm test` pass, including
   `src/lib/canvasGraph.test.ts` and the workflow tests.

**Run (d) must not touch:** `src/lib/workflows.ts`, `src/lib/canvasGraph.ts`
(beyond nothing at all), `src/app/runs/`, `src/app/settings/`, `src/app/page.tsx`,
`src/app/branches/`, `src/app/chat/`, or `src/components/ui/`.

---

## 3.E — Build run (e): dashboard, runs list, branches, chat, agents, account

### 3.E.1 `/` — the dashboard

**Files:** `src/app/page.tsx` (1156), `LiveTelemetry.tsx`, `UsagePeriods.tsx`,
`RepoSpendCard.tsx`, `Meter.tsx`.

**What it holds.** A header with a provenance strip, then **eight cards** and
**five standalone `Notice`s wedged between the first and second**:

| # | Card | Emphasis | Source |
|---|---|---|---|
| 1 | `5-hour session window` **and** the weekly window, in one card | `primary` | A |
| — | five `Notice`s (`:727`, `:755`, `:772`, `:799`, `:817`) | — | — |
| 2 | `Live from runs — first-party` | `quiet` | **C** |
| 3 | `This install, last N hours` | `quiet` | **B** (+C in the hatched band only) |
| 4 | `Rate and totals` | `quiet` | A |
| 5 | `Usage by period` | `default` | A |
| 6 | `What each repository cost` | `default` | **B** |
| 7 | `Where it went — …` | `default` | A |
| 8 | `Recent 5-hour blocks` | `quiet` | A |

Source **A** = this app's price table over every transcript on the machine
(`buildSnapshot`). **B** = `runs.spent_usd`, money this app recorded spending.
**C** = OTLP telemetry, Claude Code's own per-request cost.

**What arrived with what.** `24a886d` shipped cards 1 and 8. `5abcbaa` added
`Where it went`, `22bd9c7` and `e42e3b3` gave the page a hierarchy and added
`Rate and totals`, `f6a3f92` added `Usage by period`, `cc55c24` added the
telemetry card, `e25727d` (#108) added the install ceiling card, `53c685d`
(#113) added the repository card. **Six of the eight cards were appended by six
separate features and the page has never been regrouped.**

**What is fuzzy — counted.**

1. **Eight cards, no grouping.** Five of them are breakdowns of one reading and
   three are *different readings entirely*, interleaved: A, C, B, A, A, B, A, A.
2. **The three-source separation exists only as prose inside individual
   cards.** `RepoSpendCard.tsx:191-193` and `page.tsx:897-900` each carry a
   sentence saying "not the same reading as the meters above and must not be
   added to them". Nothing in the page's *structure* says it, so the rule is
   re-argued in a footnote every time a card lands.
3. **Emphasis is not doing its job.** `This install, last N hours` — a ceiling
   the operator set, which stops every agent when it trips — is `quiet`, while
   `Recent 5-hour blocks`, a history table, is also `quiet` and `Usage by
   period` is `default`.
4. **A permanently-visible caveat sits in a stack of four exception notices.**
   `Costs and volumes here cover Claude Code only.` (`:817-850`) renders on
   every load, in the same run as `No percentages available.`, unpriced models,
   unreadable paths and the cache bound.

**Target structure.**

**E1 — Three named regions, and they are the never-sum rule made structural
(required).** This is the one place in this document where I take the larger
change, and here is what it buys: today the prohibition on mixing the three
cost readings is defended by a paragraph at the foot of each card, which means
every future card has to re-derive it. Made a region boundary, a new card lands
in the right place by construction, and a total drawn across a region boundary
is visibly wrong rather than merely undocumented.

| Region | Heading | Cards | One-line statement under the heading |
|---|---|---|---|
| — | *(none — card 1 leads the page)* | 1 | — |
| 1 | **`Your subscription`** | 4 `Rate and totals`, 5 `Usage by period`, 7 `Where it went — …`, 8 `Recent 5-hour blocks` | this app's price table over every Claude Code transcript on this machine |
| 2 | **`What this app spent`** | 3 `This install, last N hours`, 6 `What each repository cost` | money runs this app started reported spending |
| 3 | **`Live from runs`** | 2 `Live from runs — first-party` | Claude Code's own per-request cost, for agents this app spawned |

Region headings are `<h2>` at `CardTitle` weight. **No figure, meter, badge,
total or comparison may be drawn at a region level, and no region may contain a
card from another region's source.** Every card keeps its own footnote verbatim
— they are now belt and braces rather than the only defence.

Card 1 stays above all three regions and stays the page's only `primary`: it is
the two windows, and it is what the page exists to show.

**E2 — Emphasis, per card (required).** Within a region, the region's lead is
`default` and the rest are `quiet`:

| Card | Emphasis |
|---|---|
| 1 `5-hour session window` + weekly | `primary` (unchanged) |
| 3 `This install, last N hours` | `default` (was `quiet`) |
| 6 `What each repository cost` | `quiet` (was `default`) |
| 4 `Rate and totals` | `default` (was `quiet`) |
| 5 `Usage by period` | `quiet` (was `default`) |
| 7 `Where it went — …` | `quiet` (was `default`) |
| 8 `Recent 5-hour blocks` | `quiet` (unchanged) |
| 2 `Live from runs — first-party` | `default` (was `quiet`) |

Still exactly one `primary`.

**E3 — Separate the standing caveat from the exceptions (required).**
`Costs and volumes here cover Claude Code only.` (`:817-850`, including its
`Reserve headroom` link) moves **into card 1**, as the last line of its
footnote block. It is a caveat about card 1's figures and it renders always.
The four conditional `Notice`s (`:727`, `:755`, `:772`, `:799`) stay where they
are, in that order, unchanged.

**E4 — What does not change.**

- **`Meter`.** Not one line. §5.2.
- **The telemetry card stays gated on `settings.telemetryForRuns`** — do not
  render it unconditionally, and do not read the guard figure to decide.
- **`RepoSpendCard` renders no meter and no percentage of any window.** §5.1.
- **The poll cadence**: 120s, dropping to 60s only while `workingRunCount > 0`.
- **The fleet-hold sentence stays in words on the dashboard.** §5.3.
- **The provenance strip** and every figure in it.
- `UsagePeriods`' unread `granularity` / `onGranularityChange` props, kept so
  its test compiles.

### 3.E.2 `/runs` — the runs list

**What arrived with what.** `ca50657` split the form off and left this page the
overview; `ac6be76` drew the runs as one list view instead of cards and a
table; `5d5a262` added the `waiting` status; `bcba644` (#111) added
`FleetControls`; `e9109e6` (#60) added `RestartClosed`; `d193868` added
set-aside and the archive filter. Six features — and unlike every other page
here, **each one landed in its own tier** rather than at the foot of the
nearest card.

**Verdict: this is the least fuzzy data page in the app, and the provenance is
why. Change two things and nothing else.**

It already has the structure the rest of this document is trying to produce:
three tiers by recency (`In flight` with a count badge, `Finished in the last
24 hours`, and `Older runs (n)` behind a disclosure with the six-option filter
*inside* it, applying only to the older set). The `w-full max-w-0` truncating
cell and the deliberate absence of `overflow-x-auto` are landed decisions.

- **E5 — Migrate `<details>` at `:745-755` to `Disclosure`** with
  `summary="Older runs"` and `count={older.length}`. The rendered text stays
  `Older runs (n)`.
- **E5b — `RestartClosed` (`src/components/RestartClosed.tsx`, 133) does not
  change.** It is a `Notice tone="warn"` with one `Pick up {n}` button and a
  confirming `Sheet`, rendered above `FleetControls` at `runs/page.tsx:652`.
  Its count comes from the same filtered query the press reads, which is what
  stops the badge and the payload disagreeing — see §5.5. Run (e) owns the
  file and touches nothing in it.
- **E6 — `FleetControls` keeps `emphasis="quiet"`** and its `Stop everything`
  `danger` button. A quiet card holding the page's most destructive control is
  correct here: it acts on no run in particular, so §2.3 anti-rule 1 does not
  apply.

**Do not touch:** the three-section split, the filter's placement inside the
disclosure, `fmtCycleInFlight`'s column, the unlabelled `Td`s (all three are
headline cells — status, task, controls — which is what `conventions.md`
permits), or the client-side `REOPENABLE` set. §5.4.

### 3.E.3 `/branches`

**What it holds.** Three cards, **none with an `emphasis` prop**, plus a
`fixed` selection bar: `Merge queue` (self-updating, polls unconditionally),
`Checkout slots`, and the branch inventory (an 8-column `Table stack` with a
repository filter and a pager). Twenty distinct controls.

**What arrived with what.** `36a0dbf` the table, `9c4b98a` the merge queue and
the selection bar, `96f3ba7` purge/commit row actions, `1747e26`
`Checkout slots`, `1dd2932` the filter and pager, `afcb1cd` the history
disclosure. Six features, one page, no regrouping.

**What is fuzzy — counted.**

1. **No card declares an emphasis**, so the only self-updating card on the page
   — the merge queue, which is landing branches right now — reads as a peer of
   a static pressure gauge.
2. **Weight is inverted on the destructive controls.** Arming a purge is
   `variant="ghost"` (`:1485-1491`) — the lightest weight in the kit, for the
   only irreversible destruction of committed work on the page — while
   `Refresh` (`:995`) is `secondary`.
3. **`Land N branches` has no confirmation** (`:1218-1226`), and
   `Have Claude resolve conflicts` defaults to **on** (`:709`), so one click
   starts paid unattended model work. A single dead branch takes two presses to
   delete.
4. **The land-strategy `select` is hand-written and label-less**
   (`:1201-1217`, `aria-label="How to land them"`), beside a kit `Select` with
   a visible `Repository` label 200 lines up. Its own comment calls it "the
   last hand-written select in the app".

**Target structure.**

- **E7 — Emphasis (required).** `Merge queue` → `primary` when it has any
  active item and `default` otherwise — the same conditional the chat's
  `PROPOSALS_EMPHASIS` (`chat/page.tsx:170-173`) already uses, so this is an
  existing decision applied a second time rather than a new one.
  `Checkout slots` → `quiet`. The branch inventory → `default`.
- **E8 — Convert the land-strategy `select` to the kit `Select` inside a
  `Field label="How to land them"` (required).** Both options keep their exact
  strings. This is the second of the two hand-written text-taking controls
  `conventions.md` names, and converting it means `Field`'s `CONTROL_BASE`
  supplies the `max-md:text-[16px]` floor instead of the call site repeating
  it. **`conventions.md` must be updated in the same commit** — it says there
  are "exactly two"; after this there is one, the chat composer. §7.
- **E9 — Raise the auto-resolve consequence (required).** The sentence at
  `:1190-1192` keeps its text and its `text-warn` tone and goes from 12px to
  the row's own `text-sm` **when the toggle is on**. It is the only statement
  on the page that a press of Land will spend money.
- **E10 — Confirm a paid landing (required, and it is the one control this
  document adds).** When `Have Claude resolve conflicts` is on, `Land N
  branches` opens a `Sheet` — one default action, Cancel, `danger` variant so
  it opens with Cancel focused — naming the number of branches and saying that
  a conflicting one will be reconciled by a billed model run on its own branch.
  When the toggle is off, the button behaves exactly as today with no sheet.
  *Rejected alternative: defaulting `autoResolve` to off. That changes what the
  app does rather than how it reads, and it is a decision for a person — §6.*

**What does not change.**

- **The merge queue stays on the page and out of any disclosure**, batches stay
  whole, `Cancel {n} waiting` stays per batch, and the poll stays
  unconditional. §5.3 — this is the strongest "do not tidy this" in the
  document.
- **The history disclosure keeps fetching on open** (the controlled carve-out
  in §1.3) and is migrated to `Disclosure`, not to always-rendered markup.
- **`Checkout slots` still appears at the first retired checkout**, not at a
  threshold. §5.3.
- **The repository filter is still computed from the unfiltered set.** §5.3.
- **Purge keeps its two-press arming and names the branch.** Delete and Purge
  are still never offered at once. §5.3.
- **The four unlabelled `Td`s** (Land, State, Branch, Actions) are compliant —
  each is a headline or a control cell, never a figure.
- The `fixed` bar's `left-[var(--sidebar-w)]` / `max-md:left-0`, its
  `env(safe-area-inset-bottom)`, its `--keyboard-inset` and its over-reserved
  spacer. §5.9.

### 3.E.4 `/chat`

**What it holds.** A header row, a standing `Notice tone="info" quiet`
containing a `<details>`, then a two-column grid: the conversation `Card`
(`emphasis="primary"`) with a pinned composer, and a 360px side card whose
emphasis is already conditional on pending proposals.

**What arrived with what.** `9061ac0` created the page whole. Then, one feature
per paragraph of the proposal card: `433182a` added the `prompt rewritten`
marker, `4643fa6` the dependency line and workflow proposals, `515bfe7` the
mention popover, `17d8d6a` the `as {agent}` phrasing. `b728243` and `a5e3f09`
reworked the thread into a conversation and then into an assistant pane;
`8e6a437` added `Stop`; `eb40307` added the side tab bar and the standing
disclosure. **The proposal card grew a fact at a time and its facts never got a
consistent treatment** — which is the finding below.

**What is fuzzy — counted.**

1. **The most consequential fact on a proposal card is its least visible one.**
   `prompt rewritten` (`:1289`) — the model having rewritten the operator's own
   text — renders as a bare `<span>` with **no icon and no tone**, in the same
   `text-2xs text-ink-muted` row as the folder and the guard set, both of which
   carry an `<Icon>`.
2. **`as {agentName}` (`:1276-1288`) likewise carries no icon** while its two
   row-mates do, so the row reads: icon, icon, bare text, bare text.
3. **Two display strings are compared as literals.** `"template deleted"` is
   produced at `:1268` and compared at `:1386`; `"agent deleted"` produced at
   `:1285`, compared at `:1396`. Rewording either copy silently drops the
   danger colour on a workflow block.

**Target structure.**

- **E11 — Give `prompt rewritten` a tone and a glyph (required).** It is Tier 1
  by §2.2 clause (c): a decision on this surface is approved against it. Render
  it `text-warn` with an `<Icon>`. **The text does not change** and it stays in
  the same row.
- **E12 — Give `as {agentName}` its own `<Icon name="agents" />` (required),
  and keep it outside the guard mark.** The comment at `:1271-1275` and
  `agents-and-templates.md` both say why: a phrase under the shield would claim
  the agent bounds something, and it bounds nothing. Its own glyph, not the
  guard's.
- **E13 — Stop comparing rendered copy (required).** Replace the two
  string-literal comparisons at `:1386` and `:1396` with a boolean on the DTO
  (`guardsMissing`, `agentMissing`) computed where the label is produced. This
  is a correctness fix that a copy edit in this pass would otherwise trip.
- **E14 — Migrate the `<details>` at `:644-664` to `Disclosure`.** Contents
  unchanged.

**What does not change — and one question I am deliberately not answering.**

Everything that makes a proposal card approvable stays: the guard set spelled
out including the untemplated one, the dependency order named, what the click
starts counted in words, and the explicit list of the ids the page displayed on
the wire. §5.5.

The sentence `The chat itself runs with no tool restrictions, so it can read,
run commands and reach GitHub…` stays **inside** the fold. The comment at
`:629-637` argues that trade explicitly — what stays visible is the sentence
that has to be read before anything is pressed, and the rest is read once. I
read that argument and I am not overriding it from outside. Whether it should
be promoted is in §6.

### 3.E.5 `/agents`

**What it holds.** A header with a lede and `New agent`; a conditional editor
`Card emphasis="primary"` of four stacked `Field`s; a `Saved` card whose
emphasis is already dynamic (`editing ? "default" : "primary"`); an
`On disk` card (`quiet`, zero controls).

**What arrived with what.** `d4e4cf5` *Give the agent registry a page, so a
specialist can be created at all* created the whole page; `afcb1cd` and
`be79fe8` touched it visually. **One feature, one page** — and it shows.

**What is fuzzy.** Exactly one thing, and it is small: **three `CardTitle`s
render outside their `Card`** (`:206`, `:312`, `:418`), which is the only place
in the app that does this, so the three section names read as labels floating
above boxes rather than as the boxes' own titles.

- **E15 — Move the three `CardTitle`s inside their `Card`s (required).** No
  other change.

**What does not change.** The four editor fields and nothing else — no tool
list, no permission mode, no budget, no folder, no isolation choice. That
absence is asserted by a test that counts the keys. §5.7. The `On disk` card
stays, with its full explanatory `Hint`, and stays uncontrollable.

### 3.E.6 `/account`

**What it holds.** An `<h1>`, a two-paragraph `Lede`, then one of five
mutually exclusive states. The loaded state is `Billed cost — last 30 days`
(`primary`), a `Daily cost` card and `Configured rate limits`. **Zero controls
when it is working.**

**What arrived with what.** `24a886d` shipped it; `128f024` moved it onto the
kit; `13d304c` *Say on the API account page why a Pro/Max plan is not on it*
added the second lede paragraph. Three commits, and the only one that added
content is the one this section is about.

**What is fuzzy.** One thing: the `Lede`'s second paragraph (`:53-59`) is three
sentences of `text-xs` explaining why a Pro or Max subscription is invisible
here — permanently visible, on a page a reader visits to look at four figures.

- **E16 — Fold the second lede paragraph (required)** into a
  `Disclosure summary="Why a Pro or Max subscription is not shown here"`. The
  first paragraph stays visible. This is textbook Tier 2: read once, and no
  decision on this page is approved against it.

**What does not change.** The `Daily cost` table is deliberately not a `stack`
table and deliberately has no `<thead>`. Its comment at `:210-215` says why and
`conventions.md` names it as the shape to check for. Leave it. The `Not
configured` branch keeps its full explanation — that is the state where the
sentence is load-bearing.

### Acceptance criteria for run (e)

1. `/` renders three region headings; every card is under exactly one region
   except card 1; **no figure of any kind is rendered at region level**; **no
   region is a `<section>` element** — see §5.11.
2. `/` renders exactly one `primary` card, and card 3 `This install, last N
   hours` is `default`.
3. `/` renders `Costs and volumes here cover Claude Code only.` inside card 1
   and nowhere else; exactly four conditional `Notice`s remain between card 1
   and region 1.
4. `Meter.tsx` is unmodified; `src/components/Meter.test.tsx` passes.
5. `/branches` renders the land-strategy control as a kit `Select` inside a
   `Field` with a visible label, and `conventions.md`'s "exactly two"
   hand-written text controls becomes one, named.
6. `/branches` opens a `Sheet` on `Land N` only when auto-resolve is on.
7. `/chat` renders `prompt rewritten` with a tone and a glyph; no rendered copy
   string is used in a `===` comparison anywhere in `chat/page.tsx`.
8. `/agents` has no `CardTitle` outside a `Card`.
9. No raw `<details>` element remains anywhere in `src/`.
10. `npm run typecheck` and `npm test` pass.

**Run (e) must not touch:** `src/app/settings/`, `src/app/runs/new/`,
`src/app/runs/[id]/`, `src/components/Run*.tsx`, `src/components/Workflow*`,
`src/components/ui/` (run (a) owns the kit), or `src/components/Meter.tsx`.

---

## 3.F Every dialog and every drawer

The app's whole top-layer surface is **eleven `Sheet`s and one drawer**. Listed
because the brief asks for every dialog, and because a modal is where a
restructure most easily loses a rule.

| # | Surface | File:line | Title / purpose | Owned by | Verdict |
|---|---|---|---|---|---|
| 1 | Claude sign-in | `settings/page.tsx:940` | `Sign in to Claude` | (b) | No change. Stays inside the row's `<dd>` — `939939a` put it there because a `<dl>` may hold only `dt`/`dd`/`div`. |
| 2 | Claude sign-out | `settings/page.tsx:978` | `Sign out of Claude?` | (b) | No change. `confirmVariant="danger"`, so it opens with Cancel focused. |
| 3 | Purge branch | `RunLand.tsx:609` | `Purge {branch}?` | (c) | No change. It names the branch and counts the commits and uncommitted paths. Never replaced by a generic confirm. §5.3. |
| 4 | Delete workflow | `workflows/[id]/page.tsx:349` | `Delete "{name}"?` | (d) | No change. |
| 5 | Remove schedule | `WorkflowSchedule.tsx:464` | `Remove this schedule?` | (d) | No change. |
| 6 | Stop all blocks | `instances/[instanceId]/page.tsx:447` | `Stop {n} unfinished block(s)?` | (d) | No change. Its body states that an interrupted cycle's spend is estimated rather than measured — that is the display-versus-guard split in words. §5.2. |
| 7 | Delete agent | `agents/page.tsx:489` | `Delete "{name}"?` | (e) | No change. Its second paragraph names every surface that refuses rather than quietly starting without a specialist. |
| 8 | Stop everything | `FleetControls.tsx:158` | `Stop every run in flight` | (e) | No change. |
| 9 | Pick up N stopped | `FleetControls.tsx:180` | `Pick up {n} run(s)` | (e) | No change. It carries two form fields inside the sheet; it takes the explicit id list the page displayed. §5.5. |
| 10 | Pick up restarted | `RestartClosed.tsx:116` | `Pick up {n} run(s)?` | (e) | No change. |
| 11 | Quick open | `QuickOpen.tsx:188` | `Quick open` | (a), read-only | No change. **Navigates and does nothing else.** §5.5. |
| 12 | The sidebar drawer | `Sidebar.tsx:242` | the nav drawer below `md` | (a), read-only | No change. It is the app's **only** drawer and §1.2 rule 5 keeps it that way. |

Three rules apply to all twelve and none of the five runs may bend one:

- **One default action and Cancel.** `Sheet` has no informational mode and must
  not grow one. A `danger` sheet opens with Cancel focused, because one Return
  on a destructive confirmation is not a confirmation.
- **Always rendered, never conditionally mounted; nothing sets `display`;
  `cancel` is prevented so Esc routes through `onDismiss`.** All three are
  correctness decisions about using the element rather than imitating it.
- **A `Sheet` is in the top layer, so it owes the window's edges itself** —
  all four `env(safe-area-inset-*)`, and its panel cap subtracts
  `--keyboard-inset`. §5.9.

**Change E10 adds the thirteenth** — a confirmation on `Land N branches` when
auto-resolve is on. It is the only dialog this document creates, and it obeys
all three rules above.

---

## 4. The five build runs

Each has two work cycles and cannot ask a question. Run them in this order —
(a) first because (b)–(e) all consume `Disclosure` and `ListView`.

### (a) The shell and the shared primitives

**Owns:** `src/components/ui/Disclosure.tsx` (new),
`src/components/ui/ListView.tsx` (new), `src/components/ui/Patch.tsx`,
`src/components/ui/Card.tsx`, `src/components/ui/Field.tsx`,
`src/components/shell/*` (read-only verification), plus **import-only** edits at
the five `LIST_VIEW` call sites and wherever `Subsection` is imported.

**Spec:** §3.A. **Acceptance:** §3.A.5.

**Must not touch, because a later run owns it:** every page's structure. If a
`LIST_VIEW` migration seems to need a markup change, it is wrong — the
migration is class-for-class.

### (b) `/settings`

**Owns:** `src/app/settings/page.tsx`, `src/app/api/settings/route.ts`,
`src/lib/settings.ts` (export `sameValue` only).

**Spec:** §3.B. **Acceptance:** §3.B's list.

**Must not touch:** anything else. In particular not `src/lib/plugins.ts` or
`src/lib/fleet.ts` — the plugin list and the fleet hold are deliberately not
keys of `Settings`, because this page sends the whole blob on Save. §5.10.

### (c) `/runs/new` and `/runs/[id]`

**Owns:** `src/app/runs/new/page.tsx`, `src/app/runs/[id]/page.tsx`,
`RunLand.tsx`, `RunDiff.tsx`, `RunReview.tsx`, `RunOutput.tsx`,
`RunAgentCost.tsx`, and the three-word table added to
`docs/agent/conventions.md`.

**Spec:** §3.C. **Acceptance:** §3.C's list.

**Must not touch:** `src/app/runs/page.tsx` (run (e)), `LiveTelemetry.tsx`,
`RestartClosed.tsx` (neither is on either page), `ui/Patch.tsx` (run (a)).

### (d) The workflow surfaces

**Owns:** `WorkflowEditor.tsx`, `WorkflowCanvas.tsx`, `WorkflowSchedule.tsx`,
`src/app/workflows/**`, and the three new exports in `src/lib/format.ts`.

**Spec:** §3.D. **Acceptance:** §3.D's list.

**Must not touch:** `src/lib/workflows.ts`, `src/lib/canvasGraph.ts`,
`src/lib/schedules.ts`. Every change here is presentational; if one seems to
need a change in `lib/`, stop and report.

### (e) Dashboard, runs list, branches, chat, agents, account

**Owns:** `src/app/page.tsx`, `src/components/LiveTelemetry.tsx`,
`UsagePeriods.tsx`, `RepoSpendCard.tsx`, `FleetControls.tsx`,
`src/app/runs/page.tsx`, `src/app/branches/page.tsx`, `src/app/chat/page.tsx`,
`src/app/api/chat/dto.ts` (the two booleans in E13),
`src/app/agents/page.tsx`, `src/app/account/page.tsx`, and the
`conventions.md` line E8 changes.

**Spec:** §3.E. **Acceptance:** §3.E's list.

**Must not touch:** `src/components/Meter.tsx`, `src/components/ui/*`,
`src/components/Run*.tsx`, `src/components/Workflow*`, `src/app/settings/`,
`src/app/runs/new/`, `src/app/runs/[id]/`.

### What every run does, without being told again

1. Read §5 before opening a file.
2. `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` is not required, but
   `npm run typecheck` and `npm test` are, and they are the definition of done
   — there is no linter run in this repository.
3. Verify any new Tailwind variant spelling **in the emitted CSS**. Tailwind
   emits nothing for a spelling it does not know, silently.
4. Check every change you make against §5.9: it must survive at 390px and it
   must leave 1440px pixel-identical. Concretely — every new class is either
   unprefixed and additive, or carries `max-md:`/`md:`; every new interactive
   element clears 44px below the breakpoint (a `<summary>` via `Disclosure`,
   everything else via `max-md:min-h-11`); and no new `Td` is added to a
   `stack` table without a `label` unless it is the headline cell.
5. Commit in logical steps with messages in this repository's style: what
   changes and *why*, imperative, under ~60 characters.
6. If this document is silent or contradicts itself on something you need,
   **stop and report**. Do not invent an answer and do not widen your file
   ownership to work around it.

---

## 5. What must not change

Every item here is an invariant a plausible-looking layout change would break
**silently** — nothing throws, nothing fails to typecheck, and the page looks
right. Each names its file so a build run can check itself before it commits.
The doc column is where the reasoning lives; read it if you are about to argue
with the rule.

### 5.1 The three cost sources are never summed or mixed

`CLAUDE.md`; `docs/agent/architecture.md`; `docs/agent/metering.md`.

Three readings of overlapping money, and **any sum double-counts**:

| Reading | What it is | Where it renders today |
|---|---|---|
| **A** | this app's price table over every Claude Code transcript on the machine (`buildSnapshot`) | dashboard cards 1, 4, 5, 7, 8; `RunAgentCost`'s rows |
| **B** | `runs.spent_usd` — what a work cycle's own `result` event reported | dashboard `This install…`, `What each repository cost`; the run page's `Spent` stat |
| **C** | OTLP telemetry — Claude Code's own per-request cost | `LiveTelemetry` on the dashboard; `Telemetry — first-party` on the run page |

Rules a build run must not break:

- **No card, region, header or badge may add two of them.** Adjacency is not
  permission: `budgets-and-guards.md` argues the install ceiling's separate card
  explicitly *because adjacency implies summability*. This is why §3.C.6 and
  §3.E.1 forbid a figure at region level.
- **Telemetry reaches a budget decision through one door only** —
  `telemetrySpendSince` → a `*Guard*` figure — and the display half stays
  `result`-derived. Never label `spentGuardUSD` "spent" beside a limit.
  Files: `src/lib/otlp.ts`, `src/lib/installBudget.ts`, `src/lib/orchestrator.ts`.
- **`RepoSpendCard` renders no `Meter` and no percentage of any window.** A
  meter implies a threshold and `repoSpend` is a report that reaches no guard.
  File: `src/components/RepoSpendCard.tsx`, `src/lib/repoSpend.ts`.
- **Chat spend is displayed on the chat page only.** `src/lib/chat.ts`,
  `src/app/chat/page.tsx`.
- **The telemetry card stays gated on `settings.telemetryForRuns`**, and the
  gate reads the *setting*, never the guard figure.
  `src/app/api/usage/route.ts`, `src/components/LiveTelemetry.tsx`.

### 5.2 Display versus guard, and an unknown reading

`docs/agent/metering.md`; `conventions.md`.

- **`costUSD`/`fraction` are what the user is shown; `costGuardUSD`/`guardFraction`
  are what the guard acts on. Never collapse the two.** On a meter the display
  figure is the solid fill and the guard figure is the **hatched band past it** —
  never one summed fill. Files: `src/components/Meter.tsx` (`upperFraction`),
  `src/app/runs/[id]/page.tsx` (`guardBars`),
  `src/app/workflows/[id]/instances/[instanceId]/page.tsx`,
  `src/components/UsagePeriods.tsx`.
- **An unknown reading is a hatched indeterminate meter, never a 0% bar.**
  `Meter.tsx:135-136` clamps an unknown to full width and `:204-214` picks
  `"hatched"` before `severityFor` is consulted; `data-sev` is `undefined` and
  `data-unknown` is `true`. **Losing that tiebreak paints a solid green 100%
  bar.** `src/components/Meter.test.tsx` pins it. Do not swap `Meter` for a
  progress element, do not add an "empty state" that renders 0% when the limit
  is null, and do not change `Meter.tsx` in any of these five runs.
- **The same rule at the run and instance level**: a run whose agents spent
  nothing and one nobody could measure must not look alike; an instance with no
  `maxInstanceCostUSD` gets the indeterminate bar.
- **`runs.spent_usd` is a floor** and `spent_usd_est` rides in its own column.
  Never sum them into one figure.

### 5.3 Facts that must stay visible

| Fact | File | Rule |
|---|---|---|
| `BlockStatement`'s sentence | `WorkflowEditor.tsx:883`, called `:1072` | Whole, prose, at every width, **never behind a disclosure**, never line-clamped, never turned back into a row of pickers. It is what a press of Run is approved against. `workflows-and-schedules.md`, `conventions.md`. |
| The chat proposal card's facts | `src/app/chat/page.tsx`, `src/app/api/chat/dto.ts` | The guard set spelled out *including the untemplated one*, a rewritten prompt marked, the dependency order named, what the click starts counted in words, and the explicit list of the ids the page displayed on the wire. `chat.md`, `conventions.md`. |
| The proposed-workflow card | `src/lib/workflows.ts` (`summarizeProposedGraph`) | Every guard-shaped fact a canvas would show, per block, plus the sentence saying it cannot be scheduled. Never collapsed to a block count. |
| The merge queue | `src/app/branches/page.tsx`, `src/lib/mergeQueue.ts` | **No batch the worker still owes an answer for may move behind the disclosure.** A batch is kept whole, not trimmed to its unfinished rows. Cancel is per batch. "Nth in line" is counted across batches within a repository. The poll is unconditional. The closed history case stays cheap — it fetches on open and must not become always-rendered-and-hidden. `isolation-and-landing.md`. |
| `Checkout slots` | `src/lib/land.ts` (`checkoutStores`), `src/app/branches/page.tsx` | Appears at the **first** retired checkout, not at a threshold. Do not add "only show when nearly full". |
| The branches repository filter | `src/lib/land.ts` (`selectBranchCandidates`) | `repos` is counted over the **unfiltered** set — "a filter that hides the repositories you would use to change it is a filter you cannot get out of". |
| `targetInferred` | `src/lib/land.ts:191`, `RunLand.tsx:341` | The deduction caveat stays on the land card. Do not drop it for width. |
| A shortened diff | `src/lib/diff.ts`, `RunDiff.tsx`, `ui/Patch.tsx` | The **file list is always complete**; omitted bodies are counted as "N files listed without contents". Do not paginate or virtualise the list, do not drop the count row. |
| The handoff card's `git merge` | `src/lib/land.ts` (`emitHandoff`), `RunLand.tsx` | **Withheld entirely** while the operator's checkout is dirty — never shown with a warning. Change **C7** folds the card; it must not change what the card withholds. |
| "no live mode" on workflows | `WorkflowEditor.tsx`, the instance page | Said in words on both. The missing-ceiling warning stays **beside the field**. |
| The schedule's next fire time | `WorkflowSchedule.tsx`, `src/lib/schedules.ts` | An **absolute** instant, not a relative one. |
| A held fleet | `FleetControls.tsx`, `src/app/page.tsx` | Stated **in words on the dashboard** — a held fleet and a quiet one are otherwise identical. Not an icon, not a toggle position. |
| `permission_denials` | `src/lib/chat.ts`, `src/app/chat/page.tsx` | Still shown in the thread *because* it should be empty. Grouped by tool **and command** — every entry's `tool_name` is the bare `Bash`. |
| The purge echo | `src/lib/land.ts`, `RunLand.tsx`, `src/app/branches/page.tsx` | Purge names the branch back. Delete and Purge are never offered at once. Do not replace with a generic confirm. |
| `slotExhaustionRefusal` | `src/lib/orchestrator.ts` | Names four numbers. Do not fold the unexamined ones in. |
| The five agent pickers | run form, Settings, canvas, chat mention popover, `/agents` | Each declares the ambient set beside itself, from the one `describeAmbientAgents` sentence. Do not drop it from one during a picker unification. |

### 5.4 Order and mounting

- **The log leads and nothing switches tabs on its own.**
  `src/app/runs/[id]/page.tsx:370`, `:795-808`. A run finishing while you read
  one pane must not move you to another. No auto-switch-to-Changes.
- **A tab is offered only when there is something behind it**, which is why
  `cycleOutputs` runs on the *page* and not inside `RunOutput` — the bar has to
  know whether the agent said anything. Do not move it inside for encapsulation.
- **Only the active tab is mounted.** Switching to CSS-hidden tabs to keep
  scroll position leaves four polling cards alive behind the one being looked
  at, per open run page, forever.
- **`emit()` persists then publishes.** The log's reconnect is lossless because
  of that order. A log-pane change that assumes live-first delivery drops events
    on a late page load. `emit()` is `src/lib/orchestrator.ts:482` and the bus
  is the `globalThis.__ufBus` singleton at `:332` — **there is no
  `src/lib/bus.ts`**. Also `src/app/api/runs/[id]/stream/route.ts`.
- **The guard check order** — terminus, cycles, duration, run spend, weekly,
  then session — is in `src/lib/budget.ts` and is not a UI concern. It becomes
  one the moment somebody reorders the form's limit fields and then "aligns the
  evaluator with the form". Do not.
- **Node declaration order is the workflow's tie-break**, so two presses of Run
  on one graph produce the same queue. `src/lib/canvasGraph.ts`,
  `WorkflowCanvas.tsx`. A canvas that reorders `nodes[]` on drag or auto-layout
  breaks it silently.
- **`panes.ts` is read by four things.** A pane added to one and missed in the
  others is a row you can reach and cannot get back from. `activePane` matches
  a path **segment**, not a prefix.

### 5.5 Approval gates and control placement

- **Quick open navigates and does nothing else.** Not a feature gap — a
  constraint on what the component may be. Do not add "Start a run…" or
  "Approve all". `src/components/shell/QuickOpen.tsx`.
- **The toolbar action is only ever a destination.** Start, Run, Approve and
  Land all need page state; a toolbar button wired to one is the shell reaching
  into a body it does not own. Do not "promote the primary action to the
  toolbar". `src/components/shell/panes.ts:72-88`, `Toolbar.tsx`.
- **Chat approval takes the explicit list of ids the page displayed**, in one
  synchronous pass, and the page clears its selection on `res.ok`. An
  "Approve all" that sends a filter, or a virtualised list where *displayed* no
  longer means *rendered*, breaks a gate.
  `src/app/api/chat/[id]/proposals/route.ts:63`.
- **The fleet bulk pick-up likewise takes the ids the page displayed**, and is
  deliberately narrower than `reopenRun`. `src/lib/fleet.ts`,
  `FleetControls.tsx`.
- **`restartClosedRuns` filters the query**, so the notice's count and the press
  that reads that list are the same answer and cannot disagree. Do not derive
  the badge from a separate count. `src/components/RestartClosed.tsx`.
- **Setting a live run aside marks it *before* the stop is signalled**, and the
  route composes the two. Do not implement a combined button as two client-side
  fetches in the other order. `src/app/api/runs/[id]/set-aside/route.ts`.
- **The run page declines to offer the button** for a member of a halted
  workflow rather than letting the operator find out by pressing it.
  `RunDTO.haltedWorkflow`, `src/app/runs/[id]/page.tsx`.
- **The carried-template banners stay above the form**, with their one-click way
  back, clearing when the control is touched. Do not move them beside the
  control they are about or into a fold. `src/app/runs/new/page.tsx:1690`,
  `:1819`.
- **Save stays enabled behind a failed advisory validate**, and
  `/api/workflows/validate` answers **200 for a refusal** on purpose. A form
  refactor that disables Save while there are errors strands the operator with
  no route to the authority. `WorkflowEditor.tsx`.
- **Nothing in the browser decides what a workflow or an agent may be.** Do not
  add client-side validation for a snappier form — it is a second copy of the
  rules that will be confidently wrong the day one changes.
  `src/lib/agents.ts`, `src/lib/workflows.ts`.
- **The edge picker offers the unanswered state as a real option and never
  pre-selects.** `edge: ""` reaches the wire and is refused by name.
  `src/lib/canvasGraph.ts`, `WorkflowCanvas.tsx`, `src/lib/workflows.ts`.
- **The chat mention popover takes Tab, the arrows and Esc, and never Enter or
  ⌘↩**, because this composer sends on Enter. Do not replace it with a shared
  combobox that binds Enter. `src/app/chat/page.tsx`.

### 5.6 Wording a meaning depends on

| String / rule | File | Why |
|---|---|---|
| **"work cycle" in the UI, `iteration` in the code** | copy in `runs/new`, `runs/[id]`, `runs`, `settings`, `page.tsx`, the instance page; internals in `budget.ts`, `orchestrator.ts`, `apiTypes.ts`, `db.ts` | Both directions are forbidden. Do not "align labels with the API field names". **Verified today: zero user-visible occurrences of "iteration" in `src/app` or `src/components`. Keep it at zero.** |
| **the "tighter, not exact" caveat** | `runs/new/page.tsx:1357` (the copy), `:1349` (the comment stating the rule) | `budgets-and-guards.md` requires it in **every** piece of live-enforcement copy. Measured: the phrase itself is only in that comment; the user-visible form is `:1357`'s "tighter than waiting for the cycle to end, but still not an exact cut-off", and **Settings' own live-enforcement row (`:2443`) carries no such caveat at all** — an existing gap this document neither closes nor widens. Do not condense the three enforcement-mode descriptions into one shared hint, and do not move the caveat into a fold. | | **`fmtCycleInFlight` decides the in-flight wording, wording included** | `src/lib/format.ts:59-69`; used at `runs/page.tsx:408` | One column, on the in-flight list, nowhere else. Never merged with the completed count, never formatted inline. | | **`failed` for a deadline, `stopped` for a decision** | `src/lib/orchestrator.ts`, `format.ts` (`STATUS_TONE`) | A hung agent filed as "stopped" is the sentence that stops anyone looking for the cause. Do not bucket the two into one visual "ended" group. | | **`NEEDS_REVIEW` the sentinel vs `needs-review` the status** | `src/lib/orchestrator.ts` | Spelled differently on purpose, so a task quoting the status cannot fire the matcher. Never render the status as `NEEDS_REVIEW`. | | **`stop_reason` is user-visible prose** | `src/lib/apiTypes.ts`, both runs surfaces | Never parsed or regexed to derive a badge, icon or grouping. | | **Merge-block words** | the instance page, `WorkflowEditor.tsx` | The page says "merging" and "landed"; the column says `thinking`/`emitted`. Do not surface the raw status on a merge block. | | **`started` is not a word for a press of Run that is over** | `src/lib/workflows.ts` (`instanceIsOpen`) | Act on `instanceIsOpen`, never on `status === "started"`. Four of six readings are derived. | | **The three generated prompt strings** | `src/lib/orchestrator.ts` | `COMPLETION_NOTICE`, `SHARED_CHECKOUT_NOTICE`, `RESTART_KILLED_NOTICE`, and the `needs-review` notice, are generated rather than stored **because** one press of Save materialises every default into the stored blob. Never move one into `Settings`. | | **`ceiling` / `guard` / `limit`** | §3.C.1, and §7 adds it to `conventions.md` | New with this document, and the only rewording it authorises is one string at `runs/new/page.tsx:1938-1939`. |

### 5.7 `needs-review`, and the two `REOPENABLE` sets

`docs/agent/dependencies.md`; `docs/agent/run-lifecycle.md`;
`docs/agent/workflows-and-schedules.md`.

- **`needs-review` is terminal and is **not** a success.** One
  `TERMINAL_STATUSES` entry carries that for `releasableRuns`, `retention.ts`'s
  three sweeps and the loop block's exit test. `on-success` stays blocked;
  `on-finish` starts.
- **Its tone is `warn`.** Not `danger` (that is where the machine went wrong),
  not `ok`. **A status-simplification that maps every status into three buckets
  — ok / attention / error — and files `needs-review` under green or red is the
  most likely silent break in this whole document.**
  `src/lib/format.ts` (`STATUS_TONE`), `src/components/StatusMark.tsx`.
- **The runs page's client-side `REOPENABLE` set deliberately differs from the
  server's in `orchestrator.ts`**, and `needs-review` is deliberately kept out
  of the client one. A bulk control must not answer the one ending whose entire
  content is *a person is being asked to look at this*. The run's own page
  still offers Resume, and that split is the point. **Do not unify the two sets
  and do not generate the bulk checkbox from a server DTO flag.**
  `src/app/runs/page.tsx`, `src/lib/orchestrator.ts`.
- **A `needs-review` member is settled, not written off**, so the instance reads
  `finished` — a claim about the graph, not about the work. Do not render
  `finished` as a green success summary.
- **A `needs-review` pass stops a loop** rather than waiting for it.
- `needs_review_reason` is clipped at the write because `RunDTO` is polled every
  three seconds for every row. To show the full text, read `run_events` — do
  not widen the DTO field.

### 5.8 Agents, templates and what a picker may claim

- **An agent carries a role, never a capability.** No `tools`, no permission
  mode, no folder, no budget, no isolation choice. `agentPayload` is a named
  projection and a test counts the keys. `src/lib/agents.ts`,
  `src/app/agents/page.tsx`.
- **The agent row sits *beside* the guards and never among them**, on the run
  page, in the workflow inspector and on the chat proposal card. A row inside a
  guard group claims it bounds something, and it bounds nothing. **A "group all
  the agent and permission settings into one Guards card" pass is exactly the
  change this forbids**, and nothing about it would fail to typecheck.
- **A deleted agent is refused by name at every door, never dropped to none.**
- The registry is a *part* of the ambient set, and every picker says so.
  Which definition wins on a name collision is **unverified** in the docs; a
  surface that lists both is what makes the collision visible.

### 5.9 The landed narrow-viewport work

`2c43b27` and the four runs behind it. **None of this may be undone, and every
change in §3 must survive at 390px as well as at 1440px.**

- **Every mobile rule is additive behind a breakpoint prefix.** A `max-md:` rule
  or a `md:`-prefixed override, never an edit to an unprefixed class — **the app
  at 1440px must be pixel-identical before and after.**
- The breakpoint is `md` (768px), written once in JS as `SIDEBAR_DOCKED`.
- The touch target is 44px below it (`max-md:min-h-11`), except a `<summary>`,
  which buys it with `max-md:py-3.5` — which is why `Disclosure` exists.
- 16px is the floor for a control that takes text.
- `Table`'s `stack` **and** a `label` on every `Td` are one decision. A cell
  left without a label is the headline the record is identified by — a status,
  a task, a branch — **never a figure**.
- The runs list's `w-full max-w-0` truncating cell, and its
  `max-md:max-w-none` release below the breakpoint.
- **The runs list view is deliberately not wrapped in `overflow-x-auto`.**
- A capped scroll region is released below the breakpoint, not kept — except
  the workflow canvas's, which is tightened, for the reason written beside it.
- A box inside the pane is never sized in viewport units.
- `Sheet` and the sidebar drawer owe the window's edges themselves;
  `--keyboard-inset`; the branches bar's `left-[var(--sidebar-w)]`.
- The canvas's `md:hidden` sentence, its `touch-none` targets and its `22rem`
  cap.

### 5.10 Two structural traps on the settings path

- **A field must not become a key of `Settings` if the settings form sends the
  whole blob.** The plugin list and the fleet hold live in their own rows for
  exactly this reason — a field in that blob is one an unrelated edit from a
  stale tab would silently clear, which for the fleet's kill switch is the
  failure it exists to prevent. `src/lib/plugins.ts`, `src/lib/fleet.ts`.
- **A Save stores only what differs from `DEFAULTS`.** §3.B's `nonDefaultKeys`
  reuses the existing `sameValue`; do not write a second comparison, and do not
  make the settings page write the whole effective object.
- Related, and the reason §3.B adds a field to `/api/settings` and not to
  `/api/status` or `/api/health`: those two are **exempt from auth**, so their
  payload shape is a security constraint with a test asserting the absence of a
  prompt, a folder path, a setting or a token. Never add a field there.
  `src/middleware.ts`, `src/lib/status.ts`, `src/lib/health.ts`.

### 5.11 The one CSS trap the new region headings will walk into

Three of this document's changes introduce a *region*: E1 (the dashboard's
three), C6 (the run inspector's three) and, loosely, D4 (the editor's block
groups). Every one of them will tempt a build run to reach for `<section>`.

**Do not use `<section>` for a region.** `src/app/globals.css:621` still carries

```css
section + section { margin-top: 24px; }
```

in the `@layer legacy` block. It is the exact rule `Card.tsx:29-32` records
being bitten by — *"The legacy stylesheet still carries `section + section
{ margin-top: 24px }`, which fired between sibling cards inside a grid and
pushed every card but the first down 24px. A card is a surface anyway, not a
document section."*

So a region is a `<div>` with an `<h2>` inside it, exactly as `Card` is a `div`.
The failure if you ignore this is the signature of everything else in §5:
nothing throws, nothing fails to typecheck, and every region after the first
sits 24px lower than the one above — which reads as a spacing decision somebody
made rather than as a stylesheet rule nobody meant to trigger.

The settings page's local `Section` (`settings/page.tsx:422-475`) *does* render
a `<section id>`, because its sections want a hash target and do want the
separation. It is the exception, it already exists, and run (b) leaves it alone.

The legacy block "shrinks as pages move onto the kit. When it is empty, delete
it" — this rule is one of the reasons it is not empty yet. Do not delete it in
any of these five runs; nothing here is scoped to prove it unused.

---

## 6. Recommend removing or changing — needs a human decision

**None of these is an instruction. Every one of them stays exactly as it is in
§3's target structures.** They are the things I would put to a person, with what
I would ask.

1. **The `In your own terminal` card** (`src/app/runs/[id]/page.tsx:1386-1441`).
   Change **C7** folds it. It arrived with `6c1a270`; the Land tab that does the same
   job arrived with `36a0dbf` and supersedes most of it. *Question: does anyone
   still use the copyable commands now that Land, Review and Changes are in the
   pane?* If not, deleting it removes a whole card, two sub-headings and a
   notice from the busiest tab in the app.
2. **`Have Claude resolve conflicts` defaults to on** (`branches/page.tsx:709`).
   It spends money, unattended, on the first press of Land. §3.E.10 adds a
   confirmation instead of changing the default, because the default is a
   behaviour decision. *Question: should it default off?*
3. **The chat's no-tool-restrictions sentence** (`chat/page.tsx:656-663`) is
   behind a closed disclosure. The comment at `:629-637` argues that trade and I
   did not override it. *Question: is "the chat itself can run commands and
   reach GitHub" a sentence that has to be read before the first message, or
   one that is read once?*
4. **`LiveTelemetry`'s missing `max-h-80`** (`LiveTelemetry.tsx:27-28`) — the
   only `LIST_VIEW` without a cap. §3.A.3 preserves it as `cap="uncapped"`.
   *Question: decision or omission?* **Unverified.**
5. **A loop block draws no badge on its canvas card**
   (`WorkflowCanvas.tsx:794-804`), so `maxPasses` is not on the card while an
   orchestrator's fan-out cap is. *Question: should it carry one?* It is on
   `BlockStatement`, so nothing is hidden from the approval — but the two kinds
   are inconsistent. **Unverified whether deliberate.**
6. **`Textarea`'s forced `font-mono`, `max-w-[100ch]` and `min-h-[90px]`**
   (`Field.tsx:279`). Every textarea in the app is monospace at a 90px floor,
   including the four prose prompts in Settings and the run form's task. Changing
   it moves pixels above the breakpoint, so it is out of scope here.
7. **`Field`'s unconditional `mb-3.5`** (`:179`) — the app's form rhythm, with
   no prop to vary it. Same reason it is out of scope.
8. **`Toggle` duplicates `ListRow`'s arrangement mirrored** (`Field.tsx:479-508`).
   Documented at `:473-478`. *Question: is the second component worth it?*
9. **A count badge on the sidebar's `Runs` row.** The single most-requested
   shape of change for a shell like this, and it would put a poll behind every
   page. It is a feature, not a rearrangement.
10. **`discard()` on Settings resets `copyGlobsText` but not
    `copyGlobsByRepoText` or `verifyToolsText`** (`settings/page.tsx:1229-1234`,
    and the same asymmetry in `save()` at `:1254`). Not a layout defect —
    recorded because run (b) will be looking at those rows.
11. **`docs/agent/agents-and-templates.md` contradicts itself** on how many
    surfaces read `GET /api/agents`: "read by five surfaces" in one paragraph,
    "one sentence four pickers share" in the next. Five is right (run form,
    Settings, canvas, chat mention popover, `/agents`).

---

## 7. Additions to `docs/agent/conventions.md`

Three, and no more. Each is a decision this document makes that a future editor
of a component would otherwise have to rediscover from here.

1. **The grouping vocabulary**, in one paragraph: the seven affordances, the
   caps, and the closed "never" list — pointing at this document for the
   reasoning.
2. **`ceiling` / `guard` / `limit`**, the three-word table from §3.C.1.
3. **The correction E8 forces**: `conventions.md` currently says there are
   "exactly two" hand-written controls carrying their own `text-sm` and
   therefore repeating the 16px floor. After run (e) converts the branches
   land-strategy `select` to the kit `Select`, there is **one** — the chat
   composer. Run (e) makes that edit in the same commit as the conversion.

A fourth correction is **already made** by this document, because it depends on
no code change: `conventions.md`'s `Table`/`stack` paragraph named "the settings
page's storage report" as one of the three tables without `stack`. Measured —
`grep -c '<Table[ >]'` is 20, `<Table stack` is 17 — the counts were right and
one of the three names was not. The storage report is no longer a table at all
(`settings/page.tsx:585-662` is a `ListGroup` of `ListRow`s); the settings
page's one un-stacked `Table` is the **calibration suggestion table** at
`:1859-1911`. The sentence now says so.

Items 1 and 2 and that correction are written by this document. Item 3 is run
(e)'s, because it has to land in the same commit as the conversion it
describes.
