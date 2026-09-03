# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Next.js 15 (App Router) app that (a) reads Claude Code's local session transcripts to show subscription usage against 5-hour / weekly windows, and (b) runs Claude Code headlessly against a mounted folder, stopping between iterations when a budget guard trips. Ships as a single Docker container.

## Commands

```bash
npm run dev          # next dev on :3000
npm run build        # produces .next/standalone (output: "standalone")
npm run typecheck    # tsc --noEmit
npm test             # node --test over src/**/*.test.ts, via tsconfig.test.json
npm start            # serve a production build

docker compose up --build     # the real deployment path; binds 127.0.0.1:3000

python3 scripts/make-icons.py # re-rasterise public/icon.svg; run only after editing it
```

Two environment traps, both of which make a green tree look broken and neither of which is about this repository.

- A bare `npm ci` under the image's `NODE_ENV=production` exits 0 having skipped devDependencies, and `typecheck`/`test` then fail with exit 127 — use `NODE_ENV=development npm ci --include=dev`.
- A shell inheriting `__NEXT_PRIVATE_STANDALONE_CONFIG` from a UsageFoundry container (which is what an agent this app spawns gets) makes `next build` die with `TypeError: generate is not a function`: `loadConfig` returns that JSON verbatim rather than loading `next.config.ts` and applying defaults, and a serialized config cannot carry `generateBuildId`, which is a function. `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` is the whole fix.

There is **no linter run** (`eslint.ignoreDuringBuilds` is on), and `npm test` covers a deliberately short list of pure functions whose failure modes are silent and expensive. `npm run typecheck` plus a `docker compose up --build` smoke test is the real verification loop, and `docs/verification.md` — including its "Not yet verified by hand" list, which must stay honest — records what was checked by hand. Before adding a test, read `docs/agent/testing.md`: it names every existing one and the grounds each earned, and that is the bar, not a general convention to follow.

Note that `npm run dev` on the host reads the host's **real** `~/.claude` transcripts and can spawn **real, billed** `claude` processes. Runs default to `acceptEdits`, so an agent started from the UI writes files.

## Before you edit

This app's invariants encode the product's reasoning, not style preferences, and nearly every one of them fails **silently** — nothing throws, nothing fails to typecheck, and the page looks right. Every one of them is written out in `docs/agent/`, one file per area.

What follows is routing and nothing else: **if you are about to touch anything named on a line, open that line's doc before you edit.** The clause after the dash says what kind of decision the doc settles, so you can tell whether it bears on your change; it is not a summary you can act on instead.

