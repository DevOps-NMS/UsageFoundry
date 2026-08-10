# UsageFoundry

Usage-aware orchestration for Claude Code. Point it at a folder, give it a task
and a budget, and it runs Claude Code headlessly until the work is done or the
budget guard stops it — with live limit tracking throughout.

Ships as a single Docker container.

---

## The one thing to understand first

There are **two unrelated things** called "your Anthropic limits", and this tool
treats them separately on purpose:

| | Claude Code subscription (Pro/Max) | Console API account |
|---|---|---|
| What a "limit" is | 5-hour session window, weekly quota | rate limits (RPM / ITPM / OTPM), spend |
| Official API | **none** — Anthropic publishes no endpoint and no numeric quota value | `/v1/organizations/rate_limits`, `/usage_report/messages`, `/cost_report` |
| How this tool reads it | parses `~/.claude/projects/**/*.jsonl` locally | Admin API, with an `sk-ant-admin01-…` key |
| Accuracy | **volumes and costs are exact; percentages are estimates** | authoritative |

The **Dashboard** is the subscription view. The **API account** page is the
Console view, and stays empty unless you set an Admin key. They are never summed
together.

### ⚠️ What the subscription view can and cannot see

Your 5-hour and weekly limits are **shared across every Claude surface**. Only
Claude Code writes local transcripts, so only Claude Code is measurable here:

| Surface | Local data | Counted |
|---|---|---|
| Claude Code (terminal) | `~/.claude/projects/**/*.jsonl` | ✅ |
| Claude Code SDK | same, `entrypoint: sdk-cli` | ✅ |
| **Cowork** | Electron profile — no transcript, no usage ledger | ❌ |
| **Cowork scheduled tasks** | run in the cloud, device offline | ❌ |
| Claude Desktop / web / mobile | server-side | ❌ |

This is structural, not an oversight — there is no local file to parse, and the
authoritative figure lives behind the same undocumented endpoint the in-session
`/usage` command calls. The CLI exposes no scriptable equivalent.

**It fails unsafe.** If Cowork has consumed half your weekly window, the
dashboard still reads ~20% and an 80% guard will happily start a run that
overruns the real limit.

**Mitigation: reserved headroom.** Settings → *Reserved headroom* holds back a
percentage of every window for usage this tool cannot see. It shrinks the
effective ceiling everywhere — meters, guards, and projection — so guards trip
early instead of late. Set it roughly to the share of your Claude usage that
happens outside the terminal. Capped at 95%.

Numbers below are always a **floor** on real consumption.

### Ceilings are denominated in cost, not tokens

A Claude Code workload is **~98% cache reads**, which bill at 0.1×. A raw-token
ceiling therefore measures conversation length far more than it measures work,
and its ratio to any real limit drifts with context size. Cost already applies
the 0.1× / 1.25× / 2× multipliers, so it is the stabler proxy.

This is not a theoretical concern. On the same real usage, with two
plausible-looking ceilings:

| Ceiling | Reading |
|---|---|
| $50 equivalent API cost | **45%** |
| 20M raw tokens | **143%** |

Same work, 3.2× disagreement. Cost is the primary metric everywhere; raw-token
ceilings remain available as a fallback and render as a secondary line when both
are set.

### Why percentages need configuration at all

Token counts and dollar costs come straight from your transcripts and are exact.
But a *percentage* needs a denominator, and Anthropic does not publish what a
Max plan's quota is in any unit. So:

- With no ceiling configured, meters render **hatched** ("no ceiling set"), not
  at 0%. An empty bar would read as "plenty left", which is the opposite of
  "we don't know".
- **Settings → Calibrate** derives a ceiling from your own peak usage: the
  costliest fully-elapsed 5-hour block, and the peak trailing-7-day total. Those
  are **lower bounds** on the real limit (you reached them without being cut
  off), so percentages computed against them read *high* rather than low — a
  guard trips early rather than late.
- Any budget rule expressed as a fraction (`stop at 80% of weekly`) is **refused
  outright** when no ceiling exists, rather than silently passing. A guard you
  believe is active but isn't is worse than no guard.

---

## Quick start

```bash
cp .env.example .env
# edit .env:  UF_AUTH_TOKEN (recommended), UF_WORKSPACE (required),
#             UF_WORKSPACE_2… (optional, for more than one workspace)

docker compose up --build
open http://localhost:3000
```

