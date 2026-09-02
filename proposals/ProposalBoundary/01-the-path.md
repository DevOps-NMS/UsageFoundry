# The path, traced

One proposal, from the tool call that writes it to the row in `runs`. Each
section ends with **holds** or **does not hold** so the two are never mixed.

---

## 0. The shape of the boundary

Two tables and one synchronous pass.

`propose_run` (`src/app/api/mcp/route.ts:1665`) validates and calls
`createProposal` (`src/lib/chat.ts:741`), which is one INSERT into
`chat_proposals` and nothing else — no folder claim, no concurrency slot, no
guard. The row holds `template_id`, `agent_id`, `title`, `task`,
`prompt_override`, `mount_id`, `folder`, `spec_id`, `depends_on` (JSON) and
`graph`. `template_id` is deliberately **not** a foreign key
(`src/lib/db.ts:30-33`): a template deleted between proposal and approval must
fail the approval with a sentence rather than vanish the row.

`POST /api/chat/[id]/proposals` (`src/app/api/chat/[id]/proposals/route.ts:49`)
is the only door out. It takes an explicit list of ids and an action of exactly
`approve` or `reject`, narrows the list to `pendingProposals(id)` (`:71`), and
runs `approveRunBatch` and `approveWorkflowProposal` in one event-loop turn with
no `await` between them — because `createRun`'s folder claim is only atomic
inside one turn, and because a dependency has to name a run that exists and
every run it can name is created in that same pass.

`approveRunBatch` (`src/lib/chat.ts:1311`) orders the batch with
`planApprovalBatch` (`:1066`), then calls `approveProposal` (`:1234`) once per
member. `approveProposal` calls `planProposal` (`:814`) — pure, unit-tested — and
then `createRun`.

Everything below is what can go wrong in that sequence.

---

## 1. Guard resolution

**Where each guard is read.** `planProposal` takes the template and the
untemplated set as *arguments* so it stays pure. The caller resolves both:

```
src/lib/chat.ts:1251   planProposal(
                         proposal,
src/lib/chat.ts:1253     proposal.template_id ? getTemplate(proposal.template_id) : null,
src/lib/chat.ts:1254     chatGuards(),
src/lib/chat.ts:1258     proposal.agent_id ? getAgent(proposal.agent_id) : null,
                       )
```

All three reads happen **at the click**. `planProposal:890` then picks one set:

```
const guards: RunGuards = template
  ? { permissionMode: template.permissionMode, isolate: template.isolate, budget: template.budget }
  : defaults;
```

and `:906-908` copies `permissionMode`, `isolate` and `budget` into
`CreateRunInput`. No value off the proposal reaches any of them. `createRun`
then freezes the budget and the permission mode into `runs.budget` as one JSON
blob (`src/lib/orchestrator.ts:3653`), so what the run got is on the row
afterwards.

**Deleted template.** `planProposal:840` refuses by name and does not fall back.
The DTO shows the same fact before the click as `guardsSource: "missing"`
(`src/app/api/chat/dto.ts:42`). **Holds.**

**Edited template.** The run gets the template's *current* guards; the card
carried only the template's name. That is the documented trade — a template is
"a thing the operator wrote and can go and read" (`src/app/api/chat/dto.ts:206`)
— and it is defensible because the name is a handle to the truth. **Holds.**

**Edited default guard set.** Not defensible on the same argument, because the
card for an untemplated proposal carries the *values* and not a handle:

> An untemplated one has no such handle, so the card has to carry the guards
> themselves — otherwise the only place the answer exists is a settings page two
> clicks away, and an approval gate that does not show what is being approved is
> a gate that gets clicked through.
> — `src/app/api/chat/dto.ts:207-211`

`defaultGuardsLabel()` reads `chatGuards()` when the DTO is built;
`approveProposal:1254` reads it again at the click; the request between them
carries proposal ids and nothing else (`.../proposals/route.ts:66`). Measured by
[`scripts/guard-drift.cjs`](scripts/guard-drift.cjs):

```
card as rendered:   guardsSource=defaults guardsLabel="plan · own checkout · 3 cycles · $5.00"
run as started:     permissionMode=bypassPermissions isolation=none maxIterations=null
                    maxRunCostUSD=null maxDurationMinutes=600
```

