# The handover contract

The spine of the whole proposal. `00-problem.md` §3 enumerates what the app puts
into a work cycle and reads out of it. This file puts the Codex CLI's surface
next to it, item by item, and says for each whether it is **satisfied**,
**satisfiable with work**, or **absent**.

Every Codex-side claim carries the file it was read from in `openai/codex@main`.
**No binary was run.** See `01-constraints.md` Part 2 for why, and for the ten
things this reading cannot settle.

---

## What the Codex CLI is

`@openai/codex` on npm, latest `0.152.1`, Apache-2.0. The npm package is an
11.6 KB launcher (`bin/codex.js`) over a platform binary carried in
`optionalDependencies` (`@openai/codex-linux-x64` and five siblings) — so
`npm install -g @openai/codex` is one line in a Dockerfile, structurally like
`Dockerfile:379`. Retrieved by:

```sh
curl -sS https://registry.npmjs.org/@openai/codex/0.152.1
```

The non-interactive entry point is `codex exec`:

```
codex exec [OPTIONS] [PROMPT]
codex exec [OPTIONS] <COMMAND> [ARGS]
```
— `codex-rs/exec/src/cli.rs`, `override_usage`

with subcommands `resume`, `fork` and `review`, and a prompt read from stdin
when it is `-` or absent.

## The flag surface

Read in full from `codex-rs/exec/src/cli.rs` and
`codex-rs/utils/cli/src/shared_options.rs`.

| flag | from |
|---|---|
| `--json` (alias `--experimental-json`), global | `cli.rs` — "Print events to stdout as JSONL" |
| `-o, --output-last-message <FILE>`, global | `cli.rs` |
| `--output-schema <FILE>`, global | a JSON Schema for the final response |
| `--ephemeral`, global | "Run without persisting session files to disk" |
| `--skip-git-repo-check`, global | |
| `--ignore-user-config` / `--ignore-rules`, global | does not load `config.toml` / execpolicy `.rules` |
| `--strict-config`, global | errors on unrecognised config fields |
| `--thread-source <SOURCE>`, global | |
| `--color {always,never,auto}` | |
| `-m, --model <M>` | `shared_options.rs` |
| `-s, --sandbox {read-only,workspace-write,danger-full-access}` | `shared_options.rs`, `sandbox_mode_cli_arg.rs` |
| `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`) | "EXTREMELY DANGEROUS. Intended solely for running in environments that are externally sandboxed." |
| `--approve-for-me` (alias `--not-so-yolo`) | routes approvals through automatic review under `workspace-write` |
| `--dangerously-bypass-hook-trust` | |
| `-C, --cd <DIR>` | working root |
| `--add-dir <DIR>` | "Additional directories that should be writable alongside the primary workspace" |
| `-p, --profile <NAME>` | layers `$CODEX_HOME/<name>.config.toml` |
| `-i, --image <FILE>` | |
| `--oss` / `--local-provider` | local providers (lmstudio, ollama) |
| `-c, --config key=value` | dotted-path overrides of `~/.codex/config.toml`, value parsed as TOML — `config_override.rs` |

Approval policy is a separate enum with exactly two members, `on-request` and
`never` (`codex-rs/utils/cli/src/approval_mode_cli_arg.rs`).

## The event surface

`codex exec --json` emits one JSON object per line. The union is a Rust enum
with `#[serde(tag = "type")]`, so the wire shape is `{"type": "...", ...}` —
read from `codex-rs/exec/src/exec_events.rs` in full:

```
thread.started   { thread_id }
turn.started     { }
turn.completed   { usage }
turn.failed      { error: { message } }
item.started     { item }
item.updated     { item }
item.completed   { item }
error            { message }
```

`item` is `{ id, ...details }` with `details` tagged by `type` in snake_case:

```
agent_message     { text }
reasoning         { text }
command_execution { command, aggregated_output, exit_code, status }
file_change       { changes: [{ path, kind: add|delete|update }], status }
mcp_tool_call     { server, tool, arguments, result, error, status }
collab_tool_call  { tool, sender_thread_id, receiver_thread_ids, prompt, agents_states, status }
web_search        { id, query, action }
todo_list         { items: [{ text, completed }] }
error             { message }
```

and `usage` is exactly five integers:

```rust
pub struct Usage {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub cache_write_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
}
```
— `exec_events.rs`

**There is no cost field anywhere in the union.** That is the single most
consequential fact on the Codex side and it is what
[`09-guards-and-metering.md`](09-guards-and-metering.md) is built on.

---

## Item by item

The fourteen reads from `00-problem.md` §3a, plus stderr, plus the argv items
from §3b.

### Out — what the app reads

