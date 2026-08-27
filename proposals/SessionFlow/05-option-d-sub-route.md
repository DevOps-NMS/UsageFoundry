# Option D — a sub-route under Runs

`/runs/[id]/touched`. **The placement that survives**, and the one the invariant
banning the pane names as the replacement in the same paragraph.

## Why this is the sanctioned mechanism

`docs/agent/ui-density-audit.md:159-161`, the last sentence of the tenth-pane
ban:

> **New destinations are sub-routes under an existing pane.**

That is not a loophole. It is the rule's own instruction for what to do instead,
written by the person who closed the pane list.

## What it costs, exactly

**Routing: nothing.** `activePane` matches on a path *segment*
(`src/components/shell/panes.ts:48-56`), so `/runs/[id]/touched` already
highlights the Runs row and already answers ⌘3. The comment at `:44-47` records
that this was deliberate — "The boundary is a path segment, not a prefix.
`startsWith("/runs")` — which is what the top nav did — also matches a future
`/runsheet`."

**One entry in `toolbarTitle`.** `panes.ts:66-76` is an ordered list of
`if`s and currently ends `if (pathname.startsWith("/runs/")) return "Run";` at
`:68`. A more specific test goes above it. Without one the toolbar says "Run",
which is not wrong — the docblock at `:59-65` says "A dynamic route gets the name
of the *kind* of thing it shows" — so this is arguably zero work and certainly
not more than two lines.

**Precedent for depth exists**: `/workflows/[id]/instances/[instanceId]`
(`src/app/workflows/[id]/instances/[instanceId]/page.tsx`) is two levels deeper
than this and `toolbarTitle:73` handles it with one line.

**No icon.** `docs/agent/conventions.md:57`: "a new destination needs a glyph
here before it needs a row in `panes.ts`." A sub-route has no row, so no glyph.

## What it costs that nobody will put in the estimate

**It is unreachable except from the run page.** Quick open reads `panes.ts`,
`/api/runs` and `/api/workflows` (`docs/agent/conventions.md:29`) and would not
index this. So the sub-route needs a link *from* `/runs/[id]`, which means the
run page gains an affordance anyway — a link in the Changes tab's footer, or in
the inspector. **That link is most of the value of Option C without the sixth
segment**, and it is the honest reason this option is not obviously better than
putting the content inside an existing tab.

**It is a second page to keep in step.** `docs/agent/conventions.md:15` describes
the poll discipline every page here owes — "a poll stands down when its subject
can no longer move, and re-arming it is the half that has to be designed" — with
three named edges. A sub-route showing a live run's touches inherits all of it,
or declines to poll and says so.

**It splits one reading across two screens.** The reconciliation
([F6](00-problem.md#f6)) compares tool events against the branch diff. Putting
half of that comparison on another route means an operator navigating back and
forth to compare two lists, which is the thing a reconciliation view exists to
prevent.

## When this is the right answer

If the content grows past what fits beside a diff. A file × cycle grid
([08-option-g](08-option-g-cycle-heatmap.md)), a delegation tree
([07-option-f](07-option-f-delegation-tree.md)) and a reconciliation table
([09-option-h](09-option-h-reconciliation-table.md)) together are a screen's
worth, and `docs/agent/conventions.md:50` allows "a **sub-route** for a group
that is both a screen's worth and used weekly or less".

**That is the test, and it has two clauses.** A single reconciliation table is
not a screen's worth. Three views might be. So this option is *correct at the
second step and premature at the first* — which is what
[12-recommendation.md](12-recommendation.md) does with it.

## Verdict

**Recommended as the placement, deferred as the first move.** It is the only
placement not banned by an invariant, it costs one line of routing, and it is
where this goes if it grows. It is not where a single table starts, because a
sub-route holding one table is a destination an operator has to learn in order to
read something that would have fitted where they already were.
