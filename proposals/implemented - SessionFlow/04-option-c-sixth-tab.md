# Option C — a sixth tab on the run page

The obvious fallback once [Option B](03-option-b-tenth-pane.md) is refused, and
the one the brief expected to be the other half of the fork. It is refused too,
on a cap that is stated in three places, and the fact that *both* named
placements are banned is the finding this proposal turns on.

## The strongest case for it

**It is where the subject lives.** The data is keyed on `run_id`
([F7](00-problem.md#f7)); the page is already the run's page; the split view's
pane is described as holding "what the run *produced*"
(`docs/agent/conventions.md:20`), which is exactly what a touch list is.

**The strip's own rules are already satisfied by this content.** From
`conventions.md:20`: "**A tab is offered only when there is something behind
it**" — a touch view can be offered only when the run has tool events, decidable
with one `COUNT(*)` on an indexed column (`idx_run_events_run(run_id, id)`,
`src/lib/db.ts:624-625`). "**Only the active tab is mounted**" — so it costs
nothing until opened. "**The log leads and nothing switches tabs on its own**" —
unaffected.

**And it composes with Changes rather than competing.** The reconciliation in
[F6](00-problem.md#f6) needs both `runDiff` and the tool events; a tab beside
Changes is where a reader would look for the second half of a comparison whose
first half they are already reading.

## Why it is refused

### 1. Five is the cap, stated as a cap

`docs/agent/conventions.md:50`, in the closed grouping vocabulary: a
`SegmentedControl` tab strip is "for two to five mutually exclusive views of one
subject, one strip per page". The strip has five
(`src/app/runs/[id]/page.tsx:958-970`). A sixth is over.

This is not a soft guideline in a style file. The same sentence closes an
enumeration whose preamble is "every feature that landed before it picked its own
answer and the answers did not compose", and whose companion list
(`ui-density-audit.md:157`) is prefaced "Each of these is a thing a build run
would plausibly reach for. None is allowed."

### 2. The strip is frozen by name in the density audit's own change list

`docs/agent/ui-density-audit.md:1121-1124`, under "**C12 — What does not
change**":

> - **The tab strip.** Five labels, the order, the conditions each is offered
>   under, the log leading, only the active tab mounted, and nothing switching
>   tabs on its own.

That is a *decision record from a pass that redesigned this exact page* — §C12 is
the list of things that survey deliberately left alone. "Five labels" is the
first two words of it.

### 3. It is at the cap on the common run, not the rare one

Five is conditional (`page.tsx:958-970`): `report` needs `cycles.length > 0`,
`review` and `land` need `isolated`. So a non-isolated run with no output shows
two segments and a sixth entry would be within the cap there. But an isolated run
that produced output — the case this feature is *for*, since the reconciliation
needs a branch to diff — shows all five. **The sixth label appears exactly on the
runs where the cap already binds.**

There is a width cost as well and it is measured elsewhere:
`docs/agent/conventions.md:34` records that `SegmentedControl` is an
`inline-flex` and "a five-option group is about 330px of segments against the
~358px a 390px phone has once the pane's gutter is off", which is why the
component carries `max-md:flex-wrap`. A sixth wraps on a phone. That is a
consequence rather than the reason, and the reason stands without it.

### 4. The two escapes are closed

- **A sub-strip inside Changes.** `docs/agent/ui-density-audit.md:178` bans "**A
  tab strip inside a tab.**"
- **Renaming Changes to something that covers both.** This is the strongest
  escape and it is not refused outright — see
  [09-option-h](09-option-h-reconciliation-table.md), which takes it. It is not
  a *sixth tab*, which is why it is a different option: it adds no segment.

## What this does not refuse

The content belonging on the run page is not in dispute. `conventions.md:20` puts
"what the run *produced*" in the pane, and a touch list is that. The refusal is
of the **strip gaining a segment**, and it leaves two ways to put the content on
that page: inside an existing tab ([09](09-option-h-reconciliation-table.md)) or
at a sub-route ([05](05-option-d-sub-route.md)).

## Verdict

**Refused.** Over a cap stated in the closed grouping vocabulary, and against a
freeze written into the density audit's own list of what a redesign of this page
deliberately did not change.

**Both placements the brief named are banned.** Neither is a close call and
neither was refused on taste. That is the fork resolved: the question is not
"pane or tab" but "which of the surfaces that are *not* banned", and
[05-option-d](05-option-d-sub-route.md) is the one the same paragraph that bans
the pane names as the replacement.
