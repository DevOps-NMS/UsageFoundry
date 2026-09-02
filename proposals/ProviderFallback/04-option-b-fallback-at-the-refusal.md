# Option B — a fallback cycle at the refusal site

Replace `{ action: "park" }` inside `refusalDisposition` with a fourth action —
`{ action: "fall-back" }` — taken when a Codex fallback is configured and the
refusal is an allowance wall. The run's next work cycle spawns `codex exec`
instead of `claude`, in the same folder, on the same branch.

This is the option the brief describes most directly, and it is the one whose
cost the handover contract prices most bluntly.

---

## The strongest case

**The wall is a fact about one provider, and the work is not.** Nothing about
"finish this task in this folder" is Anthropic-specific. When the allowance is
gone, the run has a live worktree, a branch with commits on it, an unfinished
task and up to six hours of nothing to do. Every other disposition in
`refusalDisposition` is about *waiting better*; this one is about not waiting.

It is also the option that attaches at the **only** point where the app already
knows, in one place, that this specific thing has happened.
`refusalDisposition` is pure, unit-tested, and documented as the place where
"every way of being wrong here is silent and expensive in one direction or the
other" (`src/lib/orchestrator.ts:1769`–`:1772`). Adding a disposition there is
adding it where the reasoning already lives.

## Its shape

```ts
export type RefusalPlan =
  | { action: "retry"; attempt: number; kind: "transient" | "rate-limit" }
  | { action: "park" }
  | { action: "fall-back" }                    // new
  | { action: "fail"; cause: RefusalCause };
```

with the gate in `refusalDisposition`:

```ts
if (o.kind === "allowance") {
  if (o.fallbackAvailable && o.fallbacksUsed < MAX_FALLBACKS_PER_RUN)
    return { action: "fall-back" };
  return o.pauseCount < MAX_PAUSES_PER_RUN
    ? { action: "park" }
    : { action: "fail", cause: "pauses-spent" };
}
```

Two new arguments on a function that currently takes three, and the function
stays pure. The loop at `:8125` grows a fourth branch beside `retry`, `park` and
`fail`.

Everything else is downstream of that one branch, and it is not small:

| owed | why |
|---|---|
| a second `buildArgs` | `02-the-handover-contract.md` §"In" — five items absent, including `--disallowedTools` and the appended system prompt |
| a second `handleStreamLine` | `02-` §"Out" — three of fourteen absent, including cost and end-of-cycle subtype |
| a second refusal classifier | C3 — `isUsageLimit` matches Claude's sentences; U1 says nobody knows Codex's |
| a cost story | C1, C2 — no `total_cost_usd`, no price table, no `--max-budget-usd` |
| a permission story | C9 — `--sandbox` × approval-policy is not `--permission-mode` |
| a credential story | C10 — and the environment strip is a denylist |
| a `codex` binary in the image | `Dockerfile:379`'s neighbour, pinned on the same argument (`:373`–`:377`) |

## Continuity

**The worst of the five options, and the reason is structural.** A Claude
`session_id` cannot be resumed by another binary, so the fallback cycle starts
from something else. `08-continuity.md` §"The four sources" costs the
alternatives; here, the important consequence is what happens *next*.

A run that falls back mid-task has, from that point:

- a Claude session id on `runs.session_id`, still valid, describing a
  conversation nothing will resume;
- a Codex `thread_id`, which the row has nowhere to put;
- **two conversation lineages and one column.**

When the Claude window refills — which it does, unconditionally, in at most five
hours — the run either abandons the Codex thread and resumes the Claude session
(losing whatever the fallback cycle reasoned, keeping whatever it committed), or
carries on in Codex and abandons the Claude session it paid to build. There is
no third answer, because there is no cross-provider resume.

**Alternating cycles is the pathological case.** Every switch is a fresh
conversation for the provider being switched *to*. `proposals/ContextControl/03-experiment-resumed-vs-fresh.md` measured a fresh conversation at **2.59× the cost
of a resumed one** with a break-even of 3.9 KB of re-reading per cycle. A run
that alternates pays that on every cycle, in both directions, in exchange for
not waiting.

## Guards and metering

**This is where the option is weakest, and it is not fixable inside it.**

- `maxWeeklyFraction` and `maxSessionFraction` do not constrain a Codex cycle at
  all (C2). They are fractions of a Claude window.
- `maxRunCostUSD` cannot be enforced *in-cycle*: `--max-budget-usd` has no
  established Codex equivalent (U4). Under `between-cycles` enforcement it
  degrades from "the CLI stops the cycle that crosses the threshold" back to
  "no new cycle starts past the threshold" — which is exactly the defect
  `buildArgs`'s docblock says the flag was added to fix
  (`cycleInvocation.ts:895`–`:902`): "a run at $34.99 of a $35 limit used to be
  authorised for one more cycle of any size at all."
