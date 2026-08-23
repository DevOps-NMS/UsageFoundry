# Recommendation

**Four steps, in order, and the first two are almost free. Then stop and ask the
operator one question before building the third.**

The recommendation is not "build a webhook". It is that three of the four steps
below are worth doing whatever the answer to that question is, and the fourth is
worthless if the answer is no.

---

## Step 1. Level the stdout lines, and add the two conditions the README is missing

**Cost: a `switch` inside an existing `case`, and two table rows in `README.md`.
No schema, no dependency, no credential, nothing leaves the box.**

`logLifecycle`'s `status` case is one line for all nine statuses
(`orchestrator.ts:544-546`):

```
case "status":
  opsLog("info", "run.status", { run_id: e.runId, status: str("status") });
  return;
```

So `needs-review`, `blocked`, `failed`, a park and an ordinary `completed` all
reach stdout at the same level. `/workspace2/3 Resources/Debugging and
Observability/Logging and Structured Logs.md` treats level as a **routing**
decision — the field a consumer filters on to decide whether a human is woken —
and by that test four of the nine rows are currently mis-routed. Routing
`needs-review`, `blocked` and `failed` at `warn` makes them filterable by any log
shipper the operator already runs, and it costs less than any other line in this
proposal.

`README.md:236-249` lists twelve alertable conditions and **`runs["needs-review"] > 0`
is not among them**, though `RunStatusCounts` is `Record<string, number>` over
every status (`src/lib/status.ts:29-30`, docblock: "every state, so the numbers add
up to the row count"). Neither is `runs.blocked > 0`. Both are on the wire today.

`grep -c "needs-review" README.md` returns **0**: the one ending whose entire
content is "a person should look at this" is not named anywhere in the document that
tells an operator what to watch. Two rows in a documentation table, and the designed
pull-based position covers two more of the nine.

This step is the cheapest thing in the survey and it is not a notification channel.
It should ship whether or not anything else does.

## Step 2. Project the two booleans the 429 ladder already carries

**Cost: two fields on an existing `opsLog` call.**

Row 3 of `00-problem.md`'s table is the most expensive wait in the app — the run
holds its folder, its worktree slot and one of `maxConcurrentRuns` for
approximately 17 minutes at the floor of the jitter band and 26 at its ceiling
(`docs/agent/run-lifecycle.md:28`).

It **does** emit. `orchestrator.ts:7931-7951` publishes an `error` event per rung
whose message reads "…— retrying in 30s (1 of 4)." and whose payload carries
`retrying: true` and `usageLimit`. What it does not do is change status, so the run
reads `running` in `/runs`'s bands, in `/api/status`'s counts and in any digest
assembled from state.

And `logLifecycle`'s `error` case drops exactly the two fields that would make it
identifiable (`orchestrator.ts:566-568`):

```
case "error":
  opsLog("error", "run.error", { run_id: e.runId, message: str("message") });
```

Adding `retrying` and `usage_limit` to that object makes the most expensive wait in
the app filterable by any log shipper the operator already runs, and distinguishes
it from a genuine terminal failure arriving at the same level. **Two fields.** It is
the best ratio of consequence to change in this survey.

Note what this step does *not* need: a new event, a new status, a schema change or
a sweeper. The invariant it must not break is the one in `logLifecycle`'s own
docblock — it "**projects** rather than serialising the payload" — so these are two
named booleans, not a spread of `p`.

## Step 3. Ask the operator one question

**Do you have, or will you run, something that receives an HTTP POST — a Slack or
Discord webhook, a Telegram bot, an ntfy topic, a Home Assistant automation, a
laptop that beeps?**

`01-constraints.md` C10 is why this is a question rather than a measurement:
`/data` is `Permission denied`, the stale in-checkout database has zero `runs`
rows, and no park, `needs-review` or ending mix is obtainable from any source on
this machine. This is the one fact that decides the recommendation and the only
one a person can answer instantly.

**If yes → step 4a. If no → step 4b.** They are different builds and building the
wrong one wastes the larger part of the work.

## Step 4a. Option C, the outbound webhook, with Option F documented as the receiver

**121 of 165 in `10-comparison.md`, tied with Option B and three points behind the
null — see that file's §1 for why the table does not decide this.**

One notifier beside `logLifecycle`, firing on a `status` of `needs-review`,
`blocked`, `failed` or a guard-reason `stopped`, and on an `error` whose payload
carries `retrying && usageLimit` on its first rung. Six fields, five of them
opaque. HMAC-signed with `node:crypto`. `fetch` is global, so the dependency count
stays at four — **the only option that leaves the box without touching a standing
decision**.

It is also the only option that reaches row 3, C1's clearest interrupt, because it
subscribes where every other option reads.

Three details that are the option rather than its trim:

- **Fire-and-forget with `AbortSignal.timeout`.** `emit()` is synchronous through
  to `logLifecycle` and `docs/agent/concurrency-and-ownership.md` records that
  `createRun` "runs from entry to INSERT with **no `await`**. Adding one silently
  puts two agents in one directory." An awaited fetch in this path is the one way
  this option breaks the run loop, and it breaks it silently.
- **A bounded delivery-attempt table and a consecutive-failure count on
  `/api/status`.** Bounded on the `requestLog.ts:115-125` pattern —
  `DELETE … WHERE id <= (SELECT MAX(id) …) - ?` on every insert. This is what makes
  the pull-based position monitor the push channel, and without it a dead webhook
  is worse than no webhook because the operator has stopped checking.
- **Its own constant, not `TERMINAL_STATUSES`.** That array has five readers and a
  warning attached (`orchestrator.ts:3503-3515`), and it contains `completed`,
  which C1 classifies as a digest row. Reusing it is how the next person starts
  paging on success.

And the documentation, not the code, names the receiver: three lines each for
Slack, Discord and Telegram. **The app never holds a vendor's token and never
chooses a vendor.** `10-comparison.md` §2 measures what that choice costs — the
same mechanism scores 121 with the destination unspecified and 107 into a chat
channel, and the whole difference is the permanent searchable third-party store
and an unsignable bearer-in-a-URL. That is the operator's trade to make in their
own `.env`, and the default content-free form ("a run on this install needs
review" plus a run id) keeps the trade optional.

**The bot must not answer back.** `07-option-f-chat-bot.md` refuses the
interactive form on three grounds, the sharpest being that the app has already
decided this pattern: the orchestrator chat *proposes* and "approval takes the
explicit list of ids the page displayed, in one synchronous pass"
(`docs/agent/chat.md`), and `docs/agent/run-lifecycle.md:48` forbids a bulk
control from answering `needs-review` at all. A button in a notification is a
control that answers an ending without the operator seeing the run.

## Step 4b. Option B, the in-app digest

**121 of 165, tied with C, and the right build if the answer to step 3 is no.** It
is also the only option that reaches row 8, the dead login, because it reads where
every channel subscribes.

One assembly function reading eight of the nine rows, an SSE consumer of
`bus.emit("*", published)` at `orchestrator.ts:513` — which has **no consumer
today** and which `subscribe()` at `:690` would accept unchanged — a badge on the
`/runs` pane row, and a section on `/`.

Three constraints that are the design:

- **Not a tenth pane.** `src/components/shell/panes.ts:12-16`: "Nine is the
  ceiling and Knowledge is the ninth — a tenth destination has no digit, and a row
  without one is a row two of the four readers cannot describe."
- **No poll to stand down.** Subscribing to `"*"` rather than polling is the
  cheapest correct answer to `docs/agent/conventions.md:15` available to any option
  here, because an install-wide count has no clean stand-down condition. The two
  rows not on the bus — the merge queue and the login — take the
  `ReadOnlyNotice.tsx` shape instead (`POLL_MS = 60_000`, render nothing on a
  failed poll), and those two genuinely can stand down.
- **A read, never a control surface.** The comment refusing an "acknowledge all"
  button belongs in the same change as the list, citing
  `docs/agent/run-lifecycle.md:48`, because it is the first feature request that
  will follow and it violates a documented invariant.

`08-option-g-narrow-viewport-status-page.md` raises this option's value in a way
its own file understates: the badge is also the **phone** answer, since the app is
already installable (`src/app/manifest.ts`) and already narrow-responsive. It still
requires the operator to open something; it no longer requires them to be at a
desk.

Steps 4a and 4b are not mutually exclusive and B is the better *second* build in
either order. They are separated because building both first is 600-850 lines
before anything is verified, and step 3's answer says which 200 to write.

---

## Refused, by name

**Option D, web push**, on four independent grounds
(`05-option-d-web-push.md`): the push endpoint is chosen by the browser vendor, so
the timing metadata of every run ending goes to a third party the operator did not
pick; reaching a device that is not the host requires exposing this app beyond
`docker-compose.yml:62`'s `127.0.0.1` bind, which is a far larger security change
than the notification; RFC 8291 encryption is 300-500 lines of hand-written crypto
whose every bug returns 201 and delivers nothing; and C9 means nothing about it
can be verified here, since a push notification is entirely a rendering on a
device nobody has. **It is the only option that reaches a person who is not at a
computer with no vendor account and no bill**, which is why it is a refusal with a
condition rather than a refusal: a fortnight of real ending-mix data showing
frequent out-of-hours parks, plus a prior decision to expose the app, flips it.

**Option E, email**, as a default (`06-option-e-email.md`). It is the best-shaped
option for the seven digest rows and simultaneously the worst-positioned on two
constraints: it is the **only** channel with no zero-dependency route, and its
usefulness is directly proportional to its leak — an interrupt can be content-free,
a digest cannot, so a useful digest email is the install's work log in plaintext to
a third party, daily. If an operator wants it, the version to build is `counts` by
default with `titles` as an explicit opt-in, over an HTTP provider rather than
SMTP, after step 4b's assembly function exists.

**Option H1, an MCP tool**, as scoped (`09-option-h-mcp-and-orchestrator-chat.md`).
The tool is forty lines and the option is a fifth credential shape on a route whose
`middleware.ts:63-68` exemption comment says "If the check in `/api/mcp` is ever
removed, this line makes the whole tool surface public — keep the two together."
**Filed as a question for a person**: if the operator wants their own Claude Code
to be able to ask, the thing to design is a `UF_READ_TOKEN` on the
`UF_STATUS_TOKEN` pattern, and that is a security decision, not a notification one.

**Option H2, the orchestrator chat**, on arithmetic. A chat turn costs money
against `chat_turn_spend` and the install's rolling 24-hour ceiling
(`docs/agent/budgets-and-guards.md`), and Option B renders the same answer from the
same tables for zero marginal cost on every page. Paying a model to proxy a
`SELECT` has no reading in which it is the better mechanism. Its one real
capability — summarising across runs — is triage rather than notification and
belongs to `proposals/ContinuousImprovement`'s neighbourhood.

**A separate narrow-viewport page, Option G**, handed back rather than refused
(`08-option-g-narrow-viewport-status-page.md`). The rendering question is owned by
`docs/verification.md:1113-1250`, which has the procedure, the viewport and the
greps written, and `CLAUDE.md` says that file's "Not yet verified by hand" list
"must stay honest". A separate page would be a tenth pane, or an unlinked URL, or a
duplicate of a live view across 16,529 lines of page code that no test renders.

**And, inside step 4a, a chat bot that can act.** Notify-only is the option, not a
limitation of it.

---

## What would overturn this

**The answer to step 3.** The recommendation's top-scoring step rests entirely on
the operator having, or being willing to run, a receiver. If the honest answer is
no and will stay no, Option C delivers nothing at all and step 4b is the whole
recommendation. Nothing in the code can settle this and no amount of further
reading would have; it is one question to one person.

**The ending mix on a real install.** If runs reach `needs-review`, park or block
rarely, and mostly during hours the operator is at their desk, then step 1 is the
whole of what is earned and steps 3 and 4 are premature. `01-constraints.md` C10
is why this survey cannot answer it: `ls -la /data` returns `Permission denied`,
`SELECT COUNT(*) FROM runs` on the stale in-checkout copy returns **0**, and the
only durable record of an unattended event anywhere readable is a single
`ops_events` row — `boot.reconciled`, `{"closed":2,"kept":0}` — which is n = 1 and
is not a rate. **Every latency claim in this proposal is a mechanism claim.**

**And one thing that would sharpen rather than overturn it:** whether row 3 is
common. Step 2 makes the 429 ladder visible and step 2 is recommended
unconditionally, so the measurement arrives as a side effect of the cheapest step.
If it turns out the ladder fires often, the case for a real interrupt — including
Option D's condition — gets much stronger, and this survey should be re-read with
that number in hand.