**Does not hold — F3.**

---

## 2. `promptOverride` and `composeTask`

**In order.** `basePrompt` (`src/lib/chat.ts:928`) takes the override when it is
non-blank after trimming, otherwise the template's prompt, otherwise null.
`composeTask` (`:947`) joins them:

```
`${lead}\n\n## This run specifically\n\n${task.trim()}`
```

and returns the task alone when `lead` is empty — "a section marker for a
section that is not there is worse than no marker".

**Truncation.** There is none on this path. `propose_run` caps neither `task`
nor `promptOverride`; `createProposal` writes both to unbounded SQLite TEXT;
`createRun` does `String(input.prompt ?? "").trim()`
(`src/lib/orchestrator.ts:3634`) and refuses only the empty string; the column
is written verbatim and reaches the first cycle as the `-p` value. The only
trimming anywhere is whitespace at the two ends.

**Reordering.** The order is a template literal with no branch in it. The one
way the boundary between the halves becomes ambiguous is a task or a template
prompt that itself contains the literal `## This run specifically`, which is
cosmetic — both halves still arrive, in order.

**Holds.** (What happens to the prompt on *later* work cycles — compaction,
`contextPruning.ts` — is the run lifecycle's ground, not this boundary's. See
[`06-not-examined.md`](06-not-examined.md).)

---

## 3. `agentId`

**A deleted agent is refused by name, twice.** At the tool
(`src/app/api/mcp/route.ts:1684-1688`) and again at approval
(`src/lib/chat.ts:861-864`), both through the same `agentRefusal`
(`src/lib/agents.ts:478`), which produces "That agent no longer exists (id
…), so there is nothing for the run to be." A second refusal covers an agent
missing its description or prompt, which the CLI would silently drop
(`:486-492`). The `if (proposal.agent_id)` at `:861` is truthy rather than
`!== null` on purpose: a row written before the column existed carries
`undefined`, and `undefined !== null` would refuse every proposal already
waiting.

**Naming one cannot change what the run may do.** Three independent reasons, all
checkable:

1. The `agents` table has no tools column, no permission-mode column and no
   budget (`src/lib/db.ts:269`).
2. `agentDefinition` (`src/lib/agents.ts:856`) returns exactly
   `{name, description, prompt, model}`.
3. `planProposal`'s returned `CreateRunInput` takes `agent` from the proposal
   and every guard from `guards` (`src/lib/chat.ts:906-913`), and `createRun`
   freezes the definition onto the row so an agent edited later cannot reach a
   later cycle (`src/lib/orchestrator.ts:3661`).

The one field that is *not* on `agentDefinition` and would break this is a tool
list, and the registry "refuses a tool list at the door".

**Holds.**

---

## 4. Dependency chains

**Where each check lives.**

| check | proposal time | approval time |
|---|---|---|
| dangling label | `route.ts:1785` — refused, naming the label | `chat.ts:1123` — refused, three sentences apart |
| self-dependency | `route.ts:1781` | `chat.ts:1095` |
| duplicate label in the chat | `route.ts:1768` (only against *pending*) | `chat.ts:1082` (within the batch) |
| a label naming a rejected/failed proposal | `route.ts:1793` | `chat.ts:1130` |
| cycle | unconstructible — see below | `chat.ts:1144` and again `orchestrator.ts:4060` |
| two branches continued by one proposal | `route.ts:1829` | `orchestrator.ts` (via `admitDependencies`) |
| **two proposals continuing one run** | **nowhere** | `orchestrator.ts:3557` |
| both ends isolated | `route.ts:1836-1856` | `orchestrator.ts:3529-3538` |

**A cycle cannot be built at proposal time**, and this is worth stating because
it is a property of the ordering rather than of a check: `propose_run` refuses a
`dependsOn` naming a label that does not already exist (`route.ts:1785`), so
every edge points backwards in time and the graph is a DAG by construction.
`planApprovalBatch:1144` checks anyway, because "`createRun` would meet this one
as *no such run to depend on*" — the wrong sentence for the right problem.
**Holds.**

