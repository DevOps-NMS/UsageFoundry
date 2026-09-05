# Option E — move the duplicate check to where proposing is decided

[← Option D](06-option-d-the-edge-pair.md) · [Next: Option F →](08-option-f-the-approval-order.md)

**Answers [F5](02-findings.md#f5).** One line moved in `systemPrompt()`, one
clause added.

## The problem

`list_proposals` is consulted on **61.9%** of first proposing turns, where there
is nothing to duplicate, and on **21.4%** of second-and-later ones, where the
panel holds everything the previous turn produced.

The prompt mentions the tool once, in the orientation block —
`src/lib/chat.ts:2529-2536`:

> ```
> "Reading the state of things:",
> "- Folder paths must come from list_folders; do not invent one. …",
> "- If a 5-hour or weekly window is nearly spent, say so — …",
> "- list_proposals carries the id you gave each proposal in this chat.",
> ```

That is a true and useful sentence about `dependsOn` ids, sitting in the block
the model reads at the top of a turn. It gets the tool called early, with the
other read tools, for the id reason. The duplicate reason lives only in the tool's
own description (`src/app/api/mcp/route.ts:258-260`, *"so the same work is not
proposed twice"*) and the "Proposing a run" block
(`src/lib/chat.ts:2556-2568`) never mentions the tool at all.

## The change

Leave the orientation line where it is — the id fact belongs there — and add one
line to the proposing block, `src/lib/chat.ts:2556-2568`, after
*"One proposal per unit of work"*:

```
"- On a second or later turn in a conversation, read list_proposals first:",
"  what you proposed last turn is still in the panel, undecided, and a near",
"  duplicate of it costs the operator a card to read and a decision to take.",
```

Two properties worth being explicit about:

- **It names the position, not the tool's purpose.** The purpose is already
  written, in the description, correctly. What the model lacks is a trigger tied
  to *when* — and the corpus says the trigger it currently has fires at the wrong
  time.
- **It is scoped to later turns.** Telling the model to always call
  `list_proposals` would raise the 61.9% toward 100% and buy nothing; 63 of 98
  conversations are single-turn, so a blanket rule mostly adds a call to a
  conversation that has no history.

## The same argument for `list_runs`, and why it is not made

`list_runs` carries the identical purpose against a different corpus —
`src/app/api/mcp/route.ts:168-173`:

> ```
> "List recent runs with their status, folder and spend, so work already " +
> "in flight is not proposed a second time. A run whose status is " +
> "needs-review is not in flight: it is finished, holds nothing, and is " +
> "waiting on a person, so proposing work that depends on it parks that " +
> "work on the same question.",
> ```

It is called before proposing on **63.2%** of turns, with the same first-turn
skew. But the failure it prevents is different in kind: a run in flight was
started by a *previous* turn or by the operator by hand, so a first turn is
exactly when the check matters. Its 63.2% is therefore not obviously misplaced,
and this survey has no measurement that says it is. **No change proposed.**

## What is not established

**Nothing in this corpus shows work actually proposed twice.** `list_proposals`
returns rows from the unreadable database, so the transcripts show that the call
happened and not what came back. This option is a repair to the *placement of a
trigger*, argued from the trigger firing at the wrong time, not from a count of
duplicates. That is the weakest evidential base of any option here and is why it
ranks where it does in [09-comparison.md](09-comparison.md).

The check that would settle it needs one read the survey could not make: for each
conversation with two or more proposing turns, whether any two proposals across
turns carry the same title or overlapping folder-plus-issue-number. The
transcripts hold the proposal arguments, so this is computable — it was not
computed because it needs a similarity judgement rather than a count, and
`scripts/` deliberately contains nothing that guesses.

## Cost

| | |
|---|---|
| Lines changed | 3 added to `src/lib/chat.ts` |
| Tokens added per turn | ~35 |
| Risk | Very low. The worst case is one extra tool call on a turn that did not need it |
| Risk it does nothing | **High.** This is the option most likely to be a no-op: the model may skip the call on later turns because it already has the previous turn's proposals in its own context, in which case 21.4% is correct behaviour and not a gap |
| Verifiable | Yes, cheaply: `scripts/final.mjs` prints the first-versus-later split |

That last row is worth stating plainly rather than hiding in a table. With a
resumed session the model *does* have the previous turn in context —
`chatPrompt()` returns the bare message when `sessionId` is set
(`src/lib/chat.ts:972`) precisely because *"the thread is already in the
conversation and restating it is spend for no information"*. So a model skipping
`list_proposals` on turn 2 may be reasoning correctly from memory. What it cannot
know from memory is what the **operator did** with those proposals in between —
approved, rejected, still pending — and that is the half `list_proposals` reports
that the thread does not.
