# Constraints

Every option in this survey is bounded by something already decided. Eleven of
them, in descending order of how much field they remove.

---

## C1. One focus treatment, stated in one place, and a component may change only its colour

`docs/agent/conventions.md:53`:

> **One focus treatment, stated in one place.** `@layer base` draws
> `outline: 2px solid var(--ring)` at 2px offset on everything focusable, so a
> new component inherits the ring by existing. A component may override the
> ring's **colour** and nothing else (`focus-visible:outline-ring-danger` on the
> destructive button), and no component in the kit states an outline width or
> offset.

This is the invariant that makes finding 2 cheap and that makes one obvious
repair illegal. Raising the ring to 3:1 by thickening it, or by adding a second
outer ring in a contrasting colour (the pattern most design systems use), is a
component stating a width. The only move the invariant leaves open is **the
colour**, which happens to be exactly where the defect is. That is luck, and the
option file for finding 2 should not pretend it is design.

It also bounds the blast radius in the other direction: there is no per-component
ring to audit. One declaration at `src/app/globals.css:576-579` is the whole
surface, and `--ring` is read by nothing else. `--selection` is a separate token
from the same source.

## C2. `docs/agent/ui-density-audit.md` is the reasoning behind a live invariant, so it is argued against explicitly or not at all

2,774 lines. `docs/agent/conventions.md` cites it as the reasoning behind the
seven-affordance vocabulary and its caps. Three parts of it bound this survey:

**§1.0 orders the moves: Delete, Group, Reorder, Hide, in that order.**
"Hiding is not the default fix for a crowded page." Any option that proposes
progressive disclosure is proposing the *last* move on a page where the audit
has already tried the first three, and owes an argument for why the earlier three
were exhausted.

**§1.2 forbids ten things by name**, of which four are live here: a tooltip
carrying anything the reader needs, any hover-reveal, an accordion or nested
disclosure, and a `data-[…]` Tailwind variant. Finding 6's surviving `title`
attribute is a violation of the first; no option in this survey may create one.

**§0.1:45-47 states its own limit** and is the reason this survey exists rather
than duplicating it:

> **There is no browser in this container.** Everything below is read from
> source. I did not look at pixels and nothing in this document is a judgement
> about how something looks.

`grep -ic contrast docs/agent/ui-density-audit.md` returns **0**. The most
thorough UI document in this repository contains the word zero times, and says
honestly why. That is the seam this survey works in, and it is the only one: on
density, grouping, affordance choice and page structure, the audit has been over
the ground and this survey defers to it.

## C3. Variants are typed props with lookup maps, never `data-[…]`, and a caller's class never cancels a component's spacing

`docs/agent/conventions.md`. Two mechanical consequences for anything proposing
a class change:

A new visual state is a new key in a `Record<Union, string>`, so it is a
TypeScript change with an exhaustive switch behind it, which is why these
changes typecheck rather than silently no-op. But an *interpolated* class is
invisible to Tailwind's scanner, so a repair may not compute a class name.

And Tailwind emits a utility's values in ascending order, so two utilities
setting the same property under the same variant resolve by **generated
stylesheet order, not class-attribute order**. A call site cannot override a
component's own value by putting a class after it. Every repair here therefore
goes in the token or in the component, never at a call site.

## C4. The palette holds two text weights at AA in light mode, not three

Measured, not assumed. `contrast.py` searches for the lightest `--fg-faint` that
clears 4.5:1 on all four light surfaces: `#6d6d71`. `--fg-muted` is `#68686d`.

So "darken `--fg-faint`" is not available as a repair. Either the third weight
stops carrying text a reader needs, or the app has two weights and one of them
is named twice. This constraint is what makes finding 1 a call-site decision in
three components rather than a one-line token edit, and it is the single most
consequential fact in the survey.

## C5. Four runtime dependencies, eight dev, no linter, and a test bar that is a sentence

`package.json`: `better-sqlite3`, `next`, `react`, `react-dom`; then
`@tailwindcss/postcss`, `@types/better-sqlite3`, `@types/node`, `@types/react`,
`@types/react-dom`, `postcss`, `tailwindcss`, `typescript`. No `lint` script,
`eslint.ignoreDuringBuilds` is on, and `CLAUDE.md` states there is no linter run
as a fact about the project rather than as an omission.

`CLAUDE.md`'s test bar:

> **A pure function whose failure mode is silent gets a unit test.** … Before
> adding a test, read `docs/agent/testing.md`: it names every existing one and
> the grounds each earned, and that is the bar, not a general convention to
> follow.

An option proposing a dependency is proposing to change a standing decision,
and must argue it there. An option proposing a *test* has a narrower and much
easier argument available: it either fits the sentence above or it does not.
That asymmetry is why the two tooling options in this survey are separate files
rather than one.

