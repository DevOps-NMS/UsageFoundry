# Comparison

Five options against the constraints in `01-constraints.md`, the contract in
`02-the-handover-contract.md`, and the four cross-cutting files. Every number in
the second table comes out of `scripts/score.mjs`; every fact in the first comes
out of a file cited in the option it belongs to.

---

## 1. The facts side by side

| | **A** park | **B** at the refusal | **C** provider at spawn | **D** per template | **E** workflow block |
|---|---|---|---|---|---|
| attaches at | — | `refusalDisposition` (`orchestrator.ts:1795`) | `runs.provider`, the spawn site | `run_templates`, copied to `runs` | a workflow node + an edge condition |
| unit of the switch | — | **a work cycle** | a run | a run | a run |
| who decides | — | a global setting | the operator, per run | the operator, once per template | the operator, on a canvas |
| spawns `codex` | **no** | yes | yes | yes | yes |
| owes the whole handover contract | **no** | yes | yes | yes | yes |
| a Codex cycle starts from | — | branch + task text, plus a dead session id | branch + prompt (a new run) | as its base | branch (`continueBranch`) + prompt |
| alternation possible | — | **yes, and it should not be** | no | no | no |
| in-cycle spend ceiling for Codex | n/a | **none found** (U4) | **none found** | **none found** | **none found** |
| window fractions apply | yes | **no** | **no** | **no** | **no** |
| guards left after a switch | all eight | `iterations`, `duration` | `iterations`, `duration` | `iterations`, `duration` | `iterations`, `duration` |
| refusable before it can hurt | n/a | **no** — at a wall, unattended | at admission | at template save | at graph validation |
| `pkill`/`killall` denied | yes | **no** | **no** | **no** | **no** |
| self-hosting notice delivered | yes | **no** (U6) | **no** | **no** | **no** |
| commit-identity notice delivered | yes | **no** | **no** | **no** | **no** |
| Sandbox card still truthful | yes | **no, unchanged** | **no, unchanged** | **no, unchanged** | **no, unchanged** |
| winnow's intake filter applies | yes | **no** | **no** | **no** | **no** |
| throttled by `maxConcurrentRuns` | n/a | **no** | yes | yes | yes |
| disclosure unit | n/a | **per cycle — hard** | per run | per run + template | per run |
| merge queue changes | none | none | none | none | none |
| new schema | none | 1 col + `run_events` marker | 1 col | 2 cols | 1 col + an edge condition |
| **build** | **0 d** | 12–18 d | 14–20 d | base + 1–2 d | 12–19 d |
| **blocked on unknowns** | **none** | U1, U4, U5, U6 | U1, U4, U5, U6 (phases 2–3) | as base | U1, U4, U5, U6 |
| loud failures / total | 3 of 3 | **1 of 6** | 3 of 5 | 2 of 6 | 4 of 6 |

## 2. Constraint compliance

| | C1 no fourth source | C2 guards mean something | C3 second classifier | C4 four sentences | C5 `finalText` | C6 landing unchanged | C8 closed union | C10 env denylist | C11 winnow |
|---|---|---|---|---|---|---|---|---|---|
| **A** | trivially | **yes** | n/a | n/a | yes | yes | yes | **defect stands** | yes |
| **B** | **fails** — a run's headline spend becomes measured + substituted | **fails** | owed | owed ×4 | owed | yes | **new member owed** | owed | **lost** |
| **C** | yes, per run | degraded, **refusable at the door** | owed | owed ×4 | owed | yes | yes | owed | **lost** |
| **D** | yes, per run | degraded, refusable earliest | owed | owed ×4 | owed | yes | yes | owed | **lost** |
| **E** | yes, per run | degraded, refusable at validation | owed | owed ×4 | owed | yes | **edge condition owed** | owed | **lost** |

Three rows do the deciding.

**C2 is where every building option loses the same amount.** No in-cycle
spending ceiling was found for `codex exec` (U4), the window fractions do not
apply, and what is left is a cycle cap and a clock. `buildArgs`' own docblock
(`cycleInvocation.ts:897`–`:902`) says what that state of affairs looked like
when it was the Claude side's state of affairs: "twenty-five runs whose settings
page reads $875 had no upper bound this app enforced."

**C1 is where B loses alone.** Because B's unit is a cycle, one run's spend
becomes a mixture of a measured figure and a substituted one — a sum of two of
the never-sum populations, on the run page's headline number.

**The `pkill`/self-hosting row is where all four lose and nobody can fix it
cheaply.** The app runs inside the process the agent could kill.
`--disallowedTools` has no Codex argv equivalent and `SELF_HOSTING_NOTICE` needs
`--append-system-prompt` (U6). Until U6 comes back favourably, every building
option ships an unattended agent in this container with neither.

## 3. What each one is actually for

Not a ranking — the options answer different questions.

- **A** answers *"is waiting actually expensive?"* — and its case is that nobody
  has checked.
- **B** answers *"keep this run working, right now, whatever it takes."* The
  narrowest unit and the widest consequences.
- **C** answers *"can this app drive a second agent at all?"* — the general
  mechanism, with fallback as a policy on top.
- **D** answers *"which tasks are portable?"* — the only option that asks a
  question only a person can answer.
