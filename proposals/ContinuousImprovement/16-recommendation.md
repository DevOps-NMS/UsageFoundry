# Recommendation

Eleven options for stopping a run re-deriving what an earlier run already
established. Two of them reach no run at all and are the two worth building
first, one of them is worth building beside them because it is nearly free and
because it is the only actuator whose shape has already been observed working on
this install, and five are refused by name on arithmetic taken from the install's
own database.

## The recommendation, stated once

**Build the readout — Option A, with Option F's contention card as its third
reading — and ship Option C, the prior-read pointer, in the same change, behind
`03-experiment-holdout.md`'s deterministic 50% holdout so that the readout
measures the pointer.** Fold Option B's `ending_code` column into that change —
not because any reading needs it, which `04-option-see-it.md` does not claim, but
because it costs one `addColumn` line and it is the selector the holdout's
outcome measures want.

**Hold Option D, the gate hook, until the holdout has separated position from
content.** Ship its two visibility repairs immediately regardless, because a
hook that fires today leaves no trace on the run's own log and that is a defect
independent of this question.

**Refuse Options E, G, H, I and J by name.** Option K's system-prompt half shipped
at `ee93684` while this survey was being written; its remaining question is a
budget-guard question and belongs to `docs/agent/budgets-and-guards.md` rather
than to this survey.

Nothing above needs a fourth store, a fourth retention horizon, a fourth arm on
`StorageReport`, a new MCP tool definition, a billed model, or a single byte
written into any mounted folder.

## First, the prize, stated the way the measurement allows

**The reading half is large, reproduces on five independent folders, and is
about half as big as it first looks.** 4,284 of 5,856 `Read` calls (73.2%)
are of a path an earlier run on the same repository had already read; 2,168 of
those (50.6%) are files the same run then edits, which nothing in this survey
displaces. The addressable share is **36.1% of all reading**, before anything is
said about whether telling a run where to look makes it read less — and
`01-constraints.md`'s arithmetic table's `d`, the share of aimed-at reading a
pointer actually removes, **does not exist anywhere in this repository**.
Orientation is priced at 20.9% of this folder's OTLP-reported spend, and the
median run makes 29 tool calls before its first edit.

**The mistake half is measured near-empty as this install is configured.** One
`needs-review` and one non-zero `exit_code` in 294 runs. The finest-grained
signal, `tool_error`, is 538 rows of which 214 are a single environment fault
across ten runs — and the answer that shipped for it was a classifier and a log
line (`src/lib/sandbox.ts:142`, `src/lib/logLine.ts:337`). **The largest
repeated cross-run mistake this install has ever made was solved by seeing it,
not by remembering it.** That is the strongest argument in this survey and it is
the codebase's own.

**And the one repeated failure with real volume turned out not to be a memory
problem.** 112 runs edited `src/lib/`; eleven read the doc the gate names. But
`continuedWorkNotice`, generated text in the same message in the same position,
was obeyed by **66 of 66** runs that received it, and 56 of them ran the exact
`git diff --stat <base>...HEAD` form it prints against **7 of a matched control
of 175** — a **21×** lift on the specific command form, against a behaviour lift
of only 1.1× on running any `git log` at all. Both texts arrive identically. One
is obeyed universally and one is declined nine times in ten.

**Compliance tracks the cost of complying, not the position of the sentence.**
Running one git command is cheap; reading a 63,394-byte document before starting
is not. That is the single most useful thing this survey found, and it is why
the recommendation is shaped the way it is.

## Why the pointer, and why not the gate

Option C is the same shape as the notice that already works: **generated,
per-repository, specific, and cheap to comply with**. It names files by path;
opening one is a single tool call. Its ranking is the only mechanism claim in
this survey that is already measured — 45.0% prequential coverage of a new run's
opening eight `Read` calls at top-20 with a ×0.9-per-run decay, against 42.3%
for raw frequency and 39.2% for distinct-run counts, so recency beats volume and
the design decision is settled by the data rather than by argument.

It costs about **$0.029 a run**, $8.45 across the whole 294-run corpus,
against $4,303.70 of measured spend. That is small enough that finding out
whether it works is cheaper than continuing to argue about it — which is the
whole case for shipping it behind the holdout rather than after the readout.

