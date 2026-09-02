# Constraints, and the unknowns

Two lists. The first is what any option has to satisfy — each entry is either a
measured property of this codebase, an invariant `docs/agent/` already enforces,
or a product commitment that follows from what the feature claims to be. The
second is what could not be established from this container, written as
questions with **what the answer would change** and **how to find out**, because
a proposal that guesses the half it could not see is worth less than one that
names it.

---

# Part 1 — Constraints

## C1. The three cost sources may not become four, and a Codex figure may never be summed with any of them

This is the constraint most likely to be broken by accident, because breaking it
produces a number rather than an error. `docs/agent/architecture.md:10` states
it as a property of the app:

> **Three** data sources now, still **never summed or mixed in the UI**.

and `docs/agent/metering.md:50` says why:

> three routes to overlapping work, and any sum double-counts

The three are the transcript scan, the CLI's own `total_cost_usd`, and OTLP
telemetry. A Codex cycle's spend, however derived, is a **fourth population over
a fourth time base**, denominated against a price table this app does not have
(`src/lib/pricing.ts:31`–`:59` — every key begins `claude-`). It may appear
beside the three. It may never be added into `runs.spent_usd`, into a dashboard
meter, or into the window fractions.

There is already a precedent for admitting a further figure without making it a
further source, and it is the shape to copy. `src/lib/intakeFilter.ts` reads
winnow's ledger — a **fourth file**, which `docs/agent/metering.md` records is
"deliberately **not** a fourth source" — and the rollup carries
`byAgent.counterfactualUSD` (`src/lib/windows.ts:703`, computed at `:1150`;
asserted at `src/lib/windows.test.ts:1004`, `:1031`–`:1032`), which is *what the same work
would have cost without the filter*. It is `null` when it cannot be computed
rather than zero, it reaches no meter and no guard, and it is rendered as a
statement about a hypothetical rather than as spend.

The precedent for how a foreign figure is handled already exists one function
over. `resolvePrice` (`src/lib/pricing.ts:115`) returns `null` for a model it
does not know; the display shows unknown; and `guardCostOf` (`:194`) substitutes
`UNKNOWN_MODEL_PRICE = { input: 10, output: 50 }` (`:84`) so that *the guard*
still has something to act on. **That is the shape any Codex costing has to
take: unknown on the card, a deliberately pessimistic substitute at the guard,
and never the same number.**

## C2. The window guards do not constrain Codex, and must not be made to look as though they do

`maxWeeklyFraction` and `maxSessionFraction` (`src/lib/budget.ts:56`, `:65`) are
fractions of a **Claude subscription window**, derived by `windows.ts` from
Claude Code's local transcripts. A Codex process writes no such transcript and
spends no such allowance. So under any fallback:

- Codex spend cannot move either fraction, and neither fraction can stop a Codex
  cycle.
- `maxRunCostUSD` may not be computable at all — see U4 below — and
  `--max-budget-usd`, which is *the* in-cycle ceiling
  (`src/lib/cycleInvocation.ts:1115`–`:1118`), has no established equivalent on
  the Codex CLI.
- `maxIterations` and `maxDurationMinutes` are the only two guards that survive
  a provider swap unchanged, because they are the **monotone termini**
  (`src/lib/budget.ts:86`–`:91`) and neither is denominated in a provider's
  money.

**An option that runs a Codex cycle under a policy whose only limits are the two
fractions is running it under no limit at all.** That is not a footnote; it is
the constraint that decides which options are admissible.

## C3. The refusal classifiers are read out of one binary and cannot be reused

`isUsageLimit` (`src/lib/orchestrator.ts:1438`) matches Claude Code's own
sentences. `isTransientApiError` (`:1475`) matches five stream-truncation
sentences its docblock says were "read out of the shipped binary rather than
guessed". `sandboxRefusal` recognises text from that same build.

None of it transfers. A Codex refusal — of any kind — arrives as text this app
has never seen, and the failure mode is not a crash: `refusalKind` (`:1540`)
would return `"other"`, `refusalDisposition` would return
`{ action: "fail", cause: "other" }` (`:1817`), and the run would end with
`refusalStopReason`'s sentence **"Claude Code refused the request: …"**
(`:1851`) attached to something Claude never said.