**A parent rejected, or approved in a different click.** `approveRunBatch:1322`
builds an `outside` map from every labelled proposal of the chat that is not in
the batch, and `planApprovalBatch:1109-1131` resolves against the batch first
and `outside` second, producing three different sentences for three different
facts — not in the chat at all, still pending ("Approve them together"), or
decided and never a run. A parent approved in an earlier click resolves to its
`run_id` and the dependency is wired to the live run. **Holds.**

**A parent that crashed.** The edge exists, the dependent is created `waiting`,
and `releasableRuns` (`src/lib/orchestrator.ts:4233`) terminates it as `blocked`
with `unsatisfiableReason` — "Set to start only after <name> succeeded
(on-success); it ended failed." That verdict lands on the *run*, and nothing
writes it back into the chat thread; `chat_proposals` still says `approved`.
That is correct — the run row is the truth — but it means the operator who
clicked in the chat learns the outcome somewhere else. **Holds**, with that
noted.

**A parent that failed to start inside the same click.** `approveRunBatch:1351`
fails the dependent by name rather than leaving `createRun` to refuse it as a
missing run, and marks it `stillborn` so the one behind *it* gets named too.
**Holds.**

**"Only one proposal may continue any given run."** Enforced, but only against
the live `runs` table at `admitDependencies` (`orchestrator.ts:3557`), and
enforcement is a `throw` that `approveProposal`'s catch turns into a terminal
`failed`. `propose_run` checks only that *one proposal* does not continue two
branches; `planApprovalBatch` deliberately does not re-decide it
(`chat.ts:1060`). Measured by
[`scripts/rival-continuation.cjs`](scripts/rival-continuation.cjs):

```
started: 2 of 3
  could not start "Document it": Run f1430f7d is already set to continue run
  b53447b0's branch (it is waiting). Two runs cannot extend the same branch;
  pick that one up again instead.
  still offered for decision: 0
```

**Does not hold — F4.**

---

## 5. Batch approval

**One member failing does not stop the rest.** `approveRunBatch:1344` loops the
steps; a `createRun` that throws is caught inside `approveProposal:1278`, marked
`failed`, and pushed onto `failed` with its reason. Unrelated members carry on.
The dependents of the failure — and only those — cascade. **Holds.**

