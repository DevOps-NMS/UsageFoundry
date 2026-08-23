# Constraints

Twelve, in descending order of how much field they remove. Every option file is
bounded by all of them; where an option argues against one, it says so by number.

---

## C1. The interrupt/digest split is a cost argument, not a taxonomy — and only two of the nine rows earn an interrupt

This is the spine of the comparison, so it is first.

`/workspace2/3 Resources/Debugging and Observability/SLOs and Error Budgets.md`
supplies the frame: an alert is worth its interruption cost only when it is
**actionable, urgent and about a symptom the user of the service feels**, and the
error budget is what converts "is this bad" into "is this bad enough to spend a
person's attention on". Its own caution is recorded in
`proposals/GapRegister/04-missing-features.md` and inherited here: the note rests
on a single vendor book with no replication, so this survey takes the *framing*
and not the authority.

Applied to `00-problem.md`'s table, the frame does most of the work of the
comparison before any option is scored, because it asks one question of each row:
**does waiting cost anything other than the operator's own time?**

| Row | Costs money or capacity while it waits? | Verdict under C1 |
|---|---|---|
| 3, the 429 ladder | Yes — folder, worktree slot, one of `maxConcurrentRuns` for ~17-26 min, and the fix is a setting only the operator can change | **Interrupt-shaped**, and it has no signal at all |
| 8, the dead login | Yes — compounding: every admitted run burns a cycle to discover it | **Interrupt-shaped**, and it is on one page nothing polls |
| 2, a refusal park | Yes — folder, slot, concurrency, up to 6h per rung, three rungs | Borderline. It resolves itself twice out of three times, and the *watched* case is already the best-served wait in the app |
| 1, `needs-review` | No. It holds a branch nobody else wants | **Digest**. Its whole content is "a person should read this", and a person reading it tomorrow is not a worse outcome than a person reading it at 03:00 |
| 4, a guard trip | No | **Digest** |
| 5, a blocked chain | No — a `waiting` run holds nothing, by design | **Digest** |
| 6, the merge queue | Partly, but see C7 | **Digest**, and never an interrupt |
| 7, a halted instance | No | **Digest** |
| 9, a restart's closed runs | No | **Digest**, though it is the one row already on the README's alert list |

**The consequence is uncomfortable, and it is specific.** The two rows that earn
an interrupt are the two that no *terminal-transition* channel reaches, for two
different reasons.

Row 3 emits — an `error` event per rung, `orchestrator.ts:7931-7951` — but it is
**not a status change**, so it is invisible to anything reading `runs.status` and
visible to anything reading the bus. An option attached to `emit()` can deliver it
today; an option attached to a terminal transition, or to a digest assembled from
state, cannot.

Row 8 is a **container** condition rather than a run event: `pendingLogin` lives in
`claudeAuth.ts` and never touches `run_events`. So it is on neither the bus nor
`runs`, and only a channel that *reads* rather than *subscribes* can reach it.

**The two interrupt rows therefore need opposite mechanisms**, which is the single
most consequential fact in this survey: a subscriber gets row 3 and misses row 8, a
reader gets row 8 and misses row 3, and every option below is one or the other.

An option file that does not engage with that is scoring itself on modernity.

## C2. A monitor must not be handed the credential that starts agents

`docs/agent/security.md:22`, verbatim:

> **A monitor must not be handed the credential that starts agents.**
> `UF_AUTH_TOKEN` opens every route in the app, including the ones that spawn
> billed children, so polling any of them from a monitoring system means a
> scraper holds the master key. `UF_STATUS_TOKEN` is a second, read-only
> credential that reaches `/api/status` and nothing else, checked in that route
> rather than in the edge middleware.

Two directions, and both bind.

**Inbound.** Anything that reaches back *in* — a chat bot answering "what needs a
decision", a webhook receiver, a push subscription endpoint — needs a credential,
and it may not be `UF_AUTH_TOKEN`. The repository holds three worked precedents
for the narrow alternative: `UF_STATUS_TOKEN` (a second read-only env var, checked
in the route, exempt in `middleware.ts` only while set), the per-turn MCP
capability token (`docs/agent/chat.md`: minted per turn, dies with it, never
`UF_AUTH_TOKEN`, and its 401 answered **outside** `auditMutation`), and the
signed session cookie that is deliberately not the master token
(`docs/agent/security.md:25`).

