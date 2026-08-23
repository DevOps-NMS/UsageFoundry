# Unattended operation

**The question:** this app's premise is that a run works while nobody watches.
Nothing it produces reaches an operator who is not looking at the page. What
should, by what route, and what does each route cost — in money, in code, and in
what leaves this machine?

**The state:** open. Nine endings and waits enumerated from the code, eight
options scored, one recommendation in four ordered steps, four options refused by
name and one handed back to the document that owns it. **Nothing here is a
decision and no product code changed.**

## The recommendation

**Four steps, in order, and the first two are almost free**,
[11-recommendation.md](11-recommendation.md).

1. **Level the stdout lines**, and add the two conditions `README.md`'s alert
   table is missing. `logLifecycle`'s `status` case is one `info` line for all
   nine statuses (`orchestrator.ts:544-546`), so `needs-review`, `blocked`, a
   park and an ordinary `completed` are byte-indistinguishable in level to any
   log shipper. `grep -c "needs-review" README.md` returns **0**.
2. **Project the two booleans the 429 ladder already carries.** It emits an
   `error` event per rung (`orchestrator.ts:7931-7951`) with `retrying: true` and
   `usageLimit`, and `logLifecycle:566-568` drops both. Two fields on an existing
   call make the most expensive wait in the app filterable. Best ratio in the
   survey.
3. **Ask the operator one question**: do you have, or will you run, something
   that receives an HTTP POST? It decides the fourth step and nothing in the code
   can settle it.
4. **If yes, Option C** — one notifier beside `logLifecycle`, six fields,
   HMAC-signed, `fetch` is global so the dependency count stays at four, with
   Option F's chat channels documented as receivers and the app never holding a
   vendor's token. **If no, Option B** — the in-app digest, an SSE consumer of the
   `bus.emit("*")` that already fires and has no reader.

**What would overturn it:** the answer to step 3, and the ending mix on a real
install. If runs reach `needs-review`, park or block rarely and mostly in office
hours, step 1 is the whole of what is earned. `ls -la /data` returns
`Permission denied` and the stale in-checkout database has zero `runs` rows, so
**every latency claim in this proposal is a mechanism claim, not a measurement**.

**Refused by name:** web push (four grounds, with the condition that flips it),
email as a default, an MCP tool as scoped, the orchestrator chat on arithmetic,
and — inside the recommended step — a chat bot that can act.

## The findings at a glance

| | |
|---|---|
| Endings and waits enumerated | **9**; the brief named eight, and row 9 was forced by the evidence |
| Of those, with any route to a person other than opening a page | **0** |
| Reaching stdout at all | 6 of 9. Rows 6, 7 and 8 are not run events |
| With a stdout level *and* an identity a log router can act on | **1** — the guard trip, `opsLog("warn","run.guard_tripped",{code,disposition,reason})` |
| With no clock on them | 7 of 9, and for one of those being unbounded is a documented invariant |
| Holding a folder, a worktree slot and one of `maxConcurrentRuns` while they sit | **2** — the refusal park and the 429 ladder |
| Install-wide event fan-outs already emitted | **1** (`orchestrator.ts:513`), with **0** consumers anywhere in the tree |
| Options scored | 8, across 9 weighted criteria, maximum 165 |
| Options scoring 5 on the highest-weighted criterion | **0** |
| Runs whose history could be read | **0**. `DATA_DIR` is `Permission denied`; the stale copy holds zero `runs` rows and one `ops_events` row |
| Browsers driven, providers contacted, notifications delivered | **0**, **0**, **0** |

Full evidence, with the table: [00-problem.md](00-problem.md).

## The three findings that shape everything else

**The two interrupt-shaped rows need opposite mechanisms.** This is
[01-constraints.md](01-constraints.md) C1, argued from
`/workspace2/3 Resources/Debugging and Observability/SLOs and Error Budgets.md`,
and it is why nothing scores full marks on the criterion that matters most. The
429 ladder leaves no state and is only reachable by *subscribing*; the dead
login leaves no event and is only reachable by *reading*. A subscriber gets row 3
and misses row 8. A reader gets row 8 and misses row 3.

**The app is best at reporting the waits that are cheapest to wait through.**
Rows 1, 4, 5 and 9 hold nothing but the operator's attention and all have a
status the UI renders. Rows 2 and 3 hold a folder, a worktree slot and a
concurrency slot; row 3 has no status at all, so it reads `running` in `/runs`'s
bands, in `/api/status`'s counts and in any digest assembled from state, for the
whole ~17-26 minutes. The mechanism behind that inversion is simply that the
cheap waits are the ones that changed a row in `runs`.

**Six of nine weighted criteria measure cost avoided, and they sum to 20 of 33.**
Which is why [02-option-a-change-nothing.md](02-option-a-change-nothing.md) tops
the table at 124 against B and C tied at 121, and why the recommendation does not
take the table's top row: the null's margin is smaller than the measurement error
in the scores and is made entirely of costs avoided, while it is worst at the
thing being surveyed. [10-comparison.md](10-comparison.md) §1 says so before
anything else.

## What already exists to build on

Recorded because it is why three options are cheaper than they sound and one is
not an option at all.

- **`emit()` already fans out install-wide, after the durable write.**
  `bus.emit("*", published)` at `orchestrator.ts:513` has no consumer anywhere;
  `subscribe()` at `:690` takes a string and would accept `"*"` unchanged. The
  persist-then-publish order means a notifier that crashes loses a notification,
  never an event.
- **`logLifecycle` is a projecting sink whose docblock has already made this
  survey's security argument** — it "**projects** rather than serialising the
  payload" because "`iteration` carries the entire prompt, the creation `status`
  carries the folder, and `assistant` carries the model's own output". Anything
  attaching there inherits a data-minimisation decision somebody has already
  taken.
