# Constraints

Eight things bound this feature. Three are refusals already written down in this
repository or in the operator's vault; two are measured properties of the corpus;
two are code that would have to change; one is a benchmark result that says the
whole shape may not work. No option in this directory is allowed to ignore any
of them, and each option file says which it satisfies and which it merely
survives.

---

## C1 — The knowledge module is read-only, and says so as a decision

> "It is also read-only, end to end. Nothing in this module or in the routes
> over it opens a file for writing, creates a directory or removes one. That is
> a deliberate bound rather than a stage not reached yet: the vault is a live
> document store that a person edits in another application, and a background
> index that can write into it is one that can lose somebody's paragraph while
> they are typing it."
>
> — `src/lib/knowledge.ts:39`–`:44`

This is the invariant Dreaming collides with head-on, and the reason given is
not "we have not built it" but "a writer here can destroy a person's work in
progress." `10-the-write-path.md` costs out what a write would need. In short:
it cannot live in `knowledge.ts` without breaking the sentence above, it cannot
live in a route over `knowledge.ts` for the same reason, and wherever it lives
it needs the containment pair `resolveInMount()` applies —
lexical check, `realpathSync`, lexical check again, both load-bearing
(`docs/agent/security.md:11`) — plus something that pair does not do, which is
decide whether *this particular file* may be overwritten.

## C2 — "Neither is ever automatic"

> "Neither is ever automatic. Both cost money, and spend nobody asked for is
> spend nobody authorised — so nothing in the run loop reaches this module."
>
> — `src/lib/review.ts:34`–`:35`

`proposals/ContinuousImprovement/16-recommendation.md:169`–`:177` rejected
Option G, the automatic per-run retrospective, and quoted this line as one of
five grounds. **The question this survey has to answer is whether Dreaming is
Option G with a different sink.** It is answered in full in
`14-recommendation.md`; the short version, argued rather than asserted:

- **On cost, the refusal does not carry.** Option G was priced at $535–$1,188
  against an eleven-day bill of $4,303.70 — 12.4–27.6% before any lesson reached
  anything — because it fired per run, 294 times. Dreaming fires once a night
  over a prose slice, at $2.57 a night against $956.09 (0.27%), or $18 a week.
  That is a real difference and it is in Dreaming's favour. Anyone repeating the
  cost objection at Dreaming is repeating a figure that does not apply.
  **The two denominators are not the same quantity** and the comparison is only
  honest with that said: $4,303.70 is `runs.spent_usd` over 294 runs across that
  survey's eleven-day window (`proposals/ContinuousImprovement/00-problem.md:23`,
  `:33`; `10-option-retrospective.md:307`, `:316`) — this app's own runs and
  nothing else — where
  $956.09 is the whole visible transcript corpus including the operator's own
  machine. The like-for-like slice is the run-worktree class, $11,819.45 over 24
  days ≈ $493/day against ContinuousImprovement's $391/day, which is the same
  order and is the reason the ratio above is quoted rather than the absolute.
- **On automaticity, it carries and it is worse.** Option G fired when a run
  settled, which is at least an event a person caused. A clock fires when
  nobody has done anything at all. `src/lib/schedules.ts:529`–`:539` already
  makes this argument, in the app's own words, about workflow schedules: "Every
  other press of Run is bounded by a person being there to see what it cost and
  decide whether to press it again; a schedule removes the person and keeps the
  press." A nightly Dreaming *is* that schedule.
- **On the corpus, the failure is different rather than absent.** Option G's
  corpus was thin: two ending-level failures in 294 runs. Dreaming's is not thin
  — 2,547 machine-established tool failures in 24 days (`10-deduplication-and-
  retirement.md`). It is *undiagnosed*, which is C6.
- **On delivery, the difference the brief hoped for runs the wrong way.**
  Option G's objection was "it has no delivery channel of its own" — its output
  landed in a table nothing read. Dreaming's output lands in a folder a person
  reads, which sounds like the answer and is not: the folder has strict
  conventions, a checker that errors on violations, a documented policy against
  foreign sessions writing into it (C3), and no version control (C4). A sink
  that rejects what you put in it is not better than a sink nobody reads; it is
  a different problem with a person's document store attached.

