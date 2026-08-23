# The problem, measured

Sixteen pages, 16,529 lines of `src/app/**/page.tsx`, and roughly fifty
components in `src/components/`, read by one operator supervising processes that
spend money. The question is where that interface fails a reader who is not the
person who built it.

The answer this survey found is narrower than the question invites, and the
narrowness is the finding. This is not a badly built interface. Attribute
coverage is strong, the four non-interaction states are designed rather than
left to a spinner, the modal path is a native `<dialog>`, and a 2,774-line
density audit has already been through every surface once. What is wrong is
**four colour values and one measurement nobody has ever taken**, plus one
tooltip that survived a pass designed to remove it.

Everything below is arithmetic on declared values, a `grep` count, or quoted
command output. Where something is inferred, the sentence says so.

---

## What was actually opened, and what the tooling is

`npm run typecheck` exits 0. `npm test` reports `# tests 1578 / # suites 230 /
# pass 1578 / # fail 0` in 16.5 s. Both were run in this worktree at
`a4d6ad9`.

`package.json` declares **4 runtime dependencies** (`better-sqlite3`, `next`,
`react`, `react-dom`) and **8 devDependencies** (`@tailwindcss/postcss`,
`@types/better-sqlite3`, `@types/node`, `@types/react`, `@types/react-dom`,
`postcss`, `tailwindcss`, `typescript`). There is no `lint` script, no jsdom, no
`@testing-library`, no Playwright, no Puppeteer, and no accessibility checker.
`"test"` is `tsc -p tsconfig.test.json && node --test ".test-build/**/*.test.js"`.

That matters for every option in this survey: **any option that proposes tooling
is proposing a dependency this repository has so far refused**, and has to pay
for itself in that argument rather than in a general appeal to good practice.

Page line counts, from `find src/app -name page.tsx | xargs wc -l`:

| Page | Lines | Page | Lines |
|---|---|---|---|
| `settings/` | 3,502 | `runs/` | 850 |
| `runs/new/` | 2,385 | `workflows/[id]/instances/[instanceId]/` | 781 |
| `branches/` | 1,656 | `workflows/[id]/` | 617 |
| `runs/[id]/` | 1,577 | `agents/` | 529 |
| `chat/` | 1,560 | `account/` | 296 |
| `/` | 1,386 | `workflows/` | 167 |
| `knowledge/` | 1,017 | `login/` | 109 |
| | | `workflows/[id]/edit/` | 77 |
| | | `workflows/new/` | 20 |

All sixteen were opened. No browser was driven by this survey: there is no
Chromium in this container and `npm run dev` on this host would read real
transcripts and could spawn real, billed `claude` processes. So every claim here
is either arithmetic on a declared value or a count from source, and no claim
here is about how anything looks.

**A browser has been driven at this app, once, and by somebody else.**
`docs/agent/ui-density-audit.md:2599-2628` records a dev server on a host with a
seeded database, and `:2750-2753` lists eleven surfaces opened. That pass found
six things reading could not, including every table in the app drawing its fixed
columns at roughly a third of their declared width (`:2650-2659`). It also
records what it could not do: the browser refused to resize below the host
window and reported `innerWidth: 2560` at a 1519px window, so **no reading at
390px has ever been taken** (`:2624-2628`, and `docs/verification.md:1139-1146`
keeps the entry).

---

## Finding 1: the app's explanatory layer is its least legible text

This is the strongest finding in the survey, and it is the one whose evidence is
least disputable.

`src/app/globals.css:63-65` declares three text weights:

```css
--fg:            light-dark(#1d1d1f, #f5f5f7);
--fg-muted:      light-dark(#68686d, #a1a1a6);
--fg-faint:      light-dark(#86868b, #8a8a8f);
```

`proposals/OperatorInterface/contrast.py` computes every pair against every
surface token. In **light mode**, `--fg-faint` measures:

| on | ratio | AA 4.5:1 |
|---|---|---|
| `--bg` (`#f0f0f3`) | **3.19:1** | fail |
| `--bg-raised` (`#ffffff`, a card) | **3.62:1** | fail |
| `--bg-inset` (`#f5f5f7`) | **3.33:1** | fail |
| `--bg-grouped` (`#f7f7f9`) | **3.39:1** | fail |
| `--bezel` (`#ffffff`) | **3.62:1** | fail |
| `--bezel-hover` (`#f2f2f4`) | **3.24:1** | fail |

Every value clears the 3:1 large-text threshold and none clears 4.5:1. The
large-text exemption needs 18.66px bold or 24px regular, and this token is never
used at either: `grep -rn "text-ink-faint" src/app src/components` returns 60
sites, of which 27 also carry `text-xs` (12px) or `text-2xs` (11px), and the
rest inherit `--text-sm` or `--text-base`, both of which are **13px** in
`@theme inline`.

Sixty sites understates it, because three kit components route many call sites
into the token:

| Component | Line | What it colours | Call sites |
|---|---|---|---|
| `src/components/ui/List.tsx:147` | `text-xs leading-snug text-ink-faint` | a `ListRow`'s `description` | **87** `description=` |
| `src/components/ui/Hint.tsx:24` | `neutral: "text-ink-faint"` | the default tone of the note under a form field | **61** `<Hint>` |
| `src/components/ui/Card.tsx:117` | `py-5 text-center text-sm text-ink-faint` | the body of every `Empty` state | **44** `<Empty>` |

That is 192 rendered strings before counting the 60 direct uses, and the three
of them are exactly where `docs/agent/ui-density-audit.md:184-187` sends facts a
reader needs:

> **A tooltip carrying anything the reader needs.** No touch equivalent, and
> WCAG 1.4.13 wants dismissable/hoverable/persistent, which a hover title is
> not. If it matters it goes on the page; `Field`'s `hint` and `ListRow`'s
> `description` are where it goes.

So the audit correctly moved needed facts out of tooltips and into the two
components whose colour fails 4.5:1, and the `Empty` state, which is the first
thing a first-run operator reads, is 13px at 3.62:1.

Two more sites are worth naming because they are the app's evidence surfaces:
`src/components/ui/Log.tsx:118` sets every run-log event's timestamp at
`text-2xs` (11px) in this token, and `src/components/ui/Patch.tsx:110,117` sets
every diff's line numbers the same way.

**And the token has no repair.** To clear 4.5:1 on all four surfaces in light
mode, `--fg-faint` must reach `#6d6d71`. `--fg-muted` is `#68686d`. Five levels
of grey per channel apart; the two weights collapse into one. **The palette has
room for two text weights at AA in light mode, not three**, and that is what
makes this a design decision rather than a colour tweak.

In dark mode the same token measures 4.84:1 on `--bg` and 5.26:1 on `--bg-inset`
(pass) but 4.17:1 on `--bg-raised` and 3.72:1 on `--bg-grouped` (fail). So the
failure is not symmetric, which matters for how a fix is written: this is a
`light-dark()` pair and only one half of it is broken everywhere.

### 1b: the second text weight fails too, on one surface, in one scheme

`--fg-muted` passes on every surface in light mode (4.87:1 to 5.54:1) and on
three of four in dark. The exception is the bezel, the surface AppKit gives an
unselected segment and a secondary button:

| dark | ratio |
|---|---|
| `--fg-muted` on `--bezel` (`#48484c`) | **3.54:1** |
| `--fg-muted` on `--bezel-hover` (`#545458`) | 2.93:1, **no call site** |

Two sites put that pairing on screen at rest, and both are 11px to 12px:

- `src/app/settings/page.tsx:133-134`, `CHIP.plain`, rendered at `:1875` as
  `text-xs font-medium`: the eight unselected section chips that are the only
  navigation of the app's 3,502-line page.
- `src/components/WorkflowCanvas.tsx:835`, the unselected Link control, at
  `text-2xs`.

Both flip to `text-ink` on hover, which is why the 2.93:1 figure has no site,
and both set `aria-current` or a label change rather than relying on colour, so
1.4.1 is satisfied. This is smaller than finding 1 by two orders of magnitude in
reach, and it is here because it shares finding 1's repair: it is a call site
choosing the wrong weight for its surface, not a broken token.