Then in the UI: **Settings → Calibrate** to set ceilings, **Runs → New run** to
start work.

### Sign in once, inside the container

The dashboard works immediately — it only reads transcripts. **Runs will fail
with `Not logged in` until you authenticate the container's own Claude Code:**

```bash
docker compose exec -it usagefoundry claude
# then: /login
```

The `~/.claude` mount carries your transcripts, settings, rules, and plugins,
but **not** your credentials. On macOS the OAuth token lives in the login
Keychain rather than in that directory, so there is nothing on disk for the
mount to carry; a Linux container cannot read it either way.

This is a one-time step. The login writes `.credentials.json` into
`/home/node/.claude`, which *is* the mounted `~/.claude`, so it survives
restarts, `docker compose down`, and image rebuilds.

One thing the mount also cannot carry is `~/.claude.json` — it sits *next to*
the directory, not inside it — so user-scoped MCP servers are not available to
the containerised agent.

### Required environment

| Variable | Purpose |
|---|---|
| `UF_WORKSPACE` | Host directory mounted at `/workspace`. Runs are confined to it. |
| `UF_AUTH_TOKEN` | Shared secret for the UI. Blank disables auth — only acceptable on loopback. |
| `ANTHROPIC_ADMIN_KEY` | Optional. Enables the API-account page. Org Admin key only. |

Compose also mounts `~/.claude` **read-write** — Claude Code writes new session
transcripts there as runs execute, so a read-only mount breaks runs.

### Multiple workspaces

Up to four host directories can be mounted, and the New run form picks one
before picking a folder inside it. A run is confined to the single workspace it
started in — containment is checked against that mount's root alone, never
against the union of all of them.

Each slot needs **both** a name and a path in `.env`; a slot with no name is not
offered in the UI regardless of its path:

```bash
UF_WORKSPACE_NAME=Code            # slot 1 — always on
UF_WORKSPACE=/Users/you/Documents/GIT

UF_WORKSPACE_2_NAME=Notes         # slot 2 — on, because it is named
UF_WORKSPACE_2=/Users/you/Documents/Notes
```

Compose translates those into `WORKSPACE_ROOTS`, which is what the app actually
reads: `Label=/path` entries separated by `|`, an empty label meaning "skip this
slot". Outside Docker — `npm run dev` — set it directly:

```bash
WORKSPACE_ROOTS='Code=/Users/you/GIT|Notes=/Users/you/Notes' npm run dev
```

With `WORKSPACE_ROOTS` unset the app falls back to the single `WORKSPACE_ROOT`
mount, so existing deployments behave exactly as before.

---

## How a run works

The UI calls an iteration a **work cycle**, because that is the unit a first-time
user has to reason about: Claude works, reports back, and the budget decides
whether it gets another one. Internally — settings, API payloads, the database —
it stays `iteration`.

1. You supply a workspace, a folder inside it, a task, and a budget policy.
2. Before **each** iteration, the budget is evaluated. If it fails, the run stops
   (or is refused before iteration 1, which is reported distinctly as `blocked`).
3. Otherwise one `claude -p … --output-format stream-json` process is spawned in
   that folder. Its output streams to the browser over SSE.
4. Cost and tokens are read from Claude Code's own `result` event — not
   re-derived — then accumulated.
5. Iteration 2+ sends the continuation prompt and `--resume`s the same session,
   so context carries across. The run ends when the agent replies `DONE`, the
   iteration cap is hit, or a guard fires.

### The guarantee, stated honestly

Guards are checked **between** iterations, not during one. A Claude Code turn
cannot be interrupted mid-flight without losing its work, so what this gives you
is *"no new work starts past the threshold"* — **not** *"spend never exceeds the
threshold"*. Overshoot is bounded by one iteration. Size the cap accordingly.

### Budget policy

| Rule | Behaviour |
|---|---|
| `maxIterations` | Hard cap on iterations. Always set — the loop has no other natural end. |
| `maxRunCostUSD` | Stop when this run's own spend reaches it. `null` disables it. |
| `maxDurationMinutes` | Wall-clock cap. `null` disables it — the run then ends only on `DONE`, the iteration cap, or another guard. |
| `maxWeeklyFraction` | Stop at N% of the weekly window (cost-denominated). **Requires a configured ceiling.** |
| `maxSessionFraction` | Stop at N% of the 5-hour window (cost-denominated). **Requires a configured ceiling.** |

