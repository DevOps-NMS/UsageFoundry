# Option B — Make the file price list say when its walk was short

**One boolean out of `walkRepo`, one clause in the notice. The repository axis's
only silent failure, and the repository already contains the pattern that fixes
it, twice.**

## The finding

`walkRepo` stops at `MAX_WALK_ENTRIES = 20_000` (`fileCostNotice.ts:182`) and
returns a plain `RepoFile[]` (`:368-404`). Nothing in the return value says the
walk stopped early, and `fileCostNotice` (`:418-433`) has nothing to report even
if it wanted to.

The queue is FIFO — `queue.shift()` at `:376` — so the walk is breadth-first.
A truncated walk therefore covers **shallow directories only**, and the notice
that comes out of it is a price list of the largest files *near the top of the
tree*, presented as the largest files in the repository.

Where that lands makes it worse than a wrong number on a page. The notice is
frozen at `createRun` and put on **every** cycle's `--append-system-prompt`
byte-identical (`orchestrator.ts:249-256`, and `docs/agent/run-lifecycle.md`'s
rule that rebuilding it would cold-start a 190,000-token context). So a
truncated price list is:

- **read by an agent, not by a person**, so nobody is in a position to notice it
  is short;
- **frozen for the life of the run**, so it does not self-correct;
- **advice about what to avoid reading**, which is the one kind of advice whose
  being incomplete makes it actively misleading rather than merely thin.

## Why this is a real defect and not a hypothetical

Because the same repository, in a file with the same constant name and the same
justification, reached the opposite conclusion:

| | `fileCostNotice.ts:174-181` | `retention.ts:716-723` |
|---|---|---|
| Constant | `MAX_WALK_ENTRIES = 20_000` | `MAX_WALK_ENTRIES = 120_000` |
| Reason given | "a mount pointed at something enormous must cost a truncated list rather than a stalled server" | "An unbounded one would be a page load that stats a million paths" |
| Reports the truncation? | **No** | **Yes** — `treeSize` returns `{ bytes, partial }`, and the docblock says the walk "says when it stopped" |
| Consumer | an agent's system prompt | an operator's Storage card |

`retention.ts`'s docblock even gives the reason a bounded walk must confess:
"'the figure took a minute' is how an operator learns not to open the card that
exists to warn them." The same sentence applies with more force to a reader who
cannot open anything.

`treeSize` also earns its own test for exactly this class of error — "what it can
now get wrong is a total that is quietly *short* … A store that reads as 1.4 GB
when it holds 2.6 is the figure an operator sets a horizon against, and nothing
about it looks wrong" (`retention.ts:749-757`). That is a description of
`walkRepo` at HEAD.

## How far away the bound is — measured

This is why Option B is insurance rather than a fix, and why it scores below
Option A.

```
find /workspace/UsageFoundry -path '*/node_modules' -prune -o -path '*/.git' -prune -o -print | wc -l
    → 1951    (9.8% of 20,000)
find /workspace2 -path '*/node_modules' -prune -o -path '*/.git' -prune -o -print | wc -l
    → 1247    (6.2% of 20,000)
```

Both an order of magnitude clear, and `SKIP_DIRS` (`:132`) and
`SKIP_EXTENSIONS` (`:156`) cut the count before the bound sees it. **Nothing
this container can read reaches the bound.** A repository ten times this one's
size does, and a mount pointed at a home directory or a monorepo does it
comfortably.

Measured cost of the walk at that size, for the record:

| | Measured | n |
|---|---|---|
| `fileCostNotice()` first call (memo cold, database opened) | 45.61 ms | 1 |
| `fileCostNotice()` steady, memo warm | **14.08-16.87 ms** | 7 |
| Notice length produced | 1,482 chars of `MAX_NOTICE_CHARS = 2_400` | |

Synchronous, inside `createRun`'s no-`await` window (`orchestrator.ts:3190-3196`
says so at the call site). So N runs created by one press pay N × ≈15 ms of
event-loop time. At `MAX_FAN_OUT = 10` that is ≈150 ms; at
`MAX_WORKFLOW_NODES = 25`, ≈375 ms. **Arithmetic on a measurement, not a
measurement** — no fleet press was timed here.

## What to change

```
walkRepo(root) → { files: RepoFile[]; partial: boolean }
```

`partial` set when the `seen < MAX_WALK_ENTRIES` loop condition or the
`++seen > MAX_WALK_ENTRIES` break is what ended the walk. `fileCostNotice` then
passes it to `renderFileCostNotice` (`:256`), which appends one clause.

**The clause must be a count, never a path.** `docs/agent/security.md`'s rule
about `SELF_HOSTING_NOTICE` — no literal an agent could `pgrep -f` — extends to
all three notices on that flag, "the file price list included … what keeps it
safe is that nothing near them offers a pattern". A sentence naming the
directory where the walk gave up would be a new pattern on every sibling's argv.
"The 20,000 most shallow entries of this repository were examined" names no path
and adds ≈60 characters to a notice measured at 1,482 of 2,400.

## Cost

| | |
|---|---|
| Files touched | 1 — `src/lib/fileCostNotice.ts` |
| New dependencies, schema changes, settings | 0, 0, 0 |
| Prompt-cache risk | **none, and this is the thing to check.** The notice is frozen per run at `createRun`; a run whose walk truncated gets the clause on every one of its cycles, identically. A run whose walk did not truncate gets exactly today's bytes. `docs/agent/run-lifecycle.md`'s invariant — "Null and empty both mean an argv byte-identical to the one before the column existed" — is unaffected |
| Test it earns | one, and it is the cheap kind: `fileCostNotice.test.ts` already builds temporary trees (`:195-213`), so a tree of `MAX_WALK_ENTRIES + 1` entries asserting `partial` is a fixture, not a harness |

## What it does not do

**It does not make the price list correct on a large repository — it makes it
honest.** A truncated list is still a list of the wrong files; the clause only
stops the agent treating it as complete. Making it correct means either raising
the bound (which puts unbounded synchronous work back in the no-`await` window,
which is what `MAX_SLOT_PROBES_PER_ADMISSION`'s docblock records as the mistake
already made once) or moving the walk off the admission path (which
`fileCostNotice.ts:174-181` and `orchestrator.ts:3190-3196` both explain is the
thing that cannot be done, because `createRun` has no `await` to offer). **The
bound is right. Only its silence is wrong.**

**It fixes nothing anybody has hit.** Measured 9.8% and 6.2% occupancy on the
two readable repositories. If the recommendation is read as urgent, it has been
misread.