Option D is the stronger idea and rests on the weaker premise. It fires at the
moment of the edit rather than 29 tool calls earlier, costs nothing on runs where
it never fires, and rides the one channel measured to survive `--resume`. But it
was designed around the hypothesis that the gate is declined **because of where
it sits**, and `15-comparison.md`'s 21× result is direct evidence against that
hypothesis. If compliance tracks the cost of complying, then moving the same
"go and read `conventions.md`" sentence to a later position changes nothing, and
D's real value is a different and smaller one: it can name the *specific* doc for
the *specific* file just edited, which is a cheaper ask than the gate list.

That is a good idea. It is not the idea D was built on, and it should be built
only once the holdout says which of the two is true.

## Five repairs owed whichever way the question goes

Every one of these was found while looking for something else, and every one is
independent of whether any option ships.

**`runs.repo_root` is not a repository field.** It is written only where
isolation resolved to a worktree, so 243 runs carry one and 51 do not — and
those 51 carry **$645.28**, which `groupRunSpend` currently collapses into a
single `(not a repository)` bucket alongside two unrelated directories. Every
per-repository reading in this survey inherits that defect, and so does the
`repoSpend` card that already ships.

**Twenty runs finished and the row says they did not.** `stop_reason = 'Agent
reported the task complete.'` with `reported_done = 0`, because the column was
added `INTEGER NOT NULL DEFAULT 0` and its own comment says rows written before
it carry the default. Anything counting successful runs on this install is
currently wrong by twenty.

**`priorWorkNotice` has never been delivered.** Zero of 500 `iteration` prompts
carry its text (`src/lib/orchestrator.ts:4417`). It has been in the tree since
`8962e9a`, whose subject — "Keep a run's session, so picking it up continues
instead of restarting" — is the reason: the change that made pick-up resume a
session removed the only path that reached the session-less branch with prior
cycles. A generated notice nobody has ever seen is either dead code or a bug,
and which one it is is a decision somebody should take deliberately.

**A hook that fires is invisible.** `--include-hook-events` appears nowhere in
`src/`, while `src/lib/orchestrator.ts` carries a block whose job is to log what
a hook injected — and that block's test names only `SessionStart` and
`UserPromptSubmit`, so a `PostToolUse` injection would fall through even with
the flag. Two repairs, both prerequisites for Option D and both worth having
without it.

**The prompt a cycle was sent is persisted and never rendered.** `describeEvent`
reads `p.n` and `p.resuming` and prints "Work cycle N". An operator cannot audit,
correct or distrust a memory they cannot read, so this is a prerequisite for
every injection option — and, per `03-experiment-holdout.md`, it is also the
half of the experiment that is already free.

## The fact that would overturn it

**Run the holdout and find that Option C's block is declined the way the gate
was.** If runs that receive a named list of files open them no more often than
runs that do not, then the 21× result is a property of git commands rather than
of generated text, no injected pointer works on this install, and the whole
answer collapses to the two readouts plus Option F's card. `03-experiment-holdout.md`
puts the compliance half at zero marginal cost — 1,014 (cycle, named path) pairs
are already queryable from evidence the app persists — and at roughly 27 runs a
day a 50% holdout separates a difference of that size in about a fortnight.

The second fact, and the one that would move more money: **measure `d`.**
Compliance is not displacement. A run that opens the four files it was pointed at
*and then reads everything else anyway* has complied and saved nothing. Nothing
in this repository measures `d`, no option supplies it, and until it exists the
cost-saving half of the original question has no derived answer — only a bounded
opportunity of 36.1% of reading and an orientation phase priced at 20.9% of
spend.

## The runner-up, and what would make it win

**Option D, the gate hook.** It wins if the holdout shows that Option C's
pointer is complied with but does not displace — that runs read the named files
*in addition to* everything they were going to read. That result would say
orientation is not steerable in advance and the only useful moment is the moment
of the edit, which is exactly what D acts on. It would also need its two
visibility repairs first, and a fourth for `sandboxArgs`: composing a hooks
payload into that function ships it nowhere, because it returns `[]` on
`arrangement === "none"`, which is every stock install.