---

## Finding 2: the app's only focus indicator fails 1.4.11 on every surface

`src/app/globals.css:576-579` is the whole of the focus treatment:

```css
:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
```

and `:112` is the colour:

```css
--ring: color-mix(in oklab, var(--accent-source) 45%, transparent);
```

Mixing with `transparent` under CSS Color 5's premultiplied rule leaves the
colour components untouched and moves only the alpha, so `--ring` is `--accent`
at 45%. `outline-offset: 2px` puts it on the surface behind the control, and a
browser composites in sRGB. The ring against the surface it is drawn on:

| | light | dark |
|---|---|---|
| on `--bg` | `#84b3e7`, **1.93:1** | `#325684`, **2.22:1** |
| on `--bg-raised` | `#8cbcee`, **1.99:1** | `#385d8c`, **2.12:1** |
| on `--bg-inset` | `#87b6ea`, **1.95:1** | `#2d5280`, **2.26:1** |
| on `--bg-grouped` | `#88b7eb`, **1.96:1** | `#3d6190`, **2.01:1** |

WCAG 1.4.11 (AA) asks 3:1 for "visual information required to identify user
interface components and **states**". A focus indicator is a state. The
`--ring-danger` variant measures 2.07:1 to 2.39:1 on the same surfaces.

The alpha that would reach 3:1 on the worst surface is **73%** in light and
**71%** in dark. At full strength the accent itself measures 4.59:1 to 6.39:1,
so there is headroom; 45% is the only reason this fails.

2.4.7 Focus Visible (AA) asks only that an indicator *exist*, and it does, on
every focusable element, from one place. 2.4.13 Focus Appearance is **AAA** and
asks for a 2px perimeter (satisfied) and 3:1 focused-against-unfocused (not).
So the conformance claim here is 1.4.11, at AA, and it is the same single line
of CSS for the whole app. That single-statement property is what makes this the
cheapest real finding in the survey.

---

## Finding 3: the one destructive button's label fails in dark mode, and the file already solved this exact problem for blue

`src/components/ui/Button.tsx:49-52`:

```ts
danger:
  "border-transparent bg-danger text-white shadow-e1 focus-visible:outline-ring-danger " +
  "not-disabled:hover:brightness-110 not-disabled:active:brightness-95 not-disabled:active:shadow-press",
```

`#ffffff` on `--danger`:

| | ratio | AA 4.5:1 |
|---|---|---|
| light (`#d70015`) | 5.38:1 | pass |
| dark (`#ff6961`) | **2.82:1** | **fail** |

Six `variant="danger"` call sites and eight `confirmVariant="danger"` sheets
reach it, which is every irreversible action in the app: the purge, the delete,
the stop, the sign-out.

The interesting part is not the number, it is that `src/app/globals.css:76-80`
documents inventing a token pair to solve this failure mode, for the other
colour:

> Split from `--accent` because the two are measured against opposite
> backgrounds: `--accent` has to clear 4.5:1 on a card, `--tint` has to clear it
> *underneath* `--tint-fg`, and in dark mode no single blue does both;
> `#4a9bff` carries white at 2.8:1. So the filled control gets its own, deeper
> blue and white stays legible at 5.1:1.

Measured: `#ffffff` on `--tint` is 5.22:1 light and **5.06:1** dark. The pair
works. The same sentence with "red" in it is the whole of the repair, and
`#c4514b` (the existing dark `--danger` 23% toward black) carries white at
4.54:1 while still reading 3.15:1 against a card.

There is a caveat I will not bury. The vault's
`3 Resources/Web Design/Colour Contrast Requirements.md:71-76` records that
WCAG 2's sRGB luminance formula is most criticised precisely for dark
backgrounds, and that neither side of that argument has participant evidence.
So this is the finding whose *number* is least secure, even though it is the one
whose *repair* is most clearly authorised by the file's own reasoning. Finding 1
sits in light mode, where the formula's critics have their weakest case, which
is why it ranks above this one.

---

## Finding 4: a resting text control has no boundary at 3:1, by either route