So every option that spawns a second binary owes a second classifier, and until
it has one, every Codex failure is terminal and misattributed.

## C4. `refusalStopReason` names Claude in four of four sentences

```
"Claude refused the work cycle for want of allowance again…"      :1836
"Claude Code hit a transient API error on N attempts in a row…"   :1840
"Claude Code was rate limited on N attempts in a row…"            :1847
"Claude Code refused the request: …"                              :1851
```

The `switch` has a `never` arm (`:1853`) that makes a fifth `RefusalCause` a
build failure, which is the good half. The bad half is that the four existing
sentences are unconditional prose about a provider. Any option that can end a
run on a Codex failure has to reach every one of them, and an option that adds a
cause without touching the other four ships a run page that lies about which
provider refused.

## C5. A run's stop reason, report and `DONE` contract are read per line from one voice

`docs/agent/run-lifecycle.md` owns the `DONE` and `needs-review` contracts. The
mechanism is that `finalText` holds **the main thread's last assistant text**
and nothing else — `handleStreamLine` keeps a forwarded sub-agent turn out of it
deliberately (`orchestrator.ts:6638`–`:6652`), on the grounds that "a sub-agent reporting
`DONE` would end a run whose main thread had not finished".

A Codex cycle has to produce a `finalText` with the same property, from a
different event shape, or the run cannot end on its own judgement. Codex's
`--output-last-message <FILE>` (`codex-rs/exec/src/cli.rs`, `-o`) is the
candidate and is a *file* rather than a stream position — which is a different
failure mode, not a worse one, but it is a different one and has to be
handled: a file that was never written is not the same as an empty answer.

## C6. Nothing new may put a clock in front of the Land button, and nothing may make a landing decision provider-conditional

`docs/agent/isolation-and-landing.md` records that nothing on the landing path
may have a clock on it. `docs/agent/git-and-review.md` records that no row may
carry a success mark it did not earn, and that the three ways of having nothing
may never render as an empty list.

A Codex-written branch is a branch. `landRun` reads git; it does not read a
model. So the constraint here is a **prohibition on inventing a difference**:
the merge queue may not gate on provider, `runTouches` may not be
provider-conditional, and a diff is a diff. What *is* owed is disclosure — see
[`11-review-landing-and-blast-radius.md`](11-review-landing-and-blast-radius.md)
— and disclosure is a label, not a gate.

## C7. New persistent state goes through `migrate()` and onto the retention map

`CLAUDE.md`: schema changes are idempotent statements in `migrate()` in `db.ts`;
a destructive one runs inside a single `db.transaction`. The mechanism for a new
`runs` column already exists and is one line —
`addColumn(db, "runs", "file_cost_notice", "TEXT")` at `src/lib/db.ts:845`,
over the helper at `:1801`.

`docs/agent/retention.md` records what expires and on which horizon. Any option
storing which provider ran a cycle has to answer both, and an option that stores
nothing gets to skip both, which is a real part of its case.

## C8. `run_events.kind` is a closed union and a new member is a real cost

`RunEventDTO.kind` (`src/lib/apiTypes.ts:1791`–`:1836`) is sixteen members, each
with a docblock arguing why it is not a flag on its neighbour. The pattern the
union enforces — `subagent` is not `assistant` with a flag; `tool_error` is not
`tool` with a flag; `sandbox` is emitted *beside* `tool_error` and not instead of
it — is the same argument any provider marker would have to make.

An option that renders a Codex cycle's tool calls as `kind: "tool"` is claiming
they are the same kind of event, and that claim has to be made deliberately
rather than by reusing the emitter.

## C9. No shell, ever, and containment is proved twice

`docs/agent/security.md` owns this. At the spawn site: arguments as an array, no
shell (`orchestrator.ts:5619`–`:5621`); `childCredentials()` (`src/lib/privsep.ts:252`) so the
child runs below the server's uid; its own process group so `signalTree`
(`orchestrator.ts:5566`) reaches what it started.

A second binary inherits none of that by being a second binary. It inherits it
by being spawned through the same discipline, and an option's cost includes
re-proving it.

