# Suspected but unverified

Four things this survey could trace but could not establish. None of them is in
[`02-findings.md`](02-findings.md) and none should be acted on as though it
were.

---

## S1 — Whether a signalled `claude` prints its final JSON, and what that costs

`finishTurn`'s comment asserts:

> Nothing is lost by that — the CLI reports cost and session id only in the final
> JSON object, which a child that was signalled never prints.
> — `src/lib/chat.ts:2337-2339`

Not verified here, in either direction. `scripts/cross-turn-settle.cjs` uses a
fake `claude` that traps SIGINT deliberately, so it exercises the *if* and says
nothing about the real CLI at the pin.

**Why it matters, and why F1 does not depend on it.** If a signalled child does
print, a cancelled turn's spend is silently dropped from `chat_sessions.cost_usd`
and from `chat_turn_spend` — the row the install-wide ceiling reads. If it does
not print, `parseTurnOutput` returns a *failed* result, which still walks
through F1's latch and settles the next turn's row as `failed` with the killed
child's stderr. So F1 holds either way; only the content of the wrong settle
changes. What is unverified is the size of the money leak beside it.

**What would settle it:** one run of the pinned CLI under `-p`, SIGINT'd
mid-answer, with stdout captured. Single-digit cents.

---

## S2 — An answer whose questions are superseded between the read and the claim

`answerChatQuestions` (`src/lib/chat.ts:1920`) reads `pendingQuestions(chatId)`
and settles them, then calls `sendChatMessage`, which `await`s
`assistRefusal()` — a full transcript scan, "seconds long on a large
`~/.claude`" by `claimTurn`'s own docblock — *before* taking the claim and
running `settleOpenQuestions`.

If an ordinary message from another tab lands inside that window, its own
`settleOpenQuestions` supersedes every open question. The answering request then
loses the claim and returns `ALREADY_THINKING`, which is correct. But if the
ordering is the other way — the ordinary message's turn settles first, and the
answering request then wins the claim — `settleOpenQuestions`' UPDATE is bounded
by `status='pending'` (`:554`) and no-ops, so the rows stay `superseded` with
`answer` and `answered_at` null while the message quoting the operator's answers
still goes to the model.

**What I could not establish:** whether that second ordering is reachable in
practice, and whether it matters. The model gets the answers either way — the
text is built from `settlement.entries`, which was computed before the race. What
is lost is the record on the row that the operator answered at all. This is a
plausible reading of the code, not an observed sequence; I did not drive two
concurrent requests.

---

## S3 — A reused `spec_id` shadowing an approved one in the `outside` map

`propose_run` allows a label to be reused once the earlier proposal carrying it
is no longer pending, and gives a reason:

> Only against what is still undecided: a label reused after the first one has
> become a run is unambiguous, because a dependency resolves against the batch
> first and only then against what already started.
> — `src/app/api/mcp/route.ts:1765-1768`

`approveRunBatch` builds the "what already started" map as:

```ts
for (const p of listProposals(chatId)) {
  if (wanted.has(p.id) || !p.spec_id) continue;
  outside.set(p.spec_id, { status: p.status, runId: p.run_id });
}
```
— `src/lib/chat.ts:1323-1326`

`listProposals` is `ORDER BY created_at, id` (`:414`), so for a reused label the
**newest** row wins the key, not the one that became a run. A third proposal
depending on that label, approved on its own, would resolve against a *pending*
namesake and be refused with "still waiting for a decision. Approve them
together." rather than being wired to the run that exists.

**Why this is here and not in the findings.** The refusal is safe, it names
something the operator can act on, and which of the two same-named proposals the
model meant is genuinely ambiguous — refusing may be the right answer. I did not
drive it, and I cannot say what the correct behaviour is, only that the sentence
justifying the reuse describes a lookup the code does not perform.

---

## S4 — How long F3's stale card really lives

[F3](02-findings.md#f3) is measured; the size of its window is not. The floor is
`POLL_IDLE_MS`, 10 s (`src/app/chat/page.tsx:54`). The claim that it is longer
in a backgrounded tab rests on ordinary browser timer throttling rather than on
anything measured here, and the claim that it is longer after a failed poll
rests on the page's own comment (`:1389`) rather than on an observed failure.

**What would settle it:** open the chat, background the tab, change
`chatDefaultGuards`, foreground and click — and record how stale the card was.
Five minutes with a browser.