## C6. There is no browser here, and the one that ran could not narrow

`docs/agent/ui-density-audit.md:2624-2628` and `docs/verification.md:1139-1146`:
the browser driven at this app "refused to resize below the host window and
reported `innerWidth: 2560` at a 1519px window". So the `md` breakpoint was
never crossed and no reading at 390px exists.

`docs/verification.md:1113-1250` already owns that gap, already prescribes the
reading (390x844, the branches selection bar's left edge, the `max-md:h-80`
spacer, the instance page as the cross-component `stack` proof), and already
records the two escaped greps that work and the unescaped one that returns 0 on
a build where the class is present. **A narrow-viewport option in this survey
would be re-deciding a question that has an owner and a written procedure.**

## C7. The legal argument is unavailable, so every option pays for itself in the operator's own terms

From `/workspace2/3 Resources/Web Design/Accessibility Law and Web Design.md`:
the EAA reaches consumer-facing services, and a single-operator tool for
supervising one's own agents is outside it by two independent routes. Article
4(5) and BFSG §3(3) exempt microenterprises regardless. New Media Service GmbH
running this for itself is not a covered entity.

That removes the argument that would otherwise carry every option here. What is
left is the only argument this survey is entitled to make: **the operator is a
reader, the app's job is to be read, and a number below a published threshold is
evidence about reading.** Where the evidence for a threshold is weak, the option
file says so.

## C8. The thresholds themselves are conventions with thin provenance

`/workspace2/3 Resources/Web Design/Colour Contrast Requirements.md:52-76`
records the provenance collapse in detail: Arditi & Faye 2004, the usual
citation for the 4.5:1 figure, is a one-page meeting abstract whose only 1.5 is
a log-contrast-sensitivity intercept rather than a derivation; w3c/wcag #1705
was closed without one; Discussion #3853 is unanswered. APCA is self-published
with no completed human-participant validation and a licence that restricts
derivative work. WCAG 3.0's March 2026 draft names no text-contrast requirement
at all. The note's instruction:

> Use them, because they are the enforceable standard and the alternative has no
> validation either, but **do not defend them as science**, and do not treat an
> automated contrast pass as proof that text is readable, especially on dark
> backgrounds and translucent surfaces, where the formula's critics have their
> strongest case.

This constrains the *rhetoric* of every option, and it demotes finding 3
specifically: white on dark red is exactly the case the critics name. It does
not weaken finding 1, which is light mode on opaque surfaces, where the formula
is least contested.

## C9. Automated coverage is a fraction, and the fraction is contested

`/workspace2/3 Resources/Web Design/Automated Accessibility Testing Coverage.md`
(confidence medium, updated 2026-08-23): automated tools detect between 13% and
57.38% of real issues depending on the denominator, and the spread is the
denominator rather than the tools. Deque's own 57.38% counts issues weighted by
occurrence, which flatters an automated tool because the issues it finds are the
repetitive ones.

So an axe-core option cannot be sold as "then the interface is accessible", and
this survey's own contrast findings are a case in point: **contrast is the
criterion automation decides best**, because it is arithmetic on declared
values, and the app's four failures were still found by hand because nobody had
ever run the arithmetic. The tool would not have been the discovery; the
decision to compute would have been.

## C10. No test in this repository renders a page, and there are 16,529 lines of them

From `proposals/GapRegister/01-frontend.md`'s F5, re-run in this worktree:
1,578 tests, 230 suites, 0 failures; 8 tests under `src/app`, of which seven are
route handlers and one is a pure helper; **0 page components rendered by a
test**; 8 component tests, all through `renderToStaticMarkup`, all asserting on
class strings.

This bounds blast radius rather than tooling. Any repair that touches a token or
a shared component is a change to 16,529 lines of code that nothing watches,
verified by a human opening a browser or not at all. It is the reason this survey
ranks *token-local* repairs above *component-structural* ones even where the
structural one is more correct: a token edit is one grep away from a complete
audit of its own reach, and a change to `Card` is not.

## C11. Two things are deliberately the way they are, and are not defects

**`--fg-faint` on disabled text is exempt.** `src/components/ui/Field.tsx:55`
sets `disabled:text-ink-faint`, and WCAG 1.4.3 exempts inactive components by
name. Nothing in this survey proposes touching it.

**The operator's own accent can override `--ring`.** `globals.css` swaps in
`AccentColor`/`AccentColorText` under `@supports`, and `--accent-source` feeds
both `--ring` and `--selection`. Every ring number in `00-problem.md` is for the
declared accent. A repair to the ring's alpha improves *any* accent's ratio,
because alpha is a multiplier on the difference from the surface, but it cannot
guarantee 3:1 for an accent the app never sees. That residual is stated in the
option file rather than hidden, and it is one more reason the repair is a token
change rather than a conformance claim.