## C10. `childEnv`'s strip is a denylist, and a denylist fails open

```ts
key.startsWith("UF_") || key.startsWith("OTEL_") ||
key === "ANTHROPIC_ADMIN_KEY" || key === "CLAUDE_CODE_ENABLE_TELEMETRY" ||
key === "DATA_DIR" || key === "NODE_OPTIONS"
```
— `src/lib/orchestrator.ts:5371`–`:5382`

**`OPENAI_API_KEY` is not on that list, and neither is `CODEX_API_KEY`.** So an
operator who sets either on the server today hands it to every Claude work
cycle, every chat turn, every review child and both auth children — five
`CLAUDE_BIN` spawn sites (`orchestrator.ts:5621`, `chat.ts:2104`,
`review.ts:660`, `claudeAuth.ts:302` and `:414`) — inside a session with `Bash`,
which can print `env`.

This is not hypothetical drift; it is the current behaviour of the current code,
and `claudeAuth.ts:245`–`:252` shows the repository already reasoning about
exactly this class for `ANTHROPIC_API_KEY`, where the omission is deliberate and
documented. **Any option that introduces an OpenAI credential owes a decision
here before it owes anything else**, and it is the one piece of work that is
worth doing even if the recommendation is "don't" —
[`10-permission-and-credentials.md`](10-permission-and-credentials.md) §"The
repair that is owed either way".

## C11. A Codex process leaves winnow's intake filter, and there is no equivalent to give it

When `WINNOW_FILTER=1`, `docker-entrypoint.sh` starts a loopback proxy in front
of `api.anthropic.com` and **exports `ANTHROPIC_BASE_URL` before the exec**, so
every agent this container spawns talks to the API through it
(`docker-entrypoint.sh:856`–`:930`). The proxy places a spent tool result after
the last `cache_control` breakpoint so the API never writes it to the prompt
cache, and drops it from the next request — "the bytes cost 1.0x once instead of
a 2.0x cache write plus a 0.1x read on every later turn" (`:864`–`:865`).

`childEnv` passes `ANTHROPIC_BASE_URL` through untouched, deliberately, because
proxy settings are the operator's decision (`:874`–`:875`).

**A Codex process talks to a different API on a different host and would bypass
all of it.** Three consequences, none of which any option can fix:

1. The per-request saving does not apply. On the Claude side this is not a
   rounding error: `proposals/ContextControl/README.md` measures 82.1% of the
   week's bill as carried context.
2. `intakeFilter.ts`'s ledger gains no line, so `counterfactualUSD` and
   `winnow inspect`/`winnow fork` know nothing about the cycle. A run whose
   cycles alternate has a ledger with holes in it that look like quiet cycles.
3. The entrypoint's own safety argument does not transfer. Its worst outcome is
   "a boot that exports the URL and no listener" (`docker-entrypoint.sh:929`); a second provider
   introduces a second base URL with no such reasoning attached to it.

This is a **cost to name, not a constraint to satisfy** — nothing here forbids a
Codex cycle. But it belongs beside the money in
[`09-guards-and-metering.md`](09-guards-and-metering.md), because an option
justified on "the wall costs us throughput" is trading a filtered, cached,
ledgered request path for an unfiltered one.

## C12. The UI says "work cycle"; the code says "iteration"

`CLAUDE.md`. Whatever a fallback is called on a run page, the column, the
policy field and the payload stay `iteration`/`maxIterations`.

## C13. The container has no OpenAI credential and no Codex binary, and acquiring either is the operator's decision

`command -v codex` exits 1. Nothing in `src/`, `docs/` or `README.md` mentions
Codex or OpenAI. There is no key here to test with and no account to bill.

That is a constraint on *this proposal*, not on the design: it means the entire
Codex half of every option below is either read from source or flagged
unverified, and no option may be recommended on the strength of behaviour nobody
here observed.

---

# Part 2 — The unknowns

## What could be established from source, and was

