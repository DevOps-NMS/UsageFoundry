# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Next.js 15 (App Router) app that (a) reads Claude Code's local session transcripts to show subscription usage against 5-hour / weekly windows, and (b) runs Claude Code headlessly against a mounted folder, stopping between iterations when a budget guard trips. Ships as a single Docker container. `docs/architecture.md` is the `src/lib/` module map and `docs/agent/` carries the per-area reasoning behind each one — read the relevant one before changing anything in `src/lib/`. `README.md` is the landing page and says nothing about `src/lib/`.

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

Two environment traps, both of which make a green tree look broken and neither of which is about this repository. A bare `npm ci` under the image's `NODE_ENV=production` exits 0 having skipped devDependencies, and `typecheck`/`test` then fail with exit 127 — use `NODE_ENV=development npm ci --include=dev`. And a shell inheriting `__NEXT_PRIVATE_STANDALONE_CONFIG` from a UsageFoundry container (which is what an agent this app spawns gets) makes `next build` die with `TypeError: generate is not a function`: `loadConfig` returns that JSON verbatim rather than loading `next.config.ts` and applying defaults, and a serialized config cannot carry `generateBuildId`, which is a function. `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` is the whole fix.

There is **no linter run** (`eslint.ignoreDuringBuilds` is on), and `npm test` covers a deliberately short list of pure functions whose failure modes are silent and expensive. `npm run typecheck` plus a `docker compose up --build` smoke test is the real verification loop, and `docs/verification.md` — including its "Not yet verified by hand" list, which must stay honest — records what was checked by hand. Before adding a test, read `docs/agent/testing.md`: it names every existing one and the grounds each earned, and that is the bar, not a general convention to follow.

Note that `npm run dev` on the host reads the host's **real** `~/.claude` transcripts and can spawn **real, billed** `claude` processes. Runs default to `acceptEdits`, so an agent started from the UI writes files.

## Before you edit

This app's invariants encode the product's reasoning, not style preferences, and nearly every one of them fails **silently** — nothing throws, nothing fails to typecheck, and the page looks right. They live in `docs/agent/`, one file per area. The lines below are gates, not summaries: if you are about to touch the files named, read the doc first.

- **`src/lib/` generally, the module map, the three data sources** → `docs/agent/architecture.md`
  - Three cost sources, never summed or mixed in the UI. OTLP telemetry must never reach `buildSnapshot()` or `runs.spent_usd`.
  - Four kinds of *agent* child process, from four modules, plus `claudeAuth.ts`'s, which starts no agent and is bounded by one pending login rather than by `maxConcurrentAssists`. Another is a decision, not a detail.
  - `emit()` persists to `run_events` **then** publishes. That order is what makes reconnect lossless.
  - Three modules joined the map: `fileCostNotice.ts` and `readGuard.ts` ride flags that already existed and both ship off or empty, and `toolComposition.ts` is a second *reader* of the transcripts, never a fourth source.

- **`windows.ts`, `transcripts.ts`, `pricing.ts`, `planUsage.ts`, `repoSpend.ts`, `otlp.ts`** → `docs/agent/metering.md`
  - Unknown renders as a hatched indeterminate meter, never a 0% bar. No numeric ceilings in `DEFAULTS`.
  - `costUSD`/`fraction` are what the user is shown; `costGuardUSD`/`guardFraction` are what the guard acts on. Never collapse the two.
  - The provider's own percentage outranks anything derived from a ceiling — and its body reports **percent** where the headers carry a 0–1 fraction.
  - Every turn must land in a bucket, so each of the five rollups reconciles to the window total. `byTool` is the one reading that deliberately does **not** — a `tool_result` carries no usage, so it counts characters, reconciles only to itself, and takes a shape (`{rows}`, not `{…, agg}[]`) the five cannot compile against.
  - `byAgent`'s `counterfactualUSD` reprices the same turns at another model's rate on the day each ran. It is a counterfactual, never a forecast, and never a cost source.
  - A model-scoped weekly wall stands alone when the provider named no all-model figure, with `planFraction` still null. An exhaustion projection past its own window's reset is dropped, never clamped.

