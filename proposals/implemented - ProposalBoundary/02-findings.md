# Findings

Ranked by what they cost an operator: an approval that silently starts nothing —
or silently starts the wrong thing — above a confusing message. Each says
whether the fix is a **repair** (the code does not do what it clearly intends)
or a **design change** (it does what it intends, and the intent is wrong).

Every one of the six reproduces. F1–F5 have a script; F6's live-token half has a
script and its consequence is read.

---

## F1 — A cancelled or timed-out turn's child settles the *next* turn's row

**Repair.** `src/lib/chat.ts:2340`, reached from `:1695` and `:1619`.

### The sequence

1. The operator sends a message. `claimTurn` (`:1613`) sets the row `thinking`;
   child **C1** is spawned.
2. They press Stop. `cancelChatTurn` (`:1739`) calls `endTurn` (`:1695`), which
   sets the row `failed`, appends "You stopped this message while it was being
   answered." and sends SIGINT — then **returns without waiting**. The SIGTERM
   and SIGKILL steps are `setTimeout`s at 3 s and 8 s (`:1713-1718`).
3. The row being `failed` is what invites a retry — `claimTurn`'s condition is
   `status<>'thinking'` "because a turn that failed leaves the row `failed`, and
   the next message is how an operator retries it" (`:1601`). So the operator
   sends message two, the row becomes `thinking` again, and child **C2** starts.
4. C1 finally exits, inside those eight seconds. `settleOnExit` → `land` →
   `runTurn`'s `onSettle` → `finishTurn(chat.id, C1's result)` (`:2223`).

### What happens

`finishTurn`'s latch is `WHERE id=? AND status='thinking'` (`:2347`) and carries
nothing that identifies which turn produced the result. The row *is* `thinking`
— because of turn two. So C1's answer settles turn two's row: status `idle`,
C1's text appended as the assistant reply, C1's `session_id` adopted by
`COALESCE`, C1's cost added, `turn_started_at` cleared.

Turn two is then unmonitored: `sweepStuckChats` (`:1764`) only reads `thinking`
rows and stops the sweeper when there are none. When C2 eventually finishes, its
own `finishTurn` finds `status='idle'`, changes nothing, returns at `:2358` —
so its answer, its cost and its session id are all discarded in silence. And
because the row reads `idle`, `sendChatMessage`'s "one billed child per
conversation" guard (`:1827`, `:1846`) lets a *third* message through while C2 is
still running.

Measured — [`scripts/cross-turn-settle.cjs`](scripts/cross-turn-settle.cjs),
exit 0:

```
thread:
  user: message one
  system: You stopped this message while it was being answered.
  user: message two
  assistant: reply-from-child-1

sessionId: session-1     costUSD: 0.25
threadHasChildOnesReply: true    threadHasChildTwosReply: false