- **The designed position is pull-based and it covers five of the nine rows.**
  `/api/status` behind `UF_STATUS_TOKEN`, `/api/health` unauthenticated and
  bounded to counts, and twelve documented alertable conditions. C12 checks it
  row by row: rows 1, 2, 4, 5 and 9 yes, rows 3, 6, 7 and 8 no.
- **The PWA install path exists and the brief's premise about it is wrong.**
  `src/app/manifest.ts` is a real installable manifest with maskable icons and
  `display: "standalone"`. There is no service worker and no Push API use
  anywhere in `src/`. The brief asked for this to be checked rather than trusted;
  it was, and only half of it held.

## What this survey could not do

- **Read any run history.** `ls -la /data` → `Permission denied`;
  `SELECT COUNT(*) FROM runs` on the stale in-checkout copy → **0**;
  `run_events` → 0; `ops_events` → one row, a `boot.reconciled` with
  `{"closed":2,"kept":0}`, which is n = 1 and is not a rate. So there is no
  parking frequency, no ending mix, no queue depth and no dwell time anywhere in
  this proposal, and every option file says so where its case depends on one.
- **Deliver a notification of any kind.** No provider was contacted, no webhook
  fired, no push endpoint called, no email sent. Nothing here has been seen
  working.
- **Open a browser at any viewport.** Which is why
  [08-option-g](08-option-g-narrow-viewport-status-page.md) hands its question
  back to `docs/verification.md:1113-1250` rather than scoring it.
- **Test whether an outbound `POST` from this container reaches the internet at
  all.** Deliberately not run, and named as such in
  [12-validation.md](12-validation.md), because it is the first thing to check
  when building step 4a and it may fail for reasons unrelated to the code.

## Files

| | |
|---|---|
| [00-problem.md](00-problem.md) | The nine-row endings-and-waits table — how the operator learns, how long it can sit, what it holds — plus what exists to build on and every number that could not be obtained |
| [01-constraints.md](01-constraints.md) | C1 to C12. C1 is the interrupt-versus-digest split and the finding that the two interrupt rows need opposite mechanisms |
| [02-option-a-change-nothing.md](02-option-a-change-nothing.md) | The null at its strongest — it tops the weighted table — and the two things it should absorb |
| [03-option-b-in-app-digest.md](03-option-b-in-app-digest.md) | **Recommended if the operator has no receiver.** A badge and a section, not a tenth pane; SSE rather than a poll; a read, never a control |
| [04-option-c-outbound-webhook.md](04-option-c-outbound-webhook.md) | **Recommended if they do.** Six signed fields beside `logLifecycle`, and the only option that reaches the 429 ladder |
| [05-option-d-web-push.md](05-option-d-web-push.md) | Refused on four independent grounds, with the condition that would flip it |
| [06-option-e-email.md](06-option-e-email.md) | The survey's sharpest trade: an interrupt can be content-free, a digest cannot |
| [07-option-f-chat-bot.md](07-option-f-chat-bot.md) | Not a separate option — a receiver for Option C. Largest latency reduction per line, largest content leak, and the interactive form refused by name |
| [08-option-g-narrow-viewport-status-page.md](08-option-g-narrow-viewport-status-page.md) | Handed back to `docs/verification.md`; its contribution is that Option B's badge is also the phone answer |
| [09-option-h-mcp-and-orchestrator-chat.md](09-option-h-mcp-and-orchestrator-chat.md) | H1 filed as a security question for a person; H2 refused on arithmetic; and what `emit_runs` already does with no approval step |
| [10-comparison.md](10-comparison.md) | Nine weighted criteria, justified before the scores, and four places the table misleads |
| [11-recommendation.md](11-recommendation.md) | Four steps, five refusals by name, and two falsifiers |
| [12-validation.md](12-validation.md) | Eight commands with their returns, three checks needing something this container lacks, and four specific ways this survey could have failed |

## Neighbours

[GapRegister](../GapRegister/) row **M3** proposed filing an issue for "one
outbound webhook firing the ten stdout lifecycle events"
([06-recommendation.md:154](../GapRegister/06-recommendation.md)). **This survey
supersedes that scope and does not overturn the row.** M3 was right that the gap
is real, right that `README.md`'s pull-based position should not be replaced, and
right about the mechanism. Two things it could not know without the table in
[00-problem.md](00-problem.md): a webhook reaches six of the nine rows and misses
the one that *compounds* — the dead login, which no event-attached channel can
see — and firing on all ten stdout events includes `run.cycle_finished`, which
C1 classifies as a digest item, so the scoped version fires on four statuses and
one payload condition from its own constant. The issue M3 asked for should
therefore be two: the projection repairs in steps 1 and 2, which are cheaper than
the webhook and do not depend on the operator's answer, and then the webhook
itself conditional on step 3.

[OperatorInterface](../OperatorInterface/) owns the narrow-viewport question
through its [Option I](../OperatorInterface/10-option-i-narrow-viewport.md), and
this survey's Option G hands the same question to the same place rather than
scoring it twice. Its finding that the app's keyboard path is already engineered
and only its colours fail is the reason Option B's badge is a colour-and-copy
change rather than a component: `Notice` is on 14 pages already.

Neither of those two proposals is edited by this one beyond these
cross-references, and neither of their central findings is re-derived here.

Verification loop on the tree this was written against (`b1acfec`):
`npm run typecheck` exit 0; `npm test` 1,578 tests / 230 suites / 0 failures in
16.5 s. **This proposal changes
no `src/`**, so a red tree here would be somebody else's change, not this one's —
and green tells you nothing about any of it, since there is no linter, no browser
driver and nothing in this repository that has ever delivered a notification.
