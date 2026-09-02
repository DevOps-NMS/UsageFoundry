# Recommendation

**Don't. Keep Option A — park until the window refills — and spend one line
closing the credential defect that a Codex key would otherwise walk into.**

---

## The case, in five sentences

The cost this idea exists to avoid is smaller than the brief assumed: a parked
run yields its folder (`orchestrator.ts:3089`–`:3090`) and does not consume one
of `maxConcurrentRuns` (`:3828`, `:3832`), so what it holds is one of 64
checkout slots (`:3120`) and its own wall clock.

The cost of the alternative is enumerated and large: a second `buildArgs`, a
second stream parser, a second refusal classifier, a second cost story and a
second permission story, of which none is optional and every one fails silently
(`02-the-handover-contract.md`).

Three of those five cannot even be *designed* from here, because they depend on
behaviour of a binary this container does not have and an account nobody here
holds (U1, U4, U5, U6).

Two of the losses are safety rather than fidelity — `--disallowedTools`'
`pkill`/`killall` denial and `SELF_HOSTING_NOTICE`, which together are what
stands between an unattended agent and the supervisor process it runs inside —
and neither has a Codex equivalent this session could find.

And the benefit is unquantified: `runs` has zero rows on this machine, so how
often walls happen, how long they last, and what share of runs die parked are all
unknown, which means the one criterion where parking loses is the one nobody can
weight.

## What to do instead

One change, and it is not a fallback.

**Add `OPENAI_API_KEY` and `CODEX_API_KEY` to `childEnv`'s strip — or move the
whole class behind the `UF_` namespace the repository already uses for
credentials.**

```
src/lib/orchestrator.ts:5369   childEnv
src/lib/claudeAuth.ts:258      authEnv (the deliberate copy)
```

Why this and nothing else:

- **It is a live defect, not a preparation.** Setting either variable on the
  server today gives it to all five `CLAUDE_BIN` children —
  `orchestrator.ts:5621`, `chat.ts:2104`, `review.ts:660`, `claudeAuth.ts:302`,
  `:414` — inside sessions that have `Bash`.
- **The repository has already argued the general case.** `githubEnv`'s docblock
  (`orchestrator.ts:5515`–`:5517`) prefers a namespace to a list precisely because "a *second*
  credential shape is covered by it with no change".
- **A denylist fails open**, and this one currently fails open on a key that
  does not exist yet, which is the cheapest moment there will ever be to fix it.
- **It costs one line and one assertion.** `CLAUDE.md`'s bar — a pure function
  whose failure mode is silent gets a unit test — is met by a test that asserts
  the returned environment contains neither key, in the same shape as the
  test `telemetryEnv` was exported for, which pins `UF_AUTH_TOKEN`'s absence
  because "there is nothing else in the app that would notice if one did"
  (`orchestrator.ts:5437`–`:5439`).

`authEnv` is a deliberate copy rather than an import (`claudeAuth.ts:254`–`:256`),
so both move together or the panel and the runs disagree.

**Read `docs/agent/security.md` before touching either.** This is a change to
what a child process can read, which is the file's subject.

## Runner-up, and why it lost

**Option C, provider at spawn — 120 against A's 194.**

It is the runner-up rather than E (131) despite the lower score, and the reason
is that scores rank options against a fixed question while a runner-up is what
you build if the question changes. E scores higher because a workflow block
discloses better and starts cleaner; but E's throughput is bounded by whether
graphs are used at all, and `workflows` has 0 rows here. C is the substrate D
and E both need, and its phase 1 is the only phase in the whole survey whose
value does not depend on any unknown resolving favourably.

C lost on three things:

1. **No in-cycle spending ceiling** (U4). It can refuse such a policy at
   admission, which is better than discovering it at a wall, but refusing is not
   enforcing.
2. **Its phase 1 has no established want.** Nothing under `src/`, `docs/` or
   `README.md` mentions OpenAI or Codex, and no proposal in `proposals/` raises
   multi-provider operation. 8–12 days of adapter for a policy that is 3 days of
   the total is the wrong ratio unless somebody wants Codex runs for their own
   sake.