A third message while turn two's child is still alive: ACCEPTED — two billed
children on one conversation
```

### What should happen instead

C1's settle should be a no-op. The turn it belongs to has already been ended.

### Why I believe it, from the code

`runTurn`'s `onSettle` guards the *process map* against exactly this
interleaving and does not guard the row:

```ts
onSettle: (result) => {
  // Only this child's own entry: a turn cancelled and re-sent while the old
  // child was still dying would otherwise have its live handle deleted by
  // the corpse of the previous one.
  if (spawned && turns.get(chat.id) === spawned) turns.delete(chat.id);
  finishTurn(chat.id, result);            // ← unconditional
},
```
— `src/lib/chat.ts:2218-2224`

The comment names the scenario. The line under it does not apply the same test.
`finishTurn`'s own docblock explains the latch as protecting against "a late one
[that] lands here and changes nothing, rather than reviving the thread" — true
of a late settle arriving while the row is `failed`, and not true of one
arriving while the row has been claimed by a *different* turn.

The same hazard reaches the timeout path: `sweepStuckChats` calls the same
`endTurn`, so a ten-minute turn that is failed out and immediately retried is
the same sequence with a different first sentence.

### Note on cost accounting

`finishTurn`'s comment asserts "the CLI reports cost and session id only in the
final JSON object, which a child that was signalled never prints". The script's
fake `claude` traps SIGINT and does print, which is how it exercises this — so
the script does not establish what the real CLI does under SIGINT. What it does
establish is that *if* a signalled child prints, the latch cannot tell whose
turn it was. The timeout path does not depend on that at all: there the child is
not signalled until `o.timeoutMs`, and `endTurn` runs from the sweeper
`STALE_TURN_MARGIN_MS` later, so a child that answers in that margin prints
normally.

---

## F2 — A refusal that clears on its own destroys the proposal permanently

**Repair.** `src/lib/chat.ts:1278-1285`.

### The sequence

The operator has an install-wide daily ceiling configured
(`installDailyCostLimitUSD`), and this install has reached it. They click
Approve on a pending proposal.

### What happens

`createRun` throws before it writes anything:

```
src/lib/orchestrator.ts:3645  const installRefusal = installBudgetRefusal();
src/lib/orchestrator.ts:3646  if (installRefusal) throw new Error(installRefusal);
```

`approveProposal` catches it and calls `markProposal(id, "failed", {error})`
(`:1283`). That status is terminal: `planProposal` refuses anything not
`pending` (`:833`) and the route only ever offers `pendingProposals(id)`
(`.../proposals/route.ts:71`), so the proposal can never be approved again. The
work is gone; getting it back means asking the chat to propose it again, which
is a billed turn.

The refusal the operator reads says the opposite of what just happened to their
proposal:

> This install has spent $5.00 in the last 24 hours, reaching the $1.00 limit
> set in Settings for everything it runs. **Nothing new will start until spend
> ages out of that window or the limit is raised.**

Measured —
[`scripts/transient-refusal-burns-proposal.cjs`](scripts/transient-refusal-burns-proposal.cjs),
exit 0:

```
approve while the ceiling is tripped -> ok=false
  proposal status: failed
  still offered for decision: false

ceiling off; approve the same proposal again -> ok=false
  reason: This proposal was already failed.
