# A fourth ending: `needs-review`

[← Documentation index](README.md)

**Status: implemented. Kept as the design record, not as the reference.** The
durable record now lives where this repository keeps its reasoning — the ending,
the outcome ladder and the pick-up branch in `agent/run-lifecycle.md`, the edge
semantics in `agent/dependencies.md`, the loop stop in
`agent/workflows-and-schedules.md`, what each new test earned in
`agent/testing.md`, and the operator-facing description in `runs.md`. Read those
first; read this when you want the argument behind a decision rather than the
decision. Every line reference below is against `394f325` and has drifted; the
symbol names are the durable part.

Four things below were **not** implemented as written. Decision 10's suggested
`describeRun` detail repeated the `stop_reason` it sits directly above, which
`RunState.detail`'s own contract forbids, so the detail says what the state
means instead. Decision 3's snippet kept the inline `DONE` matcher beside the
new branch; the loop reads `cycleEnding` for both tokens instead, or the tested
function would not be the one deciding. `NEEDS_REVIEW_NOTICE` is **exported**,
where `COMPLETION_NOTICE` is not, because it rides on nearly every prompt and
every exact-equality assertion in `nextPrompt`'s suite composes against it — the
alternative was degrading each of them to a substring match. And criterion 28's
honesty entry went to `docs/verification.md` rather than `README.md`, because
`README.md` says in as many words that *"the verification log, and in particular
its 'Not yet verified' list, stays the record for everything a human checked by
hand"*, and its own unverified section is scoped to the `--agent` flags.

---

## The defect

`completed` is written for two different endings and the app already says so in
three places. `orchestrator.ts:6922` writes it when the agent replies `DONE`;
`orchestrator.ts:6940` writes it when the run uses up `maxIterations` — and
`maxIterations` defaults to 1, so on a stock install almost every finished run is
the second kind. `edgeSatisfied`'s docblock (`orchestrator.ts:3455-3464`) spells
that out at length, `reopenPrompt` (`orchestrator.ts:7653`) exists to branch on
it, and `planLoopPass` reads `reportedDone` rather than the status
(`workflows.ts:1752`) for the same reason. `runs.reported_done` exists for no
other reason.

There is no ending at all for **the agent judged that it cannot finish this**. A
run that meets a wall it cannot pass has three futures today, and all three are
wrong:

- it spends the rest of its cycle cap restating the problem, because
  `COMPLETION_NOTICE` (`orchestrator.ts:4386`) tells it that stopping its turn
  without `DONE` "buys another work cycle on the same task";
- it replies `DONE` anyway and lands in `completed`, which `STATUS_TONE`
  (`format.ts:19`) paints `ok` — green, on a run that did not do the job;
- it runs out of cycles and lands in `completed` too, indistinguishable from the
  above on the list.

This adds a fourth terminal ending the agent can ask for, and one place for it to
say why.

## What this is not

Not a failure. `failed` is what this app writes when the *machine* went wrong —
a crash, a non-zero exit, a provider refusal with its ladder spent, a cycle that
went silent. Nothing has gone wrong here: a cycle ran, cost money, produced a
judgement, and reported it. Filing that as `failed` would put it under
`danger` beside dead containers and dropped sockets, and would tell the operator
to look for a fault that is not there.

Not a stop. `stopped` is "a person, or a rule they configured, decided" —
`interruptOutcome` (`orchestrator.ts:371`) and the `run_cost` verdict both say so.
Nobody decided this.

Not `blocked`. That word is taken, and it means the opposite thing: refused
before its first work cycle, nothing ran, nothing was spent
(`blockWaitingRun`, `orchestrator.ts:3899-3913`). A needs-review run has worked.

---

# Part 1 — the decisions

## 1. The stored value and the copy

**Decision.** The stored and wire token is `needs-review`. The prose says
"Needs review". There is no new label map.

**Reason.** Every multi-word value this app puts on the wire is a lowercase
hyphenated slug: `on-success` / `on-finish` (`orchestrator.ts:3388`),
`orchestrator-block` (`RUN_ORIGINS`, `orchestrator.ts:248`), `live-resume` /
`between-cycles` (`BudgetPolicy.enforcement`). `needs-review` is that convention
and nothing else.

