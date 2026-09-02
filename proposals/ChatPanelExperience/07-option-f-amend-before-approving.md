# Option F — a third answer between approve and reject

**Answers:** C4. Nothing else.

**This is the option the survey refuses**, and it is written at length because
the refusal is not obvious and the reversing fact is a single sentence from the
operator.

---

## The problem it addresses

`POST /api/chat/[id]/proposals` takes `action: "approve" | "reject"` and ids
(`route.ts:55-61`). There is no third door. A proposal whose task is right and
whose folder is wrong costs:

1. a rejection,
2. a typed correction into the composer,
3. **another billed turn** — minutes of waiting, up to `chatTurnBudgetUSD`
   ($2 default, `settings.ts:883`), and a fresh child that re-reads whatever it
   read the first time,
4. a new card to review.

Four steps and real money to change one string the operator can see on screen.

## What it would be

Three shapes, in increasing order of cost and of danger.

**F-a. Amend the task.** The card's task becomes editable before approval; the
approval route takes an optional `task` per id and `planProposal` uses it. The
audit row records both the model's text and the operator's.

**F-b. Amend the work fields.** Task, folder, agent, and *which template*
applies. Every one of these is on the work side of X1 — a template is a thing
the operator wrote, and choosing between two of them is what the run form does.
No guard is set; a guard is *selected* by naming a different template, exactly
as approving an untemplated proposal selects `chatDefaultGuards`.

**F-c. Open it in the run form.** "Approve as…" pre-fills `/runs/new` from the
proposal and marks the proposal decided when the run is created. No new
approval semantics at all — the operator is using the form they already use, on
text a model wrote.

## Why it is refused

**1. The approval gate's claim is about the card that was read.**
`docs/agent/chat.md` and `route.ts:22-32` both rest on the same property: the
operator approved *this* text, under *these* guards, and the route takes the ids
the page displayed so nothing else is swept in. An amendable card weakens the
claim in a way that has to be handled rather than assumed: what was approved is
now a thing neither the model nor the operator wrote alone. F-a is the cheapest
shape and it is the one that most muddies this — `chat_proposals.task` would
hold text the model did not write, and every downstream reader (`decisionNote`,
the run's own record, the `Decided` tab) would report it as the proposal.

**2. It is the only option here that changes the approval route.** Everything
else in this directory is a DTO field, a CSS decision or a string.
`route.ts`'s docblock calls it "the only route in the app that turns something a
model wrote into processes with write access to folders", and the synchronous
no-`await` pass is load-bearing for `createRun`'s folder claim. Adding
per-id payload to that route is not a large change and it is a change to the
smallest, most carefully bounded surface in the feature.

**3. Two thirds of the pain is C1 and C2, not C4.** The reason an operator
rejects a card is usually that they could not see what it said. Measured: a
third of the task is visible, and a templated card states no guards.
[06-option-e](06-option-e-open-the-proposal.md) makes the card readable for ~40
lines and no route change. **A proposal that reads correctly is one that does
not need amending**, and until E has shipped nobody can say how much of C4 is
left.

**4. F-c already exists in pieces and nobody has asked for it.** `/runs/new`
takes a form; the proposal has every field it needs. That it has not been built
is weak evidence, but it is evidence: the friction has not been reported.

## What would reverse the refusal

One sentence from the operator: *"I reject and re-ask because the folder or the
template is wrong, not because the task is wrong."* That says the pain is C4
rather than C1/C2, and it moves **F-b** — not F-a — from refused to first,
because a folder and a template are selections among things a person wrote and
carry none of F-a's authorship problem.

The measurement that would settle it is on the data: count `rejected`
proposals whose thread's next user message is a near-duplicate of the rejected
task. That query needs `chat_proposals` rows from a real install, and **this
survey could not run it** — the two databases in this image
(`/workspace/UsageFoundry/.data/usagefoundry.db` and the standalone copy beside
it) are outside this worktree's sandbox and `better-sqlite3` returns "unable to
open database file" on both. So the strength of C4 is unmeasured, and that is
the largest gap under this option.

## Score

Scores on exactly one finding, costs the most sensitive route in the feature,
and is dominated by Option E for the case that probably causes most of the pain.
Refused, with the sentence that reverses it stated above.
