# Option B — name the asking tool in the prompt

[← Option A](03-option-a-change-nothing.md) · [Next: Option C →](05-option-c-standing-instructions.md)

**Answers [F1](02-findings.md#f1).** One sentence added to `systemPrompt()`, and
nothing removed.

## The change

`src/lib/chat.ts:2543-2554` currently opens the paragraph with a bare heading and
three restrictive bullets. Add a fourth line, first, that names the tool and says
the thing none of the three say — that asking is an action with a mechanism:

```
"Asking the operator:",
"- When you do ask, it is `ask_operator`: it records the questions, ends your",
"  turn, and the operator's next message is the answer. Read its description",
"  before you use it — the judgement about what is worth asking is in there.",
"- Ask only for what only they know: …",
```

Three clauses, each doing one job:

- **`ask_operator`** is a literal the model can hand to a schema fetch. On the
  three occasions the model went looking, the query was
  `select:mcp__uf__ask_operator` — a name is what that mechanism takes.
- **"records the questions, ends your turn"** is the one fact from the deferred
  description that the model must not get wrong even if it never fetches it. The
  comment at `src/app/api/mcp/route.ts:298-300` says why: a model that thinks the
  tool returns an answer *"calls it, gets a receipt, calls it again, and spends
  the turn's whole budget asking the same question in a loop"*.
- **"Read its description"** is the pointer that makes the other 1,000 characters
  reachable without copying them into the prompt.

## Why this rather than moving the description into the prompt

The obvious alternative is to move the asking judgement out of
`src/app/api/mcp/route.ts:302-321` and into `systemPrompt()`, where it is read
every turn. The file argues against that in advance —
`src/app/api/mcp/route.ts:293-296`:

> ```
> // asking, and it is long for `systemPrompt()`'s stated reason: the
> // tool-calling half of the orchestrator's instructions lives here, where it
> // cannot drift from the schema, and is deliberately not repeated in the
> // prompt.
> ```

That reasoning holds and this option does not disturb it. The 1,100 characters
stay where they cannot drift from the schema; what changes is that the prompt now
tells the model there is something there to fetch. The three-clause line above
duplicates exactly **one** fact — that the tool does not return an answer — and
that duplication is deliberate, because it is the only sentence whose absence
costs a whole turn's budget rather than a worse decision.

`src/lib/chat.ts:2478-2482` is the standing rule on this and it points the same
way:

> ```
>  * *say* in the reply, which is about this conversation rather than about a
>  * call. Before deleting a sentence from a description over there, check it is
>  * not the only copy left.
> ```

The inverse applies here: before leaving a sentence in exactly one place, check
that place is read.

## What it does not do

**It does not raise the asking rate on its own, and should not be judged on
that.** The three restrictive bullets are untouched and they are the reason the
rate is 2%. What changes is *which* text produces the 2% — after this, a model
that does not ask has declined for the reasons at
`src/app/api/mcp/route.ts:302-321`, rather than never having read them.

That distinction is the whole value and it is worth being honest that it is a
modest one. If the operator's actual complaint is "it should ask me more", this
option alone will not fix it; the bullet at `src/lib/chat.ts:2549-2551` —
*"Prefer proposing with the assumption stated in your reply"* — would also have
to move, and **this survey does not recommend moving it**, because
[Option A](03-option-a-change-nothing.md) is right that 82.2%-propose is the
designed behaviour and nothing here measures it as wrong.

## Cost

| | |
|---|---|
| Lines changed | 4 added to `src/lib/chat.ts`, 0 removed |
| Tokens added per turn | ~45, against a ~1,400-token system prompt |
| Risk of over-correction | Real but small: the three restrictive bullets still follow it, and the added line is procedural rather than encouraging |
| Risk it does nothing | **Real.** `get_usage` is unnamed and is fetched 82/160 times, so naming is not necessary for a tool whose action the prompt describes imperatively. The falsifier is in [11-validation.md](11-validation.md) |
| Verifiable | Yes, and cheaply: re-run `scripts/verify.mjs` a fortnight later and count `ask_operator` in the `ToolSearch` queries |

## The variant worth naming and refusing

**Putting `ask_operator` on the argv's `--allowedTools`.** The chat child already
carries one allowlist (`src/lib/chat.ts:2074`, `args.push("--allowedTools",
...SEARCH_TOOLS)`) whose stated purpose is *"naming `Grep` and `Glob` is what
makes the pinned CLI offer them at all"*. It is tempting to do the same for the
MCP tools, on the theory that a named tool is not deferred.

**Refused**, on two grounds. First, it is a spawn-argv change, which is outside
this survey's scope by the brief and inside `docs/agent/security.md`'s routing.
Second, and worse, it is a behavioural bet on the pinned CLI's deferral rules,
which no measurement here supports — the corpus shows `ToolSearch` in use from
the first conversation (2026-08-11) to the last (2026-09-02), including on turns
that called `propose_run`, so the deferral is not something a name on the argv is
known to switch off. It would be a change whose effect is unknown made in the
file where a mistake is expensive.