The container reaches the network through a proxy (`curl` to
`registry.npmjs.org` returns `200`; `getent hosts` fails, which is why a DNS
check is the wrong probe here). So the Codex CLI's **command-line and event
surface** was read out of `openai/codex@main` on GitHub rather than guessed.
[`02-the-handover-contract.md`](02-the-handover-contract.md) is that reading in
full, with the file each fact came from. In summary: `codex exec` takes a
prompt, `--json` prints a typed JSONL event stream, `resume <SESSION_ID>` and
`fork <SESSION_ID>` are subcommands, `--sandbox` takes three modes, and
`turn.completed` carries a five-field `Usage` **with no cost in it**.

**That reading is of `main`, not of a pinned release, and no binary was run.**
Treat every Codex-side fact in this proposal as "the source says" rather than
"the binary does". `Dockerfile:373`–`:377` explains at length why this
repository pins an agent CLI and reads its contract off a specific build; the
Codex facts here have not had that treatment and cannot until somebody installs
one.

## What could not be established, and what each would change

Each row is a question, what turns on it, and the command that settles it. The
commands assume `npm install -g @openai/codex` (v0.152.1 at the time of writing,
Apache-2.0, a thin `bin/codex.js` launcher over a platform binary in
`optionalDependencies`) and an authenticated `CODEX_HOME`.

### U1. What does Codex emit when *its own* allowance or quota is exhausted?

**Turns on:** everything. Option B's entire premise is that a Claude wall is
survivable by switching; if the OpenAI side walls too, the fallback inherits the
same problem with none of the machinery — no `isUsageLimit` equivalent, no
window model, no reset boundary, no `refusalResumeAt`. `refusalKind` would file
it as `"other"` and end the run (C3).

**Not answerable from source.** `grep -in 'rate_limit|usage_limit|quota'` over
`codex-rs/exec/src/lib.rs` (2,167 lines) returns nothing, and the JSONL union in
`exec_events.rs` has exactly two error shapes — `turn.failed { error: { message } }`
and `error { message }` — both carrying a free-text `message` and nothing
machine-readable about *why*.

**How to find out:** exhaust a low-tier ChatGPT plan or a rate-limited API key
against `codex exec --json 'hello'` and capture the last three lines of stdout
and the exit code. Failing that, `codex exec --json -c model=…` against a model
the account cannot use, which produces an authorisation refusal rather than a
quota one but at least fixes the *shape* of an error event.

### U2. Is `turn.completed.usage` per-turn or cumulative, and is there exactly one per `codex exec` invocation?

**Turns on:** whether a Codex cycle's tokens can be summed at all. This is
precisely the trap `cycleCostAfterResult` exists for on the Claude side, where
`total_cost_usd` is a session running total and one child can emit two `result`
events (`src/lib/cycleInvocation.ts:25`–`:31`). Getting it backwards
double-counts or undercounts, silently.

**How to find out:** `codex exec --json 'write hello to /tmp/a then read it back'`
and count `turn.completed` events, then compare the sum of their
`usage.input_tokens` against the last one alone.

### U3. Does a Codex session id survive `codex exec resume`, and does resume restore the sandbox mode, the model and the config overrides?

**Turns on:** continuity ([`08-continuity.md`](08-continuity.md)) and the whole
alternation question. `thread.started { thread_id }` is documented as "Can be
used to resume the thread later", and `resume` takes a UUID or a thread name —
but this repository has been bitten specifically by flags that `--resume` does
*not* restore (`--plugin-dir`, `src/lib/cycleInvocation.ts:955`–`:962`), and the
same class of bug would be silent here.

**How to find out:** `codex exec --json -s read-only 'say A'`, note `thread_id`,
then `codex exec resume <id> --json 'try to write /tmp/x'` and see whether the
write is refused.

### U4. Can a `codex exec` invocation be given a hard dollar or token ceiling?

**Turns on:** C2, and with it the admissibility of every option that lets a
Codex cycle start unattended. `--max-budget-usd` is the only thing bounding what
one Claude cycle spends; **no equivalent appears anywhere in `codex exec`'s flag
surface** (`codex-rs/exec/src/cli.rs` plus `SharedCliOptions` in
`codex-rs/utils/cli/src/shared_options.rs`, both read in full).

