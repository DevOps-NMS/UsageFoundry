# Option B — a tenth pane, as asked for

**This is the literal request** and it is refused. The refusal is written out at
length because overruling an operator on the one part of their sentence that was
unambiguous deserves more than a citation.

## The strongest case for it

It is not weak, and three arguments carry real weight.

**The operator asked for it, in the one clause with no ambiguity in it.** "A new
tab on the left" names a specific surface. Everything else in the sentence needed
interpretation; this did not. An install's operator is the person who reads these
screens every day and their sense of where a thing belongs is evidence.

**The precedent for waiving the ban exists and is documented.**
`docs/agent/ui-density-audit.md:163-170` records that the same ban read "a ninth
pane" until `/knowledge` was built, and that the ninth was **allowed**. So this
is not an invariant that has never bent. It bent once, deliberately, and the
grounds are written down.

**A ninth row is genuinely cheap in code.** `panes.ts:26-39` is one array;
`activePane` matches on a path segment (`:48-56`) and needs nothing; the icon set
"covers the nine panes" (`docs/agent/conventions.md:57`) and would need one more
glyph, which the same sentence says is the order of operations — "a new
destination needs a glyph here before it needs a row in `panes.ts`."

## Why it is refused anyway

### 1. The ceiling is the digit, and there is no tenth digit

`docs/agent/ui-density-audit.md:159-161`:

> **A tenth pane.** `panes.ts` is nine rows bound to ⌘1–⌘9 and four readers
> (`panes.ts:3-16`). A tenth destination has no digit.

`panes.ts:15-16` gives the failure mode: "a row without one is a row two of the
four readers cannot describe." The four readers are the sidebar, the toolbar
title, the shortcut handler and quick open (`panes.ts:6-10`).

The `/knowledge` waiver **turned on this exact fact and said so**: "The ban's
whole ground was the digit […] and nine rows still have one, so the ninth was
allowed and the sentence moved up by one rather than being waived. Ten is where
it stops, and there it stops for the reason it always gave"
(`ui-density-audit.md:163-166`). The precedent is not a precedent for bending
the rule. It is a precedent for the rule being applied and coming out the other
way once, on a ground that is now exhausted.

`docs/agent/conventions.md:29` names the alternatives and closes them:
`isPlainCommandChord` "refuses Ctrl as an alias for ⌘ (on Windows and Linux,
Ctrl+1…9 switches browser tab and Ctrl+K is the address bar) and refuses ⌥ and
⇧, which make other people's chords." So ⌘0, ⌥1 and ⇧⌘1 are all unavailable by
a decision one layer down, and ⌘0 is a browser zoom reset besides.

### 2. It fails the `/knowledge` test on its own terms

The waiver's second half is the test, `ui-density-audit.md:167-170`:

> `/knowledge` earned a row rather than a sub-route because it is not *about* any
> existing pane: a vault is neither a run, a workflow nor a setting, and filing
> it under Settings would have made a destination out of a configuration page.

A session flow view **is about a run**. Its subject is `runs.id`; its data is
`run_events` keyed on `run_id` ([F7](00-problem.md#f7)); its natural route
carries a run id in the path. It is the most *about-an-existing-pane* thing that
could be proposed. It fails the test in the same sentence that granted the last
exception.

### 3. The destination has nothing to show when you arrive

A pane is a top-level destination reached by ⌘N from anywhere. Press it and the
question is "flow of *what*?" — because the data is per-run and the operator has
not chosen a run. The pane would open on a run picker, which is `/runs`
(⌘3) with one extra click, or on the newest run, which is a guess. `panes.ts:66-76`
shows `toolbarTitle` giving "a dynamic route the name of the *kind* of thing it
shows"; a pane whose content is always about some other pane's row is a
sub-route wearing a digit.

### 4. The renumbering cost is real and was mispaid last time

`panes.ts:11-14`: "inserting a pane renumbers the ones under it." Adding a row
above Settings moves ⌘9. Adding one below moves nothing but has no digit.

And the last renumbering was not clean. Per
[C1](01-constraints.md#c1-a-tenth-pane-is-banned-by-name-with-the-precedent-that-shows-when-an-exception-was-granted):
`panes.ts:15-16` still says "Knowledge is the ninth" when Knowledge is the
seventh (`panes.ts:36`, `shortcut: "7"`) and Settings is the ninth
(`panes.ts:38`); and `docs/agent/conventions.md:50` still says the list is
"closed at eight" and still bans "a ninth pane" while `conventions.md:57` in the
same file counts nine. **Three documents describe this ceiling and two are wrong
in a detail, because the last move through it left them behind.** That is not an
argument against ever moving it again, but it is a real, measured cost of doing
so, and it lands on the four readers the constraint exists to protect.

## The cost of overruling the operator, stated plainly

They asked for one thing precisely and are not getting it. What they lose:

- **A ⌘-digit.** Real; there is no substitute and the sub-route
  ([05-option-d](05-option-d-sub-route.md)) has no shortcut of its own.
- **Reachability from anywhere.** A sub-route is reached by opening a run first.
  For a per-run view that is the correct number of steps, but it is one more than
  a pane.
- **Visibility.** A row in the sidebar is seen by an operator who was not looking
  for it. A sub-route is found by someone who already suspects it exists. This is
  the honest loss and nothing offsets it — [GapRegister](../GapRegister/)'s
  reachability finding is the same complaint from the other side, and quick open
  reads `panes.ts` and `/api/runs` and would not index a sub-route
  (`docs/agent/conventions.md:29`).

**If the operator overrules this after reading it, the change is one array entry,
one icon and three documentation corrections** — and the corrections are the part
that must not be skipped, because C1's own history is what happens when they are.

## Verdict

**Refused.** It violates a ban that names it, fails the test that granted the
only exception to that ban, and its subject is per-run data that a top-level
destination cannot address without picking a run first.