**Verdict on the collision: the Option G refusal carries on authorship, not on
cost.** Every automatic option in this directory inherits `review.ts:34`. Every
person-fired option is refused by none of it, exactly as
`16-recommendation.md:175`–`:177` says of the manual button.

## C3 — The vault's own policy for a session like this one

> "If you are a session from another project and have not read `CLAUDE.md`, you
> do not have the writing conventions and should not write notes here. The one
> exception is a single question capture into `3 Resources/Questions/Inbox/`
> using that folder's `_TEMPLATE.md` — a quarantine that gets reviewed before
> anything counts as vault content."
>
> — `/workspace2/AGENTS.md:115`

A Dreaming child spawned by this app is precisely "a session from another
project". The vault has already decided what it may write and the answer is: one
question, into a quarantine, marked as not yet vault content. That is not a
restriction this survey is inventing to be careful; it is the licence the
destination hands out, and `06-option-d-question-capture.md` is the option that
takes it at its word.

Two further mechanics from the same file and its neighbour:

- **`AGENTS.md:113`** — "Regenerate the index before you finish:
  `python3 "_Meta/build_index.py"`. It rewrites `INDEX.md` *and* every file under
  `_Meta/index/`." So a single 2 KB note obliges a rewrite of a 2.6 MB generated
  file plus a directory of others, or the next reader gets a stale map.
- **`_Meta/Vault Conventions.md:39`** — "Growing a seed means **editing it in
  place** … Writing a second note on the same topic beside an existing seed is
  the failure mode this convention exists to prevent." A nightly writer that
  appends is doing the named thing.

## C4 — There is no version control behind the vault

`ls -a /workspace2` lists `.DS_Store`, `.claude`, `.mcp.json`, `.obsidian`, the
four PARA folders, `_Meta`, `_Templates`, `_Attachments`, `_to_delete` and three
root markdown files. **There is no `.git`.**

Every option here eventually writes something wrong. In this repository a wrong
row is deleted, a wrong branch is abandoned, a wrong commit is reverted, and
`docs/agent/retention.md` governs what ages out. In the vault there is none of
that: no history, no author field, no diff of what last night added. The only
retraction is a person opening the file and deleting it, and the only way they
know to is by noticing.

`11-deduplication-and-retirement.md` treats retirement as a first-class
requirement for this reason, and it is the axis on which most of the options
fail.

## C5 — A schedule targets a workflow, and only a workflow

`src/lib/schedules.ts` is the app's only clock over work that spends money, and
its shape is fixed:

- `ScheduleSpec` is three choices, not a cron string:
  `{kind:"everyHours"}`, `{kind:"daily", minutes}`, `{kind:"weekly", weekday,
  minutes}` (`:63`–`:66`), each carrying a `timeZone` on the row — so "a day" is
  already a defined quantity with an operator-chosen boundary, which is more
  than most of this survey's corpora have.
- **`WorkflowSchedule.workflowId` (`:104`), `getSchedule(workflowId)` (`:588`),
  `putSchedule(workflowId, …)` (`:616`).** A schedule points at a workflow.
  There is no schedule of anything else.
- `scheduleRefusal` (`:529`–`:539`) refuses a workflow whose instance budget
  sets nothing.

So "fire it nightly" is not a free choice of mechanism. Either Dreaming is
expressed as a workflow — and `WorkflowNodeKind` is `"run" | "orchestrator" |
"merge" | "loop"` (`src/lib/apiTypes.ts:1415`), so a Dreaming node is a *run*
against a folder, with a run's argv, a run's permission mode and a run's
isolation — or Dreaming brings a second scheduler, which is a timer nothing in
`docs/agent/` has an opinion about and which no existing guard watches.

## C6 — The reasoning is not in the corpus, and the diagnosis is measured to be bad

Two facts, one local and one from the operator's own vault, and they compound.

**Local.** 48,978 `thinking` blocks in the readable corpus, thirteen non-empty,
none of them from `claude-opus-5` (`00-problem.md` §3); and
`src/lib/orchestrator.ts:6675`–`:6704` handles `text` and `tool_use` and drops
every other block kind by name. A day's sessions say what was done, never why.