- **E** answers *"draw me what should happen when the first thing fails."*

## 4. The scoring

Weights reflect what the constraints showed to be scarce. The three 5-weighted
criteria are the three things this survey found no way to preserve across a
provider — truthful disclosure, a bound on money, and containment parity.

```
node proposals/ProviderFallback/scripts/score.mjs
```

| criterion | w | A | B | C | D | E |
|---|---:|---:|---:|---:|---:|---:|
| Throughput when the allowance is gone | 4 | **1** | **5** | 3 | 3 | 2 |
| The operator is told the truth | 5 | 5 | **2** | 4 | 4 | 5 |
| Money stays bounded | 5 | 5 | **1** | 2 | 3 | 3 |
| Containment parity | 5 | 5 | **1** | 2 | **1** | 2 |
| Continuity preserved | 4 | 5 | **1** | 4 | 4 | 5 |
| Blast radius controlled at a wall | 4 | 5 | **1** | 4 | 2 | 4 |
| Cost to build (inverse) | 4 | 5 | 2 | **1** | **1** | **1** |
| Independence from unresolved Codex unknowns | 4 | 5 | **1** | 2 | 2 | 2 |
| Failures are loud | 4 | 5 | **1** | 3 | 2 | 4 |
| Fit with `docs/agent/` invariants | 3 | 5 | 2 | 4 | 3 | 3 |
| **weighted total** | **42** | **194** | **70** | **120** | **105** | **131** |

### Sensitivity

| variation | A | B | C | D | E | winner |
|---|---:|---:|---:|---:|---:|---|
| base | **194** | 70 | 120 | 105 | 131 | **A** |
| throughput → weight 12 | **202** | 110 | 144 | 129 | 147 | **A** |
| containment + money → weight 2 | **164** | 64 | 108 | 93 | 116 | **A** |
| every Codex unknown resolved favourably | **194** | 86 | 132 | 117 | 143 | **A** |
| build cost → weight 1 (time is free) | **179** | 64 | 117 | 102 | 128 | **A** |
| all four together | **157** | 114 | 141 | 126 | 141 | **A** |

**A wins every run tried, and it is not close.** The script also solves for the
weight at which each rival would tie it, holding everything else at base:

```
B: 35.0   C: 41.0   D: 48.5   E: 67.0      (against a highest weight anywhere else of 5)
```

Throughput at a wall would have to matter **seven times more than truthful
disclosure, a bound on money, or containment parity** before the best-placed
rival draws level.

### Reading that honestly

**The table is measuring cost, and the benefit side of it is a blank.**

A scores 5 on eight of ten criteria for one reason: it does nothing, so it
breaks nothing. That is the same shape `proposals/RunDecisionTree/09-comparison.md`
warned about — "a weighted score that rewards *does less, correctly* over *does
what was asked, riskily* is measuring feasibility, not value."

But the reading here is not the same, and the difference matters. In that survey
the cheap option still *delivered something*; here the cheap option delivers
nothing new, and it still wins by 63 points. The reason is that **the one
criterion where A is weakest is the one nobody can weight**, because nobody has
measured it:

- how often runs park — `runs` has 0 rows on this machine;
- how long a park lasts in practice;
- what share of parks reach `pauses-spent`;
- what share of runs die on wall clock while parked.

Set that weight from data instead of from taste and the table becomes an
argument rather than a tautology. **Until then, the honest statement is: the
costs are enumerated and large; the benefit is unquantified; and an option set
in that state does not justify 12–20 days and a second vendor's credential.**

## 5. What composes and what does not

The options are not five alternatives. Four of them are layers:

```
   D  per-template opt-in ──┐
                            ├── needs ──►  a provider + an adapter pair  ◄── C
   E  workflow block ───────┘                        ▲
                                                     │  (B builds the same
   B  at the refusal site ───────────────────────────┘   adapter and skips
                                                         the admission)
   A  is the absence of all of it
```

- **C phase 1 is the substrate.** D and E cannot exist without it; B builds the
  same adapter and declines the admission path that would throttle it.
- **D composes with C or E**, and is 1–2 days on top of either.
- **B does not compose with anything**, and is the only option that makes
  disclosure structurally hard (§2, C1).
- **A composes with nothing by definition**, which is also why it costs nothing.

**The one genuine conflict is B versus everything else**, and it is a single
question: is the unit of the switch a cycle or a run? A cycle keeps the run
alive and costs continuity, disclosure, throttling and C1. A run costs latency
and keeps all four.

**The one genuine incompatibility is any building option versus the missing
`pkill` denial**, and it is not resolved by building carefully. It is resolved
by U6 coming back with an `--append-system-prompt` equivalent, or by a decision
that the container alone is enough — which is a person's call, not this
survey's.

## 6. The cross-cutting change nobody's option owns

`OPENAI_API_KEY` and `CODEX_API_KEY` are absent from `childEnv`'s strip
(`orchestrator.ts:5371`–`:5382`), so setting either on the server today hands it
to all five `CLAUDE_BIN` children, in sessions that have `Bash`.

That is true **now**, under Option A, with nothing built. It is one line and a
unit test. It is the only change this survey recommends, and it belongs to none
of the five options — see `13-recommendation.md`.
