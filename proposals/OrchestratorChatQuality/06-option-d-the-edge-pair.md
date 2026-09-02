# Option D — make each dependency field name the other

[← Option C](05-option-c-standing-instructions.md) · [Next: Option E →](07-option-e-the-duplicate-check.md)

**Answers [F3](02-findings.md#f3) and [F4](02-findings.md#f4).** Two parameter
descriptions in `src/app/api/mcp/route.ts`; nothing added to the prompt.

## The problem in one line

`edge` decides *when* the dependent starts. `continueBranch` decides *what state
it starts in*. Each description is correct on its own and neither mentions the
other, so the one combination that is dangerous — `on-finish` with
`continueBranch` — reads as two independently reasonable choices.

## The change to `edge`

`src/app/api/mcp/route.ts:442-448` as it stands:

> ```
> edge: {
>   type: "string",
>   enum: ["on-success", "on-finish"],
>   description:
>     "on-success starts only if that run completed; on-finish " +
>     "starts once it is out of the way either way.",
> },
> ```

Proposed:

```
edge: {
  type: "string",
  enum: ["on-success", "on-finish"],
  description:
    "There is no default: pick the one you mean. on-success starts only " +
    "if that run completed — which ends a chain the operator meant to run " +
    "regardless. on-finish starts once it is out of the way either way — " +
    "including after it crashed, so anything it left half-done is what " +
    "this run opens on. Use on-finish for work that is worth doing whether " +
    "or not the first run got there, and on-success for work that reads, " +
    "reviews or builds on what the first run produced.",
},
```

This copies the system prompt's own clause (`src/lib/chat.ts:2575-2577`) into the
schema rather than replacing it. The duplication is deliberate and is the
opposite of the usual rule, for one reason: the prompt states the hazard as a
warning about *picking an edge*, forty lines away from the field, and the model
picks the edge while reading the schema. The corpus supports the split it
argues for — **175 `on-success` to 31 `on-finish`** — and does not support
declaring it wrong; what it shows is that when `on-finish` is chosen, the
half-done-branch consequence is not in view.

## The change to `continueBranch`

`src/app/api/mcp/route.ts:449-455` as it stands:

> ```
> continueBranch: {
>   type: "boolean",
>   description:
>     "Carry on that run's branch instead of cutting a fresh one, " +
>     "so this agent starts with its commits already there. Only " +
>     "when both runs work in a checkout of their own, and only " +
>     "one proposal may continue any given run.",
> },
> ```

Proposed:

```
continueBranch: {
  type: "boolean",
  description:
    "Carry on that run's branch instead of cutting a fresh one, so this " +
    "agent starts with its commits already there. Prefer it with an " +
    "on-success edge: on an on-finish edge the commits already there may " +
    "be half of a run that crashed. It needs both runs in a checkout of " +
    "their own, which is a guard you do not set — check the template's " +
    "isolation, or the default guard set's, in list_templates before you " +
    "set this. Only one proposal may continue any given run.",
},
```

Three additions:

| Added | Answers | Corpus |
|---|---|---|
| *"Prefer it with an on-success edge…"* | F3 | 7 of 31 `on-finish` edges carry it |
| *"which is a guard you do not set — check … in `list_templates`"* | F4 | 149 proposals set it; **only 30 name a template**; 125 did call `list_templates` |
| *"Only one proposal may continue any given run"* | — | Kept verbatim; the corpus shows no violation |

The F4 clause is the more valuable of the two and the less obvious. As written,
*"Only when both runs work in a checkout of their own"* states a precondition as
a fact about the world. It does not say the fact is a **guard the model cannot
set**, and it does not say where to look it up. Both are already true elsewhere —
`src/lib/chat.ts:2519-2524` says guards are not the model's, and
`src/app/api/mcp/route.ts:161-163` says `list_templates` reports isolation
including for the default set — and neither is in front of the model at the
moment it types `continueBranch: true`.

## Why not fix this in the prompt instead

Because the prompt already says the F3 half and it did not stop the seven cases.
`src/lib/chat.ts:2570-2579` is a five-line block about ordering that includes
*"on-finish starts work on top of a run that crashed"*, read every turn, and
seven `on-finish` + `continueBranch` proposals were written under it. The
information was present and was not in the place the decision is made. Moving it
to where the field is typed is the entire change.

The prompt block is left alone. It says something the schema cannot —
*"Order them when the work has an order … not to avoid a collision the folder
claim already prevents"* (`src/lib/chat.ts:2571-2574`) — which is a judgement
about whether to order at all.

## The stronger variant, and why it is refused

**Refuse the combination in `planEmission`/the proposal validator**: make
`on-finish` + `continueBranch` a server-side error, the way an unknown
`dependsOn` id already is (`This is set to start after "…", which is not a
proposal in this chat`).

**Refused**, on two grounds and the second is decisive.

It is a schema/behaviour change, which is outside this survey's write scope, and
it belongs to whoever owns `docs/agent/dependencies.md` — the routing line in
`CLAUDE.md` says that file settles *"what satisfies an edge; which edge
conditions must be explicit on the wire"*.

More importantly, **the combination is not always wrong**. Look at the seventh
case: *"orient: fix the four git-state reporting issues (#4 #7 #10 #11)"*
depending on `orient-truncation` with `on-finish` + `continueBranch`. Two batches
of independent issue fixes in one repository, serialised so they do not collide,
where the second batch is worth doing even if the first one failed and the
second batch's author wants whatever the first one did land. That is a coherent
choice. A hard refusal would break it and force the model into `on-success`,
which is strictly worse for that shape — it would drop the second batch entirely
when the first crashed.

So the right instrument is a description that names the trade, not a door that
closes it.

## Cost

| | |
|---|---|
| Lines changed | ~14 in `src/app/api/mcp/route.ts` |
| Tokens added | ~90 to `propose_run`'s schema, fetched on 85 of 160 `ToolSearch` queries |
| Applies to `propose_workflow` too? | **Yes, and it is not proposed here.** The same two fields exist at `src/app/api/mcp/route.ts:574-587` with near-identical text. Two calls in the corpus is no evidence, so changing them would be copying an unmeasured fix into an unmeasured surface. Named in [11-validation.md](11-validation.md) as the follow-up |
| Risk | Low on F4's clause. Moderate on F3's: telling the model to *prefer* `on-success` where 85% of edges are already `on-success` could push the remaining 15% the wrong way. The wording above says "prefer with", not "never use", for that reason |
| Verifiable | Partly. `scripts/deep.mjs` counts the pairs; whether the choices got *better* needs the run outcomes, which are in the unreadable database |