| # | what the app needs | Codex offers | verdict |
|---|---|---|---|
| 1 | `session_id`, announced on change, on **every** event (`orchestrator.ts:6617`) | `thread.started { thread_id }`, **once, as the first event** | **satisfiable.** The app's guard is `ev.session_id !== acc.sessionId`; a one-shot field needs the adapter to latch it. Note the app's own comment (`:6612`–`:6616`) that the change guard is what stops one callback per line — a one-shot id makes that moot but the emptiness guard still matters. |
| 2 | assistant text → `finalText`, kind `assistant` | `item.completed` with `agent_message { text }` | **satisfied**, with a caveat: Claude's `finalText` is last-write-wins over turns; Codex's `-o <FILE>` is a purpose-built "last message" and is the more honest source. |
| 3 | **provider refusal** → `apiError`, via `message.model === "<synthetic>"` (`:6636`) | `turn.failed { error { message } }` and `error { message }` | **absent as a distinction.** Claude's `<synthetic>` marker separates "the provider refused" from "the agent failed" — the same marker `transcripts.ts` keys on. Codex has one free-text `message` for both. **Nothing in the JSONL union tells the two apart.** |
| 4 | resident context size → `contextTokens`, for `startsFresh` | `usage.input_tokens + cached_input_tokens + cache_write_input_tokens` | **satisfiable, unverified.** The arithmetic maps cleanly onto `orchestrator.ts:6668`–`:6671`. Whether the figure is per-turn or cumulative is **U2**. |
| 5 | tool calls → kind `tool`, with `name` and clipped `input` | `item.started`/`item.completed` with `command_execution`, `file_change`, `mcp_tool_call`, `web_search` | **satisfiable with work.** Four item types map onto one event kind, and `clipToolInput`'s bound has no equivalent — `command_execution.aggregated_output` is the command's whole output and would go into `run_events` unbounded unless the adapter clips it. |
| 6–7 | sub-agent attribution and forwarded sub-agent text (`:6653`, `:6678`) | `collab_tool_call { sender_thread_id, receiver_thread_ids, agents_states }` | **different shape, not absent.** Codex models delegation as thread ids rather than as a parent `tool_use` id, and there is no "forward the sub-agent's words" flag. The app's three-way separation (`finalText`, `apiError`, `kind`) would have to be re-derived from thread identity. |
| 8 | failed tool results → kind `tool_error`, named with the command | `command_execution { exit_code, status: failed }`; `mcp_tool_call { error, status }` | **satisfied, and better shaped.** Codex carries the command *on the same item* as its outcome, where the app has to keep `toolCalls: Map` parser state (`cycleInvocation.ts:83`–`:92`) precisely because Claude's `tool_result` carries only an id. |
| 9 | sandbox refusals → kind `sandbox` (`orchestrator.ts:6793`) | `CommandExecutionStatus::Declined` | **satisfiable, and better shaped.** A dedicated status beats `sandboxRefusal`'s text matching against sentences read out of a binary. |
| 10 | **cost** → `costUSD` from `result.total_cost_usd` | **nothing** | **absent.** See §"The cost hole" below. |
| 11 | tokens → `tokens` | `turn.completed.usage`, five fields | **satisfiable**, subject to U2. Note the app sums four Claude fields (`orchestrator.ts:6824`–`:6828`); Codex's fifth, `reasoning_output_tokens`, has no Claude counterpart in that sum. |
| 12 | **why the cycle ended** → `subtype` (`:6834`) | **nothing** | **absent.** This is the second-worst gap. `subtype` is documented as "the only machine-readable statement the CLI makes about *why* a cycle ended" (`cycleInvocation.ts:102`–`:104`), and its `error_max_budget_usd` member is what stops a run hitting its own spending ceiling from being misread as an allowance wall and parked for hours. Codex offers `turn.failed`, `error`, and the exit code. |
| 13 | refused tool calls → `permission_denials` (`orchestrator.ts:6860`) | `CommandExecutionStatus::Declined` per item | **satisfiable**, by counting rather than reading a summary field. |
| 14 | hook output and task events (`orchestrator.ts:6889`) | Codex has hooks (`codex-rs/hooks`, `codex-rs/config/src/hook_config.rs`) | **unverified.** Not in the JSONL union read here. |
| — | stderr tail → `refusalInStderr` (`orchestrator.ts:1558`) | any process has stderr | **satisfied mechanically**, useless semantically: `refusalInStderr` promotes a line only if `isUsageLimit` matches it, and that predicate is Claude's (C3). |

### In — what the app sends