- **`budget.ts`, `installBudget.ts`, every guard site in `orchestrator.ts`** → `docs/agent/budgets-and-guards.md`
  - `null` / `""` / `0` all mean "off". Only an explicit `null` asks for an uncapped loop.
  - The loop must always have a monotone terminus: `maxIterations` is nullable only alongside `maxDurationMinutes`.
  - `no_ceiling` is refused at the door and never acted on afterwards; `no_terminus` stays enforceable.
  - The check order — terminus, cycles, duration, run spend, weekly, then session — is load-bearing, and an unreadable window must not end it early: `no_ceiling` is **held** and returned only once every readable guard has passed, in `evaluateBudget` and `evaluateInstanceBudget` alike.
  - The display-versus-guard split holds in `reconcileKilledCycle` too. There is no column for the guard half, so what survives a restart or a pick-up is the floor.
  - The install ceiling's rolling 24 hours bounds a run on `finished_at` or on `paused_at` while it is still `paused`, a block on `started_at`, and a chat per **turn** through `chat_turn_spend` — never a thread's lifetime total.

- **`orchestrator.ts`'s run loop, `fleet.ts`, `requestLog.ts`, `notify.ts`** → `docs/agent/run-lifecycle.md`
  - `runs.origin` is a **required** field at every `createRun` call site. `reopenRun` deliberately writes none.
  - Only the 5-hour window can be waited out. A provider refusal parks the run regardless of enforcement mode.
  - `cancelled` is checked twice per cycle, and the interrupt test comes **before** the exit-code test.
  - Both bulk pick-ups filter on `set_aside_at`; `reopenRun` clears it. Setting a live run aside marks it **before** the stop.
  - The DONE contract reaches cycle 1 as **generated** text, gated on `endsOnDone`. A prompt in `Settings` would not reach a saved install.
  - `needs-review` is the agent's own judgement about the *task*. Its rung sits below every refusal and exit-code test, above `DONE`, and clears `reportedDone` explicitly. Its notice is generated too and is **not** gated on `endsOnDone`.
  - `reopenPrompt`'s restart branch sits **above** the pushback: `reported_done` is stale after a mid-cycle kill.
  - `reopenFleet` lays its two fields **over** each run's stored budget, never in place of it. `reopenRun` carries a fourth check that is not one of the three carried-forward guards: the terminus pair, moved to the one door every caller passes because the fleet sheet never sees the route's.
  - A 429 has its own ladder and its own ending. `RATE_LIMIT_BACKOFF_MS` retries **in place** over ~17-26 minutes, holding the folder, the worktree slot and one of `maxConcurrentRuns` the whole time, and `rate-limited` is a distinct `RefusalCause` naming that setting.
  - `runs.file_cost_notice` is generated once at `createRun` and never rebuilt at a spawn: the appended prompt is part of the **cached prefix**, so text that differed between two cycles of one run would cold-start a 190,000-token context and cost far more than the notice saves. Null and empty both mean an argv byte-identical to the one before the column existed.
  - `startsFresh` is the one branch where a cycle *with* a session deliberately does not resume. Off by default, refused on a follow-up or a re-trigger (both are replies), and it reads the last main-thread turn's window rather than the largest.
  - The outbound webhook attaches beside `logLifecycle` inside `emit()` and **nothing on it is awaited**. Six fields, closed list, and `runs.title` is forbidden by name — it is model-writable text. Its own `NOTIFY_STATUSES`, never `TERMINAL_STATUSES` — and `UF_NOTIFY_ON_SUCCESS` widens it through a **branch**, never by putting `completed` in the constant. A guard-caused `stopped` is a latch armed by the `budget` event, never a parse of `stop_reason`; a 429 notifies on the first rung only. All five variables are environment-only, never `settings.json`, and a blank secret sends nothing.
  - Two flags ride **every** cycle's argv because `--resume` restores none of them: `--plugin-dir` (now carrying two generated directories as well) and the **four**-notice `--append-system-prompt` (one flag — a second is a replacement). **`--autocompact` was the third and is gone** — `contextPruning.ts` replaced it, at the same 167,000 it fired at, by ending the cycle and pruning rather than summarising in place; `CYCLE_CONTEXT_CEILING_TOKENS` is **200,000** since 2026-08-25 (it reached 300,000 the same day and came straight back down), because the ceiling reads the whole prompt and ~55,000 of it is a system prompt and tool list no prune reaches. It is still in `ARGV_ARITY` and `NON_CONTEXT_FLAGS` because those say how to *read* a stored argv and every pre-change cycle has one. What the removal gave up is measured and is in `docs/verification.md`: turns past the cap cost 0.45× per turn and 0.50× per 1,000 output tokens. Do not reinstate it beside pruning — the CLI would summarise a conversation moments before this app ended the cycle to prune it, and the run pays for both.

