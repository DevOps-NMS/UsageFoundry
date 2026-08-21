# What any option has to survive

Thirteen constraints. Every one of them has already broken something in this
codebase or is recorded in `docs/agent/` as the reason a decision went the way
it did, and every one of them fails **silently** — the run works, the page looks
right, and the mechanism is simply not there or is quietly expensive.

Option files do not re-argue these. They answer them.

## 1. It must reach an install that has ever pressed Save

`getSettings()` is `{...DEFAULTS, ...stored}` (`src/lib/settings.ts:653`–`:655`)
and the settings page PUTs the whole *effective* object
(`src/app/settings/page.tsx:1425`). `saveSettings` now stores only what differs
from `DEFAULTS` (`src/lib/settings.ts:693`–`:706`), so an unedited prompt is no
longer pinned by pressing Save — but a prompt an operator has actually **edited**
is pinned permanently, with "no versioning and no migration" (`:664`–`:666`).

Consequence, unchanged from `docs/agent/conventions.md`: **any sentence that must
stay true is generated in `orchestrator.ts`; only guidance may be a `DEFAULT_*`.**
`COMPLETION_NOTICE` (`src/lib/orchestrator.ts:4466`) and `NEEDS_REVIEW_NOTICE`
(`:4506`) are the shape; `continuedWorkNotice` (`:4401`) is the split done
properly — generated facts, editable guidance appended.

A new `Settings` field has **four** doors and silently fails at a different one
each time: the interface member, a `DEFAULTS` entry (which must be `{}` or the
deep compare persists it into every install), membership of `SETTINGS_KEYS`
(`src/lib/settings.ts:649`, which is `Object.keys(DEFAULTS)` and which
`saveSettings` iterates), and one of the 34 explicit `if ("key" in body)` arms in
`PUT /api/settings`. Miss the last and the route answers 200 without the key
while the form reverts under a "Saved" confirmation.

## 2. It must reach every cycle, not only the first

Established on the pinned binary in
`proposals/ContextControl/02-levers-on-the-pin.md:183`–`:217`:

- **`--settings <json>` and `--settings <path>` survive `--resume`.** Hooks
  delivered this way fired on cycle 1 and on the resumed cycles.
- **`--plugin-dir` does not.** Three cycles, the flag present on the first two
  and absent on the third: two firings, not three. Cycle 3 exited 0, wrote
  nothing to stderr, and ran no hook. This is the docblock at
  `src/lib/orchestrator.ts:4879`–`:4885` confirmed, and confirmed as silent.
- `--agent` does survive, which is what makes a run's agent true of every cycle.

`buildArgs` rebuilds the whole argv per cycle, which is why the app gets this
right today. An option that reaches the run through a plugin directory inherits
the re-send requirement; one that reaches it through `--settings` does not.

## 3. Anything composed into `--settings` must not travel through `sandboxArgs`

`sandboxArgs` returns `[]` when `arrangement === "none"`
(`src/lib/orchestrator.ts:5232`) and again when the policy is not `confined`
(`:5233`). That is every stock install. A hooks payload composed into that
function ships to nobody, and the run looks completely normal.

Two `--settings` flags is not the answer either: whether the CLI merges them or
lets the second replace the first is **not established** on the pin. The shape
that survives is one composer that merges the sandbox overlay and any other
payload into a single object and emits whenever either half is non-empty.

## 4. It must not write the prefix

The only cache breakpoint that matters sits inside the CLI's own `sys[2]` block,
and `gitStatus` lives there — ahead of it
(`proposals/ContextControl/02-levers-on-the-pin.md:419`–`:437`, `:470`–`:474`).
Measured on the corpus: **no handover whose previous cycle changed nothing in the
repository ever re-wrote (0 of 74), and all six handovers with no repository
change hit the cache**.

So **a repository change is a cache write**, and any option whose mechanism is
"the agent maintains a file in the tree" pays that on every cycle it writes. Text
appended at the tip of a prompt is the opposite case: `S = D`, `T* = 19·(S/D) −
20 = −1`, paid once and read at 0.1× thereafter
(`proposals/ContextControl/01-constraints.md:32`).

## 5. It must not become a fourth cost source, and must not mix the three

`docs/agent/metering.md`: three cost sources, never summed or mixed in the UI,
and OTLP telemetry never reaches `buildSnapshot()` or `runs.spent_usd`. Any
figure an option puts on a page says which source it read. `repoSpend.ts:13`–`:22`
is the precedent for a per-repository rollup that refuses to be a guard, and any
new rollup inherits that refusal.

An option that *spends* — a retrospective, a brief refresh — lands in
`run_reviews.cost_usd` and must stay out of `runs.spent_usd` by construction, the
way `startAssist` already does.

## 6. It must be visible on the run's own log

`proposals/ContextControl/01-constraints.md` states the rule and this survey
inherits it: a mechanism invisible in the log is one whose misbehaviour reads as
the agent being stupid.

There is a live defect here that gates one option outright.
`src/lib/orchestrator.ts:6208`–`:6221` exists to log what a hook injected, and
**`--include-hook-events` appears nowhere in `src/`** (`grep -rn
"include-hook-events" src/` → 0). A hook firing on a work cycle today is
invisible on that run's log. Anything hook-delivered must ship that flag with it.

