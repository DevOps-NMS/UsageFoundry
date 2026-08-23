# Comparison

A weighted table is a summary of arguments made in full in the option files, not
a substitute for them. It is here because the options differ on several axes at
once and the ranking is not obvious by inspection. Where a score is the one a
reader should challenge first, this file says so.

## The criteria, and why each is weighted as it is

| # | Criterion | Weight | Why |
|---|---|---|---|
| 1 | **Unique measured failure closed** | 5 | `C7` removes the legal argument, so the only entitlement this survey has is that a number below a published threshold is evidence about reading. Scored on *marginal* contribution, because these options are being chosen among: an option whose content is another option's is worth its difference, not its total. |
| 2 | **Contradicts a documented invariant** | 5 | `CLAUDE.md` says nearly every invariant here fails **silently** and that they encode the product's reasoning rather than style. `C2` sets the standing: argued against explicitly with new evidence, or not at all. Equal weight to closing a failure, because trading a silent failure for a silent failure is not progress. |
| 3 | **Risk of silent regression** | 4 | `C10`: 16,529 lines of page code, zero rendered by any test, no browser in the container where the work happens. Below the invariants only because an invariant violation is a *certain* silent failure and this is a risk of one. |
| 4 | **Cost to the operator's reading** | 4 | There is one reader and the app's job is to be read. An option that trades legibility for a conformance number is a net loss, and `C8` means the number is a convention rather than a measurement of harm. |
| 5 | **Blast radius** | 3 | Distinct from criterion 3: a change can reach hundreds of call sites and still be safe (a hex value) or reach nine and be dangerous (a heading level). Weighted below regression risk because reach is only a multiplier on it. |
| 6 | **Dependency and tooling cost** | 3 | `C5`: 4 runtime and 8 dev dependencies, no linter, and `CLAUDE.md` states the absence as a fact. Real, and weighted **below** the invariants deliberately: `package.json` is a decision that can be revisited on evidence, an invariant is one that encodes correctness. |
| 7 | **Reversibility** | 2 | Lowest, because everything here is in git and the container rebuilds. It discriminates only between a hex value and a restructure, which criterion 5 mostly already captures. |

Total weight 26, so the ceiling is 130. Scores are 1 to 5 with 5 best, including
for the negative criteria (5 means "contradicts nothing", 5 means "no dependency").

## The table

| Option | 1 Closes | 2 Invariants | 3 Regression | 4 Reading | 5 Radius | 6 Deps | 7 Reverse | **Total** |
|---|---|---|---|---|---|---|---|---|
| **B** token and contrast repair | 5 | 5 | 3 | 4 | 3 | 5 | 5 | **112** |
| **D** contrast floor in `node --test` | 3 | 5 | 4 | 3 | 5 | 5 | 5 | **108** |
| **C** keyboard and focus pass | 1 | 5 | 5 | 3 | 5 | 5 | 5 | **107** |
| **I** narrow viewport | 1 | 5 | 5 | 3 | 5 | 5 | 5 | **102** |
| **A** change nothing | 1 | 5 | 5 | 2 | 5 | 5 | 5 | **98** |
| **G** document outline (G1) | 2 | 4 | 4 | 3 | 4 | 5 | 5 | **95** |
| **E** axe in CI | 2 | 3 | 4 | 3 | 2 | 1 | 4 | **70** |
| **F** raise the type scale | 2 | 2 | 1 | 2 | 1 | 5 | 3 | **56** |
| **H** progressive disclosure | 1 | 1 | 1 | 1 | 1 | 5 | 2 | **40** |

## What the table gets right

**The top and the bottom.** B closes four measured failures inside the one
property `C1` leaves open, for the price of six hex values and a dozen class
strings, with no dependency and every edit reversible in one line. H contradicts
two named prohibitions in `docs/agent/ui-density-audit.md:1.2`, restructures the
longest file in `src/app`, and moves in the direction the only two controlled
tests point away from. Those are 72 points apart and the gap is not an artefact.

**That F loses despite having the better science.** `07-option-f` makes the case
at full strength: Legge & Bigelow's critical print size is angular, the app's
body text computes to 0.12° to 0.19° of x-height under stated assumptions, and
that is at or below the line where reading speed stops being flat. It still
scores 56, because the change reflows every layout in an app where nothing
renders in a test, `globals.css:707-711` already refused it in writing with
reasons that are still true, and the instrument the reader already has (browser
zoom) is strictly better than the one F would build. **Good evidence for a claim
is not the same as good evidence for a change.**

## Where the table is misleading, stated rather than left to be found

**Three options score high for being harmless.** C at 107, I at 102 and A at 98
are all within nine points of D, and none of them does anything. C's content is
`B1` and nothing else; I is `docs/verification.md`'s open item and belongs to it;
A is the null. A weighted table rewards not breaking things, and on criteria 2, 3,
5, 6 and 7 the null option scores a perfect 5 by construction. **Read column 1
first.** The honest ranking of "options that change the app" is B, then G1, then
E, then F, then H.

**D's score depends entirely on B.** `05-option-d` says it: a contrast floor
asserted over today's tokens pins four failures and converts them from an
unmeasured default into a written intention, which is worse than no test. D is
scored here as it would be *after* B. Taken alone it belongs below A.

**B's regression risk at 3 is the score to challenge.** It is the only number in
the table where the survey is guessing. The three kit components B2 touches reach
192 rendered strings across sixteen pages, and no test renders any of them. The
grounds for 3 rather than 2 are that every edit is a colour or a class string with
no geometry in it, so the failure mode is "something looks slightly different",
not "something breaks". If that reasoning is wrong, B drops to 108 and ties D,
and the recommendation is unchanged because the recommendation is both.

**G's whole row is an inference from markup.** Every other row rests on
arithmetic or a `grep`. G rests on what an unheard screen reader would announce,
which is why `08-option-g` ends as a question rather than a change, and why its 2
in column 1 should be read as "unknown, plausibly 3, possibly 0".

**E's 1 for dependency cost is the load-bearing score in its row.** It is not
"add axe-core"; it is add axe-core plus either jsdom, which cannot resolve
`light-dark()` inside `color-mix()` and therefore reports `incomplete` on exactly
the four findings this survey measured, or a browser and a running app in CI, on a
project whose `README.md:967-980` says CI never starts the container. Change that
one score to 4, as landing a rendering harness for other reasons would, and E
goes to 79 and becomes the obvious next thing after B and D.
