# The problem

An exhausted Claude subscription allowance already has a disposition in this
app, and it is **park**. This survey asks whether a work cycle should instead be
handed to the OpenAI Codex CLI, and the first thing it has to establish is what
parking actually costs — because the brief that commissioned it asserts a cost
that the code does not support.

Everything below was read at `db10377` on this machine. Line numbers are from
that commit.

---

## 1. What happens today, in order

A work cycle ends. `startRun`'s loop reads the child's refusal text and calls
`refusalKind` (`src/lib/orchestrator.ts:1540`), which asks three predicates in a
load-bearing order:

```
isUsageLimit      (:1438)  →  "allowance"
isRateLimited     (:1508)  →  "rate-limit"
isTransientApiError (:1475) →  "transient"
otherwise                  →  "other"
```

`isUsageLimit` is two regexes and one veto:

```ts
export function isUsageLimit(text: string): boolean {
  if (/\b(spend|credit|credits|balance)\b/i.test(text)) return false;
  return (
    /usage limit reached/i.test(text) ||
    /\b(?:hit|reached) your\s+(?:[\w-]+\s+){0,2}limit/i.test(text)
  );
}
```
— `src/lib/orchestrator.ts:1438`–`:1444`

The veto is the important half and it is the reason this proposal exists at all:
**a credit balance is not an allowance.** The docblock above it (`:1425`–`:1427`)
says so — "balance is not an allowance that refills on a schedule; waiting for
one holds a folder for hours to arrive at the same answer" — and files that case
as terminal. The whole of the park disposition rests on the refusal being a
*refilling* quantity.

`refusalDisposition` (`:1795`) then decides:

```ts
if (o.kind === "allowance") {
  return o.pauseCount < MAX_PAUSES_PER_RUN
    ? { action: "park" }
    : { action: "fail", cause: "pauses-spent" };
}
```
— `:1800`–`:1803`, with `MAX_PAUSES_PER_RUN = 3` at `:1652`

The call site is `:8125`. The park branch (`:8174`–`:8192`) computes
`refusalResumeAt` (`:1908`) off the last window with real spend in it, writes
`finalStatus = "paused"`, and **refunds the cycle** (`iterations -= 1` at
`:8191`) on the grounds that the provider refused before any work happened.

`sweepPaused` picks it back up. `planPausedRun` (`:9335`) re-reads the guard;
`MAX_RESUMES_PER_SWEEP = 4` (`:9272`) against a 60-second tick bounds how fast a
parked fleet drains. The wait itself is `REFUSAL_BACKOFF_MS = [20, 40, 60]`
minutes (`:1640`), floored at `MIN_REFUSAL_WAIT_MS = 5` minutes (`:1642`),
capped at `MAX_REFUSAL_WAIT_MS = 6` hours (`:1644`), and jittered
(`jitterMs`, `:1626`) so twenty-five runs computing one boundary do not wake as
one wave.

## 2. What parking costs — and two things it does not

**The brief states that "a parked run holds its folder and its worktree slot
until the window resets." Both halves of that are wrong as written, and the
correction shrinks the prize this proposal is chasing.**

**It does not hold the folder.** `occupantOf` (`:3094`) takes
`statuses = ["running", "queued"]` by default, and its docblock says why in as
many words:

> `paused` is absent from the default set on purpose — a parked run yields its
> folder, so naming it as the thing a new run is waiting for would describe a
> wait that does not happen.
> — `src/lib/orchestrator.ts:3089`–`:3091`

The sweeper carries the other half. `FOLDER_TAKEN_REASON` (`:9294`) exists
precisely because a *different* run can take the folder while this one waits:
"Waiting for the folder, which a run started while it waited now holds."

**It does not hold a concurrency slot.** `selectPromotable` (`:3813`) counts
occupancy from `status === "running"` alone:

```ts
const reserved: ConflictKey[] = runs
  .filter((r) => r.status === "running")
  .map((r) => conflictKey(workDirOf(r)));
…
let live = reserved.length;
```
— `:3827`–`:3832`, against `cap = getSettings().maxConcurrentRuns` at `:3869`

A `paused` run is in `activeRuns()` (`:3073`, which selects
`queued`/`running`/`paused`) but is skipped by the `queued` filter at `:3835`
and never counted at `:3832`. **Parking a run therefore frees one of
`maxConcurrentRuns` for something else to use.**

What parking *does* cost is four things, and they are smaller and sharper than
the brief's version:

