# Recommendation

**Fix F2 first, F1 second, F5 third, F4 fourth. Decide F3 rather than fixing it,
and leave F6 and F7 alone until something else touches their file.**

That is not the order of severity. F3 is the worst outcome in the set — a run
that does what the operator did not agree to — and it is fourth in the list
because it is the only one that is a decision rather than a fix, and a decision
made in a hurry to close a gap is how the gap comes back somewhere else.

---

## The order, and why

### 1. F2 — stop a transient refusal deciding a proposal

**Repair, and the cheapest thing here.** One condition in one catch:

```ts
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err);
  markProposal(id, "failed", { error: reason });   // ← unconditional today
  return { ok: false, reason };
}
```
— `src/lib/chat.ts:1278-1285`

The two transient throws are both already sentences produced by named functions
— `installBudgetRefusal()` and `requireDataDir()` — so the discrimination does
not need to be a string match. The cleaner shape is to ask both questions
*before* `createRun`, in `approveRunBatch` rather than per proposal, and refuse
the whole click with a 400 the way an empty batch is refused: one check, one
sentence, nothing decided. That also fixes the batch multiplication, where one
ceiling trip currently destroys every member in turn.

It goes first because it is small, because it is the difference between "the
click did nothing" and "the click destroyed the work", and because it takes most
of the cost out of F4 as a side effect.

### 2. F1 — make a settle belong to its turn

**Repair.** `finishTurn` needs a turn identity to latch on. The row already
carries something close to one: `turn_started_at` is written by the same
statement that claims the turn (`:1618`) and cleared by every settle, so
`WHERE id=? AND status='thinking' AND turn_started_at=?` with the value the
child was spawned under would close it without a migration. A monotonic
`turn_seq` column would be cleaner and is a schema change; either is a smaller
edit than the comment at `:2218` that already names the scenario.

Second rather than first only because it is a slightly larger edit. Its cost is
the highest in the set for an operator who uses Stop: a message answered by the
turn they stopped, their real answer discarded, and the one-child guard open.

### 3. F5 — say in the thread that the turn died

**Repair, and three lines.** `reconcileChatsOnBoot` becomes a `SELECT` of the
`thinking` ids, the existing `UPDATE`, and an `appendMessage` per id — the shape
`endTurn` already has at `:1703-1706`, for the reason it already gives.

Third because it is trivial and because it is the one finding here that costs an
operator *understanding* rather than work. It is worth doing at the same time as
F1: both are about a turn ending without the conversation saying so, and a
reviewer looking at one will ask about the other.

### 4. F4 — refuse the rival continuation where the model can read it

**Repair.** `propose_run` already builds `labels` — every proposal of the chat
with its `depends_on` JSON — two dozen lines above the block that checks
continuation (`src/app/api/mcp/route.ts:1750`). The check is a scan of that map
for another pending proposal already continuing the same label, and the sentence
belongs beside the two that are already there at `:1829` and `:1848`.

Fourth because F2 removes most of its cost: with the proposal left pending
rather than burned, a rival caught late is a rude message instead of lost work.
Do it anyway — the whole argument for `propose_run` being "deliberately stricter
than it has to be" is that the operator should not meet a graph problem in terms
of run ids.

### 5. F3 — decide what the request carries

**Design change. Do not patch it.** Three shapes, and picking one is the work:

- **Pin the guards.** The approval request carries a fingerprint of the guard set
  the card was rendered with, and the route refuses on mismatch with "the default
  guard set changed since this card was drawn — reload and look again". Strictly
  correct, and it is the same argument the route already makes for the ids. Costs
  a field on the DTO, a field on the request, and a refusal an operator can hit
  by leaving a tab open.
- **Pin the settings version.** The request carries `settings.updated_at`; the
  route refuses if it has moved. Cheaper, coarser, and refuses clicks that
  changed nothing relevant.
- **Give the untemplated card a handle.** Stop showing values and show something
  the operator can go and read, the way a template's name works. This is the
  option that removes the class rather than the instance — but it directly
  contradicts `defaultGuardsLabel`'s own reasoning that "an approval gate that
  does not show what is being approved is a gate that gets clicked through", so
  it is the one that needs the most argument.

The first is the survey's preference, and it is a preference rather than a
recommendation: this survey did not measure how often an operator edits
`chatDefaultGuards` with a chat open, and that number is what decides whether the
refusal is a safeguard or an irritation.

### 6 and 7. F6 and F7 — leave them

F6 costs a token eight seconds of extra life inside one process, on a credential
that dies with that process anyway. F7 is a weaker signal in a different place,
not silence. Both are worth a line in whatever change next touches `endTurn` and
the proposals route respectively; neither is worth a change of its own.

---

## What would overturn this order

**F2 and F4 both rest on `failed` being terminal.** If a future change makes a
failed proposal re-approvable — a "try again" on the card, say — F2 collapses to
a confusing message and F4 to a rude one, and F1 becomes the only thing here
worth a work cycle.

**F1 rests on Stop and the retry being reachable in the same few seconds.** If
the page disables the composer until the child is confirmed gone, the cancel half
closes — but the timeout half does not, because there the operator is not present
to be disabled and the turn fails out from under a child that may still answer
inside `STALE_TURN_MARGIN_MS`.

**F3 rests on the card carrying values.** If the untemplated card ever stops
spelling the guards out, F3 becomes the templated case, which is already
decided and defensible.

---

## What this does not recommend

No new abstraction, no new table, no "approval preflight" service. Four of the
six are single-function edits and the fifth is a decision. The temptation this
survey wants to name and refuse is a general "validate everything at approval
time" pass: three doors already re-check the same conditions, each with its own
reason for doing so and its own sentence, and a fourth layer over the top would
be a fourth place to keep in step with `admitDependencies`.