## Rejected by name

**Option G, the automatic retrospective.** It spends $535–$1,188 — 12.4–27.6% of
this install's eleven-day bill — before any lesson reaches any run, has no
delivery channel of its own, cannot see the reasoning it would need because
thinking is dropped by name, learns from a corpus with two instances in it, and
is refused in as many words by the docblock of the module it would live in:
"Neither is ever automatic. Both cost money, and spend nobody asked for is spend
nobody authorised" (`src/lib/review.ts:34`–`:35`). A **manual** button on a
finished run is refused by none of that and costs $1.82 a press; if anybody wants
this shape, that is the one to build.

**Option H, the sha-gated repository brief.** Of 120 lands on this repository in
the window, 20 produced a HEAD that any later run started on. A hundred briefs in
a hundred and twenty would be written, billed and never opened, and the
alternative — serving one stale — is the only failure mode in this survey that
is *wrong* rather than merely expensive.

**Option I, the run-scoped MCP tool.** $8.14–$8.26 per tool definition per week,
standing, before a single call, against a break-even of 58–59 substitutions a
week. Measured demand for the voluntary read-only surface this install already
grants: 51 `Grep`/`Glob` calls in the whole corpus, 47 of them on the day
`SEARCH_TOOLS` landed, and **zero across the 1,093 tool calls of the two days
since**. It would also require `--mcp-config` on a work-cycle argv, which
without `--strict-mcp-config` admits every MCP server in the shared `~/.claude`
into every run — silently, because the run still works.

**Option J, the agent-maintained `CLAUDE.md`.** Negative money, derived: every
write is a repository change, `gitStatus` sits in the CLI's own `sys[2]` block
ahead of the only breakpoint that matters, and no handover whose previous cycle
changed nothing has ever re-written the prefix. And it multiplies writers on the
file that already carries **$201.45 of the $238.20** this install has paid to
resolve conflicts — 84.6%, at a mean of $4.38 against the all-file mean of
$4.04, with all eight *failed* resolutions naming it. The version that survives
is Option H's shape, where the server writes the file and no run edits it, and
Option H is refused on other grounds.

**Option E, the operator's per-repository note.** Not refused on harm — refused
because its own file measured that it cannot work: moving the operator's text
from the mount's `CLAUDE.md` into `DATA_DIR` changes neither its position nor its
content, and `15-comparison.md`'s result says content is what compliance tracks.
Its one real property, that a run cannot rewrite the instructions the next run
gets, is worth keeping in mind the moment anything model-written is proposed
again.

## What a person would have to accept to overrule this

To build an actuator first, somebody has to accept that a mechanism whose
displacement is unmeasured should be shipped ahead of the instrument that would
measure it — and to do that in a repository whose immediately preceding survey
closed on exactly the opposite conclusion for exactly this reason. That is a
defensible position if the belief is that the readouts will take months to be
acted on; it is not defensible on the numbers.

To build a *store* first — G, H, or a lessons table — somebody has to accept
paying a billed model on every run to mine a corpus with two instances in it,
and to accept a fourth retention horizon for text that has no retirement
mechanism. Nobody in this survey found an argument for that, and
`10-option-retrospective.md` gives the strongest version of it that exists.

## What this recommendation does not claim

It does not claim the pointer saves money. It claims the pointer is measured to
aim well and costs $0.029 a run, and that whether aiming reduces reading is
unknown and is worth $8.50 to find out.

It does not claim the mistake half of the question is unreal — only that this
install, in eleven days and 294 runs, produced two ending-level failures and one
environment fault, and that a mechanism built on that corpus would be a mechanism
with almost nothing to learn from. An install with a different failure profile
would read `09-option-conflict-history.md` differently.

And it does not claim the 21× compliance result is causal. Runs that receive
`continuedWorkNotice` are continuation runs, which have reasons to look at git
that other runs do not; the 1.1× behaviour lift is the part that confounding
explains easily, and the 21×-on-the-exact-form is the part it does not.
Separating them properly is `03-experiment-holdout.md`'s probe (b), and until it
runs, this recommendation rests on an observational result and says so.
