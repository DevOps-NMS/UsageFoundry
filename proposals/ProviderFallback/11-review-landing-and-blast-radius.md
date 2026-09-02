# Review, landing, and blast radius

Two questions the brief asks and one answer each, plus the disclosure rule they
share.

---

## Part 1 — Does a Codex-written branch land through the same merge queue?

**Yes, and it must.**

`landRun` reads git. It does not read a model, a provider, or a transcript. The
merge queue's job is to put a branch onto a target without two runs racing each
other into the same checkout, and none of that reasoning is about who wrote the
commits.

`docs/agent/isolation-and-landing.md` fixes the rules this path runs under —
when a Land button appears and on which run, what the operator's checkout must
be, unavailable versus used-up isolation, and that **nothing on this path may
have a clock on it**. A provider check would be a new condition in front of a
button an operator presses to merge, and the doc's rule about clocks exists for
exactly that class of addition.

`docs/agent/git-and-review.md` fixes the other half: the flags every
content-reading `git diff` carries, pinned pathspecs, `GIT_CONFIG_COUNT`, which
call site may run a check, which half of the touched/changed reconciliation may
reach the database, and the one `CASE` that must not be re-derived. **None of
those is provider-conditional and none should become so.**

So the answer to "does it land the same way" is yes, by prohibition rather than
by convenience: **inventing a difference here is the failure mode**, not
overlooking one.

One caution that is not about landing but arrives at the same moment.
`proposals/GapRegister/README.md` records that `landRun` "merges without building
or testing anything (`src/lib/land.ts:947-1057`)". That is a documented gap
today and it is provider-independent — but it becomes more consequential if a
branch can be produced by an agent that ran under a weaker permission story
(`10-permission-and-credentials.md`), because the human review of the diff is
then the only check that happened.

## Part 2 — Does a run, a diff and a needs-review card have to say which provider produced them?

**Yes for the run and the card. No for the diff.**

### The run: yes

An operator reading a finished run is reading it to decide something —
land it, reopen it, believe its report. Every one of those decisions is affected
by facts that follow from the provider:

- the spend figure is a substitute rather than a measurement
  (`09-guards-and-metering.md`);
- the window guards did not apply;
- the process-kill denial and the self-hosting notice were absent
  (`10-permission-and-credentials.md`);
- the commit-identity instruction was absent.

Withholding that is `docs/agent/git-and-review.md`'s rule inverted: **no row may
carry a success mark it did not earn.** A run page that presents a Codex run
identically to a Claude run is carrying four marks it did not earn.

### The `needs-review` card: yes

`docs/agent/run-lifecycle.md` owns the `DONE` and `needs-review` contracts, their
rungs, and which is generated. A `needs-review` card is a request for a person's
attention, and the first thing that person needs to know is what they are
looking at. Same argument as the run page, one step more urgent.

### The diff: no

A diff is text. `runTouches`/`runTouchScan` reconcile what a run touched against
what changed, under rules `docs/agent/git-and-review.md` fixes, and none of it
is a claim about authorship. Labelling hunks by provider would be a new claim
with no source: a branch with commits from both providers has no per-hunk
attribution unless somebody invents one, and inventing one is precisely what
`proposals/RunDecisionTree/01-constraints.md` C1 refuses in a neighbouring
context.

**The provider belongs on the run, not on the bytes.**

### Where the label may not go

`docs/agent/git-and-review.md` records "the three ways of having nothing that
may never render as an empty list". The analogous rule here: **an unknown
provider must render as unknown, not as Claude.** Every run created before the
column exists has `provider IS NULL`, and `null` means "made before this was
recorded", not "Claude". Defaulting it to Claude on read would be a mark the row
did not earn — the same failure, one column over.

### The unit problem

This is where the options differ, and it is the sharpest practical distinction
between them.