- **`createRun`/`promoteQueued`, `serverLock.ts`, `db.ts`, `instrumentation.ts`** → `docs/agent/concurrency-and-ownership.md`
  - `createRun` runs from entry to INSERT with **no `await`**. Adding one silently puts two agents in one directory — and what that one turn may contain is bounded by constants rather than by a repository's history: the slot walk's `MAX_SLOT_PROBES_PER_ADMISSION`, and the file price list's `MAX_WALK_ENTRIES` and per-folder memo.
  - Never key occupancy on `isRunning()`.
  - Every writer asks the lock at the moment of the write. `unclaimed` is not a refusal.

- **`retention.ts`** → `docs/agent/retention.md`
  - Nothing deletes a `runs` row. What expires is the evidence behind it, on three separate horizons.
  - Every sweep asks the database what is live; never a file's age.
  - The Storage card's two walks are read through a five-minute TTL with single-flight; `treeSize` itself is **not** cached, so no delete path can act on a stale size.

- **`releasableRuns`/`admitDependencies`/`releaseDependents`** → `docs/agent/dependencies.md`
  - A run that ran no work cycle satisfies nothing. Both edge conditions are explicit on the wire, never defaulted.
  - `needs-review` is terminal and is **not** a success: `on-success` stays blocked, `on-finish` starts. One `TERMINAL_STATUSES` entry carries that, retention's three sweeps and the loop block's exit test.
  - Every terminal transition wakes the dependents; a boot deliberately does not.

- **`land.ts`, `mergeQueue.ts`, `resolveIsolation`/`ensureWorktree`** → `docs/agent/isolation-and-landing.md`
  - One branch, one Land button: the last run on the chain, and only once nothing behind it can still commit.
  - The operator's checkout must be clean **and** standing on the recorded target branch.
  - Isolation being *unavailable* degrades to `mode: "none"`; isolation being *used up* throws.
  - Nothing on the landing path has a clock on it. Do not add one.
  - `branchInventory`'s probes run concurrently, so `MAX_PENDING_PROBES` is applied by `selectProbeTargets` in one synchronous pass before the first is dispatched: a counter test spread across awaits caps nothing and makes *which* branch was probed a function of the event loop.

- **`plugins.ts`, `vaultSkill.ts`, the `--plugin-dir` argv, `/api/plugins`** → `docs/agent/architecture.md`
  - Never `claude plugin install`: `~/.claude` is one bind mount shared with the host and its registry records absolute paths.
  - `--plugin-dir` does not survive `--resume`, so it goes on **every** cycle's argv. Neither does `--add-dir`.
  - A stored path is proved contained in a mount again at use time. It becomes a directory whose hooks the container runs.
  - The vault skill is generated per spawn and never written to `DATA_DIR`, which the agent uid cannot read. `--add-dir` grants **write**, so only the skill's own text forbids writing into the vault.
  - The read guard is a third kind of entry on that list and the only one carrying hooks. **A ranged read is tested first and never refused**, so nothing it says no to becomes unreachable — an agent stranded by a guard burns work cycles, which costs more than the reads it prevented. `/run` again, root-owned, with the ledger a *sibling* the agents may write. It ships off, and that `--plugin-dir` registers hooks as well as skills is not confirmed.

- **`contextPruning.ts`, the cycle boundary, `liveGuardTick`'s ceiling** → `docs/agent/run-lifecycle.md`
  - Tokens, never bytes. Winnow frees 3.4× more file than it removes from what is sent, and its own token readout says 0 for a prune that took out 28% of the context.
  - A boundary prune pays no invalidation — `--resume` was rewriting that prefix anyway. An early end manufactured its boundary and pays for it. `trigger` is what separates them and it is priced, not decorative.
  - `paybackTurns` takes the suffix **before** the cut. The after figure is short by exactly what was removed, which flatters the cuts that do not pay.
  - `gentle` is not offered: its one effective strategy is `metadata-strip`, which deletes the `usage` frames every window and every guard here reads.
  - The early end refunds the cycle it ended, bounded by `MAX_EARLY_ENDS_PER_RUN`, or the loop has no terminus.

- **`agents.ts`, `agentRegistry.ts`, `templates.ts`** → `docs/agent/agents-and-templates.md`
  - An agent carries a role, never a capability: no `tools`, no permission mode, no folder. A `tools` field is refused by name at save.
  - `runs.agent` is a frozen copy; `run_templates.agent_id` is a reference. A deleted agent is refused **by name** at every door, never dropped to none.

