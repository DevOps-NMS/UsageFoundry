# ProviderFallback

**Whether, and how, this app should hand a work cycle to the OpenAI Codex CLI
when the Claude subscription allowance is exhausted.** Today an allowance
refusal is recognised (`src/lib/orchestrator.ts:1438`), classified
(`:1540`) and **parked** (`:1795`) — up to three times, then failed
`pauses-spent`. This survey asks whether the run should instead switch provider,
gives five answers their strongest honest case, and recommends against four of
them.

An option set, not a plan. Read `00-problem.md` first: the measurement in §2
corrects the premise the brief was written on, and it moves the answer.

---

## The finding that shapes everything

**Parking costs much less than it was thought to.** The brief that commissioned
this survey states that "a parked run holds its folder and its worktree slot
until the window resets." Both halves are wrong:

- **It yields the folder.** `occupantOf`'s status set excludes `paused`
  deliberately — "a parked run yields its folder, so naming it as the thing a new
  run is waiting for would describe a wait that does not happen"
  (`src/lib/orchestrator.ts:3089`–`:3091`), and `FOLDER_TAKEN_REASON` (`:9294`)
  exists because another run really does take it.
- **It frees a concurrency slot.** `selectPromotable` counts occupancy from
  `status === "running"` alone (`:3828`, `:3832`) against `maxConcurrentRuns`
  (`:3869`).

What a parked run actually holds is **one of 64** checkout slots for its
repository (`MAX_WORKTREE_SLOTS = 64`, `:3120`; `SlotCensus.heldByRuns` includes
paused, `:3138`) — sixteen times the default concurrency cap — plus its own wall
clock, which `maxDurationMinutes` counts through the park by design
(`src/lib/budget.ts:99`–`:101`).

Three more findings narrow it further:

- **`codex exec --json` reports tokens and never a cost.** The whole JSONL union
  is eight events and nine item types; `turn.completed.usage` is five integers
  with no money in it (`codex-rs/exec/src/exec_events.rs`). Claude's
  `result.total_cost_usd` (`orchestrator.ts:6819`) has no counterpart, and
  neither do the other two of this app's three cost sources — so **a Codex cycle
  has zero of the three.**
- **No per-invocation spending ceiling was found anywhere in `codex exec`'s flag
  surface.** `--max-budget-usd` is the only thing that bounds what one Claude
  cycle spends (`cycleInvocation.ts:1115`–`:1118`); its absence means a fallback
  cycle runs under a cycle cap and a clock and nothing denominated in money.
- **Two safety mechanisms have no Codex equivalent**: the unconditional
  `--disallowedTools Bash(pkill:*) Bash(killall:*)` (`cycleInvocation.ts:650`,
  `:1050`) and `SELF_HOSTING_NOTICE` (`:652`–`:663`), which together are what
  stands between an unattended agent and the supervisor process it runs inside.

And one thing that is true today, with nothing built:
**`childEnv` does not strip `OPENAI_API_KEY` or `CODEX_API_KEY`**
(`orchestrator.ts:5371`–`:5382`), so either one set on the server reaches all
five `CLAUDE_BIN` children, in sessions that have `Bash`.

## Recommendation, in one line

**Don't — keep parking, and spend one line adding `OPENAI_API_KEY` and
`CODEX_API_KEY` to `childEnv`'s strip.**
[13-recommendation.md](13-recommendation.md) has the case, the runner-up
(Option C, and why it lost), five things that would overturn it, and the fixed
order to build in if somebody does.

---

## The files