- **`src/lib/` generally, the module map, the three data sources** → `docs/agent/architecture.md` — which cost source may reach what and what may never be summed; the kinds of *agent* child process and what bounds each; `emit()`'s persist-then-publish order; where `fileCostNotice.ts`, `readGuard.ts` and `toolComposition.ts` sit on the map, and why `runs.file_cost_notice` is frozen against the cached prefix.
- **`windows.ts`, `transcripts.ts`, `pricing.ts`, `planUsage.ts`, `repoSpend.ts`, `otlp.ts`** → `docs/agent/metering.md` — how unknown renders and why `DEFAULTS` carries no ceiling; the shown-versus-guard figure split; whose percentage outranks which and in what units; the five rollups, and why `byTool` is deliberately not a sixth; `counterfactualUSD`; the model-scoped weekly wall and exhaustion projections.
- **`budget.ts`, `installBudget.ts`, every guard site in `orchestrator.ts`** → `docs/agent/budgets-and-guards.md` — what counts as "off" and what asks for an uncapped loop; the monotone-terminus rule; the guard check order and how an unreadable window is held rather than acted on; how the shown-versus-guard split survives a restart; what the install ceiling's rolling 24 hours bounds for a run, a block and a chat turn.
- **`orchestrator.ts`'s run loop, `fleet.ts`, `requestLog.ts`, `notify.ts`** → `docs/agent/run-lifecycle.md` — `runs.origin`; what may be waited out and what parks a run; where cancellation is checked and in what order; set-aside and the bulk pick-ups; the `DONE` and `needs-review` contracts, their rungs and which is generated; `reopenPrompt`/`reopenFleet`; the 429 ladder and what it holds; `startsFresh`; the outbound webhook's closed field list and its own status set; and the flags that must ride **every** cycle's argv, including the context ceiling that replaced `--autocompact`.
- **`createRun`/`promoteQueued`, `serverLock.ts`, `db.ts`, `instrumentation.ts`** → `docs/agent/concurrency-and-ownership.md` — the no-`await` window in `createRun` and the constants bounding what that one turn may do; what occupancy may never be keyed on; when a writer asks the lock.
- **`retention.ts`** → `docs/agent/retention.md` — what expires, what never does, and on which horizons; what a sweep may ask; how the Storage card's walks are cached and which figure deliberately is not; which store's cap counts readings rather than rows.
- **`releasableRuns`/`admitDependencies`/`releaseDependents`** → `docs/agent/dependencies.md` — what satisfies an edge; which edge conditions must be explicit on the wire; where `needs-review` sits against `on-success` and `on-finish`; what wakes dependents and what deliberately does not.
- **`land.ts`, `mergeQueue.ts`, `conflictMap.ts`, `resolveIsolation`/`ensureWorktree`** → `docs/agent/isolation-and-landing.md` — when a Land button appears and on which run; what the operator's checkout must be; unavailable isolation versus used-up isolation; that nothing on this path may have a clock on it; how `branchInventory` caps concurrent probes; what the conflicts map may size a node by, and why a clash count nobody read is `null` rather than zero.
- **`plugins.ts`, `vaultSkill.ts`, the `--plugin-dir` argv, `/api/plugins`** → `docs/agent/architecture.md` — why never `claude plugin install`; which flags `--resume` does not restore; when a stored path is re-proved contained; how the vault skill and the read guard are generated, what they grant, and what only their own text forbids.
- **`contextPruning.ts`, the cycle boundary, `liveGuardTick`'s ceiling, the composition series** → `docs/agent/run-lifecycle.md` — tokens rather than bytes, and why winnow's own readout cannot be trusted; what a boundary prune costs against an early end and why `trigger` is priced; how `paybackTurns` is measured; why `gentle` is not offered; what an early end refunds and what bounds it; which readings are gated on the feature being on and which are free; what `winnow context` is asked, on what pacing, and why its window may never be subtracted from the sample's.
- **`agents.ts`, `agentRegistry.ts`, `templates.ts`** → `docs/agent/agents-and-templates.md` — that an agent carries a role and never a capability, and which field is refused by name; frozen copy versus reference, and how a deleted agent is refused.
- **`chat.ts`, `chatThread.ts`, `src/app/chat/page.tsx`'s questions, `src/app/api/mcp/`** → `docs/agent/chat.md` — which half of a run a model may write and where its guards come from; which of them are frozen when the proposal is written and which are read at the click, and what a card that spells values out promises; how approval reads the page; the capability token's life, and why its 401 is answered outside the audit path; where a turn's cost lands and why beside the total; which turn a child's answer may settle, and what a stopped turn's child may no longer touch; where every ending must be written and why the row is not that place; why asking the operator ends the turn rather than waiting through it, why a pending question is a row and not a status, and what an unanswered one becomes; where a question is drawn and why *when* it was asked is not that place; when a choice may send on one press; and why the composer beside an open question is neither disabled nor pre-filled.
- **`workflows.ts`, `schedules.ts`, `canvasGraph.ts`** → `docs/agent/workflows-and-schedules.md` — how instantiation runs and why it is all-or-nothing; what a node may not hold; `fanOut`, and what makes a workflow schedulable; how a loop block unrolls, what stops it, and what `run_deps` never learns; where `looping` is live; how an instance's status is derived and what to act on instead of it.
- **`review.ts`, `git.ts`, `diff.ts`, `patch.ts`, `runTouches.ts`, `runTouchScan.ts`** → `docs/agent/git-and-review.md` — the flags every content-reading `git diff` carries and how pathspecs are pinned; what a shortened diff must say; `GIT_CONFIG_COUNT`; which call site may run a check and what it may run; which half of the touched/changed reconciliation may reach the database and why the other half may not; the one `CASE` that must not be re-derived; why no row may carry a success mark; and the three ways of having nothing that may never render as an empty list.
- **auth, path containment, spawn argv, anything holding a credential** → `docs/agent/security.md` — the two containment checks and why both are load-bearing; never a shell; `middleware.ts`'s exemptions and their standing checks; why nothing on the appended system prompt may carry a literal an agent could `pgrep -f`; which children `UF_GITHUB_TOKEN` reaches and the lever that withholds it.
- **`src/components/`, route handlers, `globals.css`** → `docs/agent/conventions.md` — how variants are typed; which colours a chart's marks may take and why a status tone is not among them; the closed grouping vocabulary, and what a region is not; why a caller's class must not cancel a component's spacing; when a table may stack; what a `"use client"` file may import; how a `<canvas>` reads a colour, sizes itself and stops; what a route handler must export, how it answers and who writes its `Cache-Control`; list DTOs and the quick-open cast; positions resolved at the fetch boundary; when a poll stands down and how it re-arms; `saveSettings`.
- **`dreaming.ts`, `dreamingLedger.ts`, `dreamingRun.ts`, `/dreaming`, `/api/dreaming`** → `docs/agent/dreaming.md` — which half writes and which cannot; why the corpus is the error slice and what widening it deletes; the write-on-second-sighting policy and the three numbers behind it; why the ledger is the retraction mechanism and why `forgetNote` never touches a file; when a signature is claimed and what that trade costs; why reconciliation is keyed on the run; the sticky `selected`; what the prompt must always say, and that nothing enforces it; the three kinds of nothing; and why the tenth pane has no digit.
- **`docker-compose.yml`, `.env`, `Dockerfile`, `config.ts`** → `docs/agent/environment.md` — which variable refuses the boot and why every other only warns; how compose renders optional variables and what that does to `env()`; which defaults must never come back; `DISCORD_WEBHOOK_URL`'s relay, and what must never be forwarded or auto-filled from it.

