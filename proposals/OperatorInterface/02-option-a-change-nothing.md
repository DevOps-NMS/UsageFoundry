# Option A: change nothing

The option that has to be beaten, and it is stronger here than it usually is.

## The case

**Nobody is failing.** There is one reader. They built it, they read it every
day, and there is no report of a legibility problem anywhere in the repository:
`docs/verification.md` records what has been measured and its "Not yet verified
by hand" list carries narrow-viewport entries, iOS zoom and a `--keyboard-inset`
return, not a word about text being hard to read. The strongest evidence in any
interface argument is a reader who could not do something, and this survey has
none.

**The measurement is not a measurement of harm.** `00-problem.md`'s numbers are
arithmetic on declared hex values, and `01-constraints.md`'s C8 records what the
vault says about the threshold they are compared against: the 4.5:1 figure's
usual citation is a one-page meeting abstract whose only 1.5 is a
log-contrast-sensitivity intercept, the WCAG issue asking for the derivation was
closed without one, the proposed replacement has no completed
human-participant validation, and WCAG 3.0's March 2026 draft names no
text-contrast requirement at all. A ratio below 4.5 is a ratio below a
convention. It is not a report that anything was misread.

**The legal argument does not exist.** C7: outside the EAA by two independent
routes, and microenterprise-exempt regardless. There is no deadline, no auditor,
and no procurement questionnaire.

**The app is already better than the corpus.** 29.6% of its declared pairings
fail against a published 40.9%, and it is not in the compliant 20.4%. That is a
middle-of-the-distribution position on a criterion with contested thresholds, for
an internal tool with one user.

**Every repair spends the scarcest thing this repository has.** C10: 16,529
lines of page code, zero of it rendered by any test. A change to `--ring`,
`--fg-faint` or `Card`'s `Empty` reaches hundreds of call sites and is verified
by a human opening a browser or not at all, and there is no browser in the
container where the work would happen. Option A is the only option with a zero
regression risk, and on a codebase whose own `CLAUDE.md` says its invariants fail
*silently*, that is worth more than it sounds.

**And the last person to survey this interface end to end declined to go here.**
`docs/agent/ui-density-audit.md` is 2,774 lines over every page, and
`grep -ic contrast` returns 0. That could be an oversight. It could also be a
correctly scoped document by someone who knew there was no browser and stuck to
what source can settle. §0.1:45-47 reads like the second.

## Why it loses

Four things, and only the first two are decisive.

**The `Empty` state is the first text a new reader reads, and it is the app's
least legible.** `src/components/ui/Card.tsx:117` renders it at 13px, 3.62:1 on a
card. 44 call sites. The brief's question is about "a reader who is not the
person who built it", and the surface designed *specifically* for a reader who
does not yet know what a page holds is the one routed into the third text
weight. That is not a taste judgement; it is a structural mismatch between where
the app puts explanation and where the app puts its weakest colour, and it holds
whatever one thinks of 4.5:1.

**The focus ring costs one line and one number.** C1 says the ring's colour is
the one thing a component may change and the one thing the base layer states, so
the repair is `45%` becoming `75%` at `src/app/globals.css:112-113`. The
regression argument that carries the rest of Option A does not apply to a change
whose entire reach is "the focus ring is more visible", in an app where the only
way to operate a run without a mouse is to see where focus is. Declining a
one-token change with no layout consequence is not caution, it is inertia.

**The arithmetic now exists, so leaving it is a decision.** Before this survey,
"nobody has computed the contrast" was true and blameless. `contrast.py` is 190
lines with no dependencies and it runs in under a second. After it, choosing not
to act is a recorded choice with numbers next to it, which is a different thing
from an omission and ages differently.

**Two of the app's own rules are being broken and nobody noticed.** Finding 6:
one `title` tooltip at `src/app/branches/page.tsx:335-340` carrying the
definition of a dollar figure, after `docs/agent/ui-density-audit.md:2687-2694`
deleted six others on the grounds that a tooltip has no touch equivalent; and one
`onClick` on a `<div>` at `src/app/knowledge/page.tsx:390`. Option A keeps both.
Neither is important. Both are five lines. An option that cannot pick up two
five-line fixes to its own documented invariants is not really an option about
cost.

## What would make Option A right

If the ring repair, tested, turned out to look wrong: a 75% ring is a nearly
solid 2px outline where a 45% one is a halo, and `globals.css:92-97` shows this
palette is deliberately imitating AppKit, whose focus ring is a soft glow. If
that reads as loud to the one person who has to look at it all day, the
conformance number is not worth it and Option A wins on findings 2 through 6,
with only finding 1's call sites left standing. **That is a browser question and
this survey cannot answer it**, which is why `13-validation.md` puts it first.
