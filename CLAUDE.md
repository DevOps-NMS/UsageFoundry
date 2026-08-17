# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Next.js 15 (App Router) app that (a) reads Claude Code's local session transcripts to show subscription usage against 5-hour / weekly windows, and (b) runs Claude Code headlessly against a mounted folder, stopping between iterations when a budget guard trips. Ships as a single Docker container. `README.md` explains the domain reasoning in depth — read it before changing anything in `src/lib/`.

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

There is **no linter run** (`eslint.ignoreDuringBuilds` is on), and `npm test` covers a deliberately short list of pure functions whose failure modes are silent and expensive. `npm run typecheck` plus a `docker compose up --build` smoke test is the real verification loop, and README's "Verified" section — including its "Not yet verified" list, which must stay honest — records what was checked by hand. Before adding a test, read `docs/agent/testing.md`: it names every existing one and the grounds each earned, and that is the bar, not a general convention to follow.

Note that `npm run dev` on the host reads the host's **real** `~/.claude` transcripts and can spawn **real, billed** `claude` processes. Runs default to `acceptEdits`, so an agent started from the UI writes files.

## Before you edit

This app's invariants encode the product's reasoning, not style preferences, and nearly every one of them fails **silently** — nothing throws, nothing fails to typecheck, and the page looks right. They live in `docs/agent/`, one file per area. The lines below are gates, not summaries: if you are about to touch the files named, read the doc first.

- **`src/lib/` generally, the module map, the three data sources** → `docs/agent/architecture.md`
  - Three cost sources, never summed or mixed in the UI. OTLP telemetry must never reach `buildSnapshot()` or `runs.spent_usd`.
  - Four kinds of *agent* child process, from four modules, plus `claudeAuth.ts`'s, which starts no agent and is bounded by one pending login rather than by `maxConcurrentAssists`. Another is a decision, not a detail.
  - `emit()` persists to `run_events` **then** publishes. That order is what makes reconnect lossless.

- **`windows.ts`, `transcripts.ts`, `pricing.ts`, `planUsage.ts`, `repoSpend.ts`, `otlp.ts`** → `docs/agent/metering.md`
  - Unknown renders as a hatched indeterminate meter, never a 0% bar. No numeric ceilings in `DEFAULTS`.
  - `costUSD`/`fraction` are what the user is shown; `costGuardUSD`/`guardFraction` are what the guard acts on. Never collapse the two.
  - The provider's own percentage outranks anything derived from a ceiling — and its body reports **percent** where the headers carry a 0–1 fraction.
  - Every turn must land in a bucket, so each rollup reconciles to the window total.

- **`budget.ts`, `installBudget.ts`, every guard site in `orchestrator.ts`** → `docs/agent/budgets-and-guards.md`
  - `null` / `""` / `0` all mean "off". Only an explicit `null` asks for an uncapped loop.
  - The loop must always have a monotone terminus: `maxIterations` is nullable only alongside `maxDurationMinutes`.
  - `no_ceiling` is refused at the door and never acted on afterwards; `no_terminus` stays enforceable.
  - The check order — terminus, cycles, duration, run spend, weekly, then session — is load-bearing.

- **`orchestrator.ts`'s run loop, `fleet.ts`, `requestLog.ts`** → `docs/agent/run-lifecycle.md`
  - `runs.origin` is a **required** field at every `createRun` call site. `reopenRun` deliberately writes none.
  - Only the 5-hour window can be waited out. A provider refusal parks the run regardless of enforcement mode.
  - `cancelled` is checked twice per cycle, and the interrupt test comes **before** the exit-code test.
  - Both bulk pick-ups filter on `set_aside_at`; `reopenRun` clears it. Setting a live run aside marks it **before** the stop.

- **`createRun`/`promoteQueued`, `serverLock.ts`, `db.ts`, `instrumentation.ts`** → `docs/agent/concurrency-and-ownership.md`
  - `createRun` runs from entry to INSERT with **no `await`**. Adding one silently puts two agents in one directory.
  - Never key occupancy on `isRunning()`.
  - Every writer asks the lock at the moment of the write. `unclaimed` is not a refusal.

- **`retention.ts`** → `docs/agent/retention.md`
  - Nothing deletes a `runs` row. What expires is the evidence behind it, on three separate horizons.
  - Every sweep asks the database what is live; never a file's age.

- **`releasableRuns`/`admitDependencies`/`releaseDependents`** → `docs/agent/dependencies.md`
  - A run that ran no work cycle satisfies nothing. Both edge conditions are explicit on the wire, never defaulted.
  - Every terminal transition wakes the dependents; a boot deliberately does not.

- **`land.ts`, `mergeQueue.ts`, `resolveIsolation`/`ensureWorktree`** → `docs/agent/isolation-and-landing.md`
  - One branch, one Land button: the last run on the chain, and only once nothing behind it can still commit.
  - The operator's checkout must be clean **and** standing on the recorded target branch.
  - Isolation being *unavailable* degrades to `mode: "none"`; isolation being *used up* throws.
  - Nothing on the landing path has a clock on it. Do not add one.