| | |
|---|---|
| [`00-problem.md`](00-problem.md) | What parking actually costs, corrected; the fourteen things the app reads out of a work cycle and the thirteen it puts in; what is on this machine and what is not. |
| [`01-constraints.md`](01-constraints.md) | Thirteen constraints, and **ten unknowns** about the Codex CLI — each with what the answer would change and the exact command that settles it. C1, C2, C10 and C11 decide the ranking. |
| [`02-the-handover-contract.md`](02-the-handover-contract.md) | The spine. Codex's flag surface and JSONL event schema, read from source, put against the app's contract item by item. Three of fourteen reads are **absent**, not merely different. |
| [`03-option-a-park-as-today.md`](03-option-a-park-as-today.md) | **A — change nothing.** Free, correct, three loud failure modes, and cheaper than the brief assumed. |
| [`04-option-b-fallback-at-the-refusal.md`](04-option-b-fallback-at-the-refusal.md) | **B — replace `park` inside `refusalDisposition`.** The narrowest unit, the widest consequences, one loud failure in six. |
| [`05-option-c-provider-at-spawn.md`](05-option-c-provider-at-spawn.md) | **C — a `provider` column, chosen at spawn.** The general mechanism; fallback becomes a policy on top. The runner-up. |
| [`06-option-d-per-template-opt-in.md`](06-option-d-per-template-opt-in.md) | **D — a per-template opt-in.** The only option that asks a question only a person can answer, and the only one whose opt-in outlives its reason. |
| [`07-option-e-workflow-retry-block.md`](07-option-e-workflow-retry-block.md) | **E — a workflow-level retry block.** Best disclosure, best honest continuity, needs a third member in a closed two-member edge union. |
| [`08-continuity.md`](08-continuity.md) | What a Codex cycle can start from — task text, a written brief, `run_events`, the branch — costed against this repository's own measurements. And why **no option should permit alternation**. |
| [`09-guards-and-metering.md`](09-guards-and-metering.md) | Which of the eight guard rungs survive a provider swap (three), where a Codex cost would come from (nowhere), and the pessimistic-at-the-guard shape the codebase already has. |
| [`10-permission-and-credentials.md`](10-permission-and-credentials.md) | What confines a work cycle today, what a Codex process would and would not be under, and **the repair that is owed either way**. |
| [`11-review-landing-and-blast-radius.md`](11-review-landing-and-blast-radius.md) | The merge queue does not change and must not; the run and the card disclose, the diff does not; and why a wall's realised blast radius is the whole fleet. |
| [`12-comparison.md`](12-comparison.md) | The facts table, constraint compliance, the weighted score, five sensitivity runs, and what composes with what. |
| [`13-recommendation.md`](13-recommendation.md) | The case, the one change to make, six refusals by name, the build order if overruled, and the five overturning facts. |
| [`14-validation.md`](14-validation.md) | Every claim re-checked with its command. **Verified**, **corrected** (five, three of them in the brief), and **not verified** (six, including all ten Codex unknowns) — plus the four SQL statements that would settle the frequency question. |
| [`scripts/score.mjs`](scripts/score.mjs) | The comparison's arithmetic, dependency-free. Every number in §4 of `12-` comes out of it. |
| [`scripts/check-citations.mjs`](scripts/check-citations.mjs) | Resolves every link, path and line number in this directory. It found **53** mis-anchored bare `:NNNN` references on the first pass — the defect class ContextControl's validation found fifty of — and all 53 were qualified in place. |

## The options at a glance

| | unit | spawns `codex` | in-cycle $ ceiling | `pkill` denied | disclosure unit | build | loud failures |
|---|---|---|---|---|---|---:|---|
| **A** park | — | **no** | n/a | **yes** | n/a | **0 d** | **3 of 3** |
| **B** at the refusal | **cycle** | yes | none found | no | **per cycle** | 12–18 d | 1 of 6 |
| **C** at spawn | run | yes | none found | no | per run | 14–20 d | 3 of 5 |
| **D** per template | run | yes | none found | no | per run | base + 1–2 d | 2 of 6 |
| **E** workflow block | run | yes | none found | no | per run | 12–19 d | 4 of 6 |

Weighted totals — **A 194**, E 131, C 120, D 105, B 70 — over ten criteria in
`12-comparison.md` §4, recomputable via `node scripts/score.mjs`. A wins all five
sensitivity runs. The script also solves for the weight at which each rival would
tie it: **B needs 35, C needs 41, E needs 67**, against a highest weight anywhere
else of 5.

**And the table is measuring cost, not value.** A scores 5 on eight of ten
criteria because it does nothing, so it breaks nothing. The one criterion where
it loses — throughput when the allowance is gone — is the one nobody can weight,
because `runs` has zero rows on this machine and no park has ever been counted.
That is the honest state of the question and it is why the recommendation is
"wait" rather than "never".

## Reproducing

The Codex side, read from source (no binary, no account):

```sh
D=$(mktemp -d)
curl -sS -o "$D/pkg.json" https://registry.npmjs.org/@openai/codex/0.152.1
for f in exec/src/cli.rs exec/src/exec_events.rs exec/src/lib.rs \
         utils/cli/src/shared_options.rs utils/cli/src/sandbox_mode_cli_arg.rs \
         utils/cli/src/approval_mode_cli_arg.rs utils/cli/src/config_override.rs \
         login/src/lib.rs login/src/auth_env_telemetry.rs login/src/token_data.rs \
         config/src/shell_environment_policy.rs; do
  curl -sS -o "$D/$(echo "$f" | tr / _)" \
    "https://raw.githubusercontent.com/openai/codex/main/codex-rs/$f"
done
```

The scoring, and the citation resolver:

```sh
node proposals/ProviderFallback/scripts/score.mjs
node proposals/ProviderFallback/scripts/check-citations.mjs
```

Node ≥ 20, no dependencies, read-only, runnable from anywhere in the checkout.

## What this proposal does not do

No change under `src/`, no dependency, no `Dockerfile`, `docker-compose.yml` or
`.env.example`. The one change it recommends is a line in `childEnv`, described
in `13-recommendation.md` and not made here. The constraints an implementer must
not break are in `01-constraints.md`, and each routes to the `docs/agent/` file
that owns it.

`proposals/README.md` needs a row for this directory and does not have one — the
brief fixed the change scope at this folder.
