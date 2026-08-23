# Option D — Page the run and chat lists

**The one ceiling this install has already gone past, and it belongs to
[GapRegister](../GapRegister/03-growth.md). Scored here because a growth survey
that omitted it would be dishonest; handed back rather than re-derived.**

## Confirmed unchanged at HEAD

`src/app/api/runs/route.ts:50` is still `const rows = listRuns(100);`. The
handler signature is now `GET(req: Request)`, which looks like a change and is
not — `req` is used only by `jsonMaybeGzipped(req, …)` at `:100`, and the file
contains no `searchParams` at all:

```
grep -n "req\b\|searchParams" src/app/api/runs/route.ts
  49: export async function GET(req: Request) {
  50:   const rows = listRuns(100);
 100:   return jsonMaybeGzipped(req, { runs, lastBootReconcile });
 172: async function postHandler(req: Request) {
 173:   const body = (await req.json()...
```

`listChats(limit = 30)` (`chat.ts:289`) called with no argument, and
`MAX_REMOTES_READ = 25` (`workspace.ts:168`, applied `:188`) are likewise
unchanged. All three are GapRegister G1 and G2, verbatim.

## Why it is the soonest-hit ceiling in the survey

Because it is not "soonest". It is **past**.

`proposals/README.md` records that
[ContinuousImprovement](../ContinuousImprovement/README.md) measured "two
ending-level failures in **294 runs**" and a `Read`-call corpus across runs on
the same repository. That figure was taken from the transcript corpus, not from
the database, so it is readable evidence of an install that has done nearly three
times what its own list route will show. **This install cannot see two thirds of
its own history through its own API.**

That is a growth limit reached, on the axis the brief asked about, with a number
behind it. It is also the only one.

## What the repository already contains

Two working implementations of the fix, both cited by GapRegister G1 and both
re-verified here:

- **`/api/branches`** takes `repo`, `offset` and `limit`
  (`src/app/api/branches/route.ts:25-40`), treats a blank `repo=` as every
  repository, and carries its own measurement in a comment: "254,752 bytes to
  75,613, measured".
- **`/api/knowledge/search`** is a real parameterised search — `?q=` over title,
  alias, tag and path, `?limit=` defaulting to 50 and capped at 200
  (`src/app/api/knowledge/search/route.ts:9-19`).

GapRegister's sentence on that is the whole argument and this proposal will not
improve on it: the repository contains a working, parameterised, capped search
implementation, and it is pointed at the operator's vault rather than at the
operator's own runs.

## What this proposal adds to it, and it is one number

The `/api/runs` route now carries a **measurement of the response it is
capping**, added since GapRegister was written:

> `src/app/api/runs/route.ts:55` — `budget` and `agent` are "37KB between them
> over a hundred rows, measured … and neither the runs list nor quick open reads
> either"; `:78` — the prompt clip accounted for "522,541 bytes of a
> 696,197-byte response"; `:66` — `needs_review_reason` "measured as free above
> only because that capture held no `needs-review` rows, and a fleet that ends
> that way puts ~200KB back on a four-second poll."

**A measured 100-row response was 696,197 bytes, and the prompt field alone was
522,541 of them — 75%.** That changes the shape of the paging argument in a way
worth recording: the reason to page this route is no longer payload size,
because somebody has already removed the three fields that made up most of it.
It is **reach**. Which is what GapRegister said, and the size objection to paging
has since been dissolved by an unrelated change.

## Why it is not this proposal's recommendation

**It is owned, ranked and already recommended elsewhere.**
[GapRegister's recommendation](../GapRegister/06-recommendation.md) makes
reachability its **first** survey of three, on the grounds that "nine of the
twenty rows are one sentence — the app cannot find what it has already done".
Recommending it again here would be a second vote by the same voter, and
`proposals/README.md`'s own framing — a proposal "surveys one question" —
suggests the right move is to strengthen the existing row rather than open a
competing one.

**And its axis is not the one the brief asked about.** "More concurrent runs,
more repositories, more months of history" is a question about resource
exhaustion. This is a question about a UI's window onto a database. The two
share the word "growth" and nothing else: no ceiling is approached, no memory is
consumed, no walk truncates. What breaks is that an operator cannot find
something, and the thing they cannot find is fine.

## Cost, for the comparison table

| | |
|---|---|
| Files touched | 3 routes, 3 DTO readers, and the two pages that render the lists |
| Precedent to copy | 2, both in-tree and both measured |
| New dependencies, schema changes | 0, 0 |
| Blocked on anything | no |
| Owned by | [GapRegister](../GapRegister/03-growth.md) G1, G2, F1, F2, B5, and #78's `/api/runs` row |
