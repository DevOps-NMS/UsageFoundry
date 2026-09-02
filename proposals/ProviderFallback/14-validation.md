# Validation

Three sections: **verified** (re-checked, with the command), **corrected**
(things the brief or an earlier draft of this proposal got wrong), and **not
verified** (claims standing on reasoning or on source-reading rather than on
observation, each flagged where it is used).

Everything below was run in this container at `db10377`.

## 0. Every citation resolved mechanically

```sh
node proposals/ProviderFallback/scripts/check-citations.mjs
→ files 16  links 35  repo paths 282  foreign names 58  named lines 197  bare :N 309
  no problems
```

The script checks three things: that every internal markdown link resolves to a
sibling file; that every `path/file.ts:N` names a real path with at least N
lines; and that every bare `` `:N` `` chains to the last **named** repo path in
the same markdown file, which is the convention `proposals/ContextControl/19-validation.md`
found fifty violations of across eight files.

**On the first pass this proposal had 53 of them.** Every one was qualified in
place — a bare line reference sitting after a `src/lib/budget.ts` citation but
meaning `src/lib/orchestrator.ts:1652` was rewritten to name its own file — and
the run above is the result. Names that are
not this repository's (the Codex sources, `config.toml`, `AGENTS.md`, absolute
host paths) suppress the anchor rather than erroring, so a bare reference after
one is *reported* rather than silently chained to something older.

---

## 1. Verified

### 1a. The refusal path

| claim | where | how checked |
|---|---|---|
| `isUsageLimit` matches the CLI's refusal text and vetoes `spend\|credit\|credits\|balance` | `src/lib/orchestrator.ts:1438`–`:1444` | read |
| `refusalKind` files an allowance wall first, then rate limit, then transient | `:1540`–`:1545` | read |
| `refusalDisposition` parks an allowance refusal below `MAX_PAUSES_PER_RUN`, else fails `pauses-spent` | `:1795`–`:1818` | read |
| `MAX_PAUSES_PER_RUN = 3` | `:1652` | read |
| the call site, and the park branch writing `status = "paused"` and refunding the cycle | `:8125`, `:8174`–`:8192` | read |
| `REFUSAL_BACKOFF_MS = [20, 40, 60]` min, `MIN_REFUSAL_WAIT_MS = 5` min, `MAX_REFUSAL_WAIT_MS = 6` h | `:1640`–`:1644` | read |
| all four `refusalStopReason` sentences name Claude | `:1836`, `:1840`, `:1847`, `:1851` | read |
| `MAX_RESUMES_PER_SWEEP = 4` against a 60-second tick | `:9272` | read |

### 1b. The spawn and stream contract

| claim | where |
|---|---|
| `spawn(CLAUDE_BIN, args)`, no shell, `stdio: ["ignore","pipe","pipe"]`, own process group | `:5621`, `:5619`–`:5621`, `:5628`, `:5634` |
| the fourteen reads in `00-problem.md` §3a | `orchestrator.ts:6595`–`:6919`, each row cited individually |
| cost comes only from `result.total_cost_usd` | `orchestrator.ts:6819` |
| `subtype` is "the only machine-readable statement the CLI makes about *why* a cycle ended" | `src/lib/cycleInvocation.ts:102`–`:104` |
| `buildArgs`' argv, in order | `src/lib/cycleInvocation.ts:1023`–`:1119` |
| `--max-budget-usd` is the only in-cycle spend bound | `:1115`–`:1118`, `src/lib/budget.ts:14`–`:19` |
| `--plugin-dir` is not restored by `--resume` | `cycleInvocation.ts:955`–`:962` |
| `PROCESS_KILLERS = ["Bash(pkill:*)", "Bash(killall:*)"]`, unconditional | `cycleInvocation.ts:650`, `:1050` |
| `SELF_HOSTING_NOTICE` is what stops the agent routing around them | `:652`–`:663` |
| `childEnv` strips six classes, none of them an OpenAI key | `src/lib/orchestrator.ts:5369`–`:5384` |
| `authEnv` is a deliberate copy, and `ANTHROPIC_API_KEY` is deliberately not stripped | `src/lib/claudeAuth.ts:245`–`:273` |
| five `CLAUDE_BIN` spawn sites | `orchestrator.ts:5621`, `chat.ts:2104`, `review.ts:660`, `claudeAuth.ts:302`, `:414` — `grep -rn "spawn(" src/lib` |

