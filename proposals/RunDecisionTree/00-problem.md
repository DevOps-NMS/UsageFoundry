# The problem: a finished run does not explain itself

An operator opens a completed run. The page offers five tabs — `log | report |
changes | review | land` (`src/app/runs/[id]/page.tsx:415`). Between them they
answer *what happened* (the log tail), *what the agent says it did* (the report)
and *what is different now* (the diff). None of them answers **how it got
there**: where the run had a choice, what it picked, what it discarded, and why.

That question is not a nicety. A run in this app costs real money and writes to
a real checkout. The grounding run measured below spent **$43.51** at Opus 5
list rates across **520 model requests** and **297 tool calls** over 58 minutes,
and left 14 commits behind. An operator deciding whether to land that work, or
to re-run it with a different prompt, is currently choosing between reading a
3.8 MB transcript and trusting a 4.8 KB summary the run wrote about itself.

This document measures what is actually recoverable, because the answer is
narrower than it looks and it decides the whole design.

---

## 1. The model's reasoning is not in the transcript. Re-verified, and worse than stated

`proposals/ContextControl/00-problem.md:476-493` measured 13,454 thinking blocks
with zero non-empty bytes; `proposals/ContextControl/19-validation.md:62`
re-confirmed 13,734 empty over 113,468 records. **Both still hold, on a corpus
that has since roughly doubled**, and the re-measurement adds a distinction the
earlier passes did not draw.

Over the whole of `~/.claude/projects` on this machine — 875 `.jsonl` files,
266,362 records:

| model | `thinking` blocks, empty | non-empty | non-empty bytes |
|---|---:|---:|---:|
| `claude-opus-5` | 28,857 | **0** | 0 |
| `claude-sonnet-5` | 2 | **0** | 0 |
| `claude-haiku-4-5-20251001` | 25 | 11 | 3,905 |

```
node scripts/thinking-by-model.mjs
```

The corpus grows while it is being measured — this very session writes to it, so
the empty count rises by a few dozen between passes (28,805 on the first run of
this script, 28,857 twenty minutes later). **The non-empty column does not
move**, and that is the column the design depends on.

The eleven non-empty blocks are the finding worth stating out loud, because they
are the only counter-evidence in a quarter of a million records and they do
**not** reopen the design. Every one of them is a Haiku 4.5 probe session of ten
to eighteen records — `"reply with the single word ok"`, `"hi"`, one commit
smoke-test — and their combined 3,905 bytes are the model narrating a one-line
instruction back to itself. Cross-tabulating by request shape shows why:

| model | entrypoint | `effort` | thinking text |
|---|---|---|---:|
| `claude-opus-5` | `sdk-cli` | `xhigh` | 21,244 empty |
| `claude-opus-5` | `cli` | `xhigh` | 7,613 empty |
| `claude-sonnet-5` | `sdk-cli` | `xhigh` | 2 empty |
| `claude-haiku-4-5` | `sdk-cli` | *(absent)* | 25 empty, 11 non-empty |

**Every record carrying an `effort` field carries empty thinking. Without
exception, 28,859 times.** The agents this app spawns are `sdk-cli`,
`claude-opus-5`, `effort: xhigh` — the first row. There is no configuration
reachable from this codebase under which a run's own reasoning lands in its
transcript, and there is no partial credit: it is 28,857 out of 28,857.

The `thinking` blocks are not absent, which matters for a different reason. They
are present, ordered, and **expensive**. In the grounding run alone:

```
thinking blocks=210 signatureBytes=312988 thinkingTextBytes=0
```

312 KB of cryptographic signature — 8.2% of the 3.84 MB transcript — marking the
exact positions where 210 acts of reasoning happened, and carrying none of them.
The transcript knows precisely where the run thought. It cannot say what it
thought.

**Design consequence.** "The reasoning behind each decision" cannot be lifted.
Every option below must name a different source for its *why* and state how
faithful that source is. There is no option that reads the model's mind, and any
option that appears to is reconstructing.

---

## 2. The run barely narrates either

If thinking is gone, the fallback is assistant text. It is thinner than the
thinking was.

Two real UsageFoundry-spawned runs (`entrypoint: sdk-cli`, `claude-opus-5`):

| | run A `4c7c4e5c` | run B `b51351ba` |
|---|---:|---:|
| records | 1,292 | 1,464 |
| transcript bytes | 3,838,145 | — |
| tool calls | 297 | 484 |
| `thinking` blocks (all empty) | 210 | 140 |
| **assistant text blocks** | **13** | **7** |
| **assistant text bytes** | **5,578** | **6,670** |
| `TodoWrite` calls | 0 | 0 |
| compaction boundaries | 4 | 0 |

```
node scripts/census.mjs ~/.claude/projects/<dir>/<session>.jsonl
```

Run A wrote **5,578 bytes of prose across 297 tool calls** — 0.145% of its own
transcript, one prose moment per 23 tool calls. And the distribution is worse
than the total: of the twelve blocks over 40 characters, **one** is the 4,873-byte
final report and the other **eleven total 680 bytes**, all of them pure
stage-direction:

```
2026-08-22T02:29:28Z    71B  Now the remaining two paragraphs of that section, then the audit table.
2026-08-22T02:33:58Z    49B  Now fixing the figure error in the option M file:
2026-08-22T02:36:24Z    50B  Now the score table and the sensitivity paragraph:
2026-08-22T02:41:35Z    53B  Now committing the comparison work and this addendum.
2026-08-22T02:46:25Z    50B  Now the framing paragraph at the head of Option F.
```

Not one of them says *why*. They say *next*. Run B, at 484 tool calls, produced
seven text blocks and no todo writes at all.

**This is the second design consequence, and it is the one most likely to be
underestimated.** A "decision tree derived from what the run said" has, in a
one-hour 297-tool-call run, twelve sentences and one report to work with. The
tree's *shape* is recoverable in abundance; its *annotations* are not.

---

## 3. `TodoWrite` is not a fallback here

Zero `TodoWrite` calls in both runs. This is not a sampling accident: an agent
under this app's system prompt is told to work and commit, not to maintain a
visible plan, and the harness's own task-reminder attachments (29 of them in run
A) went unanswered. Any design that leans on `TodoWrite` for structure is
designing for a run that does not happen here.

---

## 4. Sub-agents leave nothing behind. Zero, corpus-wide

The most consequential structural finding. Across **266,362 records**:

```
files=875 records=266362 isSidechain=true → 0
```

**Not one sidechain record exists.** Ninety-one transcripts contain `Task`/`Agent`
tool calls; none of them contains a single record of what those agents did.

What survives is the tool result — and even that is conditional. From a host
session with five `Agent` calls:

```
Agent "Explore run UI and API routes"        promptLen=1565 resultLen=45768
Agent "Explore orchestrator run loop"        promptLen=1922 resultLen=40268
Agent "Explore usage windows and reset times" promptLen=1848 resultLen=32564
Agent "Design live-kill and pause/resume"    promptLen=9145 resultLen=2288
Agent "Design policy model and UI"           promptLen=8566 resultLen=2288
```

The last two `resultLen=2288` are not short reports. They are stubs:

```
<persisted-output>
Output too large (52.4KB). Full output saved to: …/518f…
```

So a delegated decision leaves the parent transcript **one tool call and one
result**, and when the result is large it leaves a *pointer to a file the
retention sweep does not know about*. Every branch the sub-agent explored, every
alternative it rejected, is gone at the moment it returns.

**Design consequence.** A decision tree built from the transcript cannot expand a
sub-agent. It can only draw the delegation as a single node. Any option that
promises otherwise is promising something the data does not contain — and §5
names the one place in this codebase that does better.

---

## 5. `run_events` already knows more than the transcript does

This is the fact that reshapes the option set, and it is easy to miss because
the table looks like a log.

`run_events` (`src/lib/db.ts:167`) is `(id, run_id, ts, kind, payload)`, and its
`kind` is a closed union (`src/lib/apiTypes.ts:1711`):

```
status | log | assistant | subagent | tool | tool_error | sandbox
      | iteration | budget | result | handoff | land | review | error | replay-complete
```

Nine of those are emitted by the orchestrator's stdout parser
(`src/lib/orchestrator.ts:7483–7812`), including — decisively —

- **`assistant`** (`:7565`, `:7640`) — the run's prose, already separated from its tool calls;
- **`subagent`** (`:7620`) — sub-agent output, *which the transcript does not have at all*;
- **`tool`** (`:7483`, `:7659`, `:7671`) and **`tool_error`** (`:7720`) — calls and failures, already distinguished;
- **`iteration`** (`:8501`) — the work-cycle boundary, already a first-class row;
- **`sandbox`** (`:7737`) — a policy refusal, deliberately its own kind rather than a flag.

Three properties follow, and each of them is worth more than a transcript field:

1. **It is already the right shape.** A decision tree needs nodes typed by *what
   kind of act this was*. `run_events.kind` is that typing, written at the
   moment the act happened, by the process that watched it happen.
2. **It survives the transcript.** `expiredTranscripts`
   (`src/lib/retention.ts:554`) deletes `.jsonl` files past the horizon;
   `run_events` rows are `ON DELETE CASCADE` on `runs` and go when the *run*
   goes. A run whose transcript is swept still has its events.
3. **It recovers the sub-agent.** The corpus has zero sidechain records, but the
   orchestrator emits `subagent` rows from stdout. What the transcript threw
   away, the app kept.

**This does not make the transcript redundant.** `run_events` has no
`tool_use.input` — no `file_path`, no `old_string`/`new_string`, no shell
command — and it has no compaction metadata. The tree's *edges* and *evidence*
still want the transcript. But the claim "the reasoning must come from the
transcript" was never true, and §4's "sub-agents leave nothing behind" is true of
the transcript and false of the database.

---

## 6. The seams: what compaction and resume do to the chain

Run A compacted four times. The boundaries are not silent — they are the
best-documented records in the file:

```
#170  compact_boundary  parentUuid=null  logicalParentUuid=222fd8b6…  resolves=true
      trigger=auto  preTokens=167284  postTokens=11135  cumulativeDroppedTokens=156149
#444  …  logicalParentUuid=f54d65fa…  resolves=true  pre=167264 post=14387  dropped=309026
#764  …  logicalParentUuid=c1973ae6…  resolves=true  pre=170492 post=11619  dropped=467899
#1139 …  logicalParentUuid=865486e6…  resolves=true  pre=169820 post=11311  dropped=626408
```

```
node scripts/seams.mjs <transcript>
```

Three facts, all of which cut *for* the feature:

- **`parentUuid` is null at every boundary — the naive chain does break.** A
  tree built by following `parentUuid` fragments into five disconnected
  components in run A. 102 of 1,292 records have a null parent.
- **`logicalParentUuid` repairs it, and resolves 4 times out of 4.** The
  boundary record points back at the exact pre-compaction record. The chain is
  crossable; it just is not crossable by the obvious field.
- **`compactMetadata.preservedSegment` names what survived** — head, anchor and
  tail uuids, plus `allUuids`. So a view can say *"156,149 tokens of context were
  dropped here; these five records carried across"* rather than going quiet.

**Resume is the harder seam, and it is a duplication problem, not a gap.** The
corpus contains pairs of transcripts with identical record and tool-call counts
under different session ids — `00ffb053…`/`db276def-3f4a-50ed…` (1,544 records,
252 tool calls each), `62086ee2-e9e3-5f1d…`/`717c455d…` (1,161/248),
`b2baed45-8727-50ee…`/`d01c0434…` (1,138/258). Note the `-5xxx-` version-5 UUID
marker on one of each pair: a resume writes a *second copy* of the history under
a derived id. And `resolveSessionTranscript` (`src/lib/transcripts.ts:1062`)
deliberately returns `null` when a basename matches more than one file:

```ts
const mine = files.filter((f) => path.basename(f) === name);
return mine.length === 1 ? mine[0] : null;
```

So a resumed run's tree is at risk of being built twice, and a run whose id
collides across projects resolves to nothing at all. Both are stated failure
modes, not surprises — but an option that walks transcripts must say which one
it produces.

---

## 7. The transcript is not permanent

`expiredTranscripts` (`src/lib/retention.ts:554`) removes files past the cutoff
that belong to no session a run or chat may resume. `retentionCutoff` (`:107`)
returns `null` for "keep all", so the horizon is operator-configurable and may be
off — but when it is on, the transcript for a finished run **will** be deleted,
and its `run_events` will not.

Any view that derives from the transcript at request time therefore has a
guaranteed empty state, on a schedule the operator sets. §5's second property is
what makes that survivable.

(The brief named `src/lib/retentionSweep.ts`. There is no such file; the sweep
and the decision both live in `retention.ts`, with the pure half at `:554` and
the impure half below `:570`.)

---

## 8. What we can build on, verified

| claim | anchor |
|---|---|
| a run reaches its transcript by session id | `runs.session_id` added at `src/lib/db.ts:744`; `resolveSessionTranscript` at `src/lib/transcripts.ts:1062` |
| tool calls are already parsed | `parseToolRecord` `src/lib/toolComposition.ts:124`; `buildToolComposition` `:256`; `ToolRecord` `:71` |
| a per-run event stream already exists, typed | `run_events` `src/lib/db.ts:167`; `RunEventDTO["kind"]` `src/lib/apiTypes.ts:1711` |
| tasks are already derived from that stream | `runTasks(events): RunTask[]` `src/lib/runTasks.ts:189` |
| the tab strip has a natural slot | `type RunTab = "log" \| "report" \| "changes" \| "review" \| "land"` `src/app/runs/[id]/page.tsx:415` |
| a layered DAG layout already ships | `autoLayout(blocks: {id}[], links: {from,to}[]): Map<string, Point>` `src/lib/canvasGraph.ts:149`; `edgeGeometry` `:283`; `layoutBounds` `:243` |
| a force layout also ships, for a different shape | `createSimulation` `src/lib/forceLayout.ts:151`, Barnes-Hut `buildQuadtree` `:224` |

`autoLayout` is the reusable one and it is reusable **unchanged**: its signature
asks for `{id}[]` and `{from, to}[]`, which is exactly a decision tree. The force
simulation in `forceLayout.ts` is for the knowledge graph's untyped mesh and is
the wrong instrument for a rooted, ordered tree — see `03-option-a…` §"What we
reuse".

---

## 9. The problem restated, precisely

Build a view that shows a finished run's branch points, choices, discards and
rationale, given that:

- the reasoning is **gone** — 28,857 of 28,857 empty for the model this app runs;
- the narration is **5.5 KB per 297 tool calls**, and eleven-twelfths of it is stage direction;
- the sub-agents are **invisible in the transcript** and *visible in `run_events`*;
- the parent chain **breaks at every compaction** and is repairable via `logicalParentUuid`;
- a resume **duplicates** the transcript and can make it unresolvable;
- the transcript **is deleted on a schedule** and `run_events` is not.

Everything from here is a choice about which of those to accept and which to
change. The one thing no option may do is imply a `why` it did not measure — the
subject of `08-marking-inference.md`.