| option | unit of provider | can the run page say it in one line? |
|---|---|---|
| **B** fallback at the refusal | **the cycle** | **no** — a run has cycles from both, so the page needs a per-cycle marker and a summary that is honest about the mixture |
| **C** provider at spawn | the run | **yes** |
| **D** per-template | the run (inherited) | **yes**, plus the template it came from |
| **E** workflow block | the run | **yes** |

Option B is the only one that makes disclosure hard, and it makes it hard in a
specific way: `run_events` would need a provider marker per `iteration` event,
which is a new member of a closed union (C8), and the run's headline spend
becomes a sum of a measured figure and a substituted one — which
`09-guards-and-metering.md` says may not be summed.

**That is not a rendering inconvenience. It is Option B running into C1.**

## Part 3 — Blast radius

The question is: per work cycle, per run, or fleet-wide when the window is gone?

### What the trigger actually is

An allowance wall is **fleet-wide by nature**. Every run sharing the account is
refused within the same minute; `refusalResumeAt`'s docblock describes the
consequence in detail (`src/lib/orchestrator.ts:1899`–`:1906`) and `jitterMs`
(`:1626`) exists because the fleet computes one answer and would otherwise act
on it as one. The `JITTER_FRACTION` docblock records what that looked like:

> Reproduced by the budgets sweep at exactly that: one distinct `resume_at`
> across twenty-five runs. They then wake together, spawn together and — because
> the boundary is approximate in both directions — are refused together, three
> times, at which point `MAX_PAUSES_PER_RUN` ends the fleet.
> — `:1577`–`:1581`

So whatever an option's *declared* radius, its **realised** radius at a wall is
every running run at once, unless it has its own spreading mechanism.

**Any option that switches provider on a wall needs the equivalent of `jitterMs`
before it ships**, or a Claude wall becomes N simultaneous first-ever Codex
cycles against an account nobody has load-tested, under guards that do not bind
(`09-`), with no in-cycle ceiling (U4). That is the worst possible first
production exercise of a new code path.

None of the four building options gets this for free. C and E get it *nearly*
for free, because a switch produces a new run and new runs go through
`promoteQueued`, which already bounds concurrency at `maxConcurrentRuns`
(`:3869`) — so the fallback fleet is throttled by machinery that already exists.
**B does not**, because a fallback cycle is a cycle of an already-running run and
passes through no admission at all.

### Declared radius by option

| option | declared | realised at a wall | throttled by |
|---|---|---|---|
| **A** park | none | none | — |
| **B** refusal site | per cycle | **every running run** | nothing — needs its own spread |
| **C** provider at spawn | per run, operator-chosen | as many as the operator started | `maxConcurrentRuns` |
| **D** per template | per template, inherited | every run from that template, including scheduled ones | `maxConcurrentRuns` |
| **E** workflow block | per graph | as the graph is drawn | `maxConcurrentRuns` |

### The orchestrator chat is explicitly out of scope

For all five options, and the reasons are three.

1. **It is a different spawn with different guards.** `chat.ts:2104` is its own
   site, and `docs/agent/chat.md` governs "which half of a run a model may write
   and where its guards come from", the capability token's life, and why its 401
   is answered outside the audit path. A provider swap inside a chat turn would
   touch every one of those.
2. **A chat turn is watched.** The whole premise of a fallback is that waiting
   costs something because nobody is there. Somebody is there.
3. **A chat can create runs.** Chat proposals carry a `dependsOn` and blocks
   (`src/lib/apiTypes.ts:2596`–`:2601`), so a model can propose work. A provider
   is closer to a capability than to a prompt, and `docs/agent/agents-and-templates.md`
   already refuses a capability field by name on a neighbouring object. **A
   proposal should not be able to set a provider**, and stating that here is
   cheaper than discovering it later.

The one thing that *is* in scope for the chat is the credential defect in
`10-permission-and-credentials.md` §"The defect that exists today" — `chat.ts`'s
spawn is one of the five that would inherit an unstripped `OPENAI_API_KEY`.