### 1c. Guards and metering

| claim | where |
|---|---|
| the guard order: `no_terminus`, `iterations`, `duration`, `run_cost`, `run_tokens`, `weekly_fraction`, `session_fraction`, held `no_ceiling` | `src/lib/budget.ts:494`, `:502`, `:514`, `:524`, `:531`, `:558`, `:574`, `:556` |
| `maxDurationMinutes` includes parked time | `:99`–`:101` |
| `maxIterations`/`maxDurationMinutes` are the only monotone termini | `:86`–`:91` |
| `PRICES` has 20 keys and all 20 begin `claude-` | `src/lib/pricing.ts:31`–`:59`; counted by `node -e` over the literal → `count 20`, `non-claude: (none)` |
| `guardCostOf` substitutes `UNKNOWN_MODEL_PRICE = { input: 10, output: 50 }` | `:194`, `:198`, `:84` |
| three data sources, never summed or mixed in the UI | `docs/agent/architecture.md:10`; `docs/agent/metering.md:50` |
| `byAgent.counterfactualUSD` is the precedent for a further figure that reaches no meter | `src/lib/windows.ts:703`, `:1150`; `src/lib/windows.test.ts:1004`, `:1031`–`:1032` |

### 1d. This machine

| claim | command | result |
|---|---|---|
| `codex` is not installed | `command -v codex` | exit 1, no output |
| no Codex/OpenAI reference in the app | `grep -rni codex src/ docs/ README.md` (excl. `proposals/`) | 0 |
| Claude Code is pinned at 2.1.226 and is the only agent CLI | `Dockerfile:378`–`:379` | read |
| `@anthropic-ai/sandbox-runtime` pinned at 0.0.71 | `Dockerfile:400`–`:402` | read |
| the network is reachable through a proxy | `curl -sS -o /dev/null -w '%{http_code}' https://registry.npmjs.org/@openai/codex` | `200` |
| DNS is **not** the right probe here | `getent hosts registry.npmjs.org` | exit 2, while `curl` succeeds |
| the local database is a dev scratch file | `node -e` + `better-sqlite3`, read-only, over `.data/usagefoundry.db` | `runs 0`, `run_events 0`, `ops_events 1`, `request_log 8`, `chat_sessions 1` |
| `/data` is unreadable from here | `ls -la /data` | empty; the sandbox's read denylist includes it |

### 1e. The Codex CLI, read from source

Every one of these is **`openai/codex@main` as fetched on 2026-09-02**, not a
pinned release, and **no binary was run**.

| claim | file |
|---|---|
| `@openai/codex` 0.152.1, Apache-2.0, `bin/codex.js` over platform `optionalDependencies` | `https://registry.npmjs.org/@openai/codex/0.152.1` |
| `codex exec [OPTIONS] [PROMPT]`, subcommands `resume`/`fork`/`review` | `codex-rs/exec/src/cli.rs` |
| `--json` (alias `--experimental-json`) prints events as JSONL, global | `cli.rs` |
| `-o/--output-last-message`, `--output-schema`, `--ephemeral`, `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules`, `--strict-config` | `cli.rs` |
| `-m/--model`, `-s/--sandbox`, `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`), `--approve-for-me`, `-C/--cd`, `--add-dir`, `-p/--profile` | `codex-rs/utils/cli/src/shared_options.rs` |
| sandbox modes are exactly `read-only`, `workspace-write`, `danger-full-access` | `codex-rs/utils/cli/src/sandbox_mode_cli_arg.rs` |
| approval modes are exactly `on-request` and `never` | `codex-rs/utils/cli/src/approval_mode_cli_arg.rs` |
| `-c key=value` overrides `~/.codex/config.toml`, value parsed as TOML | `codex-rs/utils/cli/src/config_override.rs` |
| the eight top-level JSONL events and the nine item types | `codex-rs/exec/src/exec_events.rs` |
| `Usage` is five integers and **carries no cost** | `exec_events.rs` |
| `thread.started.thread_id` is documented as resumable | `exec_events.rs` |
| auth reads `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` | `codex-rs/login/src/lib.rs:38-47`; `codex-rs/login/src/auth_env_telemetry.rs` |
| ChatGPT-plan auth persists a `chatgpt_plan_type` under `CODEX_HOME` | `codex-rs/login/src/token_data.rs` |
| `shell_environment_policy` has `inherit`, `exclude`, `include_only`, `set`, `ignore_default_excludes` | `codex-rs/config/src/shell_environment_policy.rs` |
| **no rate-limit or quota handling by name in the exec crate** | `grep -in 'rate_limit\|usage_limit\|quota'` over `codex-rs/exec/src/lib.rs` (2,167 lines) → 0 |
| **no per-invocation spend ceiling anywhere in the flag surface** | `cli.rs` + `shared_options.rs`, both read in full |