- **`chat.ts`, `src/app/api/mcp/`** → `docs/agent/chat.md`
  - Prompt text is the one half of a run a model may write. Guards come from a named template or `settings.chatDefaultGuards`.
  - Approval takes the explicit list of ids the page displayed, in one synchronous pass.
  - The capability token is minted per turn, dies with it, and is never `UF_AUTH_TOKEN`. Its 401 is answered **outside** `auditMutation`: `request_log` is capped and evicts on every insert, so auditing a credential-free refusal is a lever on the audit log itself.
  - A turn's cost lands on `chat_turn_spend` beside the thread's running total, because the install ceiling reads a window and the total reads a lifetime.

- **`workflows.ts`, `schedules.ts`, `canvasGraph.ts`** → `docs/agent/workflows-and-schedules.md`
  - Instantiation is topological, one synchronous pass, all or nothing. Half a graph is not a smaller workflow.
  - A node holds no permission mode, no budget and no model — guards come from its template.
  - An orchestrator block's `fanOut` is not nullable, and a workflow whose instance budget sets nothing cannot be scheduled.
  - A loop block unrolls: every pass is a fresh run continuing the last one's branch, and `run_deps` never learns a loop exists.
  - `planLoopPass` stops on `runs.reported_done`, never on `completed` — a used-up cycle cap writes that too. `maxPasses` is not nullable.
  - A `needs-review` pass **stops** the loop rather than waiting for it, and the member counts as settled, never as written off.
  - `looping` is live everywhere `thinking` is, and settled nowhere.
  - An instance's status is four parts derived: `started` means something is live, never "not halted". Act on `instanceIsOpen`, never on `status === "started"`.

- **`review.ts`, `git.ts`, `diff.ts`, `patch.ts`** → `docs/agent/git-and-review.md`
  - Every `git diff` that reads contents carries `--no-ext-diff --no-textconv`; the one exempt call site is named in the doc. Paths that go back out as pathspecs are pinned `:(top,literal)`.
  - A shortened diff says so and names the omitted files in the prompt.
  - `GIT_CONFIG_COUNT` must equal the number of pairs, or git discards the whole block silently.
  - The resolver may run a check only on `resolveCheckout`'s reuse branch, and only what `resolveVerifyTools` names. The reviewer gets none.

- **auth, path containment, spawn argv, anything holding a credential** → `docs/agent/security.md`
  - `resolveInMount()` checks containment on the resolved path **and again** after `realpathSync`. Both are load-bearing.
  - Never a shell. Argv arrays only, at every spawn site.
  - `middleware.ts`'s five exemptions each stay paired with the check that stands in for them.
  - `SELF_HOSTING_NOTICE` carries no literal an agent could `pgrep -f`: it is on every sibling's argv, so a literal matches the fleet. All **four** notices on that one flag inherit the rule. The file price list is a set of repo-relative paths every run on that repository shares, and what keeps it safe is that nothing near them offers a pattern; `RENDERING_NOTICE` names a command for the same reason it carries **no viewport size** — the digits test refuses one, because `1280` reads as a port and the recipe above it says to select a process by its port.
  - `UF_GITHUB_TOKEN` reaches three kinds of child, not one: a work cycle through `selectGithubToken`, and the orchestrator chat turn and a workflow's orchestrator-block child through `chatEnv` — install-wide, under `bypassPermissions` with write access to every mount. Leaving it blank and configuring only `UF_GITHUB_TOKENS` is the lever that withholds it there.