- **`plugins.ts`, the `--plugin-dir` argv, `/api/plugins`** → `docs/agent/architecture.md`
  - Never `claude plugin install`: `~/.claude` is one bind mount shared with the host and its registry records absolute paths.
  - `--plugin-dir` does not survive `--resume`, so it goes on **every** cycle's argv.
  - A stored path is proved contained in a mount again at use time. It becomes a directory whose hooks the container runs.

- **`agents.ts`, `agentRegistry.ts`, `templates.ts`** → `docs/agent/agents-and-templates.md`
  - An agent carries a role, never a capability: no `tools`, no permission mode, no folder. A `tools` field is refused by name at save.
  - `runs.agent` is a frozen copy; `run_templates.agent_id` is a reference. A deleted agent is refused **by name** at every door, never dropped to none.

- **`chat.ts`, `src/app/api/mcp/`** → `docs/agent/chat.md`
  - Prompt text is the one half of a run a model may write. Guards come from a named template or `settings.chatDefaultGuards`.
  - Approval takes the explicit list of ids the page displayed, in one synchronous pass.
  - The capability token is minted per turn, dies with it, and is never `UF_AUTH_TOKEN`.

- **`workflows.ts`, `schedules.ts`, `canvasGraph.ts`** → `docs/agent/workflows-and-schedules.md`
  - Instantiation is topological, one synchronous pass, all or nothing. Half a graph is not a smaller workflow.
  - A node holds no permission mode, no budget and no model — guards come from its template.
  - An orchestrator block's `fanOut` is not nullable, and a workflow whose instance budget sets nothing cannot be scheduled.
  - An instance's status is four parts derived: `started` means something is live, never "not halted". Act on `instanceIsOpen`, never on `status === "started"`.

- **`review.ts`, `git.ts`, `diff.ts`, `patch.ts`** → `docs/agent/git-and-review.md`
  - Every `git diff` carries `--no-ext-diff --no-textconv`; paths that go back out as pathspecs are pinned `:(top,literal)`.
  - A shortened diff says so and names the omitted files in the prompt.
  - `GIT_CONFIG_COUNT` must equal the number of pairs, or git discards the whole block silently.

- **auth, path containment, spawn argv, anything holding a credential** → `docs/agent/security.md`
  - `resolveInMount()` checks containment on the resolved path **and again** after `realpathSync`. Both are load-bearing.
  - Never a shell. Argv arrays only, at every spawn site.
  - `middleware.ts`'s five exemptions each stay paired with the check that stands in for them.

- **`src/components/`, route handlers, `globals.css`** → `docs/agent/conventions.md`
  - Variants are typed props with `Record<Union, string>` lookup maps, never `data-[…]` Tailwind variants.
  - `"use client"` files import from `apiTypes.ts` / `format.ts`, never `windows.ts` / `transcripts.ts`.
  - Route handlers touching SQLite or the filesystem need `runtime = "nodejs"` and `dynamic = "force-dynamic"`.

- **`docker-compose.yml`, `.env`, `Dockerfile`, `config.ts`** → `docs/agent/environment.md`
  - `DATA_DIR` **refuses** the boot; every other variable warns. That asymmetry is the decision.
  - Compose renders every optional variable as `${VAR:-}`, so a blank-by-default key read through `env()` becomes a permanent warning on every stock install.
  - Never restore a default to `UF_WORKSPACE` or `HOME` in compose.

## Always

- **The UI says "work cycle", the code says "iteration".** User-facing copy names the unit a first-time user must reason about; `Settings`, `BudgetPolicy`, the API payloads and the `runs` table keep `iteration`/`maxIterations`. Don't rename the internals to match the copy, and don't reintroduce "iteration" into the UI.
- **Comments explain *why* a decision was made** — usually a correctness or safety trade-off — never what the code does. Match that when editing.
- **Long-lived module state goes on `globalThis`** (`__ufDb`, `__ufBus`, `__ufProcs`, `__ufCancelled`, `__ufTranscriptCache`), or it silently resets on every request in dev.
- **Schema changes** are idempotent statements in `migrate()` in `db.ts`. A destructive one is the exception and runs inside a single `db.transaction`.
- **A pure function whose failure mode is silent gets a unit test.** That is the bar the existing suite was built to; `docs/agent/testing.md` records what each one earned.

## Docs

`docs/agent/` is the agent-facing reasoning above. `docs/` proper is human-facing: `install.md`, `runs.md`, `workflows.md`, `security.md`, `review-and-land.md`, `orchestrator-chat.md`, `limits-and-accuracy.md`, `backup-and-restore.md`, and `verification.md` — which records what has been measured against the pinned CLI and what has not.
