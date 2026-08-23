# Option E: email

A daily digest to one address, listing everything awaiting a decision. Under C1
this is the *right shape for seven of the nine rows* — and it carries the survey's
sharpest trade, which is that a digest's usefulness is proportional to how much it
leaks.

## The trade, first, because it decides the option

An **interrupt** can be content-free. "A run on this install needs you" plus a
link is a complete interrupt: the operator opens the app, which is authenticated,
and the content never leaves the box. Option C's payload is six fields and five
of them are opaque, and it loses nothing by that.

A **digest** cannot be content-free. "Nine things await a decision" is not a
digest, it is a badge, and Option B already renders it for free inside the app.
For an email at 08:00 to be worth reading it must say *which* nine — which means
run titles, which means the prompt text that `docs/agent/chat.md` records as "the
one half of a run a model may write", plus branch names for the merge-queue rows
and repository names to disambiguate. A useful digest email is a daily export of
what this install works on, in plaintext, to a mailbox.

So the two halves of C1's split invert on C3:

| | Interrupt | Digest |
|---|---|---|
| Content needed to be useful | A link | Titles, branches, repositories |
| What leaves the box | Opaque handles | The work log |
| Right channel under C1 | Rows 3 and 8 | Rows 1, 4, 5, 6, 7, 9 |

**Email is the correct medium for the wrong half of the leak.** That is not a
refusal on its own — an operator may be entirely happy sending their own task
titles to their own mailbox — but it must be a stated, configured choice rather
than a default, and the honest form of this option is therefore two settings: a
`UF_DIGEST_DETAIL` of `counts` or `titles`, defaulting to `counts`, where the
default is deliberately the near-useless one.

## Mechanics

**Two delivery routes, and both are bad in different ways.**

*SMTP.* This is **the one channel in the survey with no zero-dependency route.**
C4's arithmetic: `fetch` is global so a webhook needs nothing, and `node:crypto`
covers push, but there is no SMTP client in Node's standard library. Either a
dependency — which is a change to a documented four-package standing decision
(`proposals/OperatorInterface/01-constraints.md` §C5: "an option proposing a
dependency is proposing to change a standing decision") — or a hand-written SMTP
conversation over `node:tls` with `AUTH LOGIN`, `STARTTLS` negotiation and
line-ending correctness. The second is worse than the first, and worse than
Option D's crypto, because it is protocol code whose failure mode is a hung socket
rather than a wrong answer.

*An HTTP API provider.* Needs no dependency — one `fetch` to Resend, Postmark or
SES. Needs an account, an API key at rest in the environment, a recurring bill
(small: assumed free tier for one operator's volume, unverified since no provider
was contacted), and the message body transits the provider's infrastructure in
plaintext and sits in their logs. Against Option D's RFC 8291 encryption this is
the weaker position on content and no better on metadata.

**Deliverability is the silent failure this survey keeps finding.** An email that
lands in spam is indistinguishable, from the operator's side, from an install with
nothing to report. This is worse than Option C's dead webhook because a webhook's
failure is a non-2xx the app can count; a spam-foldered email is a 202 Accepted.
Mitigating it needs SPF, DKIM and DMARC on a domain the install may not have, and
none of that is code this repository can contain.

**It needs a schedule, and this app's scheduler does not schedule this.**
`ScheduleSpec` is `{everyHours,hours,anchorAt} | {daily,minutes} | {weekly,weekday,minutes}`
with `FIRE_GRACE_MS = 2*60_000`, and `schedules.ts` attaches schedules to
**workflows only** — `scheduleRefusal(workflow)` is the door. A daily digest is
either a second scheduler (a `setInterval` beside `SWEEP_MS`'s at
`orchestrator.ts:8491` and the live guard's at `:8424`, which is the established
shape) or a widening of `schedules.ts` to schedule something that is not a
workflow. The first is right and is genuinely small; the second would be a real
mistake and is worth naming so nobody proposes it.

**And it needs Option B's server-side assembly regardless.** Nine reads across
`runs`, `mergeQueue`, `workflows` and `claudeAuth` — the same function
`03-option-b` describes. This option is a *renderer* of that function, not an
alternative to it.

## Coverage against the nine rows

All nine, at up to 24 hours of latency, and that is its unique property: the
digest is assembled from state rather than from events, so rows 6, 7 and 8 — which
no event-attached option reaches — are simply `SELECT`s. Row 3 remains invisible
because it leaves no state either, but a digest can say something no other option
can: *this run has been running for 2h with no cycle finishing*, which is the
observable shadow of a 429 ladder.

That last point is worth isolating, and then discounting. A state-based digest can
detect row 3 by inference — a run running for two hours with no cycle finishing —
where nothing else reading `runs` can. But it detects it a day late, which is
useless for a ~26-minute wait, and Option C detects it *directly* and immediately
by subscribing to the `error` event the ladder already emits
(`orchestrator.ts:7931-7951`). So the inference is a curiosity rather than an
advantage.

## Cost

| | |
|---|---|
| Money | A provider account, assumed within a free tier for one operator (unverified — no provider was contacted for this survey), or an SMTP server the operator runs |
| Code | Option B's assembly function, a renderer, a `setInterval`, one env-configured recipient, plus either a dependency or a hand-written SMTP client |
| Dependencies | **One**, or protocol code instead. The only option here that cannot avoid the choice |
| Schema | None, if it is stateless per send. A "do not repeat yesterday's items" rule needs one column |
| Leaves the machine | At `counts`, four integers. At `titles`, the install's work log daily, in plaintext, to a third party |
| Credential | One API key or SMTP password, env-only per C2 |

## Verdict

**Not recommended, and not refused.** It is the best-shaped option for the seven
digest rows and the worst-positioned on C3 and C4 simultaneously — the only one
that cannot avoid a dependency question and the only one whose usefulness requires
sending task text off the machine.

If an operator wants this, the version to build is `counts` by default with
`titles` as a deliberate opt-in, over an HTTP provider rather than SMTP, and it
should be built *after* the assembly function exists for another reason. That
ordering is the recommendation's, not this file's.
