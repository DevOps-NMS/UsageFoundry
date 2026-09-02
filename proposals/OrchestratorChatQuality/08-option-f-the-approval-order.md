# Option F — say the order, not just the rule

[← Option E](07-option-e-the-duplicate-check.md) · [Next: the comparison →](09-comparison.md)

**Answers [F7](02-findings.md#f7).** One clause added to an existing prompt line.

## The problem

Three operator messages, in three separate conversations, all asking the same
thing:

> *"can you give me the run order in which to approve them?"*
>
> *"ok, whats the execution steps now, tell me what to approve in what order?"*
>
> *"can you not use the run after feature so i can just approve all and they run
> in the correct order?"*

Those three turns cost 1,201, 1,972 and 3,103 characters of reply and — for two
of them — zero or near-zero tool calls. They are pure bookkeeping: the operator
re-asking for information the previous turn had and did not say.

The instruction that governs the previous turn is
`src/lib/chat.ts:2578-2579`:

> ```
> "- Say in your reply that they have to be approved in the same click. A",
> "  dependent approved on its own is failed by name rather than started.",
> ```

**81 of 85 dependency-carrying turns (95.3%) complied.** This is not a
compliance problem. The rule *approve them in the same click* is a rule about
the **click**; the operator is asking about the **sequence**, and those are
different sentences. A model that does exactly what this line says produces a
reply that answers a question the operator did not have.

## Why the gap is large on this install

**142 of 175 `on-success` edges also carry `continueBranch`**, which serialises
the chain onto one branch. One observed turn proposed a seven-deep strictly
serial chain — `kit → shell → dashboard → runform → settings → rundetail →
workflows` — every link `on-success` + `continueBranch`, and told the operator:

> *"Each is chained with `continueBranch`, because a design overhaul where five
> agents each re-decide what a Card looks like produces five diffs that cannot
> merge. The cost is that it is strictly serial, and all seven commit to **one**
> branch…"*

That is a very good reply. It numbered the proposals 1–7 with `← kit`-style
arrows and named the cost of its own choice. **Nothing in the prompt asked for
any of that.** It is what a model does when it has room; the three turns above
are what happens when it does the minimum the prompt specifies.

## The change

`src/lib/chat.ts:2578-2579`, extended:

```
"- Say in your reply that they have to be approved in the same click, and",
"  give the order they will run in — by the ids you gave them, shortest",
"  first. A dependent approved on its own is failed by name rather than",
"  started, and an operator holding seven cards and no sequence asks you",
"  for one, which costs a turn.",
```

*"by the ids you gave them"* matters: **314 of 450 proposals (69.8%) already
carry an `id`**, well above the 206 that are named by an edge, so the labels
exist and cost nothing to reuse. The reply that did this well used exactly
them (`← kit`, `← shell`).

## What this cannot fix

**The panel may already show the order and this survey does not know.** No
browser was opened. `docs/orchestrator-chat.md:39-49` says a proposal *"can carry
a short label and say it starts after another proposal in the same
conversation"* and that the card *"say[s] what it waits for" — which is a
per-card statement of its own predecessor, not a sequence. Whether the panel
composes those into a readable order is exactly the thing three operator
sentences suggest it does not, and exactly the thing a screenshot would settle in
thirty seconds.

So this option is the **prompt-side half of a two-sided problem**, and it is
worth saying which half is likely to be the bigger one. If the panel does not
render the chain, a sentence in the reply is a workaround for a missing view, and
the right fix is in `src/app/chat/page.tsx` — out of scope here and not
recommended from this evidence. The prompt-side clause is worth having anyway,
because it costs 30 tokens and because the reply is where an operator reading on
a phone actually is.

## The variant that is refused

**Telling the model to prefer fewer dependencies.** The third operator message
— *"can you not use the run after feature so i can just approve all and they run
in the correct order?"* — reads as a request for exactly that, and it is the
wrong lesson to take.

`src/lib/chat.ts:2571-2574` already decides this:

> ```
> "- Runs on one folder are serialised anyway, and runs in their own checkouts",
> "  are not. Order them when the *work* has an order — a fix before the test",
> "  that proves it, a refactor before what builds on it — not to avoid a",
> "  collision the folder claim already prevents.",
> ```

And `docs/orchestrator-chat.md:46-49` says why the dependency exists at all:
*"a run told to wait and started immediately is indistinguishable from a run that
was never told, and both agents then work in the same checkout in whatever order
the queue felt like."* The operator's request, granted literally, produces
precisely that. The chain in the seven-deep example is load-bearing — seven
agents each re-deciding what a Card looks like is the failure it prevents.

The operator does not want fewer dependencies. They want to know what they are
approving, which is one clause, not a feature retreat.

## Cost

| | |
|---|---|
| Lines changed | 5 in `src/lib/chat.ts`, replacing 2 |
| Tokens added per turn | ~30 |
| Risk | Very low; it lengthens a reply that is already median 2,188 characters, which [F8](02-findings.md#f8) says is the direction of travel. Roughly one line per chain |
| Verifiable | Partly. Whether the model states an order is greppable; whether the operator stops asking is three data points and would need a fortnight |