**What the operator is told.** The route builds `decisionNote`
(`src/lib/chat.ts:1432`) and appends it to the thread as a `system` message
(`.../proposals/route.ts:154-163`). `decisionNote` is pure and unit-tested
because it is "the *only* account the operator gets of a click that acted on
nothing"; it keeps `decided` (this chat's, already decided) apart from `foreign`
(another thread's), names each failure with the right verb for its kind, and
prefixes "Nothing was approved." when nothing moved. **Holds.**

**One asymmetry.** The route returns 400 when `targets` is empty, and says why:

> A 200 with an empty `started` is indistinguishable from a batch that worked:
> the page clears the selection on `res.ok` and shows no error, so the click
> reads as having succeeded silently. — `.../proposals/route.ts:88-91`

When `targets` is non-empty and *every* member fails, the same route returns 200
with `started: []` (`:165`). The thread note does carry the failures, so this is
not silence — but it is the route's own stated reasoning not applied to the case
it describes. **F7 in [`02-findings.md`](02-findings.md)**, ranked last.

---

## 6. Restart

`reconcileChatsOnBoot` (`src/lib/chat.ts:2446`) is one statement: every
`thinking` row becomes `failed` with `turn_started_at=NULL` and an error string.
It is called from `src/instrumentation.ts:124`, gated on `ownsDataDir()`, after
`reconcileOnBoot` and before the workflow reconcilers. Nothing is resumed, which
is the documented rule — "a chat turn is a question somebody put minutes ago,
and re-asking it unattended is spend nobody is present to want."

Measured by [`scripts/restart-state.cjs`](scripts/restart-state.cjs) on a chat
that had proposed and asked before the process died:

```
chat status after boot:        failed
chat.error after boot:         "The server restarted while this message was being answered."
turn_started_at after boot:    null
pending proposals:             1
pending questions:             1
messages before / after:       1 / 1
```

**Pending proposals stay actionable.** They are untouched by the sweep and are
still returned by `pendingProposals`, so the Approve button still works.
**Holds.**

**Open questions stay actionable.** Also untouched. This is load-bearing and
`listQuestions`' own docblock (`src/lib/chat.ts:444`) says why a question is a
row rather than a chat status: a status meaning "asked and waiting" would have to
be excluded from this sweep by hand, "a silent way for a restart to eat every
open question". Because the chat lands in `failed` rather than `thinking`, the
cards are pressable again. **Holds.**

**The in-flight turn.** The row settles and the indicator stops. But the thread
gets nothing, where `endTurn` (`:1706`) appends a system message for exactly this
reason — "a turn that stops without a word looks like an answer that never came"
— and `claimTurn` (`:1618`) clears `error` in the same statement that takes the
next turn, so the one record there was is gone the moment the operator retries.
Measured: `chat.error once the next message claims the turn: null`.

**Does not hold — F5.**

**The sweeper.** `startChatSweeper` is only called from `sendChatMessage:1857`,
and `sweepStuckChats:1768` stops itself when no `thinking` row is left. After a
boot there are none, so nothing needs starting. **Holds.**

---

## 7. Capability tokens

**Lifetime.** Minted in `runOrchestratorChild:1999`, one per turn, 32 random
bytes, with `expiresAt = now + CHAT_TIMEOUT_MS + 60_000` (`:1540`) — eleven
minutes. Held in a `globalThis` map, never persisted. Revoked in exactly two
places: `land` (`:2144`), which runs once when the child settles, and the
`writeMcpConfig` failure path (`:2008`), which exists because otherwise a token
minted for a turn that could not start would live out its whole expiry.
`subjectForCapability` (`:1556`) reaps expired entries as it scans, and compares
in constant time against every live token rather than looking one up by key.

**Revoked on rejection?** No, and correctly not: a token belongs to a *turn*, not
to a proposal. `rejectProposal` (`:1384`) is one UPDATE and touches nothing else.
Rejecting a proposal has no bearing on whether the turn that wrote it is still
running.

**Revoked on chat end?** There is no chat end. `grep` for `DELETE` across
`src/app/api` finds no route that deletes a chat, `retention.ts` reads
`chat_sessions.session_id` (`:675`) and deletes no chat row, and nothing in the
app removes one. A thread is permanent, so the question does not arise — which
is worth writing down, because "revoke on chat end" reads like a missing feature
until you look for the end.

**Revoked on Stop?** No. `endTurn` (`:1695`) settles the row and signals the
child, and the revoke happens later, when that child actually exits.
[`scripts/cross-turn-settle.cjs`](scripts/cross-turn-settle.cjs) reads the
singleton the instant after `cancelChatTurn` returns:

```
live capability tokens the instant after Stop: 1
```

**F6.**

**Can `chatOwnsRun` disagree with the proposal that created the run?** No, as
far as this survey could establish. `chatOwnsRun` (`:712`) is
`SELECT 1 FROM chat_proposals WHERE chat_id=? AND run_id=?`, and `markProposal`
(`:1476`) is the only writer of `run_id` — the same UPDATE for every status, so
a proposal that failed has `run_id` set back to null rather than left behind.
`approveProposal` writes it with the id `createRun` just returned, in the same
synchronous block. Run ids are `randomUUID`, so a deleted run cannot have its id
reused by a later one. The only direction it can be wrong is *narrower* than the
proposal — a proposal whose run was deleted still names a run id that no longer
resolves, and `getRunPatch` refuses on `getRun(runId)` first
(`src/app/api/mcp/route.ts:1207`) — which is a refusal, not an over-grant.
**Holds.**

---

## 8. The turn lifecycle underneath all of it

`claimTurn` (`:1613`) is a conditional UPDATE on `status<>'thinking'` whose
`changes` count decides, so two messages racing into one chat start one child —
covered by a test. `finishTurn` (`:2329`) latches on `WHERE status='thinking'`,
which is what lets `cancelChatTurn` and the sweeper settle a turn without
waiting for a `close` that may never come.

The latch carries nothing that identifies *which* turn produced the result, and
`endTurn` returns without waiting for the child it signalled. So the two
statements can be about different turns. Measured by
[`scripts/cross-turn-settle.cjs`](scripts/cross-turn-settle.cjs):

```
thread:
  user: message one
  system: You stopped this message while it was being answered.
  user: message two
  assistant: reply-from-child-1

A third message while turn two's child is still alive: ACCEPTED
```

**Does not hold — F1**, and it is the most expensive of the six.
