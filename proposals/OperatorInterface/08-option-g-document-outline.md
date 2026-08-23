# Option G: give the pages a document outline

The option whose premise nobody in this container can hear, which is why it ends
as a question rather than a change.

## The case

`00-problem.md`'s finding 5: `src/components/ui/Card.tsx:59` renders every
`CardTitle` as an `<h2>`, and so does every region heading
(`src/app/page.tsx:194`, `src/app/runs/[id]/page.tsx:327`) and every sheet
heading (`src/components/ui/Sheet.tsx:125`). One `<h1>` per page, exactly one
`<h3>` in the whole of `src/app`.

The concrete consequence: `/` has three `SourceRegion`s containing nine `Card`s
with eight `CardTitle`s. Navigated by heading, that is eleven `<h2>`s at one
level, and nothing in the outline says which three of them are the containers
that the three-cost-source invariant exists to keep apart. Those three regions
are the app's most load-bearing separation, the one `docs/agent/architecture.md`
describes as never summed and never mixed, and in the outline they are
indistinguishable from the cards inside them.

The vault supports the general shape of the concern.
`/workspace2/3 Resources/Web Design/Visual Hierarchy and Scanning.md`
(confidence medium) reads the F-pattern not as a layout target but as
Nielsen Norman Group's own description of what happens when a page gives the eye
no better cues, whose remedy is "giving headings and subheads enough
differentiation to be entry points". That argument is about visual
differentiation rather than markup levels, and it is the closest the evidence
gets.

## Two shapes it could take, and the first is cheap

**G1, landmarks only.** Put `role="region"` and `aria-labelledby` on the nine
region `<div>`s. No element changes, no heading changes, no spacing changes. The
app has already established that this is available and why:
`src/app/knowledge/page.tsx:417-419` does exactly it, with the reasoning in a
comment, and `docs/agent/conventions.md`'s "never a `<section>`" rule turns out to
be about the legacy `section + section { margin-top: 24px }` cascade rather than
about landmarks. `src/app/settings/page.tsx:547-556` is the one place that uses a
real `<section id aria-labelledby>` and neutralises the spacing rule with `mt-0`.
So G1 is roughly nine `role`, `id` and `aria-labelledby` triples.

**G2, heading levels.** `CardTitle` gains a typed `as: "h2" | "h3"` prop and
every card inside a region passes `h3`. This is the change that actually fixes the
outline, and it is much larger: every `CardTitle` call site has to be classified
by whether it sits inside a region, which is a judgement per site across sixteen
pages, verified by nothing (`C10`). It also puts a structural decision in a call
site's hands, which is the pattern `docs/agent/conventions.md` spends its length
avoiding.

## Why neither is recommended now

**It is a technique, not a criterion.** WCAG 1.3.1 does not require heading
nesting; `G141` is a *sufficient technique*, one of several. 2.4.10 Section
Headings is **AAA**. Calling a flat outline a conformance failure would be
precisely the move
`/workspace2/3 Resources/Web Design/Misapplied Laws in Interface Design.md`
exists to refuse: citing a real source for a claim it does not contain. Every
other finding in `00-problem.md` names an AA criterion and a number. This one
names a preference with a good argument behind it, and the difference matters
when the two are put in the same list.

**Nobody has heard this app.** Attribute coverage was counted, not listened to.
The harm G describes is a screen-reader navigation harm, and this survey used no
screen reader, so the entire premise is an inference from markup. That is a
weaker position than any other finding here, all four of which are arithmetic. Of
everything in this survey, G is the one where **the instrument is missing rather
than the effort**.

**G1 has a cost of its own that is easy to miss.** Nine `region` landmarks on one
page is nine entries in a landmark list, and ARIA guidance is that `region`
should be used sparingly for exactly that reason. Trading eleven undifferentiated
headings for eleven headings plus nine landmarks may not be an improvement, and
deciding that requires listening to it.

**And the honest ordering.** If the outline is worth fixing, `06-option-e`'s
`heading-order` and `region` rules would flag it mechanically and keep flagging
it, which beats a one-time pass. So G's natural home is behind a rendering-test
harness, alongside E, and both of those are behind
`proposals/GapRegister/01-frontend.md`'s F5.

## What this option is, then

**A sixteenth question, filed next to the fifteen that
`docs/agent/ui-density-audit.md:2191-2262` already leaves open for a person.**
Those fifteen are all questions the audit could not settle from source, and this
is the same kind: it needs somebody with a screen reader and ten minutes on `/`
and `/runs/[id]`, and it needs them before, not after, any markup moves.

This proposal does not edit `docs/`, so filing it is a follow-up rather than part
of the option. `12-recommendation.md` records it as one.

## What would overturn this

Hearing it. If `/` announces as eleven peer headings and a listener cannot tell
the three cost sources apart, G1 becomes the cheapest correct fix in the survey
and should be taken immediately. If it announces adequately because the cards'
own titles carry their source in the text, G is closed for good and the
`aria-labelledby` triples are never written.
