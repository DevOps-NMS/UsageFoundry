# Option B — a default per install, per kind of child

Keep the decision install-wide and stop asking one string to answer for four
kinds of `claude` child. `settings.defaultModel` stays; beside it go a default
for the reviewer and resolver and a default for the chat and orchestrator turn,
each read at the site that already reads a model independently.

## The strongest case, first

**The code has already reached this conclusion once and implemented half of it
by accident.** There are three read sites, not one: a work cycle takes
`run.model` (`src/lib/orchestrator.ts:4843`), a review and a conflict resolution
take the same column at a different spawn (`src/lib/review.ts:624`), and the
chat turn and a workflow block's deciding turn **skip the run entirely** and
read the setting (`src/lib/chat.ts:1699`). That last line is the argument:
somebody already decided that one of these four children is not the run's
decision, and wrote it down as a different read rather than as a different
setting.

**And it is the only option that changes what a non-run child costs.** A review,
a conflict resolution and a chat turn are not runs, have no `BudgetPolicy` and
are not put through `evaluateBudget` (`src/lib/review.ts:457`–`463`); their
model comes from a decision made for something else entirely. This is the one
shape in the survey that lets an operator say "reviews are cheap" without saying
anything about the work.

**And it costs nothing to reverse.** Two nullable settings keys, null in
`DEFAULTS`, behaving exactly as today until somebody types in one of them.
Nothing is stored on a run, nothing is stored on a template, and no record
changes meaning.

## Shape

`settings.ts` gains two keys beside `defaultModel` (`:86`, default `null` at
`:611`) and `DEFAULTS` gains their nulls. `review.ts:624` stops reading
`run.model` and reads the review default, falling back to `run.model` and then
to nothing. `chat.ts:1699` reads its own. `createRun` is untouched: `runs.model`
keeps meaning "what a work cycle runs on", which is what `buildArgs` uses it for
and what `run_reviews.model` already records separately for a review
(`src/lib/db.ts:218`).

The Settings page gains two rows in the Runs section
(`src/app/settings/page.tsx:2223`–`2249`) — or one row in Runs and one wherever
the chat's own settings live. No schema change, no migration, no new record and
no new route.

## Which half of the split

The "what a person wrote" half, unambiguously: it is the same settings object
`chatDefaultGuards` lives on (`src/lib/settings.ts:477`), saved through the same
`PUT /api/settings`, by the same operator.

But note what it is **not**: it is not inside `RunGuards`
(`src/lib/settings.ts:489`–`:493`). Putting a model there would make it one of
the three fields a template, a chat proposal and a workflow node all resolve
from, which is Option C's problem and is not bought here. This option leaves the
model exactly where it is in the taxonomy — a fourth thing on `CreateRunInput`,
plus two siblings that never touch a run at all.

## When the decision is taken

For the cycle default, at `createRun`'s INSERT, synchronously, unchanged
(`src/lib/orchestrator.ts:3205`), inside the no-`await` region
(`docs/agent/concurrency-and-ownership.md:10`).

For the review and chat defaults, at the spawn — both already outside
`createRun`, both already reading `getSettings()` at the moment of the spawn.
Neither is a frozen read, so a Settings edit reaches the next review
immediately. That asymmetry is real and should be stated on the page: a work
cycle's model is frozen per run, a review's is not.

## The measured precedence

Unchanged in mechanism and therefore unchanged in consequence: any of these
boxes with text in it puts an explicit `--model` on that child's argv, and an
explicit `--model` outranks a selected agent's pin (`src/lib/agents.ts:99`–
`110`). Filling three boxes makes `SavedAgent.model` unreachable on three paths
instead of one.

Fill-only-the-gap is available and is the honest default for the two new keys:
leave them null and the behaviour is exactly today's. That is the shape this
option should ship in — new keys that are null in `DEFAULTS`, so a stock install
is bit-for-bit the current one.

## What the operator sees and controls

Two or three text boxes where there is one, in a place they already look. The
Settings page is where model choice becomes a subject a person reasons about by
kind: an unattended reviewer reading a diff is not a work cycle editing a
repository for an hour.

