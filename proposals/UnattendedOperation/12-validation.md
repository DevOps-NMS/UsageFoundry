# Validation

What would count as this survey having been wrong, and how to check it. Eleven
checks: eight are commands, three need a person or a running install.

## The commands, and what they returned when this was written

Run from the repository root. Each is a claim in this proposal, phrased so that a
different answer falsifies it.

```sh
# 1. The install-wide fan-out exists and has no consumer.
grep -n 'bus.emit("\*"' src/lib/orchestrator.ts          # 1 hit, :513
grep -rn 'subscribe("\*"\|subscribe(`\*`' src/            # 0 hits
```
Returned: `513:  bus.emit("*", published);` and nothing. If a consumer appears,
`03-option-b`'s "cheapest correct answer to C5" loses its cost argument.

```sh
# 2. There is no service worker and no Push API use.
grep -rn "serviceWorker\|navigator\.serviceWorker" src/   # exit 1
grep -rn "PushManager\|showNotification\|Notification(" src/  # exit 1
find src public -name 'sw*.js' -o -name 'sw*.ts'          # empty
```
All three as stated. **And the counter-check, which is the one the brief asked
for:** `find . -path ./node_modules -prune -o -name 'manifest*' -print` under
`src/` finds `src/app/manifest.ts`. The brief's premise that there is no web
manifest is wrong; only the service worker is absent.

```sh
# 3. The 429 ladder emits, and the projection drops what identifies it.
sed -n '7931,7951p' src/lib/orchestrator.ts   # emit({kind:"error", … retrying, usageLimit})
sed -n '566,568p'   src/lib/orchestrator.ts   # opsLog("error","run.error",{run_id,message})
```
This is the check that **caught an error in an earlier draft of this proposal**,
which asserted the ladder emitted nothing. It emits; it does not change status; and
the two booleans that distinguish it are dropped by `logLifecycle`. Anyone
re-reading this survey should run this one first.

```sh
# 4. needs-review is on the status wire and nowhere in the README.
grep -n "RunStatusCounts" -A 2 src/lib/status.ts     # Record<string, number>, "every state"
grep -c "needs-review" README.md                     # 0
```
`README.md:236-249` lists twelve alertable conditions and neither
`runs["needs-review"]` nor `runs.blocked` is among them — and the second grep
returns **0**, so the string does not appear in the README at all. The status is on
the wire (`status.ts:29-30`, docblock: "every state, so the numbers add up to the
row count") and unmentioned in the document that tells an operator what to watch.
If a future README adds it, step 1 of the recommendation is already half done.

```sh
# 5. needs-review renders in the history table, not the attention band.
sed -n '32,91p' src/app/runs/page.tsx     # ACTIVE, ACTIVE_ORDER, REOPENABLE
```
`ACTIVE` is `running`/`queued`/`paused`/`waiting`. If `needs-review` is added to
it, `02-option-a`'s second objection disappears and Option B's value drops.

```sh
# 6. The sidebar is capped at nine panes.
grep -c 'shortcut: "' src/components/shell/panes.ts   # 9
```
Nine, with shortcuts 1-9 and a docblock saying nine is the ceiling. A tenth entry
would change Option B's and Option G's shape, not their score.

```sh
# 7. /api/mcp is reachable only by a per-turn capability.
sed -n '94,99p' src/app/api/mcp/route.ts
sed -n '58,70p' src/middleware.ts
```
If a long-lived credential ever reaches this route, Option H1 stops being a
security-design change and becomes a forty-line tool.

```sh
# 8. The verification loop on this tree.
npm run typecheck && npm test
```
`typecheck` exit 0; `npm test` 1,578 tests / 230 suites / 0 failures in 16.6 s at
`b1acfec`. **This proposal changes no `src/`, so a red tree here would be somebody
else's change, not this one's.**

## The three checks that need something this container does not have

**A number for how often any of the nine rows occurs.** `ls -la /data` returns
`Permission denied`; `SELECT COUNT(*) FROM runs` on the stale in-checkout copy
returns 0; `ops_events` holds one row. This is the survey's largest hole and it is
`11-recommendation.md`'s second falsifier. The check is one query on a real
install:

```sql
SELECT status, COUNT(*) FROM runs GROUP BY status;
SELECT COUNT(*) FROM run_events WHERE kind='error' AND payload LIKE '%"retrying":true%';
```

The second of those is the one nobody has ever run and the one that would most
change this survey: it counts how often the 429 ladder has fired, which is the
frequency behind the highest-weighted criterion in `10-comparison.md`.

**One answer from the operator.** Step 3 of the recommendation: do you have, or
will you run, something that receives an HTTP POST? If no, step 4a is worthless and
step 4b is the whole recommendation. No amount of code reading settles it.

**A browser at 390px.** `docs/verification.md:1113-1250` owns this, prescribes the
reading and has never had it done — C9, and
`proposals/OperatorInterface/10-option-i-narrow-viewport.md` handed the same
question back. `08-option-g`'s premise that the operator's phone is already a
usable surface is **assumed** until somebody looks.

## What would count as this survey having failed

Not "the recommendation was not built". Four specific failures:

1. **A tenth row.** The endings table claims to be the complete set of states that
   need a person. If somebody names a wait it misses — a schedule that silently
   stopped firing, an isolation slot exhausted, an OTLP exporter refusing — then
   `00-problem.md` is incomplete and every option's coverage number is wrong.
2. **A row's "what it holds" column being wrong.** Row 2's claim that a `paused`
   run reserves its folder rests on `activeRuns()` including `paused`
   (`orchestrator.ts:2628-2634`). Row 5's claim that a `waiting` run holds nothing
   rests on `docs/agent/dependencies.md`. Both are load-bearing for C1's
   interrupt/digest split, so an error in either re-scores criterion 1.
3. **A webhook being built without the failure counter.** `04-option-c`'s central
   condition is that a dead channel announces itself on `/api/status`. Shipped
   without it, the option is a liability, and this survey will have caused the
   thing it spent a page warning about.
4. **An "acknowledge all" button appearing on the digest.**
   `docs/agent/run-lifecycle.md:48` forbids it, `03-option-b` predicts the request,
   and if it lands anyway the prediction was not written prominently enough.

## One thing this survey deliberately did not check

Whether an outbound `POST` from this container reaches the public internet at all.
No egress test was run, and no external host was contacted from this work cycle —
so `04-option-c`'s and `07-option-f`'s delivery is **assumed** to be possible from
a deployed container. The first thing to do when building step 4a is a `POST` to a
local listener and then to a real endpoint, in that order, because the second may
fail for reasons that have nothing to do with the code.