**Outbound.** The channel's own secret — a webhook URL with a token in it, VAPID
keys, an SMTP password, a bot token — is a credential this app must hold at rest.
`settings.json` under `DATA_DIR` is not obviously the right place for one:
`saveSettings` stores only what differs from `DEFAULTS`
(`docs/agent/conventions.md`), which is a mechanism for *product defaults*, not a
secret store, and settings are readable by every route. Env-var-only, like every
other credential in this app, is the option-file default; an option proposing
otherwise argues it.

## C3. What leaves the box is task text, repository names and possibly diff content

The hard constraint the brief named, and it decomposes into three separate rules
already written down.

**`logLifecycle`'s projection is the standard.** `orchestrator.ts:536-583` drops
`iteration`'s prompt, the creation `status`'s folder, and `assistant`'s model
output, and says why in its docblock. An outbound payload that carries more than
`{run_id, status, cost_usd, duration_ms, subtype}` is arguing against a decision
somebody has already made and documented at the exact seam it would attach to.

**`/api/status`'s docblock is the second standard**, and it is stricter:
`src/lib/status.ts:25-27` — "no token, no branch name, no model. A folder path
here is a leak of what this install works on into whatever scrapes it."

**A run title is not safe by default.** Prompt text is the one half of a run a
*model* may write (`docs/agent/chat.md`), so a notification that includes a task
title is forwarding model-authored text to a third party. That is not a
prohibition, but it is the sentence an option owes.

And the rule with the sharpest edge, from `docs/agent/security.md:21`: a notice on
every sibling's argv must contain no literal an agent could `pgrep -f`. It does
not bind a notification payload directly — a webhook body is not on anyone's
command line — but it is the reasoning to imitate when deciding what an identifier
in an outbound message may be. A run id is a random handle; a folder path is a
selector.

## C4. Four runtime dependencies, no linter, and a test bar that is a sentence

`package.json`: `better-sqlite3`, `next`, `react`, `react-dom`. Nothing else at
runtime. Restated from `proposals/OperatorInterface/01-constraints.md` §C5,
because the same sentence decides more here: **an option proposing a dependency
is proposing to change a standing decision, and must argue it there.**

This is less binding than it first appears, and the option files should be honest
about that rather than hiding behind it. `fetch` is global in Node 22, so a
webhook and any HTTP-API-based email or chat provider need **no** package. VAPID
signing for web push is ECDSA P-256 over a JWT, which `node:crypto`'s
`webcrypto` does — so web push is a *large amount of hand-written code* rather
than a dependency, which is a different and in some ways worse argument. **SMTP
is the one channel with no zero-dependency route**, and that is Option E's central
problem rather than an aside.

## C5. A poll stands down when its subject can no longer move, and the re-arm is the half to design

`docs/agent/conventions.md:15`. Three re-arm edges are already named: the run
page's first load sits above the gate, the last poll after a run settles is what
catches its ending, and **SSE is what wakes a poll that has stood down**.

Any option adding a surface that reads "what is waiting" must say when it stops
polling and what wakes it. An install-wide badge that polls for ever is a defect
under this invariant, not a feature — and the bus already emits `"*"`
(`orchestrator.ts:513`, no consumer), which is the wake signal such a surface
would need.

## C6. The unauthenticated surface is counts-only, and that is decided

`middleware.ts`'s `/api/health` exemption comment bounds it: counts of runs by
status, whether SQLite responds, whether the process owns its data directory, two
timings, and "anything added to that payload that is not a count makes this line a
second unauthenticated data route."

So there is no route to a useful *public* status surface. Every option that
displays anything specific is behind the session gate, which means behind a login,
which is exactly what `manifest.ts`'s docblock says makes the app installable and
deliberately does not widen.

## C7. Nothing on the landing path has a clock on it. Do not add one.

`docs/agent/isolation-and-landing.md`. Row 6 of the table is unbounded because
being unbounded is correct: the operator's checkout must be clean and on the
recorded target branch, and no amount of urgency changes whether it is. An option
that escalates a merge-queue wait — reminders, an ageing badge, a repeat
notification — is arguing against a documented invariant and must say so by name.

Reporting the state once is not a clock. Reporting it again is.

## C8. `needs-review` may never be answered in bulk

`docs/agent/run-lifecycle.md:48`: "A control that acts on twenty-five runs at once
must not answer the one ending whose entire content is *a person is being asked to
look at this*." The bulk pick-up filters to `failed`/`stopped`
(`REOPENABLE`, `src/app/runs/page.tsx:32-91`) for this reason.

This binds the digest option hardest: **a digest is a read, never a control
surface.** A list of nine things awaiting a decision with an "acknowledge all"
button is this invariant's exact violation, and it is the obvious next feature
request after the digest ships. Saying so now is cheaper than refusing it later.