3. **`proposals/ModelRouter`'s finding points the same way.** Its recommendation
   was *against building a router*, in favour of the per-run field that already
   had wire support (`proposals/README.md:20`). A provider column is that
   argument's shape; a fallback policy is the router.

**Option B is not the runner-up and should not be built even if C is.** Its unit
is a cycle, which makes alternation possible, disclosure structurally hard, and
a run's headline spend a sum of two populations `docs/agent/architecture.md:10`
forbids summing.

## What is refused by name

- **A per-cycle provider switch** (Option B's mechanism), for C1 and for
  `08-continuity.md`'s three consequences of alternation. If a switch is ever
  built, it produces a **new run**.
- **Alternating providers within one run**, under any option. One column, two
  lineages, and a `startsFresh` that would return a confident number about the
  wrong session.
- **A provider on a chat proposal.** `docs/agent/agents-and-templates.md`
  already refuses a capability field by name on a neighbouring object, and
  `docs/agent/chat.md` fixes which half of a run a model may write.
- **A provider gate in the merge queue or in `runTouches`.** C6: inventing a
  difference on the landing path is the failure mode.
- **Rendering `provider IS NULL` as Claude.** It means "made before this was
  recorded". `docs/agent/git-and-review.md`'s rule about the three ways of having
  nothing applies.
- **Deriving a Codex cost and summing it into `runs.spent_usd` or any window
  meter.** `09-guards-and-metering.md` §"Where the figure may go".

## If somebody overrules this

The order is fixed, and the first two steps are cheap enough to be worth doing
even by somebody who has not decided:

| # | step | days | gate |
|---|---|---:|---|
| 0 | the `childEnv` strip | 0.5 | none — do it anyway |
| 1 | **answer U1, U4, U5, U6** by installing the CLI and running the four probes in `01-constraints.md` Part 2 | 1–2 | an operator willing to install it and hold a key |
| 2 | **measure the wall** — the four SQL statements in `14-validation.md` | 0.5 | a live install |
| 3 | Option C phase 1: the adapter pair and `runs.provider` | 8–12 | steps 1–2 came back in favour |
| 4 | second refusal classifier, cost story, admission refusal | 3–4 | U1 answered |
| 5 | fallback as a **continuation run**, never a cycle switch | 3–4 | steps 3–4 shipped and used |

**Steps 1 and 2 together are two days and they are what this survey could not
do.** Anybody who does them will have a better version of this document than
this one, and both are cheap enough that "we don't know" should not survive a
second attempt at the question.

## What would overturn this recommendation

Any one of the following, and each is a measurement rather than an opinion:

1. **Walls are frequent and long.** If a material share of runs park, and parks
   routinely run to the 6-hour cap, throughput's weight rises and the sensitivity
   table's `throughput → 12` column becomes the base case. Note that even at 12
   A still wins by 55; it takes **35** for B to tie, which is why this alone is
   unlikely to be enough.
2. **A material share of runs die on wall clock while parked.** This converts
   parking from a delay into a loss, and it is the one measurement that would
   make the current disposition look wrong rather than merely slow. It is also
   the one with a cheaper fix than a second provider: `maxDurationMinutes`
   currently includes parked time by design (`budget.ts:99`–`:101`), and whether
   it should is a question this survey did not ask.
3. **U4 comes back with a real per-invocation spending ceiling.** That removes
   the single largest objection and moves C's "money stays bounded" from 2 to 4,
   which is +10 — still not enough alone, and necessary for anything else to
   matter.
4. **U6 comes back with an `--append-system-prompt` equivalent**, restoring the
   self-hosting and commit-identity notices. Combined with 3 — "money stays
   bounded" 2→4 and "containment parity" 2→4, ten points each — C reaches **140**
   against A's 194: closer, still losing, and for the first time defensible.
5. **Somebody wants Codex runs for their own sake.** This is not a measurement
   and it is the only overturning fact that does not need an experiment. It
   changes the question from "is a fallback worth it" to "is multi-provider
   support worth it", which this survey did not ask and which would have a
   different option set.

**Nothing here overturns it on reasoning alone**, which is the point: the
argument against building is not that a fallback is a bad idea, it is that
every input to the decision that could be measured on this machine says wait,
and every input that could not be measured is on the other side of a binary
nobody here can run.