`src/components/ui/Field.tsx:29-30` and `:68`:

```ts
const CONTROL_BASE = "ui-transition rounded-sm border bg-inset px-2.5 text-sm text-ink " + …
const BORDER_REST  = "border-line enabled:hover:border-line-strong";
```

Every text control in the app concatenates that string. WCAG 1.4.11 asks for
3:1 on whatever identifies the component, and a filled control can satisfy it
through its fill *or* its border. Neither does:

| | border vs card | fill vs card |
|---|---|---|
| light | `--border` on `--bg-raised` **1.28:1** | `--bg-inset` on `--bg-raised` **1.09:1** |
| dark | `--border` on `--bg-raised` **1.26:1** | `--bg-inset` on `--bg-raised` **1.26:1** |

88 call sites: 54 `<Input>`, 22 `<Select>`, 8 `<Textarea>`, 4 `<LimitField>`.

Two things pull the other way and both belong in the finding. `:53` sets
`focus:border-accent`, and `--accent` against a card measures 5.22:1 light and
5.06:1 dark, so a **focused** control has a boundary well past 3:1; only the
resting one does not. And the placeholder is a separate, smaller failure:
`:48` is `placeholder:text-ink-faint`, which is 3.33:1 on `--bg-inset` in light
(finding 1 again, at a site where the text is a label for an empty box).

The `disabled:text-ink-faint` at `:55` is **not** a finding: 1.4.3 exempts
inactive components by name.

This is the finding I hold most loosely, and for a stated reason. `--border` is
described at `:56-58` as "a hairline, at macOS weight", explicitly matching
AppKit's `separatorColor`, and the depth is said to come from `--shadow-e1`
rather than from the edge. Raising it to 3:1 would be raising it well past the
platform it is imitating, on a token read across the whole app. What is
defensible is naming it and putting it to a person; what is not defensible is
calling it a colour bug.

---

## Finding 5: the document outline is flat, and an invariant is why

`src/components/ui/Card.tsx:59` renders every `CardTitle` as an `<h2>`. So does
every region heading: `src/app/page.tsx:194` (`SourceRegion`) and
`src/app/runs/[id]/page.tsx:327` (`Region`). So does `src/components/ui/Sheet.tsx:125`.
Every page carries exactly one `<h1>` (seventeen sites, one per page plus the
two branches of `/settings`), and `grep '<h3'` across `src/app` returns **one**
occurrence.

The consequence is countable. `src/app/page.tsx` has three `SourceRegion`s
containing nine `Card`s with eight `CardTitle`s. Navigating that page by
heading gives eleven `<h2>`s at one level, with nothing in the outline saying
which three of them are the containers that
`docs/agent/conventions.md`'s three-cost-source invariant exists to keep apart.
`src/app/runs/[id]/page.tsx` has three `Region`s and a five-segment tab strip
in the same shape.

There is a second asymmetry underneath it. `src/app/settings/page.tsx:547-556`
is the app's one region that is a `<section>` with `aria-labelledby`, so it gets
a labelled landmark. The nine `<div>` regions on `/` and `/runs/[id]` get
neither a landmark nor a distinct heading level, and
`docs/agent/conventions.md` is the reason:

> A **region** is not an eighth affordance: a `<div>` with an `<h2>`, never a
> `<section>`, and never carrying a figure of its own.

That rule has a good reason behind it (`globals.css`'s legacy
`section + section { margin-top: 24px }`, which
`docs/agent/ui-density-audit.md:2675-2679` records firing between every pair of
merge-queue batches and costing 24px nobody wrote). The rule is about spacing
and the cost is in the outline, and nobody has connected the two.

**The app has already shown that the two are separable**, which is the fact that
makes this fixable at all. `src/app/knowledge/page.tsx:417-419` puts
`role="region"` and `aria-label` on a `<div>`, and its comment states exactly
this reasoning:

> A `<div>` with a role rather than a `<section>`, which the conventions doc
> rules out: the legacy layer still carries
> `section + section { margin-top: 24px }`, so a second one here would space
> itself. The role is what makes this focusable block announce as something
> rather than as an unnamed box.