Reproduce the whole Codex-side reading with:

```sh
D=$(mktemp -d)
curl -sS -o "$D/pkg.json"  https://registry.npmjs.org/@openai/codex/0.152.1
for f in exec/src/cli.rs exec/src/exec_events.rs exec/src/lib.rs \
         utils/cli/src/shared_options.rs utils/cli/src/sandbox_mode_cli_arg.rs \
         utils/cli/src/approval_mode_cli_arg.rs utils/cli/src/config_override.rs \
         login/src/lib.rs login/src/auth_env_telemetry.rs login/src/token_data.rs \
         config/src/shell_environment_policy.rs; do
  curl -sS -o "$D/$(echo "$f" | tr / _)" \
    "https://raw.githubusercontent.com/openai/codex/main/codex-rs/$f"
done
```

---

## 2. Corrected

Four things this survey found wrong, three of them in the brief that
commissioned it. Whether each made the recommendation easier or harder:

### 2a. **A parked run does not hold its folder.** *Easier.*

The brief states "A parked run holds its folder and its worktree slot until the
window resets." `occupantOf`'s default status set is `["running", "queued"]`
(`orchestrator.ts:3097`), and its docblock says the omission is deliberate:
"a parked run yields its folder, so naming it as the thing a new run is waiting
for would describe a wait that does not happen" (`:3089`–`:3091`).
`FOLDER_TAKEN_REASON` (`:9294`) exists because another run really does take it
while this one waits.

### 2b. **A parked run does not hold a concurrency slot.** *Easier.*

`selectPromotable` computes occupancy from `status === "running"` alone
(`:3827`–`:3832`) and compares it against `maxConcurrentRuns` (`:3869`).
A `paused` run is skipped by the `queued` filter at `:3835`. **Parking frees a
slot rather than holding one.**

### 2c. What it *does* hold is one of 64 checkout slots. *Neither.*

`MAX_WORKTREE_SLOTS = 64` (`:3120`), and `SlotCensus.heldByRuns` is documented as
"Held by a run that is queued, running **or paused**" (`:3138`–`:3139`). The
docblock at `:3112`–`:3118` says the headroom over `maxConcurrentRuns` is
deliberate and that what consumes it is dirty retired slots rather than live
runs — so a parked run is a small consumer of a large budget.

The brief was directionally right that *something* is held. It named the wrong
two things, and the thing actually held is 16× the default concurrency cap.

### 2d. The brief's line numbers had moved. *Neither.*

`isUsageLimit` at `:1438` and `refusalKind` at `:1540` are exact.
`refusalDisposition` was given as `:1795` and is at `:1795`. All three verified,
listed here only because the brief invited the check.

### 2e. An earlier draft of this proposal said `PRICES` had 21 keys. *Neither.*

It has 20. Counted rather than eyeballed, and the count is in §1c.

---

## 3. Not verified

Each of these is used somewhere in this proposal and is flagged where it is used.

### 3a. Everything about a running Codex process

**Nothing in `01-constraints.md` Part 2's ten unknowns was settled.** No binary
was installed, no account was held, no `codex exec` was run. In particular:

- **U1** — what Codex emits when its own quota is exhausted. Used in
  `04-option-b`, `12-comparison.md` §2. **This blocks every building option.**
- **U2** — whether `turn.completed.usage` is per-turn or cumulative. Used in
  `02-` item 11.
- **U3** — whether `codex exec resume` restores the sandbox mode and the model.
  Used in `08-continuity.md`.
- **U4** — whether a per-invocation spend ceiling exists. Used in
  `09-guards-and-metering.md`, and it is the largest single input to the
  recommendation.
- **U5** — what `--sandbox workspace-write` permits on Linux under this
  container's seccomp. Used in `10-permission-and-credentials.md`.
- **U6** — whether an `--append-system-prompt` equivalent exists. Used
  throughout; it is what decides whether the self-hosting and commit-identity
  notices can be delivered at all.