- `maxIterations` and `maxDurationMinutes` survive unchanged, and after a
  fallback they are **the only two guards left**.

So the honest statement of Option B's guard posture is: *a fallback cycle runs
under a cycle cap and a clock, and under nothing denominated in money.* An
operator who set `maxRunCostUSD` and nothing else has, at the moment of
fallback, no spending limit at all.

`09-guards-and-metering.md` proposes the mitigation — pessimistic pricing at the
guard, `guardCostOf`'s existing shape — and is explicit that it is a mitigation
and not a fix.

## Permission and sandbox parity

Detailed in [`10-permission-and-credentials.md`](10-permission-and-credentials.md).
The summary for this option: the fallback cycle runs under `--sandbox` and an
approval policy that are *not* the run's `--permission-mode`, under a sandbox
this app does not configure and cannot report on (`sandboxArrangement`,
`src/lib/sandbox.ts:232`, reads a Claude Code managed-settings file), with
`PROCESS_KILLERS` absent and `SELF_HOSTING_NOTICE` absent.

**The last two together are the sharpest single gap in this proposal.** The app
runs inside the process an agent could kill, and both mechanisms that stop it —
a deny list on argv and a paragraph in the appended system prompt — are
Claude-Code-shaped and have no counterpart on the Codex argv this session could
find.

## Review and landing

A fallback happens mid-run, so the branch has commits from both providers. See
[`11-review-landing-and-blast-radius.md`](11-review-landing-and-blast-radius.md).
The merge queue does not need to change (C6); the run page does need to say what
happened, and this option makes that hardest — the unit of disclosure is a
*cycle*, not a run, so "which provider produced this diff" has no single answer.

## Blast radius

**Per work cycle**, which is the narrowest available and is this option's best
property. One refused cycle is replaced. The run's other cycles are unaffected,
other runs are unaffected, and the orchestrator chat is untouched.

But the trigger is fleet-wide by nature: an allowance wall refuses every run
sharing the account within the same minute. So the *realised* radius at a wall is
every running run at once — the same synchronisation `jitterMs` (`orchestrator.ts:1626`) exists
to spread for the park path, and this option would need its own answer to it, or
a wall becomes N simultaneous first-Codex-cycles.

## How it fails, and whether loudly

**Mostly silently, which is the problem.**

| failure | loud? |
|---|---|
| Codex JSONL shape drifts | **no** — `handleStreamLine` logs an unparsed line and continues (`orchestrator.ts:6604`) |
| Codex's own quota is exhausted | **no, then wrongly loud** — `refusalKind` returns `"other"`, the run fails, and `refusalStopReason` says "**Claude Code** refused the request" (`orchestrator.ts:1851`) about something Claude never said |
| no cost is reported | **no** — the run's spend simply stops moving, and `sawResult`'s existing honesty (`cycleInvocation.ts:93`–`:100`) has no Codex analogue |
| `COMMIT_IDENTITY_NOTICE` never arrives | **no** — visible only when a commit is published under the operator's email |
| the sandbox permits more than intended | **no** — this is `policyNamesSomething`'s failure (`src/lib/sandbox.ts:201`) in a new place |
| the binary is missing | **yes** — `child.on("error")` emits "Failed to launch …" (`orchestrator.ts:5693`–`:5703`) |

One loud failure out of six.

## What it costs to build

The largest in the set. A defensible estimate, given that every line of it is
new code against an unrun binary:

| | |
|---|---|
| Codex adapter (argv + stream parse + result mapping) | 4–6 d |
| refusal classification for a second provider (needs U1 first) | 1–2 d, **blocked** |
| cost/guard story and its tests | 2–3 d |
| permission, sandbox and credential story | 2–3 d |
| schema, run page disclosure, `run_events` | 2 d |
| image, pin, and the verification loop `CLAUDE.md` describes | 1–2 d |
| **total** | **12–18 d**, with a hard dependency on unknowns nobody here can resolve |

For scale: `proposals/RunDecisionTree/09-comparison.md` prices its most
expensive option at 8–12 days and rejects it partly on that.

## What would have to be true

1. **U1 answered**, and answered favourably — Codex's quota refusal has to be
   recognisable, or every Codex failure is terminal and misattributed.
2. **U4 answered**, or `maxRunCostUSD` is knowingly abandoned for fallback
   cycles.
3. **U5 and U6 answered**, or the app knowingly runs an agent with no process-kill
   denial and no self-hosting notice inside its own container.
4. **Walls measured as frequent and long**, per `03-option-a`'s falsifiers.
5. An operator willing to hold an OpenAI credential on this machine.

Items 1–3 are the ones that cannot be resolved by deciding harder.
