# Option E — a workflow-level retry block

Do not change the run loop at all. Express the fallback in the graph the app
already has: a run block whose provider is Codex, wired downstream of a Claude
block by an `on-finish` edge, entered only when the Claude block failed for want
of allowance.

The unit is a **block**, the trigger is an **edge condition**, and the switch
happens between runs rather than inside one.

---

## The strongest case

**The app already has a language for "if that does not work, do this instead",
and it is not `refusalDisposition`.**

`run_deps` carries two edge conditions and exactly two —
`"on-success" | "on-finish"` (`src/lib/apiTypes.ts:938`, `:1510`, `:2598`) — and
`docs/agent/dependencies.md` owns what satisfies an edge, which conditions must
be explicit on the wire, and where `needs-review` sits against the two. A
workflow's node vocabulary is closed and already has four members:
`"run" | "orchestrator" | "merge" | "loop"` (`apiTypes.ts:1415`).

An `on-finish` edge into a Codex-provider run block is, structurally, exactly
what a fallback is: *when the first thing settles, however it settled, start the
second thing.* No new disposition, no new state on the refusal path, no change
to the guard order in `orchestrator.ts`.

And the two properties the run loop cannot give it come free:

- **The operator drew it.** A fallback that exists as a node on a canvas is a
  fallback somebody chose, laid out, and can see before it fires.
- **The unit is a run, not a cycle.** Which means there is no cross-provider
  resume to invent (`08-continuity.md`), no second lineage on one row, and no
  alternation.

## Its shape

Nothing in `orchestrator.ts` changes. What is needed:

1. Option C's `provider` column and adapter pair — **this option does not avoid
   the handover contract**, it only avoids the refusal-path surgery.
2. A `provider` field on a workflow node, which
   `docs/agent/workflows-and-schedules.md` governs as "what a node may not
   hold". A provider is configuration rather than state, so it is admissible in
   the same way a model is.
3. **A third edge condition**, and this is the load-bearing new thing:
   `on-finish` fires whatever the outcome, which would run the Codex block after
   a Claude block that *succeeded*. What is wanted is something like
   `on-allowance-refusal`.

Point 3 is where this option's cost actually is. `docs/agent/dependencies.md`
records that the edge conditions must be **explicit on the wire**, and the union
is two members read in three DTOs (`apiTypes.ts:938`, `:1510`, `:2598`) plus `run_deps`
plus `releasableRuns`/`admitDependencies`/`releaseDependents`. Widening it is a
schema change, a wire change, and a change to the function that decides what
wakes a dependent — `docs/agent/dependencies.md` is explicit that what wakes
dependents and what deliberately does not is a decided invariant.

Alternatively the condition rides on the *node* rather than the edge
("start only if the upstream's stop reason was an allowance wall"), which keeps
the edge vocabulary closed at the price of putting run-outcome inspection into
a node — and `what a node may not hold` is exactly the rule that has to be read
before doing it.

## Continuity

**Second best, and the reason is that it does not pretend.** A downstream block
is a new run. It starts from:

- **the branch**, if `continueBranch` is set on the edge
  (`apiTypes.ts:1511`–`:1512`) — the Codex run carries on the Claude run's
  branch rather than cutting its own, which is precisely the "start from the
  commits" answer in `08-continuity.md`;
- **its own prompt**, which the operator wrote when they drew the graph.

Nothing is lost that the option ever claimed to keep. There is no Claude session
to abandon, because the Claude run *ended*; `runs.continues_run` records the
lineage; and the operator's own prompt is a better handover brief than anything
generated, because it was written by somebody who knew what the second block was
for.

The cost is honest and large: **the Codex run does not know what the Claude run
learned**, beyond what is in the commits and the prompt. For a task where the
conversation is the work, that is most of it.

## Guards and metering

Best of the four building options, for a structural reason: **a workflow block
carries its own policy.** A Codex block can be given `maxIterations` and
`maxDurationMinutes` and no window fractions, and the refusal that C2 demands —
"this policy's only money limits do not apply to this provider" — can be made at
graph-validation time, which is where `workflowGraph.ts` already puts "every
refusal that can be decided without touching the disk" (`workflowGraph.ts:31`–`:32`).

Metering is per run rather than per cycle, so a Codex block's spend is a run's
spend, unknown or pessimistic (C1), and never mixed into a Claude run's totals
because it is a different row.

One caution from `docs/agent/workflows-and-schedules.md`: an instance's status
is **derived**, and the doc says what to act on instead of it. A fallback block
that never fires must not make an instance read as failed, and one that fires
must not make it read as succeeded on the strength of the fallback alone.

## Permission and sandbox parity

Same gaps as every spawning option
([`10-permission-and-credentials.md`](10-permission-and-credentials.md)),
disclosed at the best possible moment: the node is on a canvas the operator drew
and can annotate.

## Review and landing

**Clean.** Two runs, two rows, two `needs-review` cards if it comes to that, one
branch if `continueBranch` is set. The merge queue is untouched (C6). Provider
disclosure is per run, which is the unit the run page already renders.

## Blast radius

**Per graph, and only where an operator drew it.** Narrower in practice than
Option D (a template is reused invisibly; a graph is looked at) and wider in
principle than Option C (a graph runs unattended, and a schedule can run it
repeatedly — `docs/agent/workflows-and-schedules.md` on what makes a workflow
schedulable).

The orchestrator chat is out of scope, with a caveat this option has to own: a
chat *proposal* can propose a workflow (`ProposedBlockDTO`, `apiTypes.ts:2599`),
so a model can propose a graph containing a Codex block. `docs/agent/chat.md`
governs which half of a run a model may write; a provider is closer to a
capability than to a prompt, and the safe default is that a proposal may not set
one.

## How it fails, and whether loudly

| failure | loud? |
|---|---|
| the fallback block never fires | **yes** — a node visibly not entered on the instance view |
| the fallback fires when it should not | **yes** — a Codex run appears in the instance |
| Codex quota exhausted | **still misattributed** (C3, C4) |
| JSONL drift | **still silent** |
| commit identity notice absent | **still silent** |
| the edge condition widens the union badly | **loud** — typecheck, and `docs/agent/dependencies.md` is the review gate |

The two failures unique to this option are both visible on a page an operator
already opens, which is better than any other building option manages.

## What it costs to build

| | |
|---|---|
| Option C phase 1 (adapter pair, provider column) | 8–12 d |
| provider on a workflow node, and its graph validation | 1–2 d |
| the third edge condition (or the node-side equivalent) | 2–3 d |
| instance-status and canvas rendering | 1–2 d |
| **total** | **12–19 d** |

Not cheaper than C. Its advantage is not cost.

## What would have to be true

1. Everything Option C phase 1 needs — this option is built on it.
2. **That the graph is where this install actually expresses work.**
   Unmeasured: `workflows` and `workflow_instances` have 0 rows on this machine.
   If workflows are unused, this option ships a fallback nobody can reach.
3. That an `on-allowance-refusal`-shaped condition is admissible under
   `docs/agent/dependencies.md`'s rule about explicit edge conditions — a
   question for whoever owns that doc, not for this survey.