- **U7**–**U10** — MCP attachment, argv prompt size, `--json` stability across
  releases, and what a Codex cycle costs.

The probe for each is in `01-constraints.md` Part 2 beside the question.

### 3b. Every frequency about walls

`runs` has zero rows here and `/data` is unreadable, so **no claim in this
proposal about how often, how long, or how consequentially runs park is
measured.** Used in `03-option-a` §"What would have to be true",
`12-comparison.md` §4, and `13-recommendation.md` §"What would overturn this".

Four statements would settle it on a live install:

```sql
-- 1. How often a run has parked at all, and how deep the parks go.
SELECT pause_count, COUNT(*) FROM runs GROUP BY pause_count ORDER BY pause_count;

-- 2. How many runs ended out of waits rather than out of allowance.
SELECT COUNT(*) FROM runs
 WHERE status = 'failed' AND stop_reason LIKE '%already waited out%';

-- 3. How long parks actually last: the gap between parking and the next start.
SELECT id, paused_at, resume_at, (resume_at - paused_at)/60000.0 AS minutes
  FROM runs WHERE paused_at IS NOT NULL ORDER BY paused_at DESC LIMIT 200;

-- 4. Runs that died on wall clock — the one case where parking loses work
--    rather than delaying it. Cross-check against pause_count > 0.
SELECT pause_count, COUNT(*) FROM runs
 WHERE stop_reason LIKE '%time limit%' GROUP BY pause_count;
```

Statement 4 is the one that could overturn the recommendation on its own
(`13-recommendation.md` §"What would overturn this", item 2), and it has a
cheaper fix than a second provider.

Checkout-slot pressure needs a fifth reading that is not SQL: whether
`slotExhaustionRefusal` has ever fired. `ops_events` has one row here.

### 3c. Whether the `--yolo` argument is sound

`10-permission-and-credentials.md` notes that
`--dangerously-bypass-approvals-and-sandbox`'s own help endorses bypassing "in
environments that are externally sandboxed", and that this container arguably is
one. **That is an argument, not a finding.** Whether the uid drop, the mounts
and the process group are sufficient without the domain allowlist is a question
for `docs/agent/security.md`'s owner, and this survey did not answer it.

### 3d. Whether workflows are used on any real install

`07-option-e` depends on it. `workflows` and `workflow_instances` have 0 rows
here, which is a property of a scratch database rather than evidence about
production. `SELECT COUNT(*) FROM workflows` on a live install is the check.

### 3e. Whether `run_templates` are numerous enough for a per-template flag to be reviewable

`06-option-d` depends on it. `run_templates` has 0 rows here.

### 3f. The Codex reading is of `main`, not of a release

Everything in §1e was fetched from the default branch. `Dockerfile:373`–`:377`
explains why this repository pins an agent CLI and reads its contract off one
build; the Codex facts here have had no such treatment. Re-fetching against a
tag before acting on any of them is one command, and **U9** is the reason to.

---

## 4. Owed repairs

One, and it is not conditional on anything in this survey.

**`childEnv` (`src/lib/orchestrator.ts:5369`) and `authEnv`
(`src/lib/claudeAuth.ts:258`) do not strip `OPENAI_API_KEY` or `CODEX_API_KEY`.**
Either variable set on the server today reaches all five `CLAUDE_BIN` children,
inside sessions that have `Bash`. The two functions are deliberate copies of one
another (`claudeAuth.ts:254`–`:256`), so both move together.

Argued in `10-permission-and-credentials.md` §"The repair that is owed either
way"; recommended in `13-recommendation.md`. Read `docs/agent/security.md`
first — this is a change to what a child process can read.

---

## 5. What this proposal did not do

- **Changed nothing outside `proposals/ProviderFallback/`.** No `src/`, no
  `Dockerfile`, no `docker-compose.yml`, no `.env.example`, no dependency.
- **Did not add a row to `proposals/README.md`.** The brief fixed the change
  scope at this directory; the table there is one line short and whoever lands
  this should add it. (While there: that table's ModelRouter row links a
  directory that no longer exists — `ls proposals/` shows no `ModelRouter`. Not
  this survey's to fix, and cited in `05-option-c` on the strength of the README
  row rather than of the files.)
- **Ran no browser and started no container.** Nothing here is a judgement about
  how anything looks.
- **Ran `codex` zero times.**