And the second half: **the prompt a cycle was actually sent is persisted and
never rendered.** `describeEvent`'s `iteration` case reads `p.n` and
`p.resuming`. An operator cannot audit, correct or distrust a memory they cannot
read, so any option that injects text owes that disclosure as a prerequisite, not
as a nicety.

## 7. The write side and the read side must not have the same author

`docs/agent/chat.md`'s gate: prompt text is the one half of a run a model may
write. A memory that a run writes and a later run reads closes that loop — the
run becomes an author of the next run's instructions.

This is not hypothetical elsewhere in the stack: `~/.claude` is one bind mount
shared with the host and writable by the agent uid
(`docs/agent/architecture.md`, `docs/agent/security.md`), which is why
`claude plugin install` is refused by name. An option whose store lives in
`DATA_DIR` has a different answer to this question than one whose store lives in
the mount, and every option must state which it is.

## 8. It must state its horizon, or say it has none

`docs/agent/retention.md`: nothing deletes a `runs` row; what expires is the
evidence behind it, on three separate horizons, and every sweep asks the database
what is live rather than a file's age.

- `run_events` and `otlp_requests`: `eventRetentionDays`, default **30**
  (`src/lib/settings.ts:631`, swept at `src/lib/retention.ts:137`).
- `run_reviews`, `runs`, workflow records, settings: **never** swept
  (`src/lib/retention.ts:29`–`:32`).

A store that adds a fourth horizon adds a fourth arm to `StorageReport` and a
fourth thing an operator has to reason about, and must earn it.

## 9. It must not put an `await` inside `createRun`

`docs/agent/concurrency-and-ownership.md`: `createRun` runs from entry to INSERT
with no `await`, or two agents land in one directory. Occupancy is never keyed on
`isRunning()`. Every writer asks the lock at the moment of the write.

A per-repository lookup is a synchronous `better-sqlite3` query or it does not go
there. The related decision nobody has made explicitly: `settings` and
`githubTokenFor` are resolved **once**, before the cycle loop
(`src/lib/orchestrator.ts:6452`, `:6475`), where `enabledPluginDirs()` is
deliberately re-resolved **per cycle** (`:6763`). An option must say which class
it belongs to.

## 10. It must degrade when isolation is absent

`seedWorktree` sits behind `run.isolation === "worktree"`. A run working in the
operator's own checkout has no seed path at all, so any file-delivery mechanism
covers only part of the fleet and must say which part. `docs/agent/isolation-and-landing.md`
is the general rule: isolation being *unavailable* degrades to `mode: "none"`;
isolation being *used up* throws.

## 11. Anything naming a path re-proves containment at use time

`docs/agent/security.md`: `resolveInMount()` checks containment on the resolved
path **and again** after `realpathSync`, both load-bearing; a stored path is
proved contained in a mount again at use time. Never a shell — argv arrays only,
at every spawn site.

## 12. A standing tool definition costs money before anyone calls it

`proposals/ContextControl/12-option-retrieval-index.md:111`, re-measured at
`19-validation.md:53`: **$8.14–$8.26 per tool definition per week** on this
install, read at 0.1× across every turn of every run, whether the tool is called
or not.

Measured demand on the other side, from `run_events` kind `tool`: `Grep` 49
calls, `Glob` 2, against `Bash` 16,754 and `Read` 5,867 — and both search tools
are already granted on every cycle's `--allowedTools` (`SEARCH_TOOLS`,
`src/lib/orchestrator.ts:4642`). **A voluntary surface this install already has
is declined; a new one has to argue why it would not be.**

A work cycle also gets no MCP server today: `--mcp-config` and
`--strict-mcp-config` appear only on the chat child (`src/lib/chat.ts:1654`,
`:1658`). Adding the first without the second admits every MCP server configured
in the shared `~/.claude` into every run — a surface the operator never granted,
silently, because the run still works.

## 13. It must price what it costs when it *works*

Every option prices its idle cost. The failure this survey has to avoid is
pricing only that.

A gate that fires and is obeyed makes the run open the doc: `docs/agent/conventions.md`
is 63,394 bytes and `docs/agent/run-lifecycle.md` 46,235, written once at the 1h
rate and then carried for the rest of the cycle. A pointer that is *not enough*
leaves the conversation carrying the pointer, the brief and the file. A
delegation instruction that is followed pays a sub-agent prefix per delegation.

An option that cannot state its success cost has not been costed.

## The three arithmetic facts every option is scored against

| | |
|---|---|
| Cache read | 0.1× input; 5-minute write 1.25×, **one-hour write 2.0×**, and Claude Code writes 1h heavily (`src/lib/pricing.ts:10`–`:18`) |
| Invalidation | `T* = 19·(S/D) − 20` — the number of turns before an invalidating saving pays for itself |
| Displacement | **`d` does not exist.** No measurement in this repository establishes that a run told where to look reads less. Every saving claim multiplies by it |

`15-comparison.md` scores on this basis, and any option file that states a dollar
saving without naming `d` is overstating.