The badge renders the raw token, exactly as `completed`, `blocked` and `waiting`
are rendered raw today (`runs/page.tsx:324`, `runs/[id]/page.tsx:800`). A
`STATUS_LABEL` map introduced for one member would be a second vocabulary for the
same eight facts, and the first thing that could drift from `STATUS_TONE`. Where
a surface writes prose rather than a chip — the history filter segment, the run
page's own headline — it says **"Needs review"** in sentence case, because the
design language is sentence case throughout (`conventions.md`: "`CardTitle` and
`Th` are sentence case at a weight step, never uppercase"). Title case — "Needs
Review" — was the obvious first choice and is rejected for that reason alone.

Two declarations, and they are deliberately duplicated:

- `RunStatus` — `src/lib/orchestrator.ts:91-106`
- `RunDTO["status"]` — `src/lib/apiTypes.ts:559-567`

`apiTypes.ts:490-495` states the rule in its own words: this file is the
client-safe mirror and must not pull a server module into the browser bundle.
Do not replace one with an import of the other.

**The schema needs no change.** `db.ts:147` declares `status TEXT NOT NULL`
inside the `runs` DDL (`db.ts:142-165`) with **no CHECK constraint**, so the new
value is additive at the schema level: no table rebuild, no `db.transaction`, and
no `SCHEMA_VERSION` bump — that constant (`db.ts:67`) records that a *rebuild*
completed, and `migrate()` stamps it after the fact. `idx_runs_status`
(`db.ts:648`) covers the new value with no change.

## 2. How the agent reports it

**Decision.** A second sentinel, `NEEDS_REVIEW`, matched
`/^\s*NEEDS_REVIEW\s*$/m` against the cycle's final assistant text — the same
shape as `reportedDone`'s `/^\s*DONE\s*$/m` at `orchestrator.ts:6913`. It is
taught by a **generated** notice, and it is taught on **every** run.

**Where it is taught.** A new module constant `NEEDS_REVIEW_NOTICE` in
`orchestrator.ts`, beside `COMPLETION_NOTICE` (`4386-4392`), reached from
`nextPrompt` (`4230-4282`) at three of its four returns:

| `nextPrompt` return | line | append the notice? |
| --- | --- | --- |
| the `sessionId === null` join | 4262-4278 | **yes** — last, after `COMPLETION_NOTICE` |
| `o.followUp` | 4280 | **no** — see below |
| `o.donePushback` | 4281 | **yes** |
| `o.continuation` | 4281 | **yes** |

Generated rather than stored, for the reason `COMPLETION_NOTICE` is: `getSettings()`
is `{...DEFAULTS, ...stored}` and the settings page PUTs the whole effective
object, so a sentence added to `DEFAULT_CONTINUATION_PROMPT` would reach no
install whose operator has ever edited that field. See `saveSettings`
(`settings.ts:682`) and the `conventions.md` paragraph on it.

On both the continuation and the pushback, not on cycle 1 alone. `COMPLETION_NOTICE`'s
own docblock names the failure: cycle 1 and cycle 2 disagreeing about what an
ending is *is* the bug. An agent on cycle 5 that has been re-told about `DONE`
four times and about `NEEDS_REVIEW` once, on a turn that has scrolled away, has
been told there is one ending.

**Not appended to `o.followUp`.** That branch is the operator's own words, which
`docs/runs.md` promises are "sent verbatim as the next turn". A run whose operator
wrote a note has a person watching it — which is the state this whole ending
exists to reach — and the contract is restated on the very next cycle by the
continuation branch.

**The reason is the cycle's own final text.** `res.finalText`, clipped at the
write (decision 4). Nothing is parsed out of it: the sentinel is a line, and
everything else the agent said in that turn is the account.

**Sub-agent text cannot trip it.** `handleStreamLine` routes any message carrying
`parent_tool_use_id` to its own event kind, and that text never becomes the
cycle's `finalText` — see the `forwardSubAgentText` docblock at
`settings.ts:117-144`, which records that this was done precisely so a sub-agent
saying `DONE` on a line of its own could not end a run. The new matcher inherits
that protection unchanged; do not weaken it.

## 3. Where the test sits in the cycle-outcome ladder

The ladder is `orchestrator.ts:6651-6942`, and the real order is not the one the
prose usually gives:

| # | test | lines | outcome |
| --- | --- | --- | --- |
| 1 | interrupt (operator stop, guard, deadline, shutdown) | 6654-6667 | via `interruptOutcome` |
| 2 | `res.subtype === "error_max_budget_usd"` | 6694-6713 | `stopped` |
| 3 | refusal ladder — allowance / rate-limit / transient / other | 6720-6857 | retry, `paused`, or `failed` |
| 4 | exit code / `isError` (with the one resume retry) | 6864-6906 | `failed` |
| **5a** | **`NEEDS_REVIEW`** | **new** | **`needs-review`** |
| 5b | `DONE` | 6908-6934 | `completed` |
| 6 | cycle cap | 6936-6942 | `completed` |

**Decision.** The new test goes at **5a** — immediately above the `DONE` test at
6913, below every refusal test and below the exit-code test.

**Reason.** Everything above it is a statement about the *machine*: a person
stopping the run, a ceiling the CLI enforced, the provider refusing, the child
dying. This one is a statement about the *task*, and it is the only test in the
ladder that is. Filing a provider wall or a dropped socket as the agent's
judgement would be a lie about who decided, and it would make the ending
unactionable: an operator sent to look at "what the agent could not do" would
find a 429.

**Above `DONE`, not below it.** A cycle whose text carries both tokens is an
agent contradicting itself, and `needs-review` wins. `completed` is `ok`-toned
and green and is the one ending nobody re-reads; `needs-review` is warn-toned,
reopenable, and asks for a person. Err toward the recoverable ending.

**`reportedDone` must be cleared explicitly in that branch.** This is the trap.
`reportedDone` is not a fresh local — it is hydrated from the row at
`orchestrator.ts:6074` (`let reportedDone = run.reported_done !== 0;`) and only
reassigned by the matcher at 6913. A branch that breaks out *before* 6913 without
touching it writes a **stale** `reported_done: 1` (through `carried` at 6990) for
a run picked up after an earlier `DONE`, which then sends `donePushbackPrompt`
into a run that never said it was finished. The branch must assign
`reportedDone = false` before it breaks.

**A cycle that names the sentinel and exits non-zero ends `failed`.** The
exit-code test at 6864 sits above and wins. That is the right answer and not
merely the incidental one: a non-zero exit is the CLI's own verdict that the
cycle did not complete, the text may be a partial stream finalised after a
truncation, and the run's stop reason then names the exit code — which is what an
operator needs first. The run stays reopenable either way.

The suggested shape, so the ordering and the clearing are unmissable:

```ts
// Above the DONE test: a cycle that says both has not cleanly finished, and the
// ending that asks for a person is the one that can be taken back.
if (NEEDS_REVIEW_RE.test(res.finalText)) {
  // Cleared explicitly. `reportedDone` is hydrated from the row above, so a run
  // reopened after a DONE would otherwise carry a stale 1 into `reopenPrompt`'s
  // pushback branch and be told it had reported the task complete.
  reportedDone = false;
  needsReviewReason = clipReason(res.finalText);
  stopReason =
    "Agent reported that it could not complete the task. What it said is on this run's page.";
  log(id, stopReason);
  finalStatus = "needs-review";
  break;
}
reportedDone = /^\s*DONE\s*$/m.test(res.finalText);
```

The `log(id, stopReason)` is not decoration: it is `error_max_budget_usd`'s rule
at 6710 — every other way a run ends puts a sentence in the stream the operator
is watching, and a run that only changed status reads there like a cycle that
stopped for no stated reason.

## 4. What is written

| column | value | where |
| --- | --- | --- |
| `status` | `needs-review` | `setStatus` via `finalStatus`, `orchestrator.ts:7013` |
| `finished_at` | `Date.now()` | the non-paused branch at `7013-7018`, unchanged |
| `exit_code` | `lastExit` (0 on this path) | same branch, unchanged |
| `resume_at` | `NULL` | same branch, unchanged |
| `stop_reason` | user-visible prose | `carried`, `orchestrator.ts:6983` |
| `needs_review_reason` | the agent's own words, clipped | **new**, added to `carried` |
| `reported_done` | `0` | `carried`, `orchestrator.ts:6990` — see decision 3 |

**The new column.** `addColumn(db, "runs", "needs_review_reason", "TEXT")` in
`migrate()` in `db.ts`, alongside the twenty-nine existing `runs` columns added
that way (`db.ts:697-1051`). Additive by construction: `addColumn` reads the live
schema (`db.ts:1309-1321`), it is not keyed on `SCHEMA_VERSION`, it is not
destructive, and it therefore needs no `db.transaction` — the one exception to
that is a *rebuild*, and this is not one.

**The bound.** `MAX_NEEDS_REVIEW_REASON = 2000` characters, exported from
`orchestrator.ts` beside `STDERR_TAIL_LIMIT` (`4203`), applied **at the write**
and nowhere else. Two reasons for bounding at the write rather than at the read:
it is what `log()` does with `MAX_LOG_CHARS` and what `runIteration` does with the
stderr tail, and a second bound at a second place is a second number to keep in
step. Two reasons for 2000: `RunDTO` is polled every three seconds by the run
detail page and was, when this was written, the row shape the runs list shipped
for every row, so an unbounded model-authored blob multiplied by the length of
the list; and the full
text is not lost — it is the cycle's assistant output in `run_events`, which the
Report tab already renders. Truncate at 2000 characters with a trailing `…` so a
clipped reason cannot read as a complete one. (Both halves of the first reason
have since narrowed: the runs list reads a DTO of its own and this field is not
on it, and the detail page's poll stands down once the run is terminal, which a
`needs-review` run is. The bound stays where it is, for the second reason and
for the one above it.)

**`reported_done` must not be set.** It is the sole input to `reopenPrompt`'s
pushback branch (`orchestrator.ts:7684`) and it means one thing: the agent replied
`DONE`. A run that could not finish has not reported the task complete, and
telling it on pick-up that it had is exactly the failure `restartKilled` was added
to prevent one branch up.

**Clearing it.** `needs_review_reason` describes *the ending the row currently
records*, which is the invariant `stop_reason` already has. So it is cleared in
two places, and both are needed:

- in `carried` (`orchestrator.ts:6982-6999`), initialised `null` and set only by
  the branch above — so a run that ends any other way through the loop overwrites
  a stale value;
- in `reopenRun`'s UPDATE (`orchestrator.ts:7889-7891`), beside `stop_reason=NULL`
  — because a reopened run may end without re-entering the loop at all (stopped
  while queued, closed out by a boot), and a reason left behind would then
  describe an ending two segments old.

## 5. Is it terminal, and is it a success?

**Terminal: yes.** **Success: no.**

The single change that carries almost all of this is
`TERMINAL_STATUSES` (`orchestrator.ts:3431-3436`), which is exported and is the
one answer to "has this settled". Adding `"needs-review"` to it makes the
following true at once, with no further edits:

- `edgeSatisfied` (`3466-3473`) returns **false** for `on-success` — that branch
  is `dep.status === "completed"` and nothing else — and **true** for `on-finish`
  when the run did at least one cycle. That is precisely what is wanted: an
  `on-success` dependent is `blocked` with a sentence naming the run in front of
  it, an `on-finish` dependent starts.
- `releasableRuns` (`3629-3700`) reaches its fixed point and terminates the chain
  rather than leaving dependents `waiting` for ever.
- `retention.ts` treats the run as settled — its events (`134-150`), its checkout
  (`220`) and its transcript (`599-603`, `662-667`) begin ageing out on their own
  horizons, exactly as a `failed` or `stopped` run's do. The run's own row, its
  spend and its reason are never deleted; `retention.md` is the whole argument.
- in `workflows.ts`, `planLoopPass` (`1724`) stops waiting for the pass,
  `edgeVerdict` (`2071`, `2110`) and `loopVerdict` (`2181`) settle the block, and
  `planInstanceStep` reaches its verdict through them.

`releaseDependents()` is called from `startRun`'s `finally` for every non-paused
ending (`orchestrator.ts:7062`) — so the wake happens with no change at all, which
is `dependencies.md`'s "every terminal transition wakes the dependents".

**Where "active" is decided, and why almost none of it changes.** Every live-set
in this codebase is an **allowlist**, which is the shape that is safe when a
member is added:

| site | file:line | form |
| --- | --- | --- |
| `activeRuns` | `orchestrator.ts:2587` | `status IN ('queued','running','paused')` |
| `occupantOf` default | `orchestrator.ts:2608` | `["running","queued"]` |
| `FLEET_STATUSES` | `fleet.ts:42` | `["waiting","queued","running","paused"]` |
| `LIVE_STATUSES` | `workflows.ts:2870-2875` | same four |
| `UNSETTLED` | `land.ts:710-715` | same four |
| `isRunActive` | `mergeQueue.ts:178-179` | three-way `\|\|` |
| `probeDatabase` | `health.ts:97-98` | `status IN ('running','queued','waiting','paused')` |

None of them changes. A `needs-review` run holds no folder, no checkout slot and
no concurrency slot, is invisible to `reconcileOnBoot` (which acts on
`activeRuns()` plus `waiting`), and `stopRun` answers `not-active` for it
(`orchestrator.ts:7206`).

**Two places hardcode the terminal list instead of reading the constant**, and
both are silent. They are not equally serious and the difference matters, because
a spec that overstates one sends the implementer hunting for a symptom that is
not there.

| site | file:line | today | must become | cost of leaving it |
| --- | --- | --- | --- | --- |
| `admitDependencies` | `orchestrator.ts:3030` | `status NOT IN ('completed','stopped','failed','blocked')` | + `'needs-review'` | **serious** |
| `branchChain` | `land.ts:600-602` | the same four, inside an `ORDER BY` | + `'needs-review'` | **bounded** |

`admitDependencies` is the one that bites. Its query asks whether some other run
is already set to continue this branch, and a `needs-review` run would answer
*yes, for ever* — so no run could ever be created to carry that branch on. It is
refused by name at admission, which at least says something, but the sentence is
a lie about a run that finished hours ago.

`branchChain`'s is an `ORDER BY … CASE WHEN iterations > 0 OR status NOT IN (…)
THEN 0 ELSE 1 END`, not a filter: it chooses which successor the downward chain
walk follows when a `continues_run` link came to nothing, and that function's own
docblock (`land.ts:588-594`) argues that which of two is followed decides nothing.
Left alone it ranks a settled run as one that can still hold the branch. Nothing
breaks; the ordering simply stops meaning what it says. Fix it anyway — the next
member added will not be so lucky.

Prefer rewriting both against `TERMINAL_STATUSES` rather than adding a fifth
literal to each. `src/app/api/runs/[id]/set-aside/route.ts:26-30` states the rule
this codebase already holds itself to, and it is worth quoting at whoever reviews
the change: *"a second copy of \"which statuses are still going\" is a second
thing to forget when one is added."*

**Three things in `land.ts` deliberately do not change, and each will look like an
omission to a reader.** All three are the inline live-allowlist
`["running","queued","paused"]`, and a `needs-review` run falls straight through
every one of them:

- `landRefusal` (`land.ts:828`) does **not** refuse a land. That is correct and it
  is what the sentence there says: *"This run is still active. It can commit again
  at any moment."* A `needs-review` run cannot commit again unless somebody
  reopens it, exactly like a `failed`, `stopped` or `completed` run — all three of
  which are landable today. An operator reading a stuck run's reason may well
  decide the partial work is worth having, and taking the button away would leave
  them with a branch and no route.
- `chainBlocker` (`land.ts:750-752`) does **not** treat a `needs-review` sibling as
  a blocker, for the same reason and via the same `UNSETTLED` allowlist.
- `deleteBranch` (`1743`), `purgeRefusal` (`1889`), `resolveConflicts` (`1181`)
  and `commitRefusal` (`1588`) likewise permit their action. Consistent with every
  other terminal status.

Leave a one-line comment at `landRefusal` naming `needs-review` as deliberately
not refused, so the next reader does not have to re-derive this.

**And one consequence in a workflow, stated rather than absorbed.**
`branchVerdict` (`workflows.ts:5278-5311`) has no run-status test at all, and
`edgeSatisfied` returns true for `on-finish`, so a **merge block** behind an
`on-finish` edge will land the branch of a run that asked for review, with nobody
looking. That is not new — it already does so for a `failed` predecessor — and the
operator's control is the same one they already have: choose `on-success`, which
`workflows-and-schedules.md` describes as "waits for every branch to land". No
code change; it belongs in the user-facing copy for this ending.

## 6. Picking it up again

**Decision.** `needs-review` joins `REOPENABLE` (`orchestrator.ts:7633`), and
`reopenPrompt` gets an explicit branch with a generated notice of its own.

`REOPENABLE` becomes `["failed", "stopped", "completed", "needs-review"]`. Without
that, `reopenRun`'s gate at `7781` refuses with *"This run is needs-review, so
there is nothing here to pick up"* — which is the opposite of what the state is
for. Everything else in `reopenRun` already handles it: the budget re-checks, the
halted-workflow refusal, the checkout-holder refusal, the `set_aside_at` clear and
the `reviveBlockedDependents([id])` call all key on the row rather than on the
word.

**The prompt branch, and why the obvious answer is not enough.** The cheap reading
of this decision is "with an operator note send the note, with none send the
continuation, and never the DONE pushback". Every part of that is *already true*
with no code at all: `reopenPrompt`'s first line is `if (o.note) return o.note;`,
and the pushback branch tests `o.status === "completed"`, which a `needs-review`
row is not. So doing nothing satisfies it — and doing nothing is wrong:

- the plain continuation says *"Continue working on the task. If it is fully
  complete and verified, reply with exactly DONE"* into a conversation whose last
  turn was the agent saying it could not get past something. That is the same
  shape as the defect `RESTART_KILLED_NOTICE` (`orchestrator.ts:7708-7715`) was
  added to fix, on the same function, with a measured cost behind it: 24 runs told
  to ask themselves whether they were finished when the true answer was that their
  cycle had been cut off. `reopenPrompt`'s own docblock states the standard —
  "every branch is billed and the wrong one is silent";
- the ordinary reason an operator reopens such a run *with no note* is that they
  have cleared the wall. Telling the agent to check whether it is still there is
  one cheap step; not telling it is one billed cycle that hits the same wall and
  reports the same thing.

So: a new constant `NEEDS_REVIEW_PICKUP_NOTICE`, returned by a branch placed
**below** `restartKilled` and **above** the DONE pushback, gated on `sessionId`
for the reason both neighbours are — with no session `nextPrompt` restarts the
original task with `priorWorkNotice`, and a reply-shaped note would be describing
a conversation that no longer exists.

```
if (o.note) return o.note;                                        // 7671, unchanged
if (o.restartKilled && o.sessionId) return RESTART_KILLED_NOTICE; // 7681, unchanged
if (o.status === "needs-review" && o.sessionId) return NEEDS_REVIEW_PICKUP_NOTICE;
if (o.status === "completed" && o.reportedDone && o.sessionId) return o.donePushback;
return "";
```

The order between `restartKilled` and the new branch is **inert today** and is
written this way on purpose. `restartKilled` is
`status === "failed" && restart_closed !== 0`, so the two can never both be true —
unlike the pushback below, which reads a *column* (`reported_done`) that survives
the ending it described and is exactly why `restartKilled` had to be placed above
it. The position is for the next reader and for the next change: if
`reconcileOnBoot` ever widens what it writes on a mid-cycle kill, a kill must
still outrank a stale ending. Say so in the comment rather than leaving the order
looking load-bearing when it is not.

The notice does **not** quote the reason back. The branch requires a session, so
the agent's own words are already the last thing in that conversation; re-sending
them would be spend for no information, which is `DEFAULT_CONTINUATION_PROMPT`'s
own stated rule.

**Should `reopenRun` surface the recorded reason?** No — it clears it (decision 4).
The run page shows the reason for as long as the row records that ending, which is
when it is worth reading; the full text stays in `run_events` and on the Report
tab for ever after.

## 7. The bulk pick-ups

**Decision.** Neither bulk control offers a `needs-review` run. One of them needs
no code change; the other's change is in the client, not in `fleet.ts`.

**`restartClosedRuns` (`orchestrator.ts:8183-8189`) — no change.** Its query is
`SELECT * FROM runs WHERE restart_closed = 1 AND set_aside_at IS NULL` with **no
status predicate at all**. `restart_closed` is only ever written by
`shutdownRuns` (`8128-8130`) and `reconcileOnBoot`, and only on rows that were
`running`, so a `needs-review` row can never carry it. The notice is about runs a
restart is holding up, and this is not one.

**`reopenFleet` (`fleet.ts:225-260`) — no change either, and this correction
matters.** That function has no status query: it takes **the explicit list of ids
the page displayed**, checks `set_aside_at` against the row, and delegates each id
to `reopenRun`. The place `completed` is deliberately excluded is the *client*
selector:

```ts
// src/app/runs/page.tsx:75
const REOPENABLE: ReadonlySet<RunDTO["status"]> = new Set(["failed", "stopped"]);
// src/app/runs/page.tsx:558
.filter((r) => REOPENABLE.has(r.status) && !r.set_aside_at)
```

**Do not add `needs-review` to that set.** The argument is the same one that keeps
`completed` out of it, in a new place: a control that acts on twenty-five runs at
once must not answer the one ending whose entire content is *a person is being
asked to look at this*. Pressing it would put an agent that accepts edits back to
work, unattended, on a wall nobody has read about, and nothing would record that
the question had been skipped.

That the run's own page still offers **Resume** is not an inconsistency — it is
the same split `set_aside_at` already makes and that `run-lifecycle.md` spells
out: picking a run up **by name, on its own page** is a decision; picking up
twenty-five is a press. `set_aside_at` semantics are unchanged in every respect.

## 8. Workflows and loops

**`planLoopPass` (`workflows.ts:1720-1782`) stops the loop — but only once
`TERMINAL_STATUSES` has gained the member, and that dependency is the point.** Its
first two rungs are:

```ts
if (last.runs.some((r) => !TERMINAL_STATUSES.includes(r.status))) {   // 1724
  return { kind: "wait" };
}
…
const broken = last.runs.find((r) => r.status !== "completed");       // 1739
if (broken) {
  return { kind: "stop", code: "failed", reason:
    `Pass ${last.pass} of “${input.blockName}” ended ${broken.status}, so ` +
    "the loop stopped rather than repeating on top of it." };
}
```

So: **without** the decision-5 change, line 1724 reads a `needs-review` pass as
still working and the loop `wait`s for ever — a block that never settles, holding
everything behind it, with nothing on any page to say why. **With** it, line 1739
matches, and the loop stops with the sentence *"…ended needs-review, so the loop
stopped rather than repeating on top of it."* — which is exactly right: a loop is
not a retry mechanism, and handing the next pass the same wall costs a whole run
rather than a work cycle.

Two notes on that stop. The `code` is `"failed"`, which is the vocabulary rather
than the behaviour, and it is deliberately **left alone**: `LoopStopCode` is
branched on by callers, `advanceLoop` maps every `stop` to
`settleLoop(…, "emitted", …)` whatever the code is, and the operator-facing
sentence already names `needs-review` verbatim. If loops ever gain per-code copy,
this is where a fifth code would go. And the `reportedDone` rung at 1752 is now
unreachable for such a pass — 1739 returns first — so a loop whose last pass did
the work *and* asked for review reports the stop rather than the completion. That
is the right precedence for the same reason it is in the ladder (decision 3).

**An instance's four-part derived status.** `memberTally` (`workflows.ts:2662-2665`)
counts `live` from `LIVE_STATUSES` and `blocked` from `r.status = 'blocked'`
exactly, and `instanceStatus` (`2711-2713`) is `live > 0 ? "started" : blocked > 0
? "blocked" : "finished"`. A `needs-review` member is therefore neither live nor
blocked, and the instance reads **`finished`**.

That is correct, and it is the same treatment `failed` and `stopped` already get.
`workflows-and-schedules.md` gives the reason in its own words: `finished` is a
claim about the **graph** rather than about the work, and how a member ended is on
the member's own row. An instance reported `blocked` means part of it was *written
off* because something in front satisfied nothing — which is not what happened
here. **No change to either query.**

**`instanceIsOpen`** is derived from that status and changes only through it.
Every site must go on asking `instanceIsOpen` rather than `status === "started"`
— unchanged rule, restated because this change touches the tally it reads.

**`blockedCount`** counts members written off, which is `blocked` and only
`blocked`. A `needs-review` member is not one. **No change.**

**`memberSteps` / `haltSteps` (`workflows.ts:3538-3558`) — no change.** The walk
is: a null status is `leave`, `waiting` is `block`, anything in `LIVE_STATUSES` is
`stop`, and everything else falls through to `leave` at `3556`. A `needs-review`
row lands on that fall-through and a halt leaves it exactly as it is — which is
required, because a `completed` row rewritten as stopped destroys the record of
work that landed, and the same argument holds for the record of a question that
was asked.

**`stopFleet`** routes every live run through those same steps and so is unchanged,
as is `bootBlockPlan` (`workflows.ts:5825`), which spares an instance only if some
member is in `LIVE_STATUSES` — an instance whose members have all settled,
`needs-review` included, has its deferred blocks closed out. Correct: another pass
would be an unattended agent started hours after anyone asked for it.

## 9. The incentive, and the collision

A cheap way out turns completions into needs-review. Two separate hazards, and
they need separate answers.

### The bar the wording sets

`NEEDS_REVIEW_NOTICE` has to make reporting it *more* work than carrying on, not
less. It states the ending, the bar, and the three facts a person needs:

> If you reach something you cannot get past, reply with exactly NEEDS_REVIEW on
> its own line and this run ends for a person to look at. Use it only after you
> have actually tried and been stopped — a credential that is not there, a
> permission you do not have, a decision that is not yours to make, a repository
> or service you cannot reach — and in the same reply say what you were doing,
> what you tried, and exactly what stopped you. Do not use it because the task is
> large, unclear or tedious: work you have not attempted is not a wall, and a run
> that ends this way with nothing to act on spends a person's time instead of a
> work cycle.

A good reason string is three sentences and names a thing: *"Adding the migration
needs the production database URL; `DATABASE_URL` is unset in this checkout and
`.env` was not seeded. I ran the rest of the suite and it passes. Set the variable
or point me at a fixture and I can finish."* A bad one is *"This task is
ambiguous"* with nothing tried — and the wording above is what makes that
recognisable when an operator reads it.

`DEFAULT_DONE_PUSHBACK_PROMPT` (`settings.ts:534-542`) already ends with the same
kind of escape clause for the same stated reason: an instruction an agent cannot
satisfy produces churn rather than silence.

### The `continueAfterDone` cost, stated rather than absorbed

**The sentinel is honoured on every run — it is gated on neither
`continueAfterDone` nor `maxIterations`.** Reusing `endsOnDone`, which is what the
`DONE` contract is gated on and is the obvious symmetry to reach for, is
deliberately rejected.

`endsOnDone` (`orchestrator.ts:4248-4259`, supplied at `6388`) exists to withhold
a promise that would be *false*: under `maxIterations === 1` the cap ends the run
whatever the agent says, and under `continueAfterDone` a `DONE` is explicitly
overridden. Neither is true of this sentinel — reporting it always ends the run in
`needs-review` with the reason recorded — so `endsOnDone`'s reasoning does not
reach it.

Gating it would be actively wrong. `maxIterations` defaults to 1, so
`endsOnDone` is false for the majority of runs on a stock install, and gating
would withhold the new ending from exactly the runs where it matters most: a
one-cycle run that hits a wall is written `completed`, green, today.

The cost under `continueAfterDone` is real and is written down rather than
absorbed: that mode is documented as "the run ends only when a limit is reached",
and after this it can also end when the agent reports a wall. That is the better
trade — `donePushbackPrompt` already anticipates *"if you truly find nothing worth
doing, say so and make no changes"*, and today the answer to that is one more
billed cycle every time until the cap. But it is a behaviour change to a
documented promise, and `docs/runs.md`'s *"Running until the limit rather than
until the agent says stop"* section must say so.

### The collision hazard

The matcher runs over **generated text**, so a run whose *task* discusses the
sentinel can trip it. This is measured rather than theoretical:
`run-lifecycle.md` records that over 251 runs, of those whose budget allowed a
second cycle, the ones whose task text happened to carry `DONE` ended in a single
cycle **53%** of the time against **2 of 120** without it.

Three things reduce it, and one case is left open on purpose:

1. **The sentinel is not the stored value.** `NEEDS_REVIEW` is uppercase with an
   underscore; the wire and column value is `needs-review`, lowercase with a
   hyphen. A task that quotes the *status* — which is what a task about this app
   would do — cannot produce the sentinel. This is the reason for the spelling and
   it should not be "tidied" into agreement.
2. **It must be alone on its own line** (`^\s*…\s*$` with the `m` flag). Ordinary
   prose says "this needs review" in lowercase inside a sentence.
3. **Sub-agent text is excluded by construction** — decision 2.

Left open: a run whose task *is this document*, or is the implementation of this
feature. It will carry the literal `NEEDS_REVIEW` and may end in one cycle. That
is accepted. The fix would be a per-run nonce, and it is rejected: the token would
have to travel into the prompt and back out of every log line, the contract would
stop being memorable across a `--resume`, and nothing in this app's own logs would
read the same twice. The cost of the collision is one run ending early with its
own text recorded as the reason — visible, warn-toned, and reopenable in one
click.

## 10. What the operator sees

**Deliberately small, and the reason is a fact about the moment this was
written:** three other runs were rebuilding this app's list and detail surfaces on
branches that had not landed, so a wide UI change here is a merge conflict with
work nobody can see yet. If that is no longer true when this is implemented, the
scope below is still the right *first* one — it is what makes the state legible
and findable — but the constraint behind it has gone and a fuller treatment is a
separate decision rather than a violation of this one.

| # | change | file:line | forced by the compiler? |
| --- | --- | --- | --- |
| 1 | `STATUS_TONE` gains `"needs-review": "warn"` | `format.ts:19-33` | **yes** |
| 2 | `GLYPH` gains one entry | `StatusMark.tsx:21-75` | **yes** |
| 3 | `describeRun`'s `switch` gains a case | `runs/[id]/page.tsx:114-254` | **yes** |
| 4 | `statusTone` gains it in the warn branch | `logLine.ts:222-228` | **no — silent** |
| 5 | `pickupable` gains it | `runs/[id]/page.tsx:744-750` | **no — silent** |
| 6 | `settled` gains it | `RunDiff.tsx:33-34` | **no — silent** |
| 7 | `Filter` / `FILTERS` gain a segment | `runs/page.tsx:82-90` | **no — silent** |

**Tone is `warn`, never `ok` and never `danger`.** `warn` is what `paused`,
`stopped` and `blocked` already wear, and the map's own comment for `paused` gives
the test this passes: needing attention. `danger` is reserved for `failed`, where
something went wrong; nothing went wrong here.

**The glyph** must be visually distinct from `completed`'s and `failed`'s, drawn
to the same 16×16 box and the same stroke attributes as its neighbours in that
map. It is the mark that says a person is being asked.

**The reason renders on the run page** underneath the state card, beside
`stop_reason` — which is already rendered there verbatim at
`runs/[id]/page.tsx:865-867`. Note the contract at `runs/[id]/page.tsx:109-111`:
`RunState.detail` must **not** repeat what is rendered underneath it. So the
`describeRun` case supplies a headline and a short detail, and the agent's own
words are the thing below.

Suggested copy for case 3 — headline *"Needs review"*, detail *"The agent
reported that it could not finish this. What it said is below."*, tone `warn`.

**The list needs the filter segment (7) and nothing else.** `runs/page.tsx:499`
buckets on `ACTIVE`, which correctly does not contain `needs-review`, so the run
falls into the history table already; without a segment it is only reachable under
"All". The segment is what makes these findable, which is the whole point of
having the state.

Three things on the list are deliberately **not** changed: `ACTIVE`
(`runs/page.tsx:37`), `ACTIVE_ORDER` (`:49`) and `REOPENABLE` (`:75`) — the first
two because the run is not live, the third for decision 7.

---

# Part 2 — the call-site inventory

Every row is either **CHANGE** (must be edited), **AUTO** (correct with no edit,
because a constant or a derived type carries it), or **LEAVE** (deliberately not
changed). The **silent** column marks the rows where getting it wrong throws
nothing, typechecks, and looks right on the page.

## 2.1 The declarations and the sets

| file:line | symbol | verdict | what it must read | silent |
| --- | --- | --- | --- | --- |
| `orchestrator.ts:91-106` | `RunStatus` | CHANGE | `+ \| "needs-review"` | — |
| `apiTypes.ts:559-567` | `RunDTO["status"]` | CHANGE | `+ \| "needs-review"` (do **not** import `RunStatus`) | — |
| `db.ts:147` | `runs.status TEXT NOT NULL` | LEAVE | no CHECK constraint; additive | — |
| `db.ts` `migrate()` | `addColumn(db,"runs","needs_review_reason","TEXT")` | CHANGE | new, beside `db.ts:1026-1051` | — |
| `db.ts:67` | `SCHEMA_VERSION` | LEAVE | not bumped — no rebuild | — |
| `orchestrator.ts:3431-3436` | `TERMINAL_STATUSES` | CHANGE | `+ "needs-review"` | **yes** — dependents wait for ever, retention never sweeps |
| `orchestrator.ts:7633` | `REOPENABLE` | CHANGE | `+ "needs-review"` | no (loud refusal) |
| `orchestrator.ts:2587` | `activeRuns` SQL | LEAVE | live allowlist | — |
| `orchestrator.ts:2608` | `occupantOf` default | LEAVE | `["running","queued"]` | — |
| `orchestrator.ts:3030` | `admitDependencies` SQL | **CHANGE** | `status NOT IN (… ,'needs-review')` | **yes** — no run may ever continue that branch |
| `land.ts:600-602` | `branchChain` `ORDER BY` | **CHANGE** | same denylist; effect is bounded (decision 5) | **yes**, but harmless today |
| `fleet.ts:42` | `FLEET_STATUSES` | LEAVE | live allowlist | — |
| `workflows.ts:2870-2875` (re-export `:3561`) | `LIVE_STATUSES` | LEAVE | live allowlist | — |
| `land.ts:710-715` | `UNSETTLED` | LEAVE | live allowlist | — |
| `mergeQueue.ts:178-179` | `isRunActive` | LEAVE | three-way `\|\|` on live | — |
| `health.ts:97-98`, `:105`, `:116` | live counts | LEAVE | live allowlist | — |
| `status.ts:30`, `:250` | `RunStatusCounts`, `status='queued'` | LEAVE | `Record<string, number>`, deliberately widened | — |

## 2.2 Server consumers of the union

| file:line | symbol | verdict | note | silent |
| --- | --- | --- | --- | --- |
| `orchestrator.ts:114` | `RunRow.status: RunStatus` | AUTO | — | — |
| `orchestrator.ts:371-384` | `interruptOutcome` | LEAVE | never returns the new value | — |
| `orchestrator.ts:654` | `setStatus(id, status: RunStatus, …)` | AUTO | dynamic UPDATE | — |
| `orchestrator.ts:3419` | `DependencyState.status` | AUTO | — | — |
| `orchestrator.ts:3466-3473` | `edgeSatisfied` | AUTO via `TERMINAL_STATUSES` | `on-success` stays `=== "completed"` | — |
| `orchestrator.ts:3476-3482` | `unsatisfiableReason` | AUTO | renders "ended needs-review" | — |
| `orchestrator.ts:3629-3700` | `releasableRuns` | AUTO via `TERMINAL_STATUSES` | — | — |
| `orchestrator.ts:3718-3760` | `dependenciesOf` | AUTO | fills `RunDependencyDTO.status` | — |
| `orchestrator.ts:3795-3821` | `revivableDependents` | AUTO | — | — |
| `orchestrator.ts:3996-4001` | `reviveBlockedDependents` candidates | LEAVE | selects `blocked` only | — |
| `orchestrator.ts:6079` | `let finalStatus: RunStatus` | AUTO | new assignment in the ladder | — |
| `orchestrator.ts:6651-6942` | the ladder | **CHANGE** | decision 3 | **yes** — stale `reported_done` |
| `orchestrator.ts:6982-6999` | `carried` | **CHANGE** | `+ needs_review_reason` | — |
| `orchestrator.ts:7013-7018` | terminal `setStatus` | AUTO | stamps `finished_at`/`exit_code` | — |
| `orchestrator.ts:7048-7057` | `emitHandoff` gate | AUTO | fires for an isolated needs-review run — correct | — |
| `orchestrator.ts:7062` | `releaseDependents()` | AUTO | every non-paused ending wakes dependents | — |
| `orchestrator.ts:7159-7214` | `stopRun` | AUTO | answers `not-active` | — |
| `orchestrator.ts:4230-4282` | `nextPrompt` | **CHANGE** | decision 2 | **yes** — an unteachable contract |
| `orchestrator.ts:4386-4392` | `COMPLETION_NOTICE` | LEAVE | new notice sits beside it | — |
| `orchestrator.ts:4248-4259` | `endsOnDone` | LEAVE | the new notice is **not** gated on it | — |
| `orchestrator.ts:7653-7688` | `reopenPrompt` | **CHANGE** | decision 6 | **yes** — wrong billed prompt |
| `orchestrator.ts:7749-7947` | `reopenRun` | **CHANGE** | clear `needs_review_reason` in the UPDATE at `7889` | — |
| `orchestrator.ts:8183-8189` | `restartClosedRuns` | LEAVE | flag-driven, no status predicate | — |
| `orchestrator.ts:8219-8238` | `setRunAside` | LEAVE | writes only `set_aside_at` | — |
| `orchestrator.ts:8321-8426` | `reconcileOnBoot` | LEAVE | acts on `activeRuns()` + `waiting` | — |
| `fleet.ts:177`, `:183-192` | `FleetState.counts` | LEAVE | `{} as Record<RunStatus, number>` seeded only from `FLEET_STATUSES`. The cast means the new key is *typed* present and is `undefined` at runtime. Harmless today — `FleetControls.tsx:67` reduces `Object.values` and `:237` iterates the four live names — but any future reader that indexes this map by an arbitrary status must write `?? 0` | — |
| `fleet.ts:225-260` | `reopenFleet` | LEAVE | takes explicit ids and tests only `set_aside_at`; no status predicate exists here. Decision 7 | — |
| `workspace.ts:58-63` | folder occupancy (`busyRunId` / `parkedRunId` / `queuedCount`) | LEAVE | `=== "running"`, `=== "paused"`, `=== "queued"` — live allowlists; a needs-review run correctly frees its folder | — |
| `status.ts:241-247` | `SELECT status, COUNT(*) … GROUP BY status` | LEAVE | a new key appears on its own | — |
| `status.ts:268` | `depth: (counts.queued ?? 0) + (counts.waiting ?? 0)` | LEAVE | queue depth, correctly excludes it | — |
| `review.ts`, `budget.ts` | — | LEAVE | **no run-status predicate in either file.** Every status they test is `run_reviews`, `chat_sessions` or `workflow_instance_blocks` | — |
| `retention.ts:134-150`, `:220`, `:325`, `:599-603`, `:662-667` | all sweeps | AUTO via `TERMINAL_STATUSES` | a needs-review run's evidence ages out like any settled run's | — |
| `repoSpend.ts:169-178` | `runSpendSince` | LEAVE | no status predicate at all | — |
| `installBudget.ts:58-71`, `:82` | `installSpend` | LEAVE | filters `finished_at`; only `running` adds in-flight telemetry | — |
| `otlp.ts:399-402`, `:485` | `TelemetryRunTotal.status`, `workingRunCount` | LEAVE | server type is `string \| null`; the count is `=== "running"` | — |
| `mergeQueue.ts:142` | `planItem` | AUTO via `isRunActive` | checkout checks run once the run is settled | — |
| `land.ts:535`, `:828`, `:1181`, `:1588`, `:1743`, `:1889` | `landRefusal`, `commitRefusal`, `purgeRefusal`, `deleteBranch`, `resolveConflicts` | LEAVE | live allowlists; a needs-review run reads settled, which is correct | — |
| `land.ts:171`, `:177`, `:2022`, `:2274` | `ChainMember.status`, `LandState.runStatus`, `BranchSummary.runStatus`, `BranchCandidate.status` | AUTO | all `RunRow["status"]` | — |
| `workflows.ts:1739` | `planLoopPass` run test | LEAVE | `!== "completed"` already stops the loop | **yes if rewritten** — pin it with a test |
| `workflows.ts:1724`, `:2071`, `:2110`, `:2181` | `planInstanceStep` / `edgeVerdict` / `loopVerdict` | AUTO via `TERMINAL_STATUSES` | — | — |
| `workflows.ts:2573` | `row.status === "running"` | LEAVE | in-flight telemetry only | — |
| `workflows.ts:3386`, `:3538-3539` | `HaltMember.status`, `haltSteps` | AUTO | terminal members are left alone | — |
| `workflows.ts:5780`, `:5913` | `BootBlockInstance.memberStatuses`, boot cast | AUTO via `LIVE_STATUSES` | — | — |
| `workflows.ts:2918-2921`, `:4408`, `:4591`, `:5985-5987` | row casts to `RunStatus` | AUTO | — | — |

## 2.3 The DTOs

| file:line | field | verdict |
| --- | --- | --- |
| `apiTypes.ts:559-567` | `RunDTO.status` | **CHANGE** — the second declaration |
| `apiTypes.ts` (beside `:620`) | `needs_review_reason?: string \| null` | **CHANGE** — new optional field, snake_case like `stop_reason` / `reported_done` |
| `apiTypes.ts:522` | `RunDependencyDTO.status` | AUTO — `RunDTO["status"]` |
| `apiTypes.ts:371` | `TelemetryRunDTO.status` | AUTO — `RunDTO["status"] \| null` |
| `apiTypes.ts:1412` | `LandStateDTO.runStatus` | AUTO |
| `apiTypes.ts:1515` | `BranchSummaryDTO.runStatus` | AUTO — and unread by the branches page, which uses the server-computed `b.active` |
| `apiTypes.ts:1093` | `WorkflowInstanceNodeDTO.run.status` | AUTO |
| `apiTypes.ts:1606` | `FleetStateDTO.counts` | LEAVE — `Record<string, number>`, deliberately widened |
| `apiTypes.ts:1455`, `:1129`, `:1188`, `:1341`, `:1935`, `:1947` | merge-queue / block / instance / review / proposal / chat statuses | LEAVE — **not** run statuses |

**There is no shared `RunRow` → `RunDTO` helper.** The mapping is inlined three
times, by object spread, and those are the only places a row reaches the wire as a
run:

| file:line | site |
| --- | --- |
| `src/app/api/runs/route.ts:33-55` | the list (`...r` at `:40`) |
| `src/app/api/runs/[id]/route.ts:47-75` | the single run (`...run` at `:49`) |
| `src/app/api/runs/route.ts:250-261` | the create response |

Two consequences, and the second is the trap:

- **The new column needs no route edit.** The spreads carry it. It must still be
  declared on `RunDTO` to be visible to a client.
- **None of the three is type-annotated as `RunDTO`.** They return anonymous
  objects into `NextResponse.json`, so nothing checks them against
  `apiTypes.ts:548-667`. Widening `RunStatus` alone therefore compiles clean here
  while `RunDTO["status"]` stays narrow, and the divergence surfaces only where a
  client indexes a `Record` keyed on the DTO union. **Edit `apiTypes.ts:559-567`
  by hand; no compiler will remind you.**

The three run-status predicates in those routes — `r.status === "queued"` at
`runs/route.ts:53` and `:259`, and `run.status === "queued"` at
`runs/[id]/route.ts:62` — all stay correct. `runs/[id]/route.ts:65`'s
`haltedWorkflow: haltedWorkflowOf(id)` is the precedent to copy if this ending
ever needs its own "what can I press" fact on the wire; it does not today.
`src/app/api/runs/[id]/reopen/route.ts` carries no status literal at all and
forwards `reopenRun`'s refusal, so decision 6's `REOPENABLE` edit is the whole of
that path. There is no `stop` route: stopping is `DELETE /api/runs/[id]`
(`runs/[id]/route.ts:78-90`), and there is no `fleet/reopen` route: it is the
`action === "reopen"` branch of `src/app/api/fleet/route.ts:44-71`.

`src/app/api/workflows/dto.ts:76` (`run: runStateOf(n.runId)`) is the second
row→wire path; its type is `WorkflowInstanceNodeDTO["run"]`, whose `status` is
derived from `RunDTO["status"]` at `apiTypes.ts:1093`, so widening the union
covers it.

## 2.4 The client

Only three of these are compile errors. The rest are the ones to find by hand.

| file:line | symbol | verdict | silent? / note |
| --- | --- | --- | --- |
| `format.ts:19-33` | `STATUS_TONE` | **CHANGE** → `warn` | no — `Record<RunDTO["status"], BadgeTone>` fails to compile |
| `StatusMark.tsx:21-75` | `GLYPH` | **CHANGE** | no — same shape |
| `runs/[id]/page.tsx:114-254` | `describeRun`'s `switch` | **CHANGE** | no — no `default`, so the missing return is an error |
| `logLine.ts:222-228` | `statusTone(status: unknown)` | **CHANGE** → warn branch | **yes** — falls to `neutral` |
| `runs/[id]/page.tsx:744-750` | `pickupable` | **CHANGE** | **yes** — no Resume button, contradicting `REOPENABLE` |
| `RunDiff.tsx:33-34` | `settled` (positive list) | **CHANGE** | **yes** — Changes never auto-loads and the card says "still working" |
| `runs/page.tsx:82-90` | `Filter` / `FILTERS` | **CHANGE** | **yes** — unreachable except under "All" |
| `runs/page.tsx:37-42` | `ACTIVE` | LEAVE | — |
| `runs/page.tsx:49-56`, `:508-509` | `ACTIVE_ORDER` + its `as keyof typeof` cast | LEAVE | only reachable if `ACTIVE` gains the member — do not |
| `runs/page.tsx:75`, `:558` | client `REOPENABLE` | **LEAVE** | decision 7 — deliberate |
| `runs/[id]/page.tsx:61-66` | `ACTIVE_STATUSES` | LEAVE | — |
| `RunLand.tsx:286` | `settled` (negative list) | LEAVE | correct by accident; leave a comment saying which |
| `FleetControls.tsx:237` | `describeCounts` order | LEAVE | live statuses only |
| `LiveTelemetry.tsx:104-113` | telemetry row badge | AUTO via `STATUS_TONE` | — |
| `QuickOpen.tsx:125-132` | raw status in the row detail and the haystack | AUTO | — |
| `runs/page.tsx:323-324`, `runs/[id]/page.tsx:799-801` | `StatusMark` + `Badge` | AUTO | — |
| `workflows/[id]/instances/[instanceId]/page.tsx:121-126` | member badge via `STATUS_TONE` | AUTO | — |
| `branches/page.tsx` | — | LEAVE | reads `b.active`, never a run status |

## 2.5 The MCP surface

`src/app/api/mcp/route.ts` (1654 lines) was read end to end for this. **No
mechanical change is required**, and that is worth stating precisely so nobody
goes looking:

- **There is no `enum` of run statuses anywhere in the file.** Every `enum` in it
  is an input schema — `["on-success","on-finish"]` at `:358`, `:490`, `:602`,
  `["run","orchestrator","merge"]` at `:418`, `["merge","squash"]` at `:472`.
  There are no output schemas at all.
- `list_runs` (`:877-899`, status at `:885`) and `get_run` (`:991-1040`, status at
  `:1005`) are pure pass-throughs of `RunRow["status"]`.
- `get_usage` (`:1139-1141`) counts `running` / `queued` / `paused` off
  `activeRuns()` — live allowlists, correct.
- `list_folders` (`:784-792`) reports occupancy computed by `workspace.ts:58-63`,
  also live allowlists.
- `list_workflows` (`:1187`) counts `liveRunsOf`, which reads `LIVE_STATUSES`.

**One editorial change is worth making.** `list_runs`'s description
(`:160-163`) reads *"List recent runs with their status, folder and spend, so work
already in flight is not proposed a second time"*, and `get_run`'s (`:174-177`)
says *"how it ended"*. A deciding turn — a workflow orchestrator block, running
with nobody looking — reads those to decide what to start next, and "in flight" is
the exact judgement this ending breaks: a `needs-review` run is finished, holds
nothing, and is waiting on a person. Add a clause to `list_runs`'s description
saying so. It costs nothing and it is the difference between a block proposing
sensible follow-up work and a block re-proposing a task that is parked on a
question.

## 2.6 Documentation the implementation run owes

`docs/agent/` is the agent-facing invariant record and is updated by the
implementation run, not by this one.

| file | what it must gain |
| --- | --- |
| `docs/agent/run-lifecycle.md` | the ending itself: the ladder position and why it is above `DONE`, the explicit `reportedDone = false`, the generated notice and why it is not gated on `endsOnDone`, the `reopenPrompt` branch and its position, and the bulk pick-up exclusion |
| `docs/agent/dependencies.md` | that `needs-review` is terminal and is **not** success — `edgeSatisfied`'s two branches |
| `docs/agent/workflows-and-schedules.md` | that a `needs-review` pass ends a loop block, and that the member counts as settled-not-written-off |
| `docs/agent/testing.md` | the grounds each new test earned, in that file's own form |
| `docs/runs.md` | the ending in user-facing words; the correction to *"Running until the limit rather than until the agent says stop"* (decision 9) |
| `README.md` | the **Not yet verified** list — see Part 3 |
| `docs/README.md` | an index entry, once this stops being a specification |

---

# Part 3 — acceptance criteria

## Environment, verbatim

Both traps are from `CLAUDE.md` and neither is about this repository.

```bash
NODE_ENV=development npm ci --include=dev
```

A bare `npm ci` under the image's `NODE_ENV=production` exits 0 having skipped
devDependencies, and `typecheck`/`test` then fail with exit 127.

```bash
env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build
```

Needed only if the build is run at all. A shell inheriting
`__NEXT_PRIVATE_STANDALONE_CONFIG` from a UsageFoundry container — which is what
an agent this app spawns gets — makes `next build` die with `TypeError: generate
is not a function`.

```bash
npm run typecheck
npm test
```

There is **no linter run** (`eslint.ignoreDuringBuilds` is on).

**Docker is not available in this container.** Any step needing
`docker compose up --build` — including the real verification loop `CLAUDE.md`
names — **cannot be run here** and must be reported as unverified rather than
assumed.

## Checkable statements

Each is a statement about observable behaviour. `[typecheck]` means the compiler
enforces it; `[test]` means a unit test does; `[read]` means it can only be
checked by reading the diff, because the code path is inside `startRun`'s loop and
`orchestrator.test.ts` deliberately pins `CLAUDE_BIN` at a path that does not
exist so a regression reaching a spawn is a failed test rather than a billed one
(see `docs/agent/testing.md` on `cycleDeadline.test.ts`); `[hand]` means it needs
a running app and **cannot be checked in this container**.

**The ending**

1. `[typecheck]` `npm run typecheck` passes with `needs-review` in both unions,
   after `STATUS_TONE`, `GLYPH` and `describeRun` have gained their entries.
   Before those three, it **fails** — confirm that first, so the compiler is known
   to be doing the work claimed for it.
1b. `[hand]` Both unions were edited. Widening `RunStatus` alone typechecks: the
   three route handlers that build a run payload are not annotated as `RunDTO`
   (`api/runs/route.ts:33-55`, `:250-261`, `api/runs/[id]/route.ts:47-75`), so
   nothing compares the server's answer to the client's type. Grep both
   declarations and confirm they list the same eight-plus-one members.
2. `[test]` `cycleEnding("…\nNEEDS_REVIEW\n")` is `"needs-review"`;
   `cycleEnding("…\nDONE\n")` is `"done"`; a text carrying **both** on separate
   lines is `"needs-review"`.
3. `[test]` `cycleEnding` returns `null` for text containing `needs-review`
   (lowercase, hyphen) or `NEEDS_REVIEW` inside a sentence rather than alone on a
   line. This is the collision guard from decision 9 and it is the reason the two
   spellings differ.
4. `[read]` The branch assigns `reportedDone = false` before it breaks, so a run
   whose row already carried `reported_done = 1` from an earlier segment writes 0.
   This cannot be reached from a unit test — `reportedDone` is a local hydrated at
   `startRun:6074` — and it is the single most expensive thing to get wrong here,
   so it is a review criterion rather than an omission.
5. `[read]` The branch sits **above** `reportedDone = /^\s*DONE\s*$/m.test(...)`
   and **below** the exit-code test at `6864`, so a cycle that names the sentinel
   and exits non-zero still ends `failed` with the exit code in its stop reason.
6. `[hand]` A run that ends this way stamps `finished_at`, keeps its branch and
   its session id, and its reason is at most 2000 characters with a trailing `…`
   when clipped.

**Terminal, and not a success**

7. `[test]` `edgeSatisfied({status:"needs-review", iterations:1}, "on-success")`
   is `false`; the same with `"on-finish"` is `true`; with `iterations: 0` both
   are `false`.
8. `[test]` A chain whose dependency ends `needs-review` leaves an `on-success`
   dependent `blocked` with a reason naming that run, and starts an `on-finish`
   dependent.
9. `[hand]` A `needs-review` run appears in no folder-occupancy or concurrency
   count, and a run queued on its folder starts.
10. `[hand]` A second run may be created to continue a `needs-review` run's branch
    — the `admitDependencies` denylist at `orchestrator.ts:3030`. This is the one
    silent defect with a visible symptom; check it explicitly, because before the
    fix the refusal names a run that finished hours ago.
11. `[hand]` The Land button **is** offered for the branch of a `needs-review` run
    that committed, and Delete, Purge and a conflict resolution are all permitted
    — unchanged from every other terminal status (decision 5). This criterion
    exists because it looks like an omission and is not.

**Picking it up**

11b. `[read]` `branchChain`'s `ORDER BY` at `land.ts:600-602` lists the new value.
    It has no observable symptom today (decision 5), which is exactly why it needs
    a review criterion rather than a behavioural one.
12. `[test]` `reopenPrompt` with `status:"needs-review"`, a session and no note
    returns `NEEDS_REVIEW_PICKUP_NOTICE`; with a note returns the note; with no
    session returns `""`. The `restartKilled` control is a separate case — a
    `failed` row with `restart_closed` set still returns `RESTART_KILLED_NOTICE` —
    and it is a control rather than an ordering assertion, because the two
    branches test different statuses and can never both match.
13. `[test]` `reopenPrompt` with `status:"completed"` and `reportedDone` still
    returns `donePushback` — the control.
14. `[hand]` The run page offers **Resume** on a `needs-review` run and
    `reopenRun` accepts it.
15. `[hand]` The Fleet card's "Pick up N stopped" does **not** count or start a
    `needs-review` run, and the restart notice does not either.
16. `[hand]` Reopening clears `needs_review_reason`, so the page does not show a
    reason for an ending the row no longer records.

**The prompt contract**

17. `[test]` `nextPrompt` with `sessionId: null` includes the needs-review notice,
    after the task and after `COMPLETION_NOTICE`.
18. `[test]` `nextPrompt` includes it when `endsOnDone` is **false** — both
    because `maxIterations === 1` and because `continueAfterDone` is set. This is
    the one assertion that pins decision 9's ungating; without it the notice can
    be quietly folded under `endsOnDone` and nothing else reports the loss.
19. `[test]` `nextPrompt` with a session includes it on the continuation and on
    the pushback, and does **not** append it to a verbatim `followUp`.

**Workflows**

20. `[test]` `planLoopPass` returns `{kind:"stop"}` — not `{kind:"wait"}` — when
    the last pass's run ended `needs-review`, and the reason names the status.
    The `wait` half is the assertion that matters: it is what a missing
    `TERMINAL_STATUSES` entry produces, and a loop block that waits for ever holds
    everything behind it with nothing on any page to say why.
21. `[hand]` A workflow instance whose last live member ends `needs-review` reads
    `finished`, not `blocked`, and `instanceIsOpen` is false.
22. `[hand]` Halting a workflow leaves a `needs-review` member's row exactly as it
    was — status, `stop_reason` and reason all unchanged.
22b. `[hand]` A merge block behind an `on-finish` edge lands a `needs-review`
    predecessor's branch, and behind an `on-success` edge does not. Unchanged
    behaviour; the criterion is that the user-facing copy says so.

**The operator's view**

23. `[hand]` The badge is `warn`-toned on the runs list, the run page, the
    workflow instance page and the dashboard telemetry card.
24. `[hand]` The run page shows the agent's own reason under the state card, and
    `describeRun`'s detail does not repeat it.
25. `[hand]` The history filter has a **Needs review** segment and it selects
    exactly those runs.
26. `[hand]` The Changes tab loads on its own for a `needs-review` run.
27. `[hand]` The log line for the transition is warn-toned, not neutral.

**Honesty**

28. `[hand]` `README.md`'s **Not yet verified** list gains, by name: that a real
    agent under the pinned CLI actually uses the sentinel when it should and does
    not use it when it should not. Nothing in this repository can measure that,
    and the wording in decision 9 is reasoned rather than measured. Saying so is
    the criterion.

## Which pure functions earn a unit test

`docs/agent/testing.md` records what each existing test earned; that file is the
bar, not a general convention. Against it:

**`cycleEnding(finalText)` — earns one, but only if it is extracted.**
"Test the sentinel matcher" is the obvious first answer and it is the wrong one: a
bare regex does not earn a test here. It would pin the language, the existing
`DONE` matcher at `orchestrator.ts:6913` has never had one, and testing.md's whole
list is decisions rather than expressions. What *is* a decision is the
**precedence** — that `NEEDS_REVIEW` outranks `DONE` in one turn's text, and that
neither fires unless it is alone on its line. So extract a small pure
`cycleEnding(text): "needs-review" | "done" | null` and test that instead. It
clears the bar on the failure mode: a wrong precedence files a run that said it
was stuck as green `completed`, which is the exact defect this whole change exists
to remove, and it throws nothing.

**`reopenPrompt` — earns one.** It is already in testing.md's list for precisely
this reason ("the branch that decides what an unattended agent is told about
*ending*"), every branch is billed, and the wrong one is silent. The new branch
and its position relative to `restartKilled` are what the cases pin, and the
`completed`-plus-`reportedDone` control is half the test.

**`edgeSatisfied` — earns one.** Already covered through `releasableRuns`; the new
cases are cheap and both failure directions are the ones `dependencies.md` names:
a chain that never starts, or one started on top of work that did not happen.

**`nextPrompt` — earns one.** Also already in testing.md, for the DONE contract.
The new assertion is the ungating (criterion 18): if a later change quietly folds
the new notice under `endsOnDone`, the majority of runs on a stock install lose
the ending and nothing reports it.

**`planLoopPass` — earns one.** Correct today by the *shape* of
`r.status !== "completed"`, not by intent. A rewrite into an explicit list of
failure statuses restores the defect silently, at a cost of one whole run per
pass. testing.md's bar is met by the cost, not by the current correctness.

**Nothing else.** The two denylist SQL fixes are not pure functions:
`admitDependencies`' failure has a visible symptom and is criterion 10, and
`branchChain`'s has none at all and is criterion 11b, a read of the diff.
`land.test.ts` already exercises `landRefusal`'s chain
branch, so adding a `needs-review` member to that existing fixture is the cheap
in-bar extension rather than a new file. Do not add a test for `STATUS_TONE`,
`GLYPH` or `describeRun` — the compiler is the test, and testing.md is explicit
that a rendering earns one only when it pins something a reader would act on that
is wrong in a way that typechecks.

---

## What could not be settled by reading

Everything above was read out of the source at `394f325`, with two exceptions that
no amount of reading can close and which are therefore stated rather than guessed:

1. **Whether an agent actually uses the sentinel well.** The wording in decision 9
   is reasoned from `COMPLETION_NOTICE`'s measured precedent and from
   `DEFAULT_DONE_PUSHBACK_PROMPT`'s stated failure mode. Nothing in this
   repository can measure whether a real model under the pinned CLI reports
   `NEEDS_REVIEW` when it should and withholds it when it should not. That is
   criterion 28, and it belongs on README's **Not yet verified** list by name.
2. **Everything behind `docker compose`.** Docker is unavailable in the container
   this specification was written in, so the real verification loop `CLAUDE.md`
   names — a build plus a smoke test — has not been run against any of this.
   Every `[hand]` criterion above is unexercised.

One thing was settled by reading and is worth flagging as the single most likely
place to get this wrong: **the `TERMINAL_STATUSES` entry carries five separate
subsystems at once** — dependency release, retention's three sweeps, the loop
block's exit test, `edgeVerdict`'s two branches, and `planInstanceStep`. Adding
the union member and forgetting that constant produces a run that is terminal
everywhere a person looks and non-terminal everywhere the machine looks: chains
that never start, loops that never end, evidence that never ages out, and not one
line anywhere saying so.