```

The ceiling is a **rolling** window — `installSpend` sums everything after
`now - INSTALL_WINDOW_MS` (`src/lib/installBudget.ts:79-80`) — so it clears on
its own with no operator action at all.

The same is true of `requireDataDir()` (`src/lib/orchestrator.ts:3631`), which
throws when another process holds the data-directory lock. That is a condition
of *which server is running right now*, and it also burns the proposal.

**In a batch this multiplies.** `approveRunBatch` loops `approveProposal`
(`:1344`) with no early exit, so one ceiling trip fails every member in turn,
each one marked terminally. One click on twenty proposals destroys twenty.

### What should happen instead

A condition that will clear on its own should refuse the *click*, leaving the
proposal pending, exactly as an empty batch is refused with a 400 and a sentence.

### Why I believe it, from the code

`approveProposal`'s own comment is the witness. It justifies the terminal mark by
enumerating the permanent refusals and concluding that this catch never sees a
transient one:

```ts
} catch (err) {
  // `createRun` refuses a folder outside every mount and a folder that does
  // not exist; a folder merely *busy* queues instead, which is why this is a
  // failure rather than a retry.
```
— `src/lib/chat.ts:1278-1281`

Two of `createRun`'s five refusal points are not in that list and are not
permanent. The intent is clear and the code does not achieve it, which is what
makes this a repair rather than a decision.

---

## F3 — The guard set applied at approval is not the one the card was rendered with

**Design change.** `src/lib/chat.ts:1254` against `src/app/api/chat/dto.ts:213`.

### The sequence

1. The chat proposes work with no template. The card renders
   `guardsSource: "defaults"` and `guardsLabel` spelled out from `chatGuards()`.
2. The operator opens Settings — in this tab or another — and changes
   `chatDefaultGuards`.
3. They click Approve on the card in front of them.

### What happens

`approveProposal:1254` calls `chatGuards()` again. The run starts under the new
set. Nothing anywhere records that the card said something else.

Measured — [`scripts/guard-drift.cjs`](scripts/guard-drift.cjs), exit 0:

```
card as rendered:   guardsSource=defaults guardsLabel="plan · own checkout · 3 cycles · $5.00"
run as started:     permissionMode=bypassPermissions isolation=none
                    maxIterations=null maxRunCostUSD=null maxDurationMinutes=600
```

The card promised a planning-mode agent in a checkout of its own, capped at
three work cycles and five dollars. What started was a `bypassPermissions` agent
writing directly into the operator's folder with no cap on cycles and no cap on
money.

### How wide the window is

At least one poll interval. `POLL_IDLE_MS` is 10 s
(`src/app/chat/page.tsx:54`), and the effect that owns the timer deliberately
does not stand down (`:411-418`). It is longer than that whenever a poll has
failed — the page's own `Waiting` comment notes "`thinking` is only ever as
fresh as the last poll that worked" (`:1389`) — and, by the ordinary behaviour of
browser timer throttling in a backgrounded tab, longer again when the operator
was in Settings in another tab, which is the likeliest way to reach step 2. The
throttling half is reasoning about browsers, not a measurement taken here.

### What should happen instead

The same rule the route already applies to the ids, applied to the guards:

> `ids` is required even for "approve all": the page sends what it displayed, so
> a proposal the chat added between the render and the click is not swept into an
> approval nobody saw. — `.../proposals/route.ts:63-65`

The page sends what it displayed for *which proposals*. It sends nothing about
*under what rules*, and the server re-derives them.

### Why this is a design change and not a repair

Reading `chatGuards()` at the click is deliberate and has a good argument behind
it — it is the same read that makes a template's *current* guards apply, and it
is what lets an operator fix a bad default and have the fix take effect. The
code does what it means to. What is wrong is that the untemplated card's promise
is a set of values while the templated card's promise is a handle, and only the
handle survives a re-read. Closing it means deciding what the request carries —
a guards fingerprint the server compares, a `settings.updated_at` the request
pins, or a card that names a handle rather than values — and that is a decision
rather than a fix.

### The strength of this one

`docs/agent/chat.md` states the invariant this breaks, in the sentence that
justifies refusing a deleted template:

> the operator approved the card that said "Fix a bug", and a run under
> different rules than the card stated is what this gate exists to prevent.

That gate is closed against a template that vanished and open against a default
guard set that changed.

---

## F4 — "Only one proposal may continue a run" is caught at approval, and catching it burns the proposal

**Repair.** `src/app/api/mcp/route.ts:1828-1856`.

### The sequence

The chat proposes three runs: `groundwork`, then `polish` and `document`, each
with `dependsOn: [{id: "groundwork", edge: "on-success", continueBranch: true}]`.
Every one of them is accepted by `propose_run`. The operator approves all three
in one click.

### What happens

`propose_run` checks only that *one proposal* does not continue *two* branches
(`route.ts:1829`). `planApprovalBatch` deliberately does not re-decide it
(`src/lib/chat.ts:1060-1064`). `admitDependencies` does, against the live table:

```sql
SELECT id, status FROM runs
 WHERE continues_run = ?
   AND (iterations > 0 OR status NOT IN (...terminal...))
```
— `src/lib/orchestrator.ts:3557-3566`

`polish` is created first and takes the branch; `document`'s admission finds the
rival and throws; `approveProposal`'s catch marks it terminally `failed`.

Measured — [`scripts/rival-continuation.cjs`](scripts/rival-continuation.cjs),
exit 0:

```
started: 2 of 3
  could not start "Document it": Run f1430f7d is already set to continue run
  b53447b0's branch (it is waiting). Two runs cannot extend the same branch;
  pick that one up again instead.

  Lay the groundwork     approved
  Polish it              approved
  Document it            failed
  still offered for decision: 0
```

Two run ids, neither of which was on any card, and a proposal that can never be
approved.

### What should happen instead

`propose_run` should refuse the second proposal, in the model's own terms, at the
moment it is written.

### Why I believe it, from the code

The function's docblock states the policy this is the exception to:

> Deliberately stricter than it has to be. `planProposal` and `createRun` both
> check these again at approval time and only those checks guard anything — but
> a proposal that cannot be approved is discovered by a person clicking Approve
> on a list of twenty, which is the wrong moment and the wrong person.
> — `src/app/api/mcp/route.ts:1657-1663`

And the block that *does* check continuation gives the same reason again, in the
same words, for the two conditions it covers:

> `admitDependencies` refuses both of these as well, but it does so when the
> operator clicks and in terms of run ids they have never seen. — `:1823-1827`

The rival case is the third condition `admitDependencies` refuses, it fails in
exactly the way those two sentences describe, and it is the one that is missing.
Everything needed to check it is already in scope at that line: `labels` holds
every proposal of the chat with its `depends_on` JSON, so "does another proposal
in this chat already continue this label" is a scan of a map that has already
been built.

Note that this compounds with **F2**: the terminal mark is what makes catching
it late expensive rather than merely rude. Fixing F2 alone would leave the
proposal pending and re-approvable, which is most of the harm.

---

## F5 — A restart leaves no record in the conversation, and erases the one it leaves on the row

**Repair.** `src/lib/chat.ts:2446` against `:1706`.

### The sequence

The server goes down mid-turn and comes back. The operator opens the chat and
sends another message.

### What happens

`reconcileChatsOnBoot` sets the row `failed` with an error string and writes
nothing to the thread. `claimTurn`'s UPDATE includes `error=NULL` (`:1618`), so
the next message erases the error. Afterwards there is no record anywhere that a
turn died: the thread is the operator's question followed by their next
question, with no reply and no note between them.

Measured — [`scripts/restart-state.cjs`](scripts/restart-state.cjs), exit 0:

```
chat.error after boot:         "The server restarted while this message was being answered."
messages before / after:       1 / 1
thread:
  user: find me something worth doing

chat.error once the next message claims the turn: null
```

### What should happen instead

The same thing `endTurn` does one screen up, and for the reason it already gives:

```ts
// In the thread as well as on the row: the conversation should read as what
// happened to it, and a turn that stops without a word looks like an answer
// that never came.
if (changed) appendMessage(chatId, "system", error);
```
— `src/lib/chat.ts:1703-1706`

### Why I believe it, from the code

Three of the four ways a turn can end write to the thread — `endTurn` for a
cancel, `endTurn` for a timeout, `finishTurn` for a failure (`:2391`). The
fourth writes only to a column that the next action clears. `reconcileChatsOnBoot`
is one statement with no `appendMessage` beside it and no comment saying the
omission was decided; its docblock explains only *why nothing is resumed*, which
is a different question. The precedent is in the same file, stated as a rule
about what a conversation must read as.

---

## F6 — A stopped turn's capability token stays live while its child dies

**Design change**, and the smallest of the six.

### The sequence

The operator presses Stop. `endTurn` signals and returns. `revokeCapability` is
reachable only from `land` (`:2144`) and the `writeMcpConfig` failure path
(`:2008`), both inside `runOrchestratorChild` — so the token is revoked when the
child *exits*, not when the turn is *ended*.

### What happens

For as long as the child takes to die — up to the eight seconds before SIGKILL
(`:1716`), or the full eleven-minute expiry (`:1540`) if `endTurn` found no
handle to signal and returned `"cleared"` — the stopped turn's token still
authenticates at `/api/mcp`. Its subject is still `{kind: "chat", chatId}`, so it
can still call `propose_run` and `save_template`.

Measured — [`scripts/cross-turn-settle.cjs`](scripts/cross-turn-settle.cjs):

```
live capability tokens the instant after Stop: 1
```

The script establishes that the token is live and that the child outlives the
Stop by two seconds; it does not drive an MCP call through it, so "a proposal can
still be written after Stop" is read from the route's auth path
(`src/app/api/mcp/route.ts:1211`) rather than exercised.

### What should happen instead

Debatable, which is why this is a design change rather than a repair. The token
is bounded, in memory, and dies with the process; a proposal written after Stop
is inert and visible on the page. But `mintCapability`'s docblock says "revoked
the moment the turn's child exits", and `endTurn`'s whole argument is that the
row must be usable *before* the child is gone — the two sentences describe
different instants, and only one of them is the instant the operator acted at.

---

## F7 — A batch where every member fails answers 200

**Design change**, ranked last because the operator *is* told, in the thread.

`.../proposals/route.ts:92-107` returns 400 when nothing is actionable, and says
why: a 200 with an empty `started` "is indistinguishable from a batch that
worked: the page clears the selection on `res.ok` and shows no error". When
`targets` is non-empty and every member's `createRun` throws, the same route
returns 200 with `started: []` (`:165-171`) — the shape it just refused to send.
`decisionNote` is appended to the thread with a `Could not start "…"` line per
failure, so this is a weaker signal in a different place rather than silence.

Whether the page surfaces the `failed` array is the companion survey's ground.
