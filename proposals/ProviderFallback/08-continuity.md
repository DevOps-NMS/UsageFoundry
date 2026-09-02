# Continuity — what a Codex cycle starts from

A Claude `session_id` cannot be resumed by another binary. That is not a gap to
be engineered around; it is the definition of the problem. This file names the
four things a Codex cycle could actually start from, costs each, and says what
alternation does to the resume path.

---

## What resume means here today

`buildArgs` emits `--resume <session_id>` (`src/lib/cycleInvocation.ts:1085`)
when the row carries one. The id arrives from `handleStreamLine`'s
`onSession` callback (`src/lib/orchestrator.ts:6617`–`:6624`), which fires the
moment the stream first names a session — deliberately, because "the events that
lose it — a crash, a restart, a kill — are exactly the ones that stop this
promise settling at all" (`:5588`–`:5592`).

Whether resuming is even worth it is a decision the app already makes:
`startsFresh` reads `contextTokens` — the resident window at the moment the last
cycle stopped talking, last rather than largest, "because after a compaction the
final turn is genuinely small and resuming into it is genuinely cheap"
(`cycleInvocation.ts:59`–`:62`).

So the app already has a *cost model for discarding a conversation*, and it is
the right instrument for this question. What it does not have is a way to
discard one and pick up in a different binary.

## Codex's own resume

`codex exec resume <SESSION_ID> [PROMPT]` and `codex exec fork <SESSION_ID>`
(`codex-rs/exec/src/cli.rs`), where the id comes from
`thread.started { thread_id }`, documented as "The identified of the new thread.
Can be used to resume the thread later" (`codex-rs/exec/src/exec_events.rs`).
`--last` picks the most recent; `--all` disables cwd filtering.

**This works within Codex and is irrelevant across providers.** It also carries
U3's unknown — whether resume restores the sandbox mode, the model and the
config overrides, which is the exact class of bug this repository already found
for `--plugin-dir` (`cycleInvocation.ts:955`–`:962`).

---

## The four sources

### 1. The task text alone

The run's original prompt, re-sent to a fresh Codex session.

**Keeps:** the objective.
**Loses:** everything the run learned. Which files matter, which approach was
tried, which test was failing and why, what the last four cycles established.

**What it costs to re-derive:** `proposals/ContextControl/README.md` measured a
fresh conversation at **2.59× the cost of a resumed one**, with a break-even of
**3.9 KB of re-reading per cycle**. A run that has done five cycles of
exploration is well past that.

**Where it is honest:** on cycle 1. A run refused on its opening cycle has
learned nothing yet, and the task text *is* the state. This is the one case
where a fallback costs nothing at all in continuity — and it is worth noticing
that it is also the case where the run has spent the least and can most cheaply
just wait.

### 2. A written handover brief

Ask the Claude session, before it goes, to write what the next agent needs. Or
generate one from what the app holds.

**Keeps:** whatever the brief says.
**Loses:** whatever it does not, silently.

**This is the option that sounds best and measures worst**, and this repository
has the measurement. `proposals/RunDecisionTree/README.md`:

> The run barely narrates. A 58-minute, 297-tool-call run wrote **5,578 bytes of
> assistant prose** — eleven stage directions totalling 680 bytes, one sentence
> that states a reason, and a 4,873-byte final report. Zero `TodoWrite` calls, in
> both runs measured.

and, more sharply:

> The model's reasoning is not in the transcript, and for the model this app runs
> it never is. Across 266,362 records on this machine, `claude-opus-5` produced
> **28,857 `thinking` blocks with zero non-empty bytes**.

So a generated brief has ~5.5 KB of prose per hour-long run to work from, of
which one sentence states a reason. And a brief the *agent* writes has to be
requested at exactly the moment the provider has refused to run it — an
allowance wall means there is no turn left in which to ask.

