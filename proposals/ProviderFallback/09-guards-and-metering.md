# Guards and metering with two providers

What a guard *means* when two providers are in play, and where a Codex cycle's
cost would come from — if it can be known at all.

---

## The guard order, and which rungs survive a provider swap

`evaluateBudget` (`src/lib/budget.ts:400`) checks in a fixed order. Each row
below says whether the check still means anything for a Codex cycle.

| # | check | line | survives? | why |
|---|---|---|---|---|
| 1 | `no_terminus` | `:494` | **yes** | a policy with no cycle cap and no clock is refused whatever runs |
| 2 | `iterations` | `:502` | **yes** | counts cycles, not money |
| 3 | `duration` | `:514` | **yes** | wall clock |
| 4 | `run_cost` | `:524` | **degraded** | the comparison still runs; `spentUSD` is a figure nobody can compute for a Codex cycle |
| 5 | `run_tokens` | `:531` | **degraded** | tokens *are* reported (`turn.completed.usage`), but subject to U2, and Codex's `reasoning_output_tokens` has no counterpart in the Claude sum at `orchestrator.ts:6824`–`:6828` |
| 6 | `weekly_fraction` | `:558` | **no** | a fraction of a Claude subscription window |
| 7 | `session_fraction` | `:574` | **no** | same |
| 8 | held `no_ceiling` | `:556`, `:563` | **no** | it is a statement about a Claude window's readability |

**Three of eight survive intact and two of those three are the monotone
termini.** That is not a coincidence: `maxIterations` and `maxDurationMinutes`
are the only two guards documented as termini (`budget.ts:86`–`:91`) precisely
because they are the only two that do not depend on a provider's arithmetic.

### The in-cycle ceiling is the one that actually stops money

Rows 4–7 all bound the **count of cycles that may start**, not the amount spent
(`budget.ts:9`–`:19`). The single exception is `maxRunCostUSD`, and it is an
exception because `buildArgs` hands the CLI what is left of it as
`--max-budget-usd` (`cycleInvocation.ts:1115`–`:1118`). The docblock is blunt
about what that fixed:

> a run at $34.99 of a $35 limit used to be authorised for one more cycle of any
> size at all — the guard bounded the number of cycles that may start past the
> threshold and nothing bounded the amount the one crossing it spent.
> Concurrency multiplies that: twenty-five runs whose settings page reads $875
> had no upper bound this app enforced.
> — `src/lib/cycleInvocation.ts:897`–`:902`

**No `--max-budget-usd` equivalent was found anywhere in `codex exec`'s flag
surface** (`codex-rs/exec/src/cli.rs` and `codex-rs/utils/cli/src/shared_options.rs`,
both read in full — U4).

So the honest statement is: **a Codex cycle, as far as this session could
establish, cannot be given a hard spending ceiling by this app.** The bound is
`maxIterations` × whatever one cycle costs, and the second term is unbounded.

That is the strongest single argument against every building option, and it is
recoverable only by an answer to U4 — either a Codex flag or config key this
session did not find, or an account-side spend limit on the OpenAI platform,
which is outside this app entirely and therefore outside what the run page can
report.

## Where a Codex cycle's cost would come from

### It is not reported

The `codex exec --json` union has no cost field. `turn.completed` carries five
integers and nothing else (`codex-rs/exec/src/exec_events.rs`). Compare the
Claude side, where `result.total_cost_usd` (`orchestrator.ts:6819`) is described
as "authoritative per-iteration accounting from the CLI itself" (`:6812`).

**One of this app's three cost sources simply does not exist for Codex.** The
OTLP source does not exist either — `telemetryEnv` (`:5441`) sets Claude Code's
own telemetry variables, and `childEnv` strips inherited `OTEL_*` so that
"telemetry routing is decided here or not at all" (`:5411`–`:5413`). Nothing
here would reach a Codex process.

The transcript source does not exist: `scanUsage()` walks `~/.claude`.

**So a Codex cycle has zero of this app's three cost sources**, and the only
material available is `turn.completed.usage` in the stream the app is already
parsing.

