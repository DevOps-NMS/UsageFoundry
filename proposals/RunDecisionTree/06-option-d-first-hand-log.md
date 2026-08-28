# Option D — The run writes its own decision log

Stop mining the run for a rationale it never recorded, and ask it to record one.
A short appended instruction plus a place to write, so that when the agent
reaches a branch point it emits a structured note: what it is choosing, what it
is not, and why — **while it still knows.**

This is the only option whose `why` is first-hand at the moment of the decision.
Every other option is archaeology.

---

## The mechanism, and why the obvious one is wrong

Three ways to give the run a place to write. They are not equivalent.

**D1 — a `decision` MCP tool.** UsageFoundry already serves MCP
(`src/app/api/mcp/route.ts`, `docs/agent/chat.md`), so a `record_decision` tool
with a typed schema is a small addition. **But**: it adds a tool to every run's
tool list, and `docs/agent/security.md` records that nothing on the appended
system prompt may carry a literal an agent could `pgrep -f`. More practically,
each call is a round trip that costs output tokens and interrupts the work — and
run A made 297 tool calls in 58 minutes without being asked to make more.

**D2 — a marker in assistant text, parsed from stdout.** The agent writes
`⟦decision⟧ … ⟦/decision⟧` inline; the orchestrator's stdout parser
(`src/lib/orchestrator.ts:7483–7812`) already splits `assistant`, `subagent`,
`tool` and `tool_error` into `run_events` kinds, so a tenth kind — `decision` —
is a small change in a place that already does exactly this work. **No tool, no
round trip, no argv change beyond the prompt.** And it inherits the `subagent`
path for free: a delegated agent's markers reach `run_events` even though its
transcript does not exist.

**D3 — a file the agent appends to.** `.uf/decisions.jsonl` in the worktree.
Zero harness change, but it pollutes the diff the operator is about to land,
and `docs/agent/git-and-review.md`'s reconciliation between touched and changed
would have to learn to ignore it. Rejected.

**D2 is the mechanism.** It is the cheapest change to the thing that already
exists, and `run_events` is where the result belongs (C4: it survives the
transcript).

### The prompt

Appended alongside the notices `src/lib/agents.ts` already composes. Roughly:

> When you commit to an approach over a real alternative — a design you picked
> over another you considered, a file you decided not to change, an approach you
> abandoned after seeing something — record it before you act on it:
>
> ```
> ⟦decision⟧ chose: <what you are doing>
> instead of: <what you are not doing>
> because: <the reason, in one sentence>
> ⟦/decision⟧
> ```
>
> Only for choices where a competent alternative existed. Not for mechanical
> steps, not for re-running a mistyped command, and not as a running commentary.

That last line is doing more work than it looks. Run A's eleven narration blocks
("Now the score table and the sensitivity paragraph:") show exactly what an
unqualified "explain your reasoning" instruction produces: stage direction at
every step. The instruction has to name the failure mode it is trying to avoid.

## What a node is

Two kinds, and the split is the design:

- **declared decision** — a `⟦decision⟧` block. Carries `chose`, `instead_of`,
  `because`, and the timestamp. This is a node the run authored.
- **act** — everything else, folded exactly as Option A/E folds it, hanging
  beneath the declared decision that most recently preceded it.

So the tree is Option A's structure with a spine of first-hand decisions running
through it, and the acts become *evidence for* the declarations rather than
substitutes for them. A declared decision followed by 22 tool calls reads:
*"chose to read the ground rules first, instead of starting from the existing
comparison, because the constraints file had changed — and then did these 22
things."*

## What an edge means

`declared → act`: **"these acts implement that decision"** — a genuine
containment relation, not sequence, and the only option in the set that has one.

`declared → declared`: sequence, and where the run said so, supersession — a
later decision that names an earlier one as reversed. Run A's cycle 3
(`"the two repairs, where repair #2's premise changed"`) is exactly this shape
and Option D would have captured it as a link rather than a sentence.

## Where the "why" comes from, and how faithful

**From the run, at the moment of the decision, in its own words.** Provenance is
`declared` — a fifth value beyond `08-marking-inference.md`'s three, and the
strongest one available anywhere in this proposal.

Two honest qualifications, and neither is small:

**It is a stated reason, not the reason.** The agent is describing its own
process; there is no guarantee the stated `because` is what actually drove the
choice. This is the same epistemic status as a commit message or a design doc —
which is to say, the status of every human engineering artifact we already trust.
It is a *far* better status than inference, and it is not omniscience.

**It changes the run.** This is the objection that matters. Asking the agent to
narrate its branch points costs output tokens, occupies context, and — the real
risk — may change what it decides. A run that knows it must justify choices may
make more defensible and less imaginative ones. Nothing in this proposal measures
that, because it cannot be measured without running the experiment.

`docs/agent/run-lifecycle.md` records that the flags must ride **every** cycle's
argv; an appended prompt rides the same path and is subject to the same rule.
And `proposals/ContextControl/` measured what injected text costs against a
cached prefix — the marginal tokens here are small but they are not zero, and
they land in the prefix that gets re-read 520 times.

## Cost per run

The cheapest of the annotating options by an order of magnitude, because the run
is already paying for the context it writes into.

| | tokens | at Opus 5 rates |
|---|---:|---:|
| appended prompt, in the cached prefix | ~120, read 520× | ~$0.0004 |
| the declarations themselves | ~15 × 60 = ~900 output | **$0.023** |
| re-injection after each compaction (§ seam) | ~900 × 4 = 3,600 cached-prefix tokens | ~$0.002 |
| **total** | | **< $0.05** |

