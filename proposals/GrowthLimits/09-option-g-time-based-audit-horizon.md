# Option G — Put `request_log` on a time horizon instead of a row cap

**Refused. The cap was chosen over an age deliberately and the docblock says
why. But the survey found something better than a refusal: G4's premise about
what fills the table is wrong, and the correction changes which install runs out
first.**

## The bound

```ts
// src/lib/requestLog.ts:68
const RETENTION_ROWS = 20_000;
```

Evicted unconditionally, immediately after every insert (`:117-121`):

```sql
DELETE FROM request_log WHERE id <= (SELECT MAX(id) FROM request_log) - ?
```

`retention.ts` never touches this table. This is the only eviction, and it is
per-write rather than per-sweep. [GapRegister G4](../GapRegister/03-growth.md)
has all of that right.

## Why the shape is not the bug

`requestLog.ts:58-67` chose rows over age on purpose:

> A cap rather than an age, because what makes this table useful is having the
> burst that happened *before* somebody noticed.

That is the correct trade for this table's purpose. A 7-day horizon on a quiet
install throws away the only interesting hour it ever had; 20,000 rows keeps it
until 20,000 more arrive. An age horizon optimises for a compliance question
("what happened last Tuesday") and a row cap optimises for an incident question
("what happened just before this"), and the second is the one an operator of a
single-tenant self-hosted box actually asks.

`docs/agent/chat.md` then makes the cap load-bearing in a second way, and
`src/app/api/mcp/route.ts:639-651` states it at the site:

> the wrapper records every request it wraps and then evicts everything past the
> 20,000-row cap, so auditing a credential-free refusal hands any caller who can
> reach this path a lever on the audit table itself — twenty thousand
> correctly-refused requests, and every line naming a run that mattered is gone.

So the cap is not just a retention policy, it is a term in a security argument
that has already been reasoned through once, and the 401 sits outside
`auditMutation` *because* of it. Changing the eviction shape means re-opening
that argument to buy an ordering the table does not want. **Refused.**

## What the survey found instead — measured

G4's rate premise is that **"a polling browser generates requests
continuously"**, and it does not. Nothing a poll does reaches this table.

```
grep -rn "recordRequest(" src/ --include=*.ts | grep -v test
  src/lib/requestLog.ts:98    export function recordRequest(...)
  src/lib/requestLog.ts:189   (inside auditMutation, the throw path)
  src/lib/requestLog.ts:205   (inside auditMutation, the return path)
```

**`recordRequest` has no caller outside `requestLog.ts`.** Every row in the table
comes through `auditMutation`, and `auditMutation` is applied at the export of
mutating handlers only:

| Method | `auditMutation` exports |
|---|---|
| POST | 20 |
| DELETE | 7 |
| PUT | 5 |
| PATCH | 1 |
| **GET** | **0** |
| | **33 wrapped exports across 26 route files** |

Plus one that is not an export: `/api/mcp`'s POST wraps itself inside the handler
(`route.ts:671`), after the capability check. **34 audited handlers over 27 route
files, and no GET among them.**

Measured by grep at HEAD, and the zero is the number that matters. The dashboard
poll, the runs list, the SSE stream, `/api/status`, `/api/usage` — the entire
surface that a growth survey would expect to fill an audit table — writes
nothing to it. `auditMutation`'s own docblock (`:164-175`) explains why it is
applied at the export rather than inside the handler, and the consequence is that
read traffic is structurally outside the table rather than filtered out of it.

## So what does fill it, and this is the part nobody has bounded

Three sources, in ascending rate.

1. **Operator actions.** Create a run, resume it, review it, land it, set it
   aside. Order 2 to 5 rows per run over its life.
2. **Chat turns.** One row per `POST /api/chat/[id]/message`.
3. **`POST /api/mcp`.** One row per JSON-RPC call — this is the 34th audited
   handler, wrapped at `route.ts:671` rather than at the export precisely so the
   credential-free 401 above it stays unaudited, and an orchestrator chat turn
   that calls ten tools writes ten rows.

**Source 3 is the rate driver and it is agent-driven, not human-driven.** That
inverts G4's blast-radius sentence in a useful way: the install that loses its
audit history first is not the one with the most browser tabs open, it is the one
using the orchestrator chat and MCP heaviest. Which is also the install whose
audit history is most worth having, because an MCP call is the one request class
a model composed rather than a person.

## How long 20,000 rows lasts — arithmetic, and honest about its inputs

Not measured. `DATA_DIR` is unreadable to the agent uid, so the live table could
not be counted, and `docs/verification.md`'s "Not yet verified by hand" list
already names "the audit trail on a real database" — so it is unmeasured by the
project too, and G4 said so.

The arithmetic that can be done here rests on one measured figure from a
neighbouring proposal and one reasoned per-item rate:

- [ContinuousImprovement](../ContinuousImprovement/README.md) measured **294
  runs** on this install, from the transcript corpus rather than the database.
- At 2 to 5 audit rows per run, 294 runs is **≈600 to 1,500 rows**, or 3% to 7%
  of the cap, across the install's whole life to date.

So on the *run* axis the cap is nowhere near reached, and the honest conclusion
is that **`RETENTION_ROWS` is not the growth limit that bites first on any axis
this proposal can see.** Whether MCP traffic changes that is unmeasured, and it
is the single reading that would move this option: it is [12-validation.md](12-validation.md)
§4.

## What is genuinely missing, and it is not retention

The table has an index for a time query it never runs — `idx_request_log_ts`
(`db.ts:1117`) — and no surface reads it. G4's real finding survives this
refusal, restated: the gap is not how long the trail is kept, it is that
**nothing shows it to anybody.** Twenty thousand rows nobody can open and 90 days
of rows nobody can open are the same gap. That belongs to
[GapRegister](../GapRegister/03-growth.md), and this proposal's contribution to
it is the mutation-only measurement above, which tells whoever builds that view
what it will contain: operator actions and model tool calls, and no page loads at
all.

## Score summary

| | |
|---|---|
| Files in `src/` to change | 2 (`requestLog.ts`, plus `retention.ts` to own a fourth sweep) |
| Argument it re-opens | the `/api/mcp` 401's placement outside `auditMutation` |
| Measured occupancy | **not measurable here** — `DATA_DIR` unreadable |
| Arithmetic occupancy at 294 measured runs | 3-7% of the cap |
| G4's rate premise | **refined** — polls write no rows; `POST /api/mcp` is the driver |
| Verdict | **refused**, with one measurement handed to validation |