## C9. No browser has been driven at this app, at any viewport

Inherited, not re-derived: `proposals/OperatorInterface/01-constraints.md` §C6 and
`docs/agent/ui-density-audit.md:2624-2628` — the one browser ever driven "refused
to resize below the host window and reported `innerWidth: 2560` at a 1519px
window", so the `md` breakpoint has never been crossed by anyone.

Two consequences. **The narrow-viewport question has an owner**,
`docs/verification.md:1113-1250`, with a written procedure and a chosen viewport,
and `proposals/OperatorInterface/10-option-i-narrow-viewport.md` already handed it
back rather than re-deciding it. Option G in this survey must not re-decide it
either; what it may ask is the *different* question of whether a phone-shaped
surface should exist at all. And **no claim here about how a notification looks on
a device is available**, which reaches Option D hardest, since a push notification
is entirely a rendering on a device nobody here has.

## C10. There is no measured history, so nothing is scored on frequency

From `00-problem.md` §3: `/data` is `Permission denied`; the stale in-checkout
database has zero `runs` rows, zero `run_events`, and one `ops_events` row. No
park, no `needs-review`, no ending mix, no dwell time and no queue depth is
obtainable from any source on this machine.

Every latency claim in every option file is therefore a **mechanism** claim. The
comparison weights criteria by what the mechanism does; it cannot weight by how
often the state occurs, and any option whose case rests on frequency names the
measurement that would settle it.

## C11. A schema change is an idempotent statement in `migrate()`, and this proposal writes none

`CLAUDE.md`: schema changes are idempotent statements in `migrate()` in `db.ts`,
and a destructive one runs inside a single `db.transaction`. The brief's
boundaries forbid schema changes in this survey, so every option that would need a
table states the delta as a **proposal** — the statement it would add, and why the
existing tables do not serve.

Two existing tables matter here. `run_events` is already the durable record every
outbound option would read, and `ops_events` already carries the one structured
unattended record that exists. Neither is a delivery queue, and `request_log`'s
eviction-on-insert (`requestLog.ts:115-125`) is the worked precedent for what a
bounded one would look like.

## C12. The pull-based position is designed, and `README.md` states it

`README.md:231-253` carries twelve alertable conditions against `/api/status`,
with thresholds, plus the warning that a `null` `guardFraction` "is not zero, and
an alert that treats it as a number will read a window nobody can measure as a
window at rest."

`proposals/GapRegister/04-missing-features.md`'s **M3** already established this
and it is not re-derived: "Nothing this app runs can reach a human, and most of
that is on purpose", nine grep hits and none of them an outbound channel, and the
strongest counter is that `README.md` is a designed position rather than an
oversight. M3 sits at row 19 of 20 on the register — high absence, **lowest
confidence that it is a gap** — and its recommendation was to file an issue for a
single webhook rather than to survey the field.

**This survey supersedes that scope deliberately**, and owes the reason: M3 scored
the *absence* of a channel and correctly discounted it, but it did not enumerate
the nine states, and the enumeration changes the answer in one specific way. The
README's twelve conditions were checked row by row against
`src/lib/status.ts:60-88` for this survey:

| Table row | Visible to a `/api/status` monitor today? |
|---|---|
| 1 `needs-review` | **Yes, as a count.** `runs: RunStatusCounts` is `Record<string, number>` and its docblock says "every state, so the numbers add up to the row count". Not on the README's list of twelve, but on the wire |
| 2 park | Yes, as `runs.paused`, plus two sweeper-health conditions |
| 4 guard trip | Yes, as `runs.stopped`, though undistinguished from any other stop |
| 5 blocked | Yes, as `runs.blocked` |
| 9 restart | Yes, `lastBootReconcile.closed`, and it is condition 11 of the twelve |
| 3 the 429 ladder | **No.** There *is* an event — an `error` per rung at `orchestrator.ts:7931-7951` — but no status change, so nothing on `StatusReport` moves and the run counts as `running` for the whole ladder |
| 6 merge queue | **No.** Nothing about branches, queue depth or a refusing checkout is on `StatusReport` |
| 7 halted instance | **No.** Nothing about workflow instances is on `StatusReport` |
| 8 dead login | **No.** Nothing about credential state is on `StatusReport` |

So the designed position covers five of nine rows for an operator who has already
stood up Prometheus, and **the four it does not cover are three of C1's four
interrupt-or-borderline rows.** That is the gap this survey is entitled to work
in, and it is narrower and differently shaped than "the app cannot reach a human".
