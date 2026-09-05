# What this survey did not examine

Stated explicitly, so a later run does not read silence as coverage.

## Out of scope by the brief

- **Everything the operator sees and clicks.** The chat page, the proposal card's
  layout, whether the `failed` array a batch returns is rendered anywhere, how a
  question card is drawn, what the composer says beside an open question. The
  companion survey owns all of it. Where a finding here has a visible half —
  F3's stale card, F7's silent 200 — this survey stops at the wire.

## Examined only as far as the boundary

- **The run after it exists.** `runs.prompt` is written verbatim from
  `composeTask` and reaches the first work cycle as `-p`. What happens to it on
  later cycles — compaction, `contextPruning.ts`, the cycle-boundary prune,
  `--append-system-prompt` re-injection — is the run lifecycle's ground and was
  not traced. `docs/agent/run-lifecycle.md` owns it.
- **`releasableRuns` and the dependency sweep.** Read far enough to establish
  what happens to a dependent whose parent crashed (`blocked`, with a sentence
  naming the parent). Its own correctness — the fixed point, the `edgeSatisfied`
  definitions, `newWorkPaused` — was not audited. `docs/agent/dependencies.md`
  owns it.
- **Isolation and worktrees.** `scripts/rival-continuation.cjs` creates real
  worktrees as a side effect of proving F4, and nothing about
  `resolveIsolation`, `ensureWorktree`, `branchInventory` or landing was
  examined. `docs/agent/isolation-and-landing.md` owns it.

## Not examined at all

- **`propose_workflow` and `approveWorkflowProposal`.** Read enough to establish
  that a workflow proposal carries no `spec_id` (`src/app/api/mcp/route.ts:1422`)
  and so cannot be named by a run proposal's `dependsOn`, and that approving one
  saves a graph and starts nothing. The graph's own validation
  (`normalizeGraph`, `folderRefusal`, `workflowGraph.ts`) is untouched, as is
  everything after Run is pressed.
- **The orchestrator block.** `runOrchestratorChild` was read in full because a
  chat turn is the same child, but `emit_runs`, `planEmission`, `fanOut`,
  `settleBlock` and `BLOCK_TIMEOUT_MS`'s own sweeper were not. The block path
  reaches `createRun` too, so **F2's transient-refusal question very likely
  applies there in some form** — that is a lead, not a finding, and nothing here
  checked it.
- **`ask_operator`'s bounds beyond the read.** `MAX_OPEN_QUESTIONS`,
  `MAX_QUESTION_CHOICES` and the four refusals in `askOperator`
  (`src/app/api/mcp/route.ts:1466`) were read and look right; none was driven.
- **The MCP route's authentication path in anger.** `subjectForCapability`'s
  constant-time scan and the 401 answered outside the audit path were read, not
  probed. F6's consequence — that a stopped turn's token still authenticates —
  is read from `:1211` rather than exercised.
- **Concurrency against a second server.** `dataDirRefusal` gates
  `sendChatMessage` and `requireDataDir` gates `createRun`; both were read.
  Nothing was run with two processes.
- **Retention.** Established only that nothing in `retention.ts` deletes a chat,
  a proposal, a question or a `chat_turn_spend` row, which is what F6's "revoked
  on chat end" question needed. The sweep itself was not examined.
- **`markProposal` under a failed migration.** `db.ts:1742`'s
  `recoverStrandedProposals` describes a state where every decided proposal is on
  disk and unreachable. Read, not exercised.
- **The real `claude` CLI.** No billed process was started. Every child in these
  scripts is a shell script or a path that does not exist. See
  [S1](03-suspected-but-unverified.md#s1).

## Environment

Docker is not available in this container, so no `docker compose up --build`
smoke test was run — the second half of what `CLAUDE.md` calls the real
verification loop. Nothing here claims anything about the app as deployed.