| what the app sends | Codex equivalent | verdict |
|---|---|---|
| `-p <prompt>` | positional `PROMPT`, or stdin | **satisfied**, subject to U8 |
| `--output-format stream-json --verbose` | `--json` | **satisfied** |
| `--model <m>` | `-m, --model` | **satisfied**; the *values* are a different namespace, and `runs.model` is one column |
| `--permission-mode <mode>` | `--sandbox` × `--approve-for-me` / `--dangerously-bypass-…` | **overlapping, not equal.** See [`10-permission-and-credentials.md`](10-permission-and-credentials.md) |
| `--allowedTools` / `--disallowedTools` | **nothing per-invocation** | **absent on argv.** Codex has execpolicy `.rules` files and `--ignore-rules`, which is a file-based mechanism with a different lifetime. **`--disallowedTools` carries `PROCESS_KILLERS = ["Bash(pkill:*)", "Bash(killall:*)"]` (`cycleInvocation.ts:650`) unconditionally (`:1050`), and it is half of what stops an agent killing the server that supervises it** — the other half is `SELF_HOSTING_NOTICE` on the appended system prompt (`:652`–`:663`), which is absent too. |
| `--append-system-prompt <four notices + price list>` | **no flag** — `-c` overrides, `AGENTS.md` | **absent as an argv.** U6. `COMMIT_IDENTITY_NOTICE` is the sharp one. |
| `--agents` / `--agent` (`sessionAgentArgs`) | `--profile` layers a config file | **different mechanism**; a Codex fallback cannot carry a UsageFoundry agent definition |
| `--plugin-dir` × N (vault skill, read guard, plugins) | `codex-rs/plugin`, `codex-rs/skills` exist | **unverified**, and the generated vault skill and read guard are Claude-Code-shaped artifacts (`src/lib/vaultSkill.ts`, `src/lib/readGuard.ts`) that would have to be regenerated in another format |
| `--add-dir <vault path>` | `--add-dir <DIR>` | **satisfied**, and identically caveated: Codex's own help says "should be **writable**", which is the same finding `cycleInvocation.ts:984`–`:986` records for Claude's flag |
| `--resume <session_id>` | `codex exec resume <SESSION_ID>` | **satisfied within a provider, impossible across one.** See [`08-continuity.md`](08-continuity.md) |
| `--max-budget-usd <remaining>` | **nothing found** | **absent.** U4, and it is C2's teeth |
| `childEnv` + `githubEnv` + `childCredentials` + own process group | any spawn | **satisfied by construction**, if the option re-proves it (C9) |
| `ANTHROPIC_BASE_URL` → winnow's filter | different host | **absent by nature** (C11) |

---

## The cost hole

Item 10 deserves its own section because it is what makes a Codex cycle
structurally different from every other spend this app measures.

On the Claude side there are three sources, and **two of them are provider
figures**: the CLI's own `total_cost_usd` (`orchestrator.ts:6819`) and the OTLP
records the CLI exports. The third, `scanUsage()` over transcripts, is a
*derivation* — tokens × `PRICES` — and it exists because it can see work the
other two cannot.

A Codex cycle has **only the derivation available, and the derivation has no
table to work against.** `PRICES` (`src/lib/pricing.ts:31`–`:59`) has 20 keys
and all 20 begin `claude-` — counted, not eyeballed:
`node -e` over the literal returns `count 20`, `non-claude: (none)`. `resolvePrice` (`:115`) matches longest-prefix-first
and returns `null` for anything else.

So the three candidate answers to "what did a Codex cycle cost" are:

1. **Unknown.** Honest, consistent with `docs/agent/metering.md`'s rule that a
   figure which cannot be computed renders as unknown rather than zero, and it
   makes `maxRunCostUSD` unenforceable for the run's Codex share.
2. **Derived against a new OpenAI price table.** Requires U10, requires knowing
   which model actually ran, and adds a second maintenance surface with the same
   silent-staleness failure the Claude table already has.
3. **Priced pessimistically at the guard only.** `guardCostOf` (`pricing.ts:194`) already
   does exactly this for an unpriced Claude model, substituting
   `UNKNOWN_MODEL_PRICE = { input: 10, output: 50 }` (`:84`) — the Opus/Fable
   tier rate. **This is the shape that already exists in the codebase**, and it
   is what `09-guards-and-metering.md` recommends: unknown on the card,
   pessimistic at the guard, never the same number, never summed.

## What this contract implies for the ranking

Three of the fourteen reads are **absent** rather than merely different: the
`<synthetic>` refusal marker (3), the cost (10), and the end-of-cycle subtype
(12). Two argv items are absent: `--disallowedTools` and the appended system
prompt.

That is the floor on any option that actually spawns Codex. It is roughly a
second `handleStreamLine`, a second `buildArgs`, a second refusal classifier, a
second cost story and a second permission story — and none of the five is
optional, because in each case the failure is silent and lands on the operator's
repository rather than on a screen.

**An option that does not spawn Codex pays none of it.** That asymmetry is the
comparison.