- **`src/components/`, route handlers, `globals.css`** → `docs/agent/conventions.md`
  - Variants are typed props with `Record<Union, string>` lookup maps, never `data-[…]` Tailwind variants.
  - Grouping has a closed vocabulary of seven affordances, each capped, and a closed list of what may never be used. A `<details>` is `ui/Disclosure` and a list view's box is `ui/ListView`'s typed `box`; neither is written out at a call site again.
  - A **region** is not an eighth affordance: a `<div>` with an `<h2>`, never a `<section>`, and never carrying a figure of its own.
  - A caller's class never cancels a component's own spacing. Tailwind emits a utility's values ascending, so the larger one wins whatever the call site wrote — use a wrapper.
  - A table stacks below `md` only with `Table stack` **and** a `label` on every `Td`. One without the other is a column of unnamed figures.
  - `"use client"` files import from `apiTypes.ts` / `format.ts`, never `windows.ts` / `transcripts.ts`.
  - A `<canvas>` reads a colour by probing a real element, never from `getComputedStyle(root).getPropertyValue("--fg")` — every token is a `light-dark()` no `@property` registers, so that returns source text a 2D context rejects silently. Re-probe on a theme change. Size the backing store in device pixels. Keep the element **out of flow**, or the height the observer writes back onto it holds its own host up. And stop the frame loop when the layout cools.
  - Route handlers touching SQLite or the filesystem need `runtime = "nodejs"` and `dynamic = "force-dynamic"`. Eighteen of them answer through `jsonMaybeGzipped` — Next filters every app-router handler out of its own compression by content type — and the streaming routes are excluded by name. A route that moves onto it writes its own `Cache-Control`.
  - A list route ships the list's own DTO (`RunListItemDTO`, `WorkflowListItemDTO`), and quick open reads those same lists: `jsonRequest` is an unchecked cast, so a field dropped on the wire and not at its reader typechecks clean and throws on the shortcut.
  - A payload may carry positions into itself (the graph's links do), but they are resolved to ids at the fetch boundary — a stale index draws a line between two notes that are not linked rather than throwing.
  - A poll stands down when its subject can no longer move, and the re-arm is the half to design: the run page's first load sits above the gate, the last poll after a run settles is what catches its ending, and SSE is what wakes a poll that has stood down.
  - `saveSettings` stores only what differs from `DEFAULTS`. Writing the whole object kills every future default on that install.

- **`docker-compose.yml`, `.env`, `Dockerfile`, `config.ts`** → `docs/agent/environment.md`
  - `DATA_DIR` **refuses** the boot; every other variable warns. That asymmetry is the decision.
  - Compose renders every optional variable as `${VAR:-}`, so a blank-by-default key read through `env()` becomes a permanent warning on every stock install.
  - Never restore a default to `UF_WORKSPACE` or `HOME` in compose.
  - `DISCORD_WEBHOOK_URL` starts the in-container relay and is **unset** before `exec`, between the two because agents are spawned with `{ ...process.env }`. Never forward it to anything downstream, and never auto-fill `UF_WEBHOOK_URL` from it — blank is off.

## Always

- **The UI says "work cycle", the code says "iteration".** User-facing copy names the unit a first-time user must reason about; `Settings`, `BudgetPolicy`, the API payloads and the `runs` table keep `iteration`/`maxIterations`. Don't rename the internals to match the copy, and don't reintroduce "iteration" into the UI.
- **Comments explain *why* a decision was made** — usually a correctness or safety trade-off — never what the code does. Match that when editing.
- **Long-lived module state goes on `globalThis`** (e.g. `__ufDb`, `__ufBus`, `__ufProcs`, `__ufInterrupts`, `__ufTranscriptCacheV2`), or it silently resets on every request in dev. Those five are examples and not the roster — there are thirty-odd such keys; `grep -rn "globalThis as unknown" src/` finds every one. Note `__ufInterrupts`, and now `__ufTranscriptCacheV2`: reusing a key whose *shape* changed is the trap `orchestrator.ts:373` records, because `??=` only initialises when absent, so a pre-upgrade value survives a dev hot reload and every call on it throws. Take a new key; the cost is one cold rebuild.
- **Schema changes** are idempotent statements in `migrate()` in `db.ts`. A destructive one is the exception and runs inside a single `db.transaction`.
- **A pure function whose failure mode is silent gets a unit test.** That is the bar the existing suite was built to; `docs/agent/testing.md` records what each one earned.

## Docs

`docs/agent/` is the agent-facing reasoning above. `docs/` proper is human-facing, and its index is `docs/README.md` — go there rather than to a list here, because a list here is what drifted last time. The two an editor needs are `docs/architecture.md`, the `src/lib/` module map, and `docs/verification.md`, which records what has been measured against the pinned CLI and what has not. Beside the operator's pages — `install.md`, `runs.md`, `workflows.md`, `security.md`, `review-and-land.md`, `orchestrator-chat.md`, `limits-and-accuracy.md`, `backup-and-restore.md` — `docs/` holds one design record, `needs-review.md`, which is implemented and kept for the argument rather than the decision. The rest moved to where their reader is: the UI density audit is `docs/agent/ui-density-audit.md`, because `docs/agent/conventions.md` cites it as the reasoning behind a live invariant, and the external-validator pitch and its baseline measurement are `proposals/ExternalValidator/`, because nothing in them shipped.

`HEALTH-CHECK.md` at the repository root is neither, and is not maintained: it is one dated code audit at `267b901`, 2026-08-11, kept because `scripts/file-health-check-issues.sh` files its sections as issues by title. Its own header carries the per-finding status. Check any finding against the tree before acting on it — one of the seven was fixed in a way that contradicts its suggestion.