**From the vault.** `3 Resources/Questions/Can an Agent Write an Accurate Record
of Its Own Failure.md` (`status: growing`, `confidence: low`) at `:27`: "the best
method in the only peer-reviewed benchmark locates the failing step **14.2%** of
the time, with some methods below chance", and its stated working position is
"**admit transcription, mark diagnosis as a hypothesis, and never let an
unverified stated cause enter a store as a fact.**" The same note at `:31` cites
`[[Self-Correction and Reflection]]` (`confidence: high`): intrinsic
self-correction "falls monotonically, and on CommonSenseQA collapses from 75.8%
to 38.1% after one round", with the rule "find the verifier before adding the
loop."

Put together: the material Dreaming reads contains transcription and not
diagnosis, and the operation Dreaming performs on it — deriving a cause without
a verifier — is the one measured to degrade. **Every option in this directory is
therefore split into what it can transcribe and what it must guess**, and the
options that only transcribe are the ones that survive.

## C7 — A wrong learning is not diluted by right ones

`3 Resources/Questions/Does an Agent Defer to a Stale Memory Over What It Can
Observe.md` (`status: growing`, `confidence: low`) is the retirement constraint,
and half of it is now measured:

- `:27` — "shipped memory systems score **5.1% to 17.8%** at noticing their own
  memories have been invalidated, below plain models, and Zep, which ships the
  mechanism designed for exactly this, scores 6.0."
- `:31` — "**no memory system found so far authenticates what wrote a memory**,
  so on read-back a record that was correct in March and a record that was never
  correct are the same tokens carrying the same authority."
- `:33` — "**retrieval selects, it does not average**. A poison rate below 0.1%
  of a memory or knowledge base produced over 80% attack success with under 1%
  degradation on benign task performance (`[[AgentPoison (Chen et al 2024)]]`,
  peer-reviewed). A stale record is not an attacker, but it occupies the same
  slot."
- `:67` — "**Recurrence is a rate, not an event.** … an entry cannot be retired
  by a single successful observation either, so 'just re-verify before trusting'
  is more expensive than it sounds."
- `:37` — `[[Sycophancy and Agreement Bias]]` (`confidence: high`): "models
  follow a stated position, with one assistant wrongly admitting error on 98% of
  challenges and the best tested folding 32% of the time. A stale record **is** a
  stated position about the code."

The operational consequence for a *daily* writer is specific: a low error rate
per night is not a low error rate in effect, because the wrong note is retrieved
on the query it matches rather than averaged against the right ones. "One bad
learning in twenty" is not a 5% problem.

## C8 — The evidence that a written learning helps is absent, and the prior is null

The same corner of the vault carries the prior:

- `3 Resources/Questions/Does a Standing Instruction File Change What an Agent
  Produces.md:27` (`confidence: medium`, nine 2026 studies, four controlled) —
  "an instruction file reliably changes what an agent *does* — which tools it
  reaches for, how long it searches, what it costs — and three independent
  controlled studies have failed to detect any change in whether it *succeeds*,
  at a power none of them reached", with TOST bounding every correctness
  difference "under 10 to 15 points and probably zero."
- The one instruction form with a measured behavioural effect is naming a
  concrete artefact: a tool named in the file is invoked 1.6 times per instance
  against <0.01 unmentioned (`Gloaguen et al 2026`, cited at
  `3 Resources/Questions/Inbox/Does Writing Lessons From a Past Run Stop an Agent
  Repeating the Mistake.md:28`).
- The nearest measured thing to Dreaming is Reflexion — 91% pass@1 against 80% —
  and "the buffer dies with the episode and the gain comes from an external
  verifier, not from the writing" (same file, `:38`).
- Powering the experiment: "the existing nulls in this literature failed at 15–17
  tasks; the published calculation puts a 10-point effect at 80% power near
  120–200" (`:48`).

**And the operator's vault already holds the question Dreaming is the answer
to, unanswered, with UsageFoundry named as what prompted it.** The Inbox note's
frontmatter carries `captured_from: "UsageFoundry — a Next.js app that runs
Claude Code headlessly against a mounted folder, many runs over the same
repository"`, and `:32` says so in words: "The obvious feature is a lessons file;
whether to build it turns on this question." Its triage is still open (`:60`).

This is not a reason to refuse Dreaming outright — a null on *correctness* is
compatible with a real gain on *cost* and *process*, which is what the same
literature does measure. It is a reason no option may claim a correctness
benefit, and a reason `14-recommendation.md` weights the experiment above the
build.