**A brief could be written proactively**, at every cycle boundary, against the
possibility of a wall. That is `proposals/RunDecisionTree/06-option-d-first-hand-log.md`'s
mechanism — the run declares as it goes — priced there at under **$0.05 a run**.
It is the only version of this source that is not asking a dead session to speak.

### 3. The run's own `run_events`

The app's own record: `assistant`, `tool`, `tool_error`, `subagent`,
`iteration`, `sandbox`, `result` (`src/lib/apiTypes.ts:1791`–`:1836`), written
from stdout as the run happened, keyed on `run_id`, surviving both retention of
the transcript and a resume.

**Keeps:** what was done, in order, with the tool inputs clipped
(`clipToolInput`) and every failure named with its command.
**Loses:** why. Same measurement as above — the `why` is not in the record
because it was never emitted.

`proposals/RunDecisionTree` is the survey of exactly this material and its
conclusion is directly usable here: `run_events` "already knows more than the
transcript does" for *structure*, and knows nothing about *rationale*. A
handover assembled from it would be a faithful list of acts and a blank where
the reasoning goes.

**It is also large.** A 297-tool-call run's events are far more than a prompt,
so this source needs the same selection problem solved that
`RunDecisionTree/07-option-e` solves for a timeline — and the selection is a
judgement about what mattered, made by something that was not there.

### 4. The branch's commits

`git log` on the run's own branch, with messages.

**Keeps:** the durable output, and — uniquely among the four — the *only*
first-hand rationale a run reliably produces. A commit message is written by the
agent, at the time, about a specific change, and `CLAUDE.md` requires the subject
to say what changes and why.
**Loses:** everything not committed. Uncommitted working-tree state, the
approach considered and abandoned, the file read and dismissed.

**This is the strongest source and the one the app is already built around.**
An isolated run has a checkout and a branch by construction
(`resolveIsolation`/`ensureWorktree`, `docs/agent/isolation-and-landing.md`), and
`buildArgs` grants `ISOLATED_GIT_TOOLS` precisely so the run commits as it goes
(`cycleInvocation.ts:1044`). `continueBranch` (`apiTypes.ts:1511`) already
expresses "carry on another block's branch".

Its weakness is the honest one: a run that has not committed recently has
nothing here, and `slotIsDirty` exists because that state is common enough to
have retired checkout slots over.

## The recommendation among the four

**Branch + task text, with a proactively-written brief as the only worthwhile
addition.**

Sources 1 and 4 are free and already exist. Source 3 is expensive to select from
and adds structure without rationale. Source 2 is the only one that could add
rationale and only in its proactive form — which is a separate feature
(`RunDecisionTree` Option D) with its own case, its own cost and its own value
independent of any fallback.

That ordering has a consequence for the option set: **the fallback shapes that
start from a new run (C's continuation, E's downstream block) get the best
available continuity for free, and the shape that switches mid-run (B) gets the
same continuity while also carrying a dead session id.**

---

## What alternation does

If a run's cycles can alternate — Claude, Codex, Claude — three things follow,
and they compound.

**1. Every switch is a fresh conversation for the provider switched to.**
There is no cross-provider cache, no shared prefix, no `--resume`. The 2.59×
figure applies at each switch, in each direction.

**2. `runs.session_id` cannot hold both.** One column, two lineages. The row
either loses the Claude session — after which the Claude window refilling buys
nothing, because there is no conversation to go back to — or keeps it and lets it
go stale, after which resuming it means discarding everything Codex did that is
not in a commit.

**3. `startsFresh` stops being answerable.** It reads `contextTokens` — the
resident window of the last cycle — to decide whether resuming is worth it. After
a switch, the last cycle's window belongs to the *other* provider's conversation
and says nothing about the cost of resuming this one. The function would return a
confident number about the wrong session.

**So: no option in this set should permit alternation.** A run should switch at
most once, or not at all, and the shapes that make switching produce a *new run*
(C, E) get that property by construction rather than by a rule somebody has to
remember.

That is a design conclusion this file can state without any of the Codex-side
unknowns being resolved, and it is one of the few.