### Three answers, and the one the codebase already has

**1. Unknown.** `docs/agent/metering.md`'s rule is that a figure which cannot be
computed renders as unknown rather than as zero. `IterationResult.sawResult`
already implements exactly this discipline for a killed Claude cycle:

> when this event is missing — operator stop, crash, OOM — this iteration
> contributes $0 to the run's totals despite having burned real tokens. The run
> reports that rather than presenting the understated figure as fact.
> — `src/lib/cycleInvocation.ts:93`–`:99`

**2. Derived against a new OpenAI price table.** Requires knowing the model
(U10, account-dependent) and maintaining a second table with the same
silent-staleness failure the Claude one has. `PRICES` has 20 keys, all
`claude-*`.

**3. Pessimistic at the guard only, unknown on the card.** This already exists,
one function over, for an unpriced Claude model:

```ts
export function guardCostOf(…) {
  …
  return costOf(tokens, price ?? UNKNOWN_MODEL_PRICE);
}
```
— `src/lib/pricing.ts:194`, `:198`, with
`UNKNOWN_MODEL_PRICE = { input: 10, output: 50 }` at `:84`

That constant is the Fable/Opus-tier rate, i.e. deliberately the most expensive
band. **The display shows unknown; the guard acts on a pessimistic substitute;
the two are never the same number.**

**Answer 3 is what any option here should take**, because it is the shape the
codebase has already argued for, it degrades safely (over-charging a guard stops
a run early, which is the right direction), and it needs no new table.

## Where the figure may go, and where it may not

`docs/agent/architecture.md:10`: **three data sources, never summed or mixed in
the UI.** `docs/agent/metering.md:50`: "three routes to overlapping work, and
any sum double-counts."

A Codex figure is a fourth population. The precedent for admitting one without
making it a source is `byAgent.counterfactualUSD` (`src/lib/windows.ts:703`,
computed `:1150`) — `null` when it cannot be computed, reaching no meter and no
guard, rendered as a statement about a hypothetical.

| destination | Codex spend may go there? |
|---|---|
| `runs.spent_usd` | **no** — it is the sum of what each block's own CLI measured |
| `runs.spent_usd_est` | **arguably yes**, if it is what the guard acted on; it already holds reconciled estimates for killed cycles |
| the dashboard's window meters | **no** — those are the Claude subscription |
| `maxWeeklyFraction` / `maxSessionFraction` | **no** |
| `evaluateBudget`'s `run_cost` meter | **only as the guard figure**, and the run page has to say the figure is a substitute |
| a new, separately-labelled figure on the run page | **yes** — this is the only clean destination |

## What a guard *means* with two providers

The sentence a run page can honestly write, given all of the above:

> This run's spending limit was enforced against Claude cycles by the CLI's own
> ceiling, and against Codex cycles by an estimate this app made from token
> counts at an assumed price. The 5-hour and weekly window guards did not apply
> to the Codex cycles at all.

If that sentence is unacceptable to whoever owns the product, the option set
reduces to Option A.

## The thing that goes unmeasured either way

**Winnow.** When `WINNOW_FILTER=1`, every Claude request goes through a loopback
proxy that places spent tool results after the last cache breakpoint and drops
them next turn — "the bytes cost 1.0x once instead of a 2.0x cache write plus a
0.1x read on every later turn" (`docker-entrypoint.sh:864`–`:865`). A Codex
request goes to a different host and gets none of it.

So the cost comparison is not "a Codex cycle versus a Claude cycle". It is "an
unfiltered Codex cycle versus a filtered Claude cycle", and the second term has a
discount this app measures at scale: `proposals/ContextControl/README.md` puts
82.1% of the week's bill in carried context, priced at 0.1×–2.0× the base rate.

None of that is an argument that Codex is dearer — nobody here knows what it
costs. It is an argument that **the comparison cannot be made from token counts
alone**, and that any claim about a fallback saving or costing money is
unmeasured until somebody runs both.
