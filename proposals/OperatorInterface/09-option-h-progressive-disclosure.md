# Option H: a progressive-disclosure restructure of the densest page

The brief asked for this option by name. It is the one this survey refuses most
firmly, and the refusal has four independent grounds: a live invariant, the
repository's own history, the peer-reviewed evidence, and a misdiagnosis.

## The case

`src/app/settings/page.tsx` is 3,502 lines, the longest file in `src/app`, and
it declares nine `SECTIONS` at `:100-111` navigated by chips at `:1857-1881`.
`src/app/runs/new/page.tsx` is 2,385 and `src/app/branches/page.tsx` is 1,656.
`proposals/GapRegister/01-frontend.md`'s F6 records that there is no field search
on the settings page, so an operator who knows a setting exists and cannot
remember which of nine sections holds it has no route to it except opening
sections.

`/settings` is also the install's most consequential page: the guards, the
enforcement mode, the model, the plugin set. Wrong reading there costs money.

## Ground 1: the app's own rules forbid it, by name

`docs/agent/ui-density-audit.md:1.2` lists ten things that may not be used, and
two of them are this option's mechanisms: **an accordion**, and **nested
disclosure**. `docs/agent/conventions.md` cites that document as the reasoning
behind the seven-affordance vocabulary and its caps, so this is a live invariant
and not a preference. `C2` states the standing here: it is argued against
explicitly or not at all.

And `§1.0` orders the moves: **Delete, Group, Reorder, Hide**, with the sentence
"Hiding is not the default fix for a crowded page." Option H is the fourth move
on a page where the first three have already been made.

## Ground 2: the repository has already done this pass, with a browser

`docs/agent/ui-density-audit.md` is 2,774 lines over every page in the app,
`:2599-2628` records that it eventually drove a real browser on a host dev server
with a seeded database, and `:2750-2753` lists eleven surfaces opened. It found
six things reading could not, and its recommendations were implemented: the
`docs/agent/conventions.md` invariants about the seven affordances, the caps
(seven peer cards, nine controls per card, one `primary`, three to nine rows per
group, five segments, one strip), and `ui/Disclosure` as the single sanctioned
`<details>`.

`proposals/GapRegister/06-recommendation.md` ranked settings findability **18 of
20**. Two independent passes over this interface have looked at the density of
`/settings` and neither concluded that more of it should be hidden.

## Ground 3: the evidence points the other way, and it is not close

`/workspace2/3 Resources/Web Design/Progressive Disclosure.md` (read in full)
traces the lineage:

> Carroll & Carrithers (1984, CACM) is the real study: **n = 12, six per group**,
> one word processor, one two-hour session. The training-wheels build made seven
> error states unreachable. … These experiments disable **functions** during
> **initial learning**. They say nothing about hiding **text** in a **card** for
> a **returning user**. Every modern citation crosses that boundary silently.

The only peer-reviewed HCI work naming progressive disclosure as its object,
Springer & Whittaker 2020, is largely a null: n = 74, preference split exactly
50/50 after use, no trust difference (p = .343), no cognitive-load difference
(p = .95). The only aggregation, Ginns, Hollender & Reimann 2006, is a conference
submission whose d = 1.12 the note flags as a red flag rather than a result.

And two studies point directly against hiding. SearchPilot (2020) exposed
ingredients and nutrition that had been behind tabs and accordions and got
**+12% organic sessions** with a reported 95% CI, which the note calls
"methodologically the strongest controlled test in this whole topic". Peytchev et
al. (2010, N = 2,708) made definitions always visible rather than roll-over and
raised consultation from 36 to 45% up to **60.7%**, shifting substantive answers
on 4 of 8 items.

The operator of this app is a **returning expert user of a text-dense
configuration page**, which is the population furthest from Carroll's twelve
novices in a two-hour session.

**One argument this survey deliberately does not make.** Hick's law is not cited
here in either direction.
`/workspace2/3 Resources/Web Design/Misapplied Laws in Interface Design.md`
(confidence high) records that Liu et al. (CHI 2020) are explicit that "visual
search in a hierarchical structure is logarithmic… but has nothing to do with
Hick's law", and that the popular use of Hick inverts its own finding. Finding a
setting is visual search. The applicable peer-reviewed result from that note is
Larson & Czerwinski (CHI '98): increased **depth** harmed search, with a medium
breadth/depth structure beating both the deepest and the broadest-shallowest.
Nine flat sections with a chip strip is a medium breadth structure. Disclosure
inside them adds depth, which is the direction that result says is worse.

## Ground 4: the diagnosis is wrong

The complaint is real and it is not density. It is **reachability**: no way to
get to a field by naming it. Hiding half the fields behind disclosures makes
reachability worse by one more click per field, on a page that already has no
search.

That gap has an owner. `proposals/GapRegister/01-frontend.md`'s F6 states it, F2
states the same mechanism for the app generally (quick open's corpus is two
lists, so it cannot find a chat, a branch, an agent, a template, a schedule or a
run past the hundredth), and
`proposals/GapRegister/06-recommendation.md` puts a reachability survey on its
list. A field search on `/settings` would close F6 and this option's real
content at once, and it is that survey's call and not this one's.

`grep -rn "beforeunload" src/` returning zero hits, which GapRegister F6 also
records, is the other thing about that page a person should look at. Neither is
about how much is visible.

## What would overturn this

An observation of the operator failing on `/settings` in a way that hiding would
fix: scrolling past the field they wanted, or acting on the wrong one because a
neighbouring field was mistaken for it. That is a specific, observable event, and
if it happens the right response is still probably `ui/Disclosure` on one named
group rather than a restructure, because `§1.2` forbids the accordion and the
nested case, not the single sanctioned `<details>`.

Absent that observation, Option H would spend a large change on a page nothing
renders in a test, against a live invariant, in the direction the only controlled
tests point away from.