`maxRunCostUSD` is the one guard that needs **no ceiling** — it is absolute. Use
it on day one, before you have enough history to calibrate.

---

## Accuracy notes

Two details that materially change the numbers, both handled:

**Deduplication.** Claude Code writes the same assistant message to disk more
than once (resumed sessions, sidechain replay, snapshot rewrites). Every copy
carries an identical `message.id` + `requestId`, which is used as the dedupe key.
On the transcripts this was developed against, **99 raw records deduplicated to
31** — summing naively would have over-reported by roughly 3×.

**Cache TTL pricing.** `cache_creation` splits into `ephemeral_5m` and
`ephemeral_1h`, which bill at **1.25×** and **2×** input respectively. Claude
Code leans on 1h writes, so collapsing both into one number understates spend on
exactly this workload. Cache reads are billed at 0.1×. Older records with no TTL
split are attributed to the cheaper 5m bucket, so an unsplit record understates
rather than overstates.

Models with no known price contribute **$0 to every reported figure and are
listed in a banner** — dollar totals are a floor, never a silent guess.

**The budget guard is the one exception, deliberately.** A displayed $0 means a
window consisting entirely of an unpriced model reads as 0% used, and no
threshold can ever be crossed — so the guard would quietly cease to exist the
week a new model ships. For guard purposes only, an unrecognised model is
charged a conservative **$10/$50 per Mtok**: the most expensive
current-generation rate in the table, so an unknown can never look cheaper than
something known. The meters draw that as a hatched band past the solid fill, so
a run stopped before the visible bar looks full is explained rather than
mysterious. Nothing shown as a dollar amount is ever the fallback rate.

**Agent self-reporting (optional, off by default).** Claude Code computes a cost
for every API request and will push it to any OTLP endpoint. Turning on *Agent
self-reporting* in Settings points agents this app spawns back at this server,
which records one row per request — a first-party number that needs no price
table, no dedupe key, and no file polling. It is shown as its own card on the
run page and is **never** merged into `spent_usd`, the dashboard, or the budget
guard, all of which stay transcript-derived.

Its one real advantage: per-iteration spend normally comes from the CLI's
terminal `result` event, so a work cycle killed before that event reports $0.
Telemetry arrives per request as the run proceeds, so it captures that work. A
telemetry figure *higher* than the run's own total is the expected outcome of an
interrupted run, not a discrepancy.

It cannot replace the transcript scan: there is no historical backfill, no `cwd`
so no per-project attribution, and `cache_creation_tokens` is a single number
with the 5m/1h split collapsed. The payload also carries `user.email` and
account UUIDs — none of which are stored.

Provider-decorated model IDs are canonicalised before lookup — Bedrock's
`us.anthropic.claude-…-v1:0` and Agent Platform's `claude-…@20250929` resolve to
the same rates as the first-party IDs. No short catch-all keys are used: a
hypothetical `claude-opus-4` key would price an unreleased `claude-opus-4-9` at
a confident wrong number instead of surfacing it as unknown.

---

## Security

This container holds your Claude credentials and runs an agent that can modify
mounted code. Treat it as privileged.

- Compose binds to **`127.0.0.1:3000`**, not `0.0.0.0`. Change that only behind
  auth and TLS.
- Set `UF_AUTH_TOKEN` (`openssl rand -hex 32`) for anything beyond loopback.
- Folder input is resolved and containment-checked **before** filesystem access,
  and again after symlink resolution. `../`, absolute paths, and symlinks out of
  the tree are all rejected.
- With several workspaces mounted, containment is checked against **one mount at
  a time**, never their union. A run is confined to the workspace it started in,
  so a path valid in one workspace is rejected in another.
- The agent is spawned with an argument array and **no shell**, so a prompt
  containing shell metacharacters is inert.
- `bypassPermissions` lets the agent run any command in the mounted folder
  without asking. The UI warns; the default is `acceptEdits`.

---

## Architecture

```
src/lib/
  transcripts.ts   JSONL parser — incremental byte-offset reads, dedupe
  windows.ts       5-hour block + weekly rollups, burn rate, projection
  pricing.ts       per-model rates, cache-TTL multipliers, fast mode
  adminApi.ts      Admin API client (rate limits, usage, cost) w/ pagination
  budget.ts        policy evaluation
  orchestrator.ts  run loop, process spawn, stream-json parsing, SSE bus
  db.ts            SQLite (runs, events, settings)
src/app/api/       usage · account · runs · calibrate · settings · folders
```

