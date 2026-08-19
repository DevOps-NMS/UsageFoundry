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
| 3 | **Card** (`Card`, `emphasis`) | The contents are read together and answer **one** question a reader could ask out loud. | ≤ 7 cards per page; ≤ 9 controls in one card without an inner `ListGroup`; **exactly one `primary` per page**. |
| 4 | **Group** (`ListGroup` with `label`) | Three or more rows inside a card share a subject that the card's own title does not name. | 3–9 rows. Fewer than 3 is not a group, more than 9 is two. |
| 5 | **Disclosure** (new `Disclosure` primitive, §1.3) | The content is *evidence* (a log, a diff, an older list, a preflight report) or a setting whose default is right for nearly everyone. | Never nested. Never around a fact a decision is approved against. |
| 6 | **Tab strip** (`SegmentedControl` switching panes) | Two to five **mutually exclusive views of one subject**, where the reader wants one at a time and the page can tell whether there is anything behind each. | ≤ 5 segments. One strip per page. |
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
- **A tab strip is a view switcher, never a navigation device.** Moving between
  different *subjects* is the sidebar's job. `/runs/[id]` has the app's one
  legitimate tab strip and it stays.

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
- **Uncontrolled only.** `defaultOpen` sets the `open` attribute at mount and
  the component never reads it again. There is deliberately no `open`/`onToggle`
  pair: a controlled disclosure invites a page to *close* one in response to a
  poll, which is this app's own "nothing switches tabs on its own" rule
  (`conventions.md`, the run-page paragraph) one component over.
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
