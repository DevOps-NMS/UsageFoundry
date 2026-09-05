# ProposalBoundary

**Does an approved proposal become the run the card described, every time — and
when it does not, is the operator told?**

A survey of the moment between a proposal existing in a chat and a run existing
in the queue. It produces findings and evidence, not a feature. Nothing under
`src/` changed.

---

## The answer, in one line

**No, and in three of the five ways it fails the operator is not told anything
they can act on.** The design's own gate — "a run under different rules than the
card stated is what this gate exists to prevent" (`docs/agent/chat.md`) — is open
in the untemplated case: the card carries guard *values* and the approval
carries only ids, so a `chatDefaultGuards` edit between render and click starts
the run under rules nobody agreed to. Separately, two conditions that clear on
their own — the install ceiling and the data-directory lock — destroy the
proposal permanently rather than refusing the click, and a cancelled turn's
child settles the *next* turn's row, handing the operator a dead turn's answer
and throwing their real one away.

Five findings, all reproduced end to end against the real code by the scripts in
[`scripts/`](scripts/). Four are repairs — the code does not do what it plainly
intends — and one is a design change.

## The findings

| | finding | cost to the operator | kind |
|---|---|---|---|
| **F1** | A cancelled or timed-out turn's child settles the **next** turn's row (`src/lib/chat.ts:2340`) | The new message is answered by the turn they stopped; their real answer and its cost are discarded in silence, and the "one billed child per conversation" guard comes open | repair |
| **F2** | A refusal that clears on its own — the install ceiling, the server lock — marks the proposal `failed`, which is terminal (`src/lib/chat.ts:1283`) | An approval that starts nothing **and** deletes the work. In a batch, one ceiling trip destroys every member. Recovery is a billed chat turn | repair |
| **F3** | The guard set applied at approval is re-read at the click; nothing pins it to the card (`src/lib/chat.ts:1254`, `src/app/api/chat/dto.ts:213`) | A run under a permission mode, isolation choice and budget the card never showed. Measured: card said `plan · own checkout · 3 cycles · $5.00`, run started `bypassPermissions`, in the operator's own folder, uncapped | design change |
| **F4** | "Only one proposal may continue a run" is enforced only at `admitDependencies`, and enforcing it burns the proposal (`src/app/api/mcp/route.ts:1828`) | One click starts two of three and destroys the third, with a sentence naming two run ids that were on no card | repair |
| **F5** | A restart leaves no record in the conversation, and the record it leaves on the row is erased by the next message (`src/lib/chat.ts:2446`, `:1618`) | The thread reads as a question the model simply never answered | repair |

A sixth, smaller one — a stopped turn's capability token stays live while its
child dies — is in [`02-findings.md`](02-findings.md) as **F6**.

## What holds

Seven things the survey went looking for and found working as documented: a
deleted template refused by name, a deleted agent refused by name and setting no
guard, a dangling dependency id caught at proposal time, a cycle that cannot be
constructed at proposal time and is caught at approval, `chatOwnsRun` that
cannot be made to over-grant, `promptOverride` reaching the agent in order and
untruncated, and pending proposals and open questions surviving a restart
actionable. Each is written out with its line references in
[`01-the-path.md`](01-the-path.md), because a survey that only lists defects
reads as though nothing was checked.

## The files

| | |
|---|---|
| [`00-question.md`](00-question.md) | What was traced, what "the card promised" is taken to mean, and the method. |
| [`01-the-path.md`](01-the-path.md) | The trace itself: guard resolution, `promptOverride`/`composeTask`, `agentId`, dependency chains, batch approval, restart, capability tokens — each end to end, with what holds marked apart from what does not. |
| [`02-findings.md`](02-findings.md) | The six findings in full, ranked by operator cost, each with its trigger, its consequence, the reading behind it and whether the fix is a repair or a design change. |
| [`03-suspected-but-unverified.md`](03-suspected-but-unverified.md) | Four things the survey suspects and could not establish, kept apart from the rest. |
| [`04-coverage.md`](04-coverage.md) | What the five chat test files cover, the invariants above that no test touches, and the exact commands run with their results. |
| [`05-recommendation.md`](05-recommendation.md) | The ranked order to fix them in, and why F3 is last despite being the worst outcome. |
| [`06-not-examined.md`](06-not-examined.md) | What this survey did not look at, said explicitly. |
| [`scripts/`](scripts/) | Five dependency-free Node scripts. Every finding above is one of them; each exits 0 when it reproduces. |

## Reproducing

```sh
NODE_ENV=development npm ci --include=dev
npm test                        # also produces .test-build/, which the scripts require

node proposals/ProposalBoundary/scripts/cross-turn-settle.cjs            # F1
node proposals/ProposalBoundary/scripts/transient-refusal-burns-proposal.cjs  # F2
node proposals/ProposalBoundary/scripts/guard-drift.cjs                  # F3
node proposals/ProposalBoundary/scripts/rival-continuation.cjs           # F4
node proposals/ProposalBoundary/scripts/restart-state.cjs                # F5
```

Each script builds a throwaway `DATA_DIR`, `CLAUDE_HOME` and `WORKSPACE_ROOT`
under `$TMPDIR`, asserts that `config.DATA_DIR` is the throwaway one before it
writes anything, and removes it on the way out. `cross-turn-settle.cjs` spawns a
fake `claude` shell script; the other four never spawn. `rival-continuation.cjs`
needs `git`. Node ≥ 20, no dependencies.

Two of them print `run.status` JSON lines on stderr from `emit()` — that is the
app's ordinary logging, not part of the result. Pipe through
`grep -v '^{"ts"'` to read them.