| | cost | where |
|---|---|---|
| **1** | one of **64** checkout slots for that repository | `MAX_WORKTREE_SLOTS = 64` (`:3120`); `SlotCensus.heldByRuns` is documented as "Held by a run that is queued, running **or paused**" (`:3138`–`:3139`) |
| **2** | **wall clock, including the parked time** | `maxDurationMinutes` is "measured from when it first started and **including any time spent parked**" (`src/lib/budget.ts:99`–`:101`) |
| **3** | one of **three** waits | `MAX_PAUSES_PER_RUN = 3` (`orchestrator.ts:1652`), then `fail` with cause `pauses-spent` (`orchestrator.ts:1803`) |
| **4** | latency — the work is not done until the window refills | up to `MAX_REFUSAL_WAIT_MS = 6h` (`orchestrator.ts:1644`) |

**Cost 2 is the one that converts a wait into a loss.** A run with a
`maxDurationMinutes` shorter than the window it is waiting out cannot survive
the park: `planPausedRun` (`orchestrator.ts:9335`) ends a parked run on a verdict that can
never clear, and wall clock is exactly such a verdict. Cost 1 is the one an
operator would notice at scale, and 64 is far above `maxConcurrentRuns`'s
default of 4 — the docblock at `orchestrator.ts:3112`–`:3118` says the headroom is deliberate
and that what consumes it is dirty retired slots rather than live runs.

Cost 3 has a second edge worth naming: `refusalStopReason`'s `pauses-spent`
sentence (`orchestrator.ts:1836`) tells the operator "Out of waits rather than out of
allowance", which is honest today and would become a lie under any option that
spends a wait on a fallback attempt.

## 3. What the app reads out of the child, and what it puts in

This is the spine. Any second provider has to satisfy this list or the app has
to be told, per item, what it is giving up.

### 3a. Out — the stdout contract

`runIteration` (`orchestrator.ts:5600`) spawns with `stdio: ["ignore", "pipe", "pipe"]`
(`:5628`), splits stdout on newlines (`:5667`–`:5676`), and hands each line to
`handleStreamLine` (`:6595`). A line that does not parse as JSON degrades to a
log entry (`:6604`–`:6606`) — the parser fails soft, which is why a contract
drift here is silent.

Fourteen things are read. Every one of them is a column in
[`02-the-handover-contract.md`](02-the-handover-contract.md).

| # | read | from | line |
|---|---|---|---|
| 1 | `session_id`, on change | every event | `orchestrator.ts:6617`–`:6624` |
| 2 | assistant text → `finalText`, `run_events` kind `assistant` | `assistant.message.content[].text` | `:6696`–`:6703` |
| 3 | **provider refusal** → `apiError` | an assistant turn whose `message.model` is the literal `<synthetic>` | `:6636`, `:6697` |
| 4 | resident context size → `contextTokens` | `input + cache_creation + cache_read` | `:6665`–`:6673` |
| 5 | tool calls → `run_events` kind `tool` | `content[].type === "tool_use"` | `:6704`–`:6752` |
| 6 | sub-agent attribution | `Task` call's `subagent_type`, keyed by block id | `:6710`–`:6714` |
| 7 | forwarded sub-agent text → kind `subagent` | `parentToolUseId` | `:6678`–`:6694` |
| 8 | failed tool results → kind `tool_error` | `user` event's `tool_result` | `:6776`–`:6784` |
| 9 | sandbox refusals → kind `sandbox` | the words of the failure | `:6793`–`:6805` |
| 10 | **cost** → `costUSD` | `result.total_cost_usd` | `orchestrator.ts:6819` |
| 11 | tokens → `tokens` | `result.usage.{input,output,cache_creation,cache_read}` | `:6822`–`:6828` |
| 12 | **why the cycle ended** → `subtype` | `result.subtype` | `:6834`–`:6835` |
| 13 | refused tool calls | `result.permission_denials` | `:6860` |
| 14 | hook output, task events | `system` events, minus `thinking_tokens` | `:6889`–`:6919` |

Plus stderr, which is forwarded line by line and tailed into `stderrTail`
(`:5679`–`:5691`, bounded by `STDERR_TAIL_LIMIT = 4_096`,
`src/lib/cycleInvocation.ts:139`) so that `refusalInStderr` (`orchestrator.ts:1558`) can promote
an allowance refusal that never reached stdout.

`IterationResult` (`src/lib/cycleInvocation.ts:22`–`:136`) is the shape all of
that lands in, and its field docblocks are where the distinctions live — in
particular that `costUSD` is a *session running total* and `tokens` is a
*per-stretch sum*, which is why one is assigned through `cycleCostAfterResult`
and the other is `+=`'d (`orchestrator.ts:6814`–`:6828`).

### 3b. In — the argv contract

`buildArgs` (`src/lib/cycleInvocation.ts:885`) assembles, in order (`:1023`–`:1119`):

