# Option 8c — a stated budget on asking

[Option 3a](09-option-3a-one-question.md) bounds how many questions may be
*open* at once, and says outright that it "does not forbid a second question
after the first is answered". This file is that gap: what stops a model asking
four times in a row, one at a time, each one legal? Three forms are on the
table, two of them numeric. The numeric ones are refused on separate grounds.

## (i) A configurable setting

`settings.maxQuestionsPerChat`, on the Settings page beside the guard set, so
the operator picks their own tolerance.

Refused on [C9](01-constraints.md#c9). `docs/agent/chat.md:26` already refused
the nearest neighbour, and its reason is general:

> there is no per-chat fraction and **inventing one would be a threshold nobody
> set.**

That sentence is about money, which at least has a unit the operator reasons in
— they already set `chatTurnBudgetUSD`, and a dollar means the same thing in
every chat. A question count is the same invented threshold with *less*
justification. Ask an operator to pick a number and they have no basis: three is
generous for "rerun the flaky test" and mean for "plan the migration". The right
value is a property of the conversation, and a setting is by construction the
same across all of them.

There is a second cost. Every setting is a thing the operator must understand
before the feature works, and this one would appear in the UI as a number with
no observable consequence until the day it silently changes what a model does.
That is the worst shape a setting can have.

## (ii) A hard per-chat cap enforced in the tool

The [C8](01-constraints.md#c8) shape: `MAX_QUESTIONS_PER_CHAT`, checked at the
door in `callTool`, refused with a sentence.

The hearing it deserves is a real one. The precedent is exact and it is on this
exact surface: `MAX_PENDING_PROPOSALS = 25` is enforced at `route.ts:1533-1536`
and `:1323-1326`, and its docblock (`chat.ts:231-241`) states the transferable
property — the cap "refuses past this and says so, so the model asks for a
filter instead of silently proposing the first twenty-five". A door check is a
fact where prose is advice, it explains itself to the model rather than
truncating silently, and it turns a bound the model can reason around into one
it cannot. Everything [Option 3a](09-option-3a-one-question.md) says in favour
of the one-open-question refusal says the same in favour of this.

**It is refused on the failure it creates.** The model that legitimately needs a
fifth question in a long thread is refused, and it does not stop working — it
**proposes anyway, under a guess it now has no way to check**, and the operator
approves it believing it was researched.

That failure is not hypothetical. `docs/agent/chat.md:24` records it happening,
which is why the tool allowlist was removed:

> the allowlist this replaced […] refused every question it had not anticipated
> (a build log, `gh api`, `git -C <path> log`, anything compound), **which is a
> bad proposal an operator then approves believing it was researched.**

Same mechanism, same outcome: a bound that fires on the case nobody anticipated
converts a research gap into a confident-looking card.

And `MAX_PENDING_PROPOSALS` is different in kind, which is what makes the
precedent look closer than it is. It bounds **a list on screen** — the docblock's
own reason is that "an approval list nobody can read is an approval gate that
gets clicked through" — and its refusal hands the model somewhere to go. The
actual text (`route.ts:1357-1366`, verified):

> "Tell the operator what you would propose next and ask them to approve or
> reject these first, or narrow what you are proposing."

Both branches are moves the model can make, and neither degrades the work. Now
write the equivalent for questions. "You have asked enough questions" leaves
exactly one move: guess. There is no narrowing available, because the missing
fact is the operator's and the tool that would get it is the one just closed.

## (iii) Prose, plus the structural one-open-question cap

The recommendation. The budget is stated as a rule of thumb in `systemPrompt()`,
in the asking paragraph [Option 8a](20-option-8a-prompt-side.md) proposes:

```
- One question per topic. Wanting a second means you are guessing at the
  shape of the work: say that, and propose the smallest thing you are sure
  of.
```

Two properties make this stronger than it looks.

**It fails soft.** A model that needs the second question can ask it and has
been told what that means about its own understanding — which is a better
prompt for self-correction than a refusal, because it names the diagnosis rather
than the limit. When the rule is ignored the cost is one extra turn; when a cap
is hit the cost is a wrong proposal that looks right.

**The structural bound underneath it cannot be argued with.** One question open
at a time is a door check ([3a](09-option-3a-one-question.md)), and it already
does the heavy lifting: an interrogation cannot be *batched*. Every additional
question costs a full round trip — a settled turn, up to ten seconds of poll
latency (`POLL_IDLE_MS = 10_000`, [C3](01-constraints.md#c3)), the operator's
attention, and a second billed child for the answer
([F7](00-problem.md#f7)). Serialisation is itself a tax on asking, applied
per question, with no ceiling to hit and no cliff to fall off.

**And the real bound is that it is visible.** Four question cards in a row is
legible to the operator in a way no quota is. They can say "stop asking and
propose something", and the next turn reads it — a control that is available at
the moment it is needed, exercised by the person whose attention is being spent,
and calibrated to the conversation they are actually in. A hidden counter gives
them none of that: it fires without their knowledge, on a number they did not
choose, in the case they might have been happy to allow.

## What would settle this with data

The quota argument should not be reopened as opinion, and it does not have to
be. `chat_turn_spend` writes one dated row per settled turn with non-zero cost
(`chat.ts:1975-1981`), and the table is `(id, chat_id, ts, cost_usd)` with
`chat_id` a foreign key to `chat_sessions` (`db.ts:1171-1180`, read directly). A
`chat_questions` table keyed the same way makes **questions per settled turn**
one join:

```sql
SELECT c.chat_id,
       COUNT(DISTINCT q.id)  AS questions,
       COUNT(DISTINCT c.id)  AS settled_turns
FROM chat_turn_spend c
LEFT JOIN chat_questions q ON q.chat_id = c.chat_id
GROUP BY c.chat_id;
```

The number that would change the answer: **a chat reaching four questions before
its first approved proposal, in more than a small minority of threads.** That is
the interrogation this fork exists to prevent, and at that rate the prose is not
working and a hard cap's failure mode is the cheaper one. Below it — one or two
questions per thread, questions trailing off as the thread settles — the prose
is doing its job and a cap would only fire on the outliers, which are the threads
most likely to have needed the question.

What the join cannot answer, and should be said plainly: **whether a question was
worth asking.** No column records whether the answer changed the proposal.
Frequency is measurable, value is not, and a decision to cap should rest on the
first only when it is extreme.

## Verdict

**Prose plus the structural cap. Both numeric forms refused, each on its own
ground.** The setting is the threshold nobody set, in a unit nobody can reason
about (C9). The hard cap is refused on its failure and not on its mechanism: it
fires on the thread that most needed the question, and turns a research gap into
a confident card, which `docs/agent/chat.md:24` records as the exact failure the
allowlist's removal was paid for. The one-open-question door check makes asking
serial and therefore expensive per question, the prompt says what a second
question means, and the operator can see the cards stacking up and say stop —
which is a control no threshold gives them. If the data later says four
questions before a first proposal is common, this reopens with a number attached.