## Always

- **The UI says "work cycle", the code says "iteration".** User-facing copy names the unit a first-time user must reason about; `Settings`, `BudgetPolicy`, the API payloads and the `runs` table keep `iteration`/`maxIterations`. Don't rename the internals to match the copy, and don't reintroduce "iteration" into the UI.
- **Comments explain *why* a decision was made** — usually a correctness or safety trade-off — never what the code does. Match that when editing.
- **Long-lived module state goes on `globalThis`**, or it silently resets on every request in dev; `grep -rn "globalThis as unknown" src/` finds the thirty-odd keys already there. Never reuse a key whose *shape* changed: `??=` only initialises when absent, so a pre-upgrade value survives a dev hot reload and every call on it throws — the trap `orchestrator.ts:373` records. Take a new key; the cost is one cold rebuild.
- **Schema changes** are idempotent statements in `migrate()` in `db.ts`. A destructive one is the exception and runs inside a single `db.transaction`.
- **A pure function whose failure mode is silent gets a unit test.** That is the bar the existing suite was built to; `docs/agent/testing.md` records what each one earned.

## Docs

`docs/agent/` is the agent-facing reasoning routed above. `docs/` proper is human-facing and its index is `docs/README.md` — go there rather than to a list here, because a list here is what drifted last time. The two an editor needs are `docs/architecture.md`, the `src/lib/` module map, and `docs/verification.md`, which records what has been measured against the pinned CLI and what has not. `README.md` is the landing page and says nothing about `src/lib/`.

`HEALTH-CHECK.md` at the repository root is neither, and is not maintained: it is one dated code audit at `267b901`, 2026-08-11, kept because `scripts/file-health-check-issues.sh` files its sections as issues by title. Its own header carries the per-finding status. Check any finding against the tree before acting on it — one of the seven was fixed in a way that contradicts its suggestion.
