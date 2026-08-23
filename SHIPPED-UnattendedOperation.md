# What shipped from UnattendedOperation, and where a person sees it

**A dated record, not a maintained document.** Written 2026-08-23 at commit
`62dc931`, covering the seven commits from `594fd68` to `62dc931`. It exists
because the promoted proposal is deliberately kept as the argument it made
rather than edited into a record of what was built, so the argument and the
outcome now live in two places. The durable references are
[`docs/install.md`](docs/install.md) (setup), the **What to alert on** table in
[`README.md`](README.md) (thresholds), `docs/agent/run-lifecycle.md` (the
invariants) and `docs/verification.md` (what was measured). Check any claim here
against the tree before acting on it.

The survey is [`proposals/implemented - UnattendedOperation/`](<proposals/implemented - UnattendedOperation/README.md>).
Its recommendation was four steps. Steps 1, 2 and 4a were built. Step 3 was the
question put to the operator, and 4a is the answer they gave.

## 1. What shipped

| Step | What it is | Where |
|---|---|---|
| 1 | `logLifecycle`'s `status` case routes by level instead of one `info` line for all nine statuses. `WARN_STATUSES` is `needs-review`, `blocked`, `failed`, typed `RunStatus` at the literals so a renamed member is a compile error. | `src/lib/orchestrator.ts` |
| 2 | `run.error` carries the two booleans the 429 ladder already emits per rung and the log dropped: `retrying` and `usage_limit`. Two named fields, not a payload spread. | `src/lib/orchestrator.ts` |
| 4a | The outbound webhook: one signed POST per ending that wants a person, a bounded record of every attempt, and a health figure on `/api/status`. | `src/lib/notify.ts`, `src/lib/db.ts`, `src/lib/status.ts`, `src/lib/config.ts` |

Four new environment variables, all read through `optionalEnv` and all listed in
`BLANK_MEANINGFUL_ENV_VARS`, so blank stays quiet on a stock install:
`UF_WEBHOOK_URL`, `UF_WEBHOOK_SECRET`, `UF_PUBLIC_URL`, `UF_INSTALL_LABEL`.
None of them is readable or writable through `settings.json`, which is a
security decision rather than a convenience: `/api/settings` is reachable with
`UF_AUTH_TOKEN`, so a target held there would be repointable by anything holding
the master key.

One new table, `webhook_deliveries`, created idempotently in `migrate()` and
bounded on every insert at 2,000 rows on `request_log`'s pattern.

Tests: `src/lib/notify.test.ts` (the filter and the signature), plus additions
to `src/lib/orchestrator.test.ts`, `src/app/api/status/route.test.ts` and
`src/lib/deployment.test.ts`.

## 2. How it reaches a person

There are three surfaces, and none of them is inside the app. In order of who
sees them:

### Container stdout

Structured JSON, one line per event, from `opsLog`. `level` is the field a
shipper filters on to decide whether to wake somebody, which is why step 1 was
worth doing on its own:

| Line | Level | What it says |
|---|---|---|
| `run.status` | `warn` for `needs-review`, `blocked`, `failed`; `info` otherwise | An ending. `stopped` stays `info`: an operator's own cancel arrives as `stopped`, and a guard trip already has its own `warn` line in `run.guard_tripped`. |
| `run.error` | `error` | Now with `retrying` and `usage_limit`, which is what tells a 429 ladder holding the folder for 17 to 26 minutes apart from a run that has actually died. |
| `webhook.delivery` | `info` on success, `warn` on failure | One line per attempt, carrying the failure message. The receiver's hostname can appear here, which is fine: this is the operator's own log. |
| `webhook.unsigned` | `error` | `UF_WEBHOOK_URL` is set and `UF_WEBHOOK_SECRET` is not, so nothing was sent. One line per lost notification, not one at boot. |
| `webhook.sink_failed` | `error` | The notifier itself threw. Nothing above that line is expected to. |

### The outbound POST

Fires only when both `UF_WEBHOOK_URL` and `UF_WEBHOOK_SECRET` are set. Six
fields, and the list is closed:

```json
{ "install": "kitchen-nuc", "event": "run.needs_review", "run_id": "…",
  "status": "needs-review", "at": 1756000000000, "url": "https://uf.example.com/runs/…" }
```

```
POST <UF_WEBHOOK_URL>
Content-Type: application/json
X-UF-Signature: sha256=<hmac-sha256 of the raw body, keyed with UF_WEBHOOK_SECRET>
```

The signature is GitHub's shape because every receiver's documentation already
has an example of verifying it. It is computed over the one `JSON.stringify`
result that is also the request body, so the bytes signed are the bytes sent.

`runs.title` is forbidden by name, and so are the task text, folder, branch,
repository, model, cost, diff and `needs_review_reason`. A title is
model-writable text: `chat.ts` lets a proposal name its own run, so sending it
would put an unattended model's prose on a third party's endpoint. `url` is how
a person gets to all of it instead.

Four endings notify, plus one wait that is not an ending at all. The filter is a
reducer rather than a predicate because this sink is handed events, not
transitions:

| Event | Fires on |
|---|---|
| `run.needs_review` | The agent's own judgement that a person is needed. |
| `run.blocked` | Work refused before it started. |
| `run.failed` | A crash, or an allowance refusal that gave up. |
| `run.stopped` | Only when a `budget` verdict latched first, so a guard trip notifies and an operator's own cancel never can. Deliberately not a parse of `stop_reason`, which is user-facing prose. |
| `run.rate_limited` | The first rung of an in-place retry ladder, once per run. `status` is `running`, because the ladder changes none. |

`completed` is absent, and `NOTIFY_STATUSES` is deliberately a separate constant
from both `TERMINAL_STATUSES` and `WARN_STATUSES`: twenty-five notifications for
twenty-five runs that worked is how a channel stops being read.

Delivery is fire and forget, with a five second `AbortSignal.timeout` and a
`.catch` that records. Nothing on the path is awaited, because `emit()` is
synchronous from the durable INSERT onward and a run ending must never wait on a
receiver's DNS lookup.

### `/api/status`

Behind `UF_STATUS_TOKEN`, a read-only credential separate from the master key:

```json
"webhook": { "configured": true, "consecutiveFailures": 0, "lastAttemptAgeSeconds": 41 }
```

`consecutiveFailures` is derived from the table with one query rather than held
in memory, so "dead since Tuesday" survives a restart. There is no error string
here on purpose: this payload is retained and forwarded by whatever scrapes it,
and a fetch failure's message names the receiver's host.

This figure is the condition the survey put on the whole feature. A fire and
forget channel nobody receives from produces exactly the same silence as a fleet
with nothing wrong, and the operator who stopped watching the runs page because
the notifications were arriving is precisely the person that silence misleads.

### The two documents an operator reads

`README.md`'s **What to alert on** table gained three rows: `runs["needs-review"]`,
`runs.blocked`, and `webhook.consecutiveFailures > 3 while webhook.configured`.
`docs/install.md`'s *Getting told when a run needs you* carries the four
variables, the body, the signature, Home Assistant as the reference receiver
with a worked automation, ntfy in a line, and the warning that Discord, Slack
and Telegram cannot be pointed at directly. Those three take only their own body
shape, so a bare Discord URL answers 400; a relay or a Home Assistant automation
is the shaping layer. That the app has no vendor branch is its security
argument, not an omission: the moment this code knows what Discord's body looks
like, the feature stops being "point us at your own receiver".

## 3. What a person does not see

**No user interface at all.** No page, no banner, no badge, no bell, no toast.
The only file this work touched under `src/app` is a test. Everything above is a
log line, a JSON endpoint or a POST to a host the operator named.

That is not an oversight. Step 4b, the in-app digest, was the other half of the
recommendation and was deliberately not built; it remains the better second
build. The reason the two are not interchangeable is the spine of the survey's
comparison: the webhook subscribes, so the endings it cannot reach are the ones
that leave no event, and a dead container login is still readable only by
somebody looking. `bus.emit("*")` in `orchestrator.ts` fires after the durable
write and still has **no reader anywhere in the tree**, which is where that
build would start.

Five things were refused by name and the refusals stand: web push, email as a
default channel, an MCP tool as scoped, the orchestrator chat as the reader, and
a chat bot that can act on a `needs-review`.

## 4. What was measured, and what is still open

`docs/verification.md` carries the detail and is the file to trust over this
one. What was measured on 2026-08-23 is more than the unit tests: the real
`notifyLifecycle` was driven against a throwaway `node:http` listener, four
events in and two POSTs out, exactly the ones the filter names. The body was
156 bytes carrying those six keys and nothing else, UTF-8 on the wire, with the
trailing slash on `UF_PUBLIC_URL` stripped rather than doubled. The signature
was re-derived from the raw bytes by `openssl dgst -sha256 -hmac` and by
Python's `hmac`, so what a receiver verifies is checked by something other than
the code that produced it. A POST to `httpbin.org` returned 200, so egress from
that environment works, and an unreachable receiver logged `http_status: 0` at
`warn` and left `consecutiveFailures: 1`, which is the path the alert row
depends on.

Four things are still open, and they are the ones that matter for trusting this
unattended:

- **No real receiver.** Nothing has been pointed at a Home Assistant instance or
  an ntfy topic. The automation in `docs/install.md` is written from Home
  Assistant's documented webhook trigger and has not been loaded, so its field
  names are unconfirmed. The Discord and Slack 400 is the same kind of claim: a
  documented body shape, not a request this project sent.
- **Never run inside the container.** Docker was unavailable where this was
  built. `deployment.test.ts` proves the four variables are *written* into
  compose's `environment:` block, not that a container reads them.
- **No notification produced by an actual run loop.** The events driven through
  `notifyLifecycle` were constructed, so what is unproven is the shape of a real
  `PersistedRunEvent` at each of those endings, not the filter's answer to it.
- **Every frequency is a mechanism claim**, for the reason it was when the survey
  was written: no readable install history exists here, so how often any of these
  endings actually occurs is unmeasured.