Transcripts are re-read incrementally: only bytes appended since the last scan
are parsed, and a partial trailing line is left unconsumed for the next pass.

---

## Verified

Built and exercised against real transcripts:

- Cost math cross-checked by hand — `$12.843618` computed independently vs
  `$12.8436175` from the API, on 54 input / 83,517 output / 12,072,025 cache-read
  / 471,941 cache-1h tokens.
- Dedup verified (99 → 31 records).
- Incremental re-scan picks up records appended mid-session.
- Budget refusal returns `blocked` with 0 iterations and 0 spend.
- Metric selection: cost ceiling wins when both are set; falls back to tokens
  when cost is cleared; null when neither is set.
- Budget guard evaluated against the cost fraction — allowed at an 80% guard,
  refused at 5% with the window at 11.2%.
- Unpriced-model guard fallback, 17 assertions against the compiled modules: a
  window of 90M output tokens from an unknown model still reports `$0` and
  `fraction = 0` (so the pre-fix guard could never fire) while `guardFraction`
  reads 45× a $100 ceiling and the guard blocks with `weekly_fraction`. A fully
  priced window keeps `guardFraction === fraction` exactly, an under-threshold
  window is still allowed, and a fraction guard with no ceiling still refuses
  with `no_ceiling` rather than being satisfied by the fallback.
- Model-ID canonicalisation: `us.anthropic.claude-opus-5-20260101-v1:0`,
  `anthropic.claude-sonnet-4-5`, and `claude-sonnet-4-5@20250929` all resolve;
  `claude-nextgen-9` stays unknown; `claude-opus-4-1` keeps its own $15/$75.
- A zero-token turn (`<synthetic>`) no longer counts as an unpriced model, and
  incurs no fallback charge.
- OTLP transport captured from a real headless `claude -p` run on CLI v2.1.226,
  not taken from the docs. Telemetry *does* initialise under `-p`; a base
  endpoint of `/api/otlp` receives `POST /api/otlp/v1/logs` and
  `/api/otlp/v1/metrics`, so the CLI appends the signal suffix itself; the body
  is uncompressed `application/json`. The docs name the event
  `claude_code.api_request`, but on the wire that string is the record *body*
  and the `event.name` attribute is the bare `api_request` — the parser accepts
  both. `OTEL_RESOURCE_ATTRIBUTES` lands on the resource *and* on each record,
  and the parser merges both so run attribution does not depend on which.
- OTLP parser run against those captured payloads, 13 assertions: extracts the
  priced request with its `req_…` id, first-party cost, tokens and run id;
  drops `user.email` / `user.account_uuid` at the parser; a redelivered batch
  inserts 0 rows (delivery is at-least-once); an unknown run returns null
  rather than a zero row; and malformed or null payloads return empty instead
  of throwing, since a rejected batch would be retried forever.
- Plan detection reads `Claude Max 20x` from `.credentials.json` with no email,
  name, or account UUID crossing the wire; caches for 60s including misses (the
  CLI writes these files lazily); and degrades to "plan unknown" with no error
  when the config directory holds neither file. The legacy `~/.claude.json` is
  consulted only while the config directory is still the default — a redirected
  `CLAUDE_HOME` reports no plan rather than the wrong one.
- Path traversal rejected in every form tested: `../` escape, absolute path
  outside all mounts, a symlink pointing out of the tree, a folder belonging to a
  *different* mount, an unknown mount id, an unmounted workspace, and a path
  inside a workspace slot that is configured but disabled.
- Multiple workspaces: slots parse and are listed independently, a disabled slot
  is skipped, a missing one is reported as unavailable rather than empty, and a
  run's folder maps back to its workspace even when the mount is reached through
  a symlink.
- The **standalone** build (what the container runs) boots and serves, native
  SQLite binding included.
- **One real billed run**, end to end: 1 iteration, exit 0, stopped at the
  iteration cap, $0.067 / 13,983 tokens accounted correctly.
- Reserved headroom: 50% reserve halves the effective ceiling ($200 → $100),
  doubling the reading (13.8% → 27.5%) and converting a 20% guard from allow to
  refuse. Out-of-range input (400%) clamps to 95%.

There is no test framework and no linter in this repo. `npm run typecheck` plus
a `docker compose up --build` smoke test is the whole verification loop, and the
list above records what was checked by hand.

---

## License

MIT — see [LICENSE](LICENSE).
