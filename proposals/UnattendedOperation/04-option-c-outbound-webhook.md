# Option C: an outbound webhook on terminal transitions

One `POST` to an operator-configured URL when a run reaches a state that needs a
person. The smallest thing that leaves the box, and the only option whose
delivery target is chosen by the operator rather than by a vendor.

## What it is

A notifier beside `logLifecycle` (`orchestrator.ts:536-583`), reading the same
`PersistedRunEvent` and firing on a narrow set: a `status` of `needs-review`,
`blocked`, `failed` or `stopped`-with-a-guard-reason, and an `error` whose payload
carries `retrying && usageLimit` on its first rung. When `UF_WEBHOOK_URL` is set,
one request.

```json
{
  "install": "<UF_INSTALL_LABEL, operator-chosen, optional>",
  "event": "run.needs_review",
  "run_id": "…",
  "status": "needs-review",
  "at": 1787154203942,
  "url": "<UF_PUBLIC_URL>/runs/<id>"
}
```

Signed with `X-UF-Signature: sha256=<hmac>` over the raw body using
`UF_WEBHOOK_SECRET`, the GitHub webhook shape, computed with `node:crypto`.

Three of those four variables are new. `grep -n 'optionalEnv("UF_' src/lib/config.ts`
returns `UF_AUTH_TOKEN`, `UF_ALLOW_NO_AUTH`, `UF_COOKIE_SECURE`, `UF_GITHUB_TOKEN`,
`UF_GITHUB_TOKENS`, `UF_TRANSCRIPT_CACHE_MAX_ENTRIES` and
`UF_UNMOUNTED_WORKSPACES` — **there is no `UF_PUBLIC_URL` in the tree today**, so
the deep link is a fourth new variable rather than a read of something existing.
It is also the only optional field: with it unset the notification carries a run
id and the operator opens the app themselves.

## The security argument, made explicitly

C3 asks any option that leaves the box to argue the trade. Six parts.

**What leaves: six fields, and five of them are opaque.** `run_id` is a random
handle. `status` is one of nine literals. `at` is a timestamp. `event` is derived
from `status`. The URL is the operator's own base plus that handle. The only field
carrying meaning about the operator's work is `install`, which the operator writes
themselves and may leave blank.

**What does not leave, and why the seam makes that easy.** No task text, no folder
path, no branch name, no repository name, no model, no cost, no diff. This is not
a promise this option makes — it is what `logLifecycle` already does, and its
docblock says why: it "**projects** rather than serialising the payload, and that
is the whole of why it is a function and not `JSON.stringify(e)`: `iteration`
carries the entire prompt, the creation `status` carries the folder, and
`assistant` carries the model's own output." **Attaching here inherits a data
minimisation decision that is already made, reviewed and commented.** Attaching
anywhere else — a route reading `runs`, a wrapper around `setStatus` — starts that
decision over.

The stricter standard is `src/lib/status.ts:25-27`: "no token, no branch name, no
model. A folder path here is a leak of what this install works on into whatever
scrapes it." The payload above meets it. **A "helpful" later addition of the run
title breaks it**, and a run title is model-writable text (`docs/agent/chat.md`:
prompt text is the one half of a run a model may write), so the comment forbidding
it belongs in the code beside the payload.

**The credential is a new one, and it is env-only.** `UF_WEBHOOK_SECRET`, read
through `config.ts`'s `env()` like every other credential here, never in
`settings.json`. Two reasons, both from C2. `saveSettings` "stores only what
differs from `DEFAULTS`" (`docs/agent/conventions.md`) — a mechanism for product
defaults, not a secret store. And `/api/settings` is reachable with
`UF_AUTH_TOKEN`, so a webhook target held in settings is a target that anything
holding the master key can repoint; held in the environment, it takes a container
restart, which is a decision a person makes at a shell.

**Compose renders every optional variable as `${VAR:-}`**
(`docs/agent/environment.md`), so a blank-by-default key read through `env()`
becomes a permanent warning on every stock install. Both new variables must
therefore be read the way the other optional ones are, or this option ships a
warning to every operator who never wanted a webhook. That is a real trap and it
is documented.

**The URL is a server-side request primitive.** The container's server process is
root and makes the request with the container's network access, so whoever can
write `.env` can aim a `POST` at anything the container can reach, including
`127.0.0.1`. The honest assessment: that is the same person who can already set
`UF_GITHUB_TOKEN` and start `bypassPermissions` runs against every mount, so it
adds no privilege — but it is a new outbound connection from a container that
currently makes none on a schedule, and an operator running this in a network
where egress is controlled needs to be told which host it will talk to. One
sentence in `docs/security.md`, not a mechanism.