Two obligations come with it. `saveSettings` stores only what differs from
`DEFAULTS` (`src/lib/settings.ts:693`–`:706`), and that is a correctness
decision rather than a size one (`docs/agent/conventions.md:14`) — the new keys
must go through the same loop, not be written out whole. And the read-back
problem is untouched: `RunDTO.model` still renders on no page
(`src/lib/apiTypes.ts:559`), so an operator still cannot see which of three
boxes produced what a given run ran on. This option makes that harder rather
than easier, because there are now three boxes to have been wrong about.

## Guards, and the three cost sources

No new reader of any source. The check order is untouched
(`docs/agent/budgets-and-guards.md:32`). A review's cost stays in
`run_reviews.cost_usd` and out of `runs.spent_usd` (`src/lib/db.ts:206`–`211`),
so a cheaper reviewer moves a figure that was already reported apart from the
run's — which is the quiet reason this option is safe: the child whose model it
newly controls is the one whose spend the app already keeps separate.

## When the pricing table cannot place the model

The existing exposure, multiplied by the number of boxes, and the consequence
differs by box in a way that is worth writing on the page rather than
discovering:

- A bad **cycle** string charges $10/$50 into `spentGuardUSD`, which is what
  `--max-budget-usd` is derived from (`src/lib/orchestrator.ts:4880`–`4882`), so
  the run is stopped early at a limit its dashboard figure has not reached.
- A bad **review** string reaches no per-run limit at all — a review has no
  `BudgetPolicy` and is not put through `evaluateBudget`
  (`src/lib/review.ts:457`–`463`) — but it does reach `windowRefusal`, which
  reads `guardFraction` for exactly this reason (`:465`–`467`), so an unpriced
  reviewer makes the window it is measured against fill faster.
- A bad **chat** string reaches the per-turn `--max-budget-usd`
  (`src/lib/chat.ts:1699`–`1704`; `chatTurnBudgetUSD` in
  `docs/agent/budgets-and-guards.md:30`).

None of the three may be narrowed to a list this build knows
(`src/lib/agents.ts:116`–`119`). `isKnownModel` as an inline warning at the box
(`src/lib/pricing.ts:135`, no call site today) is the whole of what is
admissible, and it must stay a warning.

## How it fails, and whether loudly

**Silent:** drift between three boxes nobody reads back — which is
`src/lib/templates.ts:35`–`42`'s objection to a second place, arriving inside
one settings page instead of across two records. Three places to set one thing
is how they drift, and two of the three are the ones nobody remembers to check.

**Loud:** a string the CLI refuses fails the spawn of that kind of child only.
An install can then have every work cycle running and every review failing, each
with a non-zero exit and a message — loud per child, and easy to read as "the
reviewer is broken" rather than "somebody typed into the wrong box".

## What it costs to build

The smallest of the options that change behaviour. Two settings keys and their
`DEFAULTS` nulls, two read sites, two rows on a page, the `saveSettings` loop
already handles them, and the copy edits `01-constraints.md` asks for. Roughly a
day, and no schema, no migration, no new test surface beyond what `settings.ts`
already has.

## What would have to be true for this to be the right answer

That the **kind of child** is the axis that explains the money. The measurement
is largely against it: the three children this option newly reaches are the
cheap ones. `00-problem.md`'s $488.24 is sub-agent turns, which none of these
boxes touches, and its $3,592.72 is main-thread work-cycle spend, which this
option controls with exactly the string that controls it today.

What it does answer, cheaply and without overturning anything, is the narrower
complaint: one string is the wrong shape when the code already has three read
sites for it. If the decision is that the model should stay a per-install
setting and the only defect is that there is one of them, this is the whole fix.

The experiment that would raise or sink it: split the week's spend by kind of
child rather than by model. `run_reviews.cost_usd` and `chat_sessions.cost_usd`
hold it directly, and both live in the database that is unreadable from a work
cycle (`00-problem.md`) — so it is a reading an operator takes, not one this
proposal can take.
