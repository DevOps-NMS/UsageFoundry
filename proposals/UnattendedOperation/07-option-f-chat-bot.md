# Option F: a bot in a chat channel the operator already reads

Slack, Discord, Telegram or Matrix. The largest latency reduction per line of code
in this survey, and the largest content leak per notification. Both for the same
reason.

## It is not a separate option. It is a receiver for Option C.

An incoming webhook to Slack or Discord is a `POST` of a JSON body to a URL the
operator pastes in. The Telegram Bot API is a `POST` to
`api.telegram.org/bot<token>/sendMessage`. Matrix is a `PUT` to a homeserver room
endpoint. **Every one of them is Option C with the payload shape fixed by the
vendor and a formatter in between**, and `fetch` is global, so the dependency count
stays at four.

That framing is the right one and it changes what this file is for. The
implementation question — how does a message get out — is answered in
`04-option-c-outbound-webhook.md` and is not re-argued here. The two questions
this file owns are whether the destination should be a chat channel, and whether
the bot should be able to answer back.

## Why the destination is good: the notification stack already exists and is trusted

Every other option in this survey has to build or buy the last mile. Option C
requires the operator to run a receiver. Option D requires a service worker, RFC
8291 encryption, a permission prompt and an exposed app. Option E requires
deliverability. **Option F requires none of it**, because the operator's phone
already has the app installed, already has notifications permitted, already has a
do-not-disturb schedule they have tuned, already threads and mutes and searches,
and — this is the part that matters most — the operator already looks at it
without being prompted.

That is the honest answer to the brief's question about "how much operator latency
it actually removes". For the two interrupt-shaped rows under C1, this option
removes essentially all of it, at a cost of one `fetch` and a template string. No
other option comes close on that ratio.

And a chat channel is natively a **digest** medium as well as an interrupt one:
messages accumulate in a scrollback, which is exactly what
`/workspace2/3 Resources/Debugging and Observability/SLOs and Error Budgets.md`'s
frame wants for the seven digest rows — visible when looked at, not demanding when
not.

## Why the destination is bad: the message is permanent, searchable and not only the operator's

`06-option-e-email.md` established that a digest must carry content to be useful.
A chat channel makes that worse in three specific ways an email to oneself does
not.

**It persists indefinitely and is indexed.** A Slack workspace retains message
history by default and it is searchable by every member. A year of "run on
`Xapicc/UsageFoundry` needs review: *rewrite the billing reconciliation*" is a
searchable log of what this organisation builds and when.

**It has other readers.** A workspace has members and an admin, and admins can
export. Unlike an email to one's own mailbox, the operator is not the only party
to the disclosure and may not be the party who decides retention.

**The vendor's terms govern it, not the operator's.** `docs/agent/security.md`'s
whole posture — three defences resting on the server being root and every child
not, path containment checked twice, a credential scoped by host and by child, a
notice that must contain no matchable literal — is a posture about a machine the
operator controls. Nothing in it reaches a message in somebody else's database.

**The credential is a bearer in a URL and cannot be signed.** Option C's HMAC
protects the receiver from a forged sender. A Slack incoming webhook URL *is* the
authorisation: whoever holds it can post to that channel. So this option's secret
is one that cannot be HMAC'd, must be env-only per C2, and — worse — appears in an
outbound URL rather than a header, which is exactly the shape
`docs/agent/security.md` avoids everywhere else (the chat capability token is
compared constant-time "rather than looked up by key: a `Map.get` on a secret leaks
its prefix through timing"). Leaking it lets a stranger post noise into the
operator's channel, which is low harm, and tells them which workspace this install
belongs to, which is not nothing.

The mitigation is the same one Option E needs: **default to the content-free
form.** "A run on this install needs review" plus a link is a complete interrupt
and leaks a timestamp. Titles are an opt-in, and the default is the useless one.

## The refusal inside this option: the bot must not be able to answer

The obvious next step is interactive — a Slack message with **Reopen** and
**Dismiss** buttons, or `/uf reopen abc123`. **Refused, by name, on three
grounds.**

**C2.** An inbound path needs a credential, and it may not be `UF_AUTH_TOKEN`,
which "opens every route in the app, including the ones that spawn billed
children". A Slack interaction endpoint is an unauthenticated public URL
authenticated by the vendor's own request signature — a fourth credential shape
this app does not have, verified against a secret held for a third party, on a
route that would have to be exempt in `middleware.ts`, whose five exemptions each
"stay paired with the check that stands in for them". That is a serious piece of
security work to save one page load.

**C8.** `docs/agent/run-lifecycle.md:48`: "A control that acts on twenty-five runs
at once must not answer the one ending whose entire content is *a person is being
asked to look at this*." A button in a notification is a control that answers an
ending without the operator having seen the run. It is worse than the bulk control
that invariant refuses, because at least the bulk control is on a page listing what
it will act on.

**The app has already decided this pattern.** `docs/agent/chat.md`: the
orchestrator chat can *propose* a run, and "approval takes the explicit list of ids
the page displayed, in one synchronous pass". The MCP surface's write tools are
`propose_run`, `propose_workflow`, `save_template` — proposals, approved on a page.
A chat-channel button is the same actor with the same authority and no page. The
existing decision is not "chat is untrusted"; it is "a decision is taken where the
operator can see what they are deciding about".

**Notify-only is therefore not a limitation of this option. It is the option.**

## Coverage against the nine rows

Identical to Option C — six of nine promptly (rows 1, 2, 3, 4, 5, 9), and rows 6,
7 and 8 unreachable because none of them is a run event. Attaching to the same
seam gets the same coverage; what differs is whether it arrives on the operator's
phone, and here it does.

## Cost

| | |
|---|---|
| Money | Zero, on any of the four platforms at one operator's volume |
| Code | Option C's plumbing plus a formatter. Assumed 30-60 lines on top of C |
| Dependencies | **None** |
| Schema | Option C's delivery-attempt table, shared |
| Leaves the machine | At the default: a status literal, a run id, a timestamp, and the fact that this install exists — into a third party's permanent searchable store. At the opt-in: task titles as well |
| Credential | One webhook URL or bot token, env-only, unsignable, and it is itself the authorisation |

## Verdict

**Recommended as Option C's default documented receiver**, not as a distinct
mechanism. The right shape is that the app ships a webhook and the documentation
shows the three lines of Slack, Discord and Telegram configuration, so the
operator chooses the vendor and the app never holds one. Whether the app should
*also* contain per-vendor formatters is the one open question, and
`10-comparison.md` scores it as a small positive: a Slack-shaped body from a
generic webhook is a wall of JSON, and a formatter is what makes the difference
between a notification the operator reads and one they mute.