```
-p <prompt>  --output-format stream-json  --verbose
[--model <m>]  [--permission-mode <mode>]  [--forward-subagent-text]
[--agents <json> --agent <name>]                    sessionAgentArgs
--allowedTools <isolated git tools…> <search tools…>
--disallowedTools <process killers…>
--append-system-prompt <four notices + the run's frozen file price list>
[--plugin-dir <dir>]…                               plugins + vault skill + read guard
[--add-dir <vault path>]
[--resume <session_id>]
[--max-budget-usd <remaining>]
```

Five properties of that argv are load-bearing and are stated in its own
docblocks:

- **`--max-budget-usd` is the only thing bounding what one cycle may spend**
  (`:1115`–`:1118`, and `src/lib/budget.ts:14`–`:19`). Every other guard bounds
  the *count* of cycles.
- **`--plugin-dir` is not restored by `--resume`**, so it rides every cycle
  (`cycleInvocation.ts:955`–`:962`).
- **`--append-system-prompt` must be one flag**, because a second is a
  replacement rather than an addition (`:1051`–`:1057`).
- **The file price list is never rebuilt**, because it is part of the cached
  prefix and a changed prefix is a full-price re-read of a ~190,000-token
  context (`:1006`–`:1015`).
- **No shell.** Arguments go as an array, so a prompt containing backticks is
  inert (`orchestrator.ts:5619`–`:5621`).

And the environment: `childEnv` (`orchestrator.ts:5369`–`:5384`) copies `process.env`, sets
`FORCE_COLOR=0`, and deletes six classes —

```ts
key.startsWith("UF_") || key.startsWith("OTEL_") ||
key === "ANTHROPIC_ADMIN_KEY" || key === "CLAUDE_CODE_ENABLE_TELEMETRY" ||
key === "DATA_DIR" || key === "NODE_OPTIONS"
```

— then merges `telemetryEnv` (`:5441`) and `githubEnv` (`:5526`). The child runs
under `childCredentials()` (`src/lib/privsep.ts:252`) and in its own process
group so `signalTree` (`orchestrator.ts:5566`) can kill what it started.

## 4. What is on this machine, and what is not

| claim | verdict | command |
|---|---|---|
| `codex` is on `PATH` | **no** | `command -v codex` → exit 1 |
| any OpenAI or Codex reference in `src/`, `docs/`, `README.md` | **none** | `grep -rni codex src/ docs/ README.md` (excluding `proposals/`) → 0 |
| `@anthropic-ai/claude-code` is the only agent CLI in the image | **yes** | `Dockerfile:378`–`:379`, pinned `2.1.226` |
| `@anthropic-ai/sandbox-runtime` is beside it | **yes**, pinned `0.0.71` | `Dockerfile:400`–`:402` |
| `pricing.ts` knows any non-Anthropic model | **no** — every key in `PRICES` begins `claude-` | `src/lib/pricing.ts:31`–`:59` |
| `runs` has a `provider` column | **no** | `pragma table_info(runs)` on `.data/usagefoundry.db` returns 46 columns, none named for a provider or a vendor; the file is stale — it predates `file_cost_notice` (`src/lib/db.ts:845`) — so read it as a floor, and `grep -n 'addColumn(db, "runs"' src/lib/db.ts` for the authoritative list |
| the container can reach the network | **yes**, through a proxy | `curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/@openai/codex` → `200` |

That last row is why the Codex side of this proposal is **read from source
rather than guessed** — see [`02-the-handover-contract.md`](02-the-handover-contract.md)
— and why the unknowns in [`01-constraints.md`](01-constraints.md) are the ones
that need a *running* binary or an *account*, rather than the ones that need
documentation.

## 5. What could not be measured, and why

**No run history exists on this machine.** `/data` is outside this container's
read set, and the in-checkout database is a dev scratch file:

```
runs 0 | run_events 0 | ops_events 1 | request_log 8 | chat_sessions 1
```
— `node -e` over `.data/usagefoundry.db` with `better-sqlite3`, read-only

So **every frequency claim in this proposal is a mechanism claim.** How often a
run parks, how long a park lasts in practice, how many parks reach
`pauses-spent`, and what share of runs die on wall clock while parked are all
unknown here. `14-validation.md` §"Not verified" carries the four SQL statements
that would settle them, and the recommendation says which of them would change
it.

This is the same wall three neighbouring proposals hit —
`proposals/GrowthLimits/README.md`, `proposals/GapRegister/README.md` and
`implemented - UnattendedOperation/README.md` all record `/data` as
`Permission denied` and the in-checkout copy as empty. It is a standing
property of this environment, not a failure of this pass.