So a landmark costs a `role` and a label, not an element, and the spacing
invariant is not what stands in the way.

**This is a technique-level concern, not a conformance failure.** WCAG 1.3.1
does not require heading nesting; `G141` is a *sufficient technique*, and 2.4.10
Section Headings is AAA. Saying otherwise would be exactly what
`3 Resources/Web Design/Misapplied Laws in Interface Design.md` warns against.
It goes to a person alongside `docs/agent/ui-density-audit.md:2191-2262`'s
fifteen other questions, not into a repair.

---

## Finding 6: one tooltip survived the pass designed to remove them

A five-line fix, and not a survey's worth of anything. It is here because it is
the only place where this app violates one of its own documented invariants, and
`proposals/GapRegister/05-register.md` closes by observing that nothing on its
register does.

**One HTML `title` tooltip is left.** A regex sweep for `title="` inside a
lowercase JSX tag across every non-test `.tsx` in `src/` returns exactly one
hit: `src/app/branches/page.tsx:335-340`, a `<span>` at
`tabular-nums text-xs text-ink-muted` carrying
`title="What resolving this branch's conflict cost"`. Six others were deleted by
`docs/agent/ui-density-audit.md:2687-2694`, on the grounds that a tooltip has no
touch equivalent and that two of them were the only place a fact existed. This
one carries the definition of a dollar figure on a page whose primary job is
spending money to resolve conflicts, and it is the seventh.

**The one `onClick` on a non-interactive element is not a defect.** The sweep for
`<div|span|li|tr|td|p … onClick` across `src/` returns exactly one result,
`src/app/knowledge/page.tsx:390`, and reading it settles it: the comment above it
says "One delegated handler for every note link on the page, the list, the
backlinks, the health rows and the wikilinks inside a body." The interactive
elements are real anchors; the `<div>` only catches their bubbling clicks to
route them client-side, and a keyboard activation of an anchor dispatches a click
that bubbles the same way. So this finding has one half, not two, and the second
half is recorded here because a sweep that returns a hit and stops looking is how
a survey manufactures a defect.

---

## What is in better shape than the question implies

Recording these matters as much as the findings, because four of the seven
options in this survey are worth less than they sound and this is why.

- **The keyboard path is not merely intact, it has been engineered in the places
  usually missed.** `src/app/layout.tsx:126-129` renders a skip link.
  `src/components/ui/Sheet.tsx` is a native `<dialog>` opened with
  `showModal()`, so the focus trap, the inert background, the top layer and Esc
  come from the browser; `onCancel` is prevented so Esc routes through
  `onDismiss`, and Cancel takes `autoFocus` when the confirm is destructive.
  `src/components/ui/SegmentedControl.tsx:122` runs a roving tabindex
  (`tabIndex={selected ? 0 : -1}`) with its own `onKeyDown`, which is the
  correct pattern and not the one a hurried implementation reaches for; and
  `src/app/page.tsx:995` records that a hand-rolled pill strip claiming
  `role="tablist"` was **replaced** by that component. `Log.tsx:82-84` and
  `Patch.tsx:56,63,91` add `tabIndex={0}` to scrollable regions with a comment
  saying why ("unreachable. tabIndex is what fixes that"), which is the single
  most commonly missed keyboard defect on the web. `chat/page.tsx:800-805` is a
  real `role="listbox"`/`role="option"` mention picker. Seven files carry an
  `onKeyDown`; none of them is a `<div>` pretending to be a button.
  `src/components/WorkflowCanvas.tsx` looks pointer-only and is not: every
  function is reachable through an inner `<button>` with an `aria-label`
  (`:705`, `:758`, `:799`), and link mode announces itself through an
  `sr-only role="status" aria-live="polite"` at `:590`. What a keyboard cannot
  do there is *drag* (`:749`), which is layout rather than function, and
  `docs/agent/conventions.md` already states that arranging a graph is a screen
  task and says so on the surface below `md`.