Against run A's measured $43.51 that is **0.06%**, and against the 356,961 output
tokens the run already generated, 900 more is noise. The prompt tokens ride the
cached prefix at 0.1× input rates — `proposals/ContextControl/` measured what
injected text costs there, and 120 tokens is at the bottom of that scale.

**The real cost is not the money.** It is the context the declarations occupy and
the possibility that asking for them changes what the run decides — neither of
which appears in this table, and the second of which nothing here measures.

## Sub-agents, forks, resumes

**Sub-agents: Option D is the only option that can genuinely expand one.** The
transcript has zero sidechain records, but the appended prompt reaches sub-agents
too, and their stdout already becomes `run_events` rows of kind `subagent`
(`src/lib/orchestrator.ts:7620`). A delegated agent that emits `⟦decision⟧`
markers puts its branch points into the parent run's event log **even though its
transcript does not exist and its 52 KB report was written to a file.**

That is a real capability no other option has, and it is worth stating plainly:
the app can see inside a sub-agent's reasoning precisely because it watches
stdout rather than reading transcripts.

Caveat: whether the appended prompt actually reaches a sub-agent depends on how
`agents.ts` composes it and what the SDK propagates — this is the one claim in
this file that is **unverified** and it is flagged as such in `11-validation.md`.

**Resumes:** `run_events` is keyed on `run_id`, not `session_id`, so a resumed
run's declarations accumulate in one place with no special handling. This is
Option D's quiet structural advantage over A and, to a lesser extent, over B.

**Forks:** not present in this corpus.

## The compaction seam, explicitly

**Option D degrades at the seam in a way none of the others do, and it is the
strongest argument against it.**

A declaration is text in the context window. Run A compacted four times, dropping
156,149 / 309,026 / 467,899 / 626,408 cumulative tokens, preserving four to five
records each time. A decision declared in cycle 1 is **gone from the agent's
context** by cycle 2 — so the run cannot reference, revise, or supersede its own
earlier decisions, and the "supersession" edge above will be rarer than it
sounds.

The declarations themselves survive: they are `run_events` rows, written when
emitted, unaffected by what the agent can still see. But their *coherence* does
not. Across four seams, a run may declare four unrelated decision sets rather
than one evolving one.

Two mitigations, both real, neither free:

- **Re-inject the declarations after a compaction.** ~15 declarations × 60
  tokens = ~900 tokens, trivially affordable at 11,135 post-compaction tokens.
  This is `proposals/ContextControl/`'s "continuation brief" idea applied to a
  narrow, structured payload, and it is the right answer.
- **Render the seam in the tree** and say the run could not see across it — which
  every option does anyway (C5).

## Cost to build

Deceptively small on the harness side; the risk is entirely in the prompt.

| piece | size | notes |
|---|---|---|
| appended prompt text | ~20 lines | `src/lib/agents.ts`; `docs/agent/security.md`'s literal rule applies |
| marker parsing in the stdout parser | ~60 lines | `orchestrator.ts:7483–7812`, beside the existing kinds |
| `decision` added to `RunEventDTO["kind"]` | 1 line | `src/lib/apiTypes.ts:1711` — a closed union, so this is a typed change |
| fold: declarations + Option A/E acts | ~300 lines | `runTasks.ts:189` is the model |
| re-injection after compaction | ~80 lines | the `contextPruning.ts` boundary; `docs/agent/run-lifecycle.md` |
| `RunDecisions.tsx` + canvas | ~400 lines | `autoLayout` unchanged |
| tests | ~200 lines | marker parsing is pure and silent-failing |

**4–6 days of code.** But the calendar cost is different from the code cost:
**Option D only works for runs that happen after it ships.** Every finished run
in the operator's history gets nothing, forever. That is not a build cost; it is
a coverage cost, and it is the reason D cannot be the whole answer.

## How it degrades

| situation | what the operator sees |
|---|---|
| **run predates the feature** | **nothing.** No retroactive path exists |
| transcript compacted | declarations survive (they are rows); the run's *awareness* of them does not, unless re-injected |
| transcript swept | declarations survive — they were never in the transcript |
| run crashed mid-task | every declaration up to the crash, which is the best crash behaviour of any option: the last declaration says what the run was trying to do when it died |
| agent ignores the instruction | a tree with no spine — falls back to Option A/E's structure. Silent, and unmeasurable without an experiment |
| agent over-declares | run A's eleven narration blocks, but structured. Noise, not error |
| sub-agent declares | **its decisions appear** — unique to this option, and unverified |

The "agent ignores the instruction" row deserves emphasis: it has no detector.
The only way to know whether D works is to ship it and count `decision` rows per
run, which is a real experiment with a real answer and should be run before D is
committed to.

## Where it is strongest

- **The `why` is first-hand.** Not inferred, not mined — authored at the moment,
  by the party that knows.
- **It gets `instead_of` honestly**, which is the field Option C can only guess.
- **It is nearly free** — under $0.05 per run, against $43.51.
- **It sees inside sub-agents**, via `run_events`' `subagent` path.
- **It survives retention** and resume for free, because `run_events` does.
- **It is the best crash behaviour** in the set.

## Where it is weakest

- **Zero retroactive coverage.** Every existing run is untouched, permanently.
- **It changes the run**, in a direction nothing here measures.
- **It degrades at every compaction** without re-injection, and run A compacted
  four times in 58 minutes.
- **Compliance is unmeasured and unmeasurable in advance.** The agent may simply
  not do it, and the failure is silent.
- **The sub-agent claim is unverified** — see `11-validation.md`.