**How to find out:** `codex exec --help` on an installed binary, and
`codex exec -c '<key>=…' --strict-config` against candidate config keys —
`--strict-config` errors on unrecognised fields, which makes it a probe for
whether a key exists. Also worth checking whether the OpenAI platform's own
project-level spend limits can stand in, which is an account-side answer rather
than a CLI one.

### U5. What does `--sandbox workspace-write` actually permit on Linux, and does it hold under this container's seccomp profile?

**Turns on:** [`10-permission-and-credentials.md`](10-permission-and-credentials.md).
`codex-rs` contains `linux-sandbox`, `bwrap`, `sandboxing` and
`process-hardening` crates, so a mechanism exists; what it grants and whether it
composes with Docker's default seccomp is not readable from a crate listing.
This repository already knows that a sandbox can be enabled and confine nothing
(`src/lib/sandbox.ts:201`, `policyNamesSomething`), which is the failure to look
for.

**How to find out:** inside this container, `codex exec -s workspace-write --json
'read /etc/passwd, then curl https://example.com, then write /tmp/x'` and record
which of the three are refused.

### U6. Is there an `--append-system-prompt` equivalent?

**Turns on:** four notices that ride every Claude cycle
(`SELF_HOSTING_NOTICE`, `DELEGATION_NOTICE`, `RENDERING_NOTICE`,
`COMMIT_IDENTITY_NOTICE`) plus the run's frozen file price list
(`src/lib/cycleInvocation.ts:1058`–`:1069`). `COMMIT_IDENTITY_NOTICE` is the one
that matters most: it is what stops an agent signing commits with the operator's
email, and its absence is silent until a commit is published.

Codex has `-c key=value` config overrides against `~/.codex/config.toml`
(`codex-rs/utils/cli/src/config_override.rs`) and an `AGENTS.md` convention, so
*a* mechanism plausibly exists; the flag does not, and a repository-level
`AGENTS.md` is a file in the worktree rather than an argv, which is a different
lifetime and a different blast radius.

**How to find out:** `codex exec --help`, then
`codex exec -c '<candidate>=…' --strict-config --json 'what instructions were you given'`.

### U7. Can MCP servers be attached per invocation, and would `/api/mcp` accept a Codex client?

**Turns on:** less than it appears. `buildArgs` carries **no** `--mcp-config` —
grep finds MCP wiring only on the chat path (`src/app/api/mcp/route.ts` and its
consumers), not the run path. So the MCP tool surface is **not** part of the run
contract a fallback has to satisfy, and this is an unknown about a *future*
scope rather than about the fallback itself. `codex-rs` has `mcp-server`,
`rmcp-client` and `codex-rs/config/src/mcp_types.rs`, so servers are configured in
`config.toml` rather than on argv.

**How to find out:** deferred. Nothing in scope depends on it.

### U8. How large a prompt can `codex exec` take on argv?

**Turns on:** whether a handover brief can be passed the way `-p <prompt>` is
today. Codex's own CLI documents stdin as the alternative ("If not provided as
an argument (or if `-` is used), instructions are read from stdin"), which is a
ready answer — but the app's spawn is `stdio: ["ignore", "pipe", "pipe"]`
(`orchestrator.ts:5628`), so using it means opening stdin on the child, which is a change to
the spawn discipline rather than a change of flag.

**How to find out:** `codex exec --json "$(head -c 200000 /dev/urandom | base64)"`
and see whether it is `E2BIG`.

### U9. Is the `--json` event stream stable across Codex releases?

**Turns on:** whether the pin argument at `Dockerfile:373`–`:377` applies with
equal force. The `--json` flag carries `alias = "experimental-json"`, which is
the CLI's own statement that this surface was recently experimental.

**How to find out:** diff `codex-rs/exec/src/exec_events.rs` between two release
tags. Cheap, and worth doing before any implementation.

### U10. What does a Codex cycle actually cost?

**Turns on:** every figure in [`09-guards-and-metering.md`](09-guards-and-metering.md).
Two unknowns compound: which model `codex exec` defaults to under a given
account, and what that model's input/output rates are.

**How to find out:** `codex exec --json 'hi'` and read the model out of the
session; then price it against the published rate. Note that this is the one
unknown a *future* session cannot settle by reading source, because the default
is account-dependent.