**And the failure is silent.** A webhook that stops delivering is worse than no
webhook, because the operator has stopped checking. Mitigation is the one thing
this option must not skimp on and it costs a schema change (C11): a delivery
attempt row, bounded the way `request_log` is bounded
(`requestLog.ts:115-125`, `DELETE … WHERE id <= (SELECT MAX(id)…) - ?` on every
insert), and a count of consecutive failures on `/api/status` so the *existing*
pull-based position can alert on the push channel having died. Without that this
option is a liability; with it, it is one field on an endpoint that already has
twelve documented conditions.

## Mechanics that are not obvious

**The fetch must not be awaited in the emit path.** `emit()` is synchronous
through to `logLifecycle` (`orchestrator.ts:505-515`), and
`docs/agent/concurrency-and-ownership.md` records that `createRun` "runs from
entry to INSERT with **no `await`**. Adding one silently puts two agents in one
directory." The webhook is fire-and-forget with `AbortSignal.timeout(5_000)` and a
`.catch` that records the failure and nothing else. Getting this wrong is the one
way this option can break the run loop, and it breaks it silently.

**`fetch` is global in Node 22 and HMAC is `node:crypto`, so the dependency count
stays at four.** C4 is satisfied outright rather than argued — the only option in
this survey for which that is true and which still leaves the box.

**Terminal transitions are already enumerated.**
`TERMINAL_STATUSES = ["completed","needs-review","stopped","failed","blocked"]`
at `orchestrator.ts:3503-3515`, with a warning that five subsystems read it. The
webhook filter is a *subset* of that list and must be its own constant, not a
reuse of it: `completed` is a digest row under C1, and adding the notifier as a
sixth reader of `TERMINAL_STATUSES` is how the next person accidentally starts
paging on success.

## Coverage against the nine rows

| Row | Delivered? |
|---|---|
| 1 `needs-review` | **Yes**, promptly, and this is the row the option is shaped for |
| 4 guard trip | **Yes** |
| 5 blocked | **Yes** |
| 2 park | Yes if a park emits a `status` event with `paused` — it does. But three rungs mean up to three notifications for one run, and the third is `failed`. Needs a rule: notify on the *last* rung or on the `failed`, not on each |
| 9 restart closed runs | Yes, as N separate `stopped`/`failed` notifications, which is not the same as one "a restart happened" |
| 3 the 429 ladder | **Yes, and this is the option's one advantage over every state-based reading.** The ladder emits an `error` per rung with `retrying: true` and `usageLimit` on the payload (`orchestrator.ts:7931-7951`), and this option attaches to the bus rather than to `runs`. It needs its own filter — `retrying && usageLimit`, on the *first* rung only, or a run meeting the wall four times sends four messages |
| 6 merge queue | **No.** Not on the run bus |
| 7 halted instance | **No.** Not on the run bus, unless `workflows.ts` emits its own |
| 8 dead login | **No.** Not a run event at all |

**Six of nine promptly, including one of C1's two interrupt rows** — and the three
it misses (6, 7, 8) are the three that are not run events at all. That is a better
result than Option A's five-as-counts and a different result from Option B's
eight-from-state: this option is the only one in the survey that reaches row 3
without new plumbing, because it subscribes where the others read.

The corollary is that row 8, the dead login, is unreachable here by construction.
A subscriber cannot see a condition that never becomes an event. Covering both
interrupt rows takes a subscriber *and* a reader, which is `01-constraints.md`
C1's closing observation and the reason `11-recommendation.md` does not treat B and
C as alternatives in the long run.

## What it does not solve

**It is not a notification. It is a notification-shaped hole for somebody else's
notification.** An operator with no receiver gets nothing; the operator has to run
something at the other end. That is either the option's greatest strength — the
app never chooses a vendor, holds a vendor's token, or renders anything on a
device nobody here has tested (C9) — or a complete answer to why it does not
remove operator latency, depending on whether the receiver exists. It is honestly
both, and which one it is depends on a fact about the operator that C10 says is
not obtainable here.

## Cost

| | |
|---|---|
| Money | Zero from this app. Whatever the receiver costs |
| Code | One narrowed case in `logLifecycle`, one signer, one bounded delivery-attempt table, one `/api/status` field, two env vars, docs. Assumed 150-250 lines |
| Dependencies | **None** |
| Schema | One table, bounded on insert. Stated as a proposal per C11 |
| Leaves the machine | Six fields, five opaque, over TLS to a host the operator names |
| Credential | One new env secret, HMAC only, never a bearer in a URL |