- **The four non-interaction states are designed, and mostly present.** Counted
  per page: `<Empty>` appears on 13 of 16, `Skeleton`/`SkeletonText` on 10,
  `<Notice>` on 14, `role="alert"` on 8, `aria-busy` on 6. The gaps are real but
  small and specific: `/settings`, `/runs/new` and `/chat` have no skeleton
  (`/settings:1720` shows `<Empty>Loading settings…</Empty>`, `/chat:745` shows
  a bare `"Loading…"`, `/runs/new:1456` a `<option>Loading…</option>`), and
  `/chat` and `/account` carry no `role="alert"`.
- **First run is designed, not defaulted.** `src/app/page.tsx:279-310`
  distinguishes "no billable turn has happened yet" from a wrongly pointed
  `CLAUDE_HOME` and lists what to do about each. `src/app/login/page.tsx` puts
  its error on the `Field` so it reaches the input through `aria-describedby`,
  autofocuses, sets `autoComplete="current-password"`, and handles 409
  explicitly rather than redirecting past it.
- **`Badge`'s tone pairs all pass.** Every entry in
  `src/components/ui/Badge.tsx`'s `TONE` map puts the tone in the *text* on
  `--bg-inset`: 4.79:1 to 5.19:1 in light, 6.39:1 to 8.94:1 in dark.
- **`--tint`/`--tint-fg` passes in both schemes** (5.22:1 and 5.06:1), which is
  the whole point of finding 3.
- **Attribute coverage is genuinely strong**: 31 `role="alert"`, 17
  `aria-live`, 23 `aria-invalid`, 18 `aria-describedby` across `src/`.

## Where this app sits against a baseline

The vault records the only large measurement of this criterion:
`3 Resources/Web Design/Colour Contrast Requirements.md:82-90` cites
Vaughan & Ortiz Suarez (2026, arXiv preprint, read at abstract depth), a static
CSS analysis of 4,327 colour pairings across 240 homepages sampled from Common
Crawl's most-crawled 500 domains. 40.9% of pairings failed 4.5:1; median
per-site compliance was 62.7%; **20.4% of sites were fully compliant**.

The same method applied here, over the declared cross-product of 7 text tokens
against 7 surface tokens in both schemes (98 pairings), gives **29 failures,
29.6%**, and that number flatters nothing: 12 of the 49 light pairings and 17 of
the 49 dark ones fail. Restricted to pairings that actually occur in source,
the failures are the four findings above.

So this app is better than the median site in that corpus and is not in the
compliant fifth. That is the honest frame for everything that follows: this is a
short, specific punch list on a well-built interface, not a rescue.

## What was not inspected

- **No browser, at any width.** Nothing here is a visual judgement, and the
  390px column of `docs/verification.md:1113-1250` stays exactly as unverified
  as that file says it is.
- **No screen reader.** Attribute coverage was counted; nothing was heard.
- **No real data.** `DATA_DIR` is unreadable from a work cycle, so no page was
  seen holding a hundred runs, a long log or a large diff. Every density claim
  here is a count of components in source, which is the same limit
  `docs/agent/ui-density-audit.md:43-64` states for itself.
- **The `@supports` accent swap.** `globals.css` substitutes the operator's own
  system accent where the browser exposes `AccentColor`/`AccentColorText`, and
  `--accent-source` feeds `--ring` and `--selection`. Every ring number above is
  for the *declared* accent. An operator accent could be worse or better and
  nothing in the app measures it. This is the one place where a token repair
  cannot fully guarantee its own result, and `01-constraints.md` records it as a
  bound on the field rather than as a defect.
- **`--fg-muted` on a pressed row.** I measured this, found 3.67:1 in light over
  `--fill-active`, went looking for a site, and found none: the two components
  that use `--fill-active` (`shell/QuickOpen.tsx:36`,
  `shell/Sidebar.tsx:58`) both put `text-ink` on it, which is 14.80:1. The one
  hovered-fill site with tone-coloured text is
  `src/components/ui/Patch.tsx:31` (`bg-fill-hover text-accent`, a diff hunk
  header) at 3.93:1 to 4.46:1 in light. One site, marginal, recorded and not
  claimed.
