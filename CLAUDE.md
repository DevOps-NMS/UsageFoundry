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
```

There is **no linter run** (`eslint.ignoreDuringBuilds` is on), and `npm test` covers exactly one thing: `overlaps()` in `orchestrator.ts`. It is there because that predicate is pure and every way it can be wrong ends with two agents writing the same working tree — not because the repo has a testing convention to follow. `npm run typecheck` plus a `docker compose up --build` smoke test is still the real verification loop, and the README's "Verified" section records what was checked by hand.

Note that `npm run dev` on the host reads the host's **real** `~/.claude` transcripts and can spawn **real, billed** `claude` processes. Runs default to `acceptEdits`, so an agent started from the UI writes files.

## Environment gotchas

- The app reads `WORKSPACE_ROOTS` (multiple mounts, `Label=/path` entries joined by `|`) and falls back to the single `WORKSPACE_ROOT` when it is unset. `.env` / `.env.example` define `UF_WORKSPACE`, `UF_WORKSPACE_N` and `UF_WORKSPACE_N_NAME`, which are **only** consumed by `docker-compose.yml` — to pick the host mounts and to compose `WORKSPACE_ROOTS`. Running `npm run dev` without either set falls back to `~/workspace`, so `/api/folders` will look empty even though `.env` names a directory.
- An entry in `WORKSPACE_ROOTS` with an *explicitly empty* label (`=/workspace2`) is **skipped**, while a bare path (`/workspace2`) is labelled from its basename. That asymmetry is load-bearing: compose cannot omit a volume conditionally, so all four slots are always mounted and an unset `UF_WORKSPACE_N_NAME` is what switches a slot off. Adding a workspace must stay an `.env` edit, not a compose edit.
- `CLAUDE_HOME` (default `~/.claude`) determines which transcripts are parsed; `DATA_DIR` (default `./.data`) holds the SQLite file.
- `UF_AUTH_TOKEN` blank disables auth entirely. `ANTHROPIC_ADMIN_KEY` blank leaves the API-account page in an explicit "not configured" state rather than showing zeros.
- All process-level config is centralised in `src/lib/config.ts` and fixed at boot. User-editable values belong in the settings table (`src/lib/settings.ts`), not here.

## Architecture

Two data sources that are **never summed or mixed in the UI**:

| | Subscription view | API-account view |
|---|---|---|
| Source | `~/.claude/projects/**/*.jsonl` | Anthropic Admin API |
| Code | `transcripts.ts` → `windows.ts` | `adminApi.ts` |
| Route | `/api/usage`, `/api/calibrate` | `/api/account` |
| Nature | exact volumes, **estimated** percentages | authoritative |

The subscription pipeline:

```
transcripts.ts  scan + dedupe → UsageEntry[]      (incremental byte-offset reads)
pricing.ts      per-model rates, cache multipliers → costUSD per entry
settings.ts     limitConfig() applies reserved headroom → LimitConfig
windows.ts      buildSnapshot() → 5-hour blocks, weekly rollup, burn, projection
budget.ts       evaluateBudget(policy, snapshot, progress) → allow / block + code
orchestrator.ts the run loop: guard → spawn claude → parse stream-json → repeat
db.ts           SQLite: runs, run_events, settings
```

`orchestrator.ts` is the only module that spawns processes, and it spawns exactly two kinds: the agent (`spawn`) and git (`gitSync`). Both go through an argv array and never a shell. Its loop calls `currentSnapshot()` (a fresh transcript scan) *before every iteration*, evaluates the budget, then spawns one `claude -p … --output-format stream-json --verbose` child in the run's working directory. Iteration 2+ uses `settings.continuationPrompt` and `--resume <sessionId>`; the run ends on `DONE`, the iteration cap, a guard, or a non-zero exit.

Several runs can be in flight at once. `createRun` admits a run or leaves it `queued`; `promoteQueued()` starts whatever is startable, and is called after creation and again in `startRun`'s `finally`. A run on a git repository defaults to its own worktree (`work_dir` ≠ `folder`), which is what lets two runs share a project; a run anywhere else takes the folder exclusively.

Events flow: `emit()` writes to `run_events` **and** publishes on a `globalThis` EventEmitter → `/api/runs/[id]/stream` replays persisted history first (honouring `Last-Event-ID`), then tails live. Persist-then-publish is what makes reconnect and late page loads lossless — keep that order.

## Invariants — these encode the product's reasoning, not style preferences

**Unknown must not render as zero.** Anthropic publishes no numeric value for a Pro/Max limit, so ceilings default to `null`. A `null` fraction renders as a hatched indeterminate meter ("no ceiling set"), never an empty 0% bar. Do not add default numeric ceilings to `DEFAULTS` in `settings.ts`.

**A fraction guard with no ceiling is refused, not ignored.** `evaluateBudget` returns `code: "no_ceiling"` when `maxWeeklyFraction`/`maxSessionFraction` is set but the window has no ceiling. Silently passing would leave the user believing a guard is active.

**Cost is the primary metric; raw tokens are the fallback.** A Claude Code workload is ~98% cache reads at 0.1×, so a token-denominated ceiling tracks conversation length rather than work. `WindowState` exposes both `costFraction` and `tokenFraction`, but `fraction`/`limitMetric` prefer cost whenever a cost ceiling exists.

**Unpriced models contribute $0 and are named.** `resolvePrice` returns `null` for unknown models rather than guessing; `scanUsage` collects `unpricedModels` and the dashboard banners them. Dollar totals are a documented floor.

**Reserved headroom is applied in exactly one place.** `limitConfig()` subtracts it so meters, guards, and the exhaustion projection all agree. Raw configured values stay on `Settings` for display. Capped at 0.95.

**Per-iteration spend comes from the CLI's own `result` event** (`total_cost_usd`), not re-derived from tokens. The transcript-derived cost math in `pricing.ts` serves the dashboard; the two are independent on purpose.

**Transcript parsing details that materially change the numbers:**
- Dedupe key is `${message.id}:${requestId}`, applied across files (a resumed session copies earlier turns forward). Naive summing over-reports by ~3×.
- Files are read from a cached byte offset; the bytes after the final `\n` are left unconsumed so a partially-flushed line is re-read next pass. A shrinking file means rotation → re-parse from 0.
- `cache_creation` splits into 5m (1.25×) and 1h (2×). Unsplit legacy records are attributed to the **cheaper** 5m bucket so ambiguity understates rather than overstates.
- Pricing changes over time: `resolvePrice(model, {at, speed})` is date- and speed-aware (Sonnet 5 intro pricing has an end date; `speed: "fast"` has its own table). Keep new rates in that shape rather than flattening them.

**Guards run between iterations, never during one.** The guarantee is "no new work starts past the threshold", not "spend never exceeds it"; overshoot is bounded by one iteration **per run active at the time**. Concurrency multiplies it — `maxRunCostUSD` is per run, so N runs at $5 is a $25 worst case — and `maxConcurrentRuns` (default `null`, no limit) is what bounds N. Don't document or imply a hard cap. The cap is enforced in `promoteQueued`, counting **running** rows only: it is a limit on work in flight, so a run over it waits rather than being refused, and queued rows — which cost nothing — must never consume it.

**`cancelled` is checked twice per cycle, and both matter.** Once before committing to a cycle (the top-of-loop check is separated from the spawn by a transcript scan that takes seconds, and `stopRun` has already promised no further cycle will start), and once after the child returns, *before* the exit-code test — a SIGTERM'd child closes with a null code that reads as `-1`, so testing the code first files every deliberate stop as `failed`. Likewise `runIteration` resolves on `exit` with a grace period, not on `close` alone: `close` waits for inherited pipes, and an agent that leaves a grandchild behind would otherwise hold its folder until the next restart.

**One writing run per folder subtree, unless the run is isolated.** "Folder" means `(physical tree, path within it)` — `conflictKey()` — compared segment-wise and case-folded by `overlaps()`. Path equality is wrong three ways, all reachable from shipped config: the picker offers the mount root, which contains every folder under it; two mounts can be one host directory (compose defaults `UF_WORKSPACE_2..4` to `${UF_WORKSPACE}`); and macOS is case-insensitive. Mount identity is resolved once, at first use, because `/api/folders` annotates up to 400 folders per request and because a per-check `stat` that throws would fail **open**, permitting exactly the collision this prevents.

**The folder claim is a synchronous check-then-insert.** `createRun` runs from entry to INSERT with **no `await`**, so one event-loop turn covers deciding a folder is free and recording that it was taken. Adding a single `await` to that path silently reintroduces two agents in one directory; the `db().transaction()` wrapper does not save you, because better-sqlite3 is synchronous either way. Never key occupancy on `isRunning()` — `procs` is emptied at the end of every iteration, so it reads false while a running run sits in its pre-iteration scan.

**A restart must close out its own runs.** `reconcileOnBoot()` (via `src/instrumentation.ts`) marks stale `running` rows failed and `queued` rows stopped. Without it one crash blocks a folder permanently. It **never signals a pid**: the DB outlives the container, so a recorded pid names something else after a restart — plausibly this server. Queued rows are stopped rather than resumed, because auto-starting a days-old prompt as an unattended `acceptEdits` agent is the one thing a queue must not do by itself.

**An isolated run works on a branch, and the tool never merges.** A worktree contains committed work only, so `seedWorktree` copies the gitignored config files named in `settings.isolationCopyGlobs` and nothing else — dependencies are the agent's job, and slot reuse is what makes that cheap. The handoff card withholds the `git merge` command entirely while the operator's own checkout is dirty rather than showing it with a caveat, because a copyable command gets copied.

**The UI says "work cycle", the code says "iteration".** User-facing copy names the unit a first-time user must reason about; `Settings`, `BudgetPolicy`, the API payloads, and the `runs` table keep `iteration`/`maxIterations`. Don't rename the internals to match the copy, and don't reintroduce "iteration" into the UI.

**Every budget rule except `maxIterations` can be switched off.** `null` means "no limit" for cost, tokens, duration, and both fractions — `normalizePolicy` maps `null`/`""`/`0` to `null` rather than to a default, so a blank field disables a guard instead of quietly restoring one. `maxIterations` is the exception because the loop has no other natural end.

## Security-critical paths

- `resolveInMount()` (`orchestrator.ts`) checks containment on the lexically resolved path **before** touching the filesystem, then **again** after `realpathSync` — a symlink inside the root can still point out of it. Both checks are load-bearing. `resolveWorkspaceFolder()` runs that pair against **one mount at a time**; multiple mounts widen which roots are legal, never what counts as contained. A run is confined to the mount it started in.
- Containment stays **per mount**, while collision detection is deliberately **cross-mount**: `conflictKey`/`overlaps` see two mounts onto one directory as one folder. Widening what counts as a collision never widens what a run is permitted to touch.
- Worktrees live at `<mountRoot>/.uf-worktrees/<repo>-<slot>` so the unmodified `resolveInMount` validates the agent's cwd. `ensureWorktree` `lstat`s that directory and refuses a symlink **before** git writes — validating afterwards would mean a full checkout had already landed wherever the link pointed.
- The agent is spawned with an argument array and `stdio: ["ignore", "pipe", "pipe"]`, **never a shell**, so prompt metacharacters are inert. `gitSync` does the same, and additionally strips `ANTHROPIC_*`/`UF_*` from the child environment and clears `core.fsmonitor`: both `worktree add` (via `post-checkout`) and `status` (via fsmonitor) can execute repository-controlled commands.
- `permissionMode` is narrowed against the four literals in `POST /api/runs` before it reaches `--permission-mode`.
- `src/middleware.ts` runs in the **edge runtime**: it reads `process.env.UF_AUTH_TOKEN` directly and must not import `lib/config` (which pulls in `node:os`/`node:path`). Comparison is constant-time; API paths get 401, page paths redirect to `/login`.
- `bypassPermissions` is offered in the new-run form with a warning; the default stays `acceptEdits`.

## Conventions

- **Server-only vs client.** `src/lib/apiTypes.ts` holds the DTO mirror of the server types so client components never transitively import `node:fs`. `src/lib/format.ts` is likewise client-safe. Don't import `windows.ts`/`transcripts.ts` types into a `"use client"` file — add to `apiTypes.ts` instead.
- **Route handlers** that touch SQLite or the filesystem need `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"`. Every existing data route has both.
- **Module state survives dev hot reload** via `globalThis` singletons: `__ufDb`, `__ufBus`, `__ufProcs`, `__ufCancelled`, `__ufTranscriptCache`. New long-lived state must follow the same pattern or it silently resets on every request in dev.
- **Schema changes** go in `migrate()` in `db.ts` as idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements — there is no migration framework or version table.
- **Pages are client components** that poll their API route (dashboard 10s, run detail 3s for the row while SSE carries the log). There is no server-side data fetching or React Server Component data layer.
- **Styling** is one hand-written `src/app/globals.css`: CSS custom properties under `:root` with a `prefers-color-scheme: light` override, and variants driven by data attributes (`data-sev`, `data-tone`, `data-unknown`, `data-active`). No Tailwind, no CSS modules, no component library.
- `better-sqlite3` is a native addon — it must stay in `serverExternalPackages` in `next.config.ts`, and the Dockerfile's `deps` stage carries the build toolchain for it.
- Comments in this codebase explain *why* a decision was made (usually a correctness or safety trade-off), not what the code does. Match that when editing.
