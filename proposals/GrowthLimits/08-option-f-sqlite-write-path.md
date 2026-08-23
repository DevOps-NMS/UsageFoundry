# Option F — Harden the SQLite write path for concurrency

**Refused. Both of the two failure modes the literature warns about have a
precondition, and neither precondition exists in this tree — one of them
provably.**

This is the option the brief's mention of "`journal_mode = WAL` with
better-sqlite3's synchronous single-process writes (`src/lib/db.ts:118`) against
25 runs, 56 route handlers, the SSE bus and the poll fan-out" points at, and it
is the option most likely to look correct to a reviewer who has read the right
books. It is wrong here, and the reason is specific.

## What the write path is

```ts
// src/lib/db.ts:114-121
const db = new Database(DB_PATH);
// WAL keeps the dashboard's frequent reads from blocking on run writes.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
```

Two pragmas, and no `synchronous`, no `busy_timeout`, no `wal_autocheckpoint`.
56 route handlers (`find src/app/api -name route.ts | wc -l` → 56), one process,
one handle on `globalThis`.

## Failure mode 1: a contended write stalls the event loop for 5 seconds

The literature is unambiguous and this is the strongest version of the argument.
`/workspace2/3 Resources/Service Runtime/Blocking the Event Loop.md`:

> `better-sqlite3` sets a **5000 ms** busy timeout by default, and it is a
> synchronous binding. One contended write that waits out that timeout is
> $\lambda B = 200 \times 5 = \mathbf{1{,}000}$ requests queued behind a single
> call, the last of them waiting five seconds, with no error raised anywhere and
> no server timeout tripped.

And `/workspace2/3 Resources/Data and Storage/SQLite Concurrency and Locking.md`
gives the mechanism: `busy_timeout` "is not a queue, so it grants no fairness and
no ordering", and "in a synchronous binding it blocks the calling thread". Both
notes agree, and the second adds the fix — `BEGIN IMMEDIATE` for anything that
will write, which "relocates the entire contention window to one statement where
waiting is legal".

**The precondition is a second connection.** The vault note is explicit that
`SQLITE_BUSY` (5) means "another **connection** holds the write lock", that
`SQLITE_LOCKED` (6) is a program defect rather than contention, and that
`SQLITE_BUSY_SNAPSHOT` (517) is a deferred transaction upgrading after another
connection wrote. All three require two connections.

This app has one, by design and by enforcement. `db()` returns a single
`globalThis`-pinned handle; a second *process* that does not own `DATA_DIR`
**refuses to write at all** — `promoteQueued` returns early on
`!mayWriteDataDir()` (`orchestrator.ts:3416`), `docs/agent/concurrency-and-ownership.md`
makes "every writer asks the lock at the moment of the write" an invariant, and a
second replica gets the `ReadOnlyNotice`. `db.ts:105-111` even declines to
*migrate* a directory another process holds: "migrations belong to the process
that owns this directory."

So the second writer that produces `SQLITE_BUSY` is the thing the server lock
exists to prevent, and #68 already measured the timeout at 5000 ms and correctly
recorded it as "**Not a gap.**" Setting `busy_timeout` lower, or converting
transactions to `BEGIN IMMEDIATE`, would be defending against a state whose
existence is a separate bug — and if that bug ever occurs, a shorter timeout
converts a stall into an error on a path that has no retry discipline, which is
worse than the stall.

## Failure mode 2: WAL grows without bound under checkpoint starvation

`wal_autocheckpoint` is unset, so it is SQLite's default of 1,000 pages
(≈4 MB at the 4 KiB page size). A checkpointer starves when a reader's
transaction is open across the checkpoint attempt, so the WAL cannot be reset.
#68 filed this as its suspected finding 5: "whether 25 agents' event writes plus
polling readers can starve the checkpointer and grow `-wal` without bound is
unknown."

**It is now known, without a load test, because the precondition is a
long-lived reader and there is no statement in this app that produces one:**

```
grep -rc "\.iterate(" src/ | awk -F: '{s+=$2} END {print s+0}'    → 0
```

Every read is `.get()` or `.all()`, both of which run to completion inside one
synchronous statement and hold no open cursor across an `await`. better-sqlite3's
`.iterate()` is the API that would hold one, and it appears nowhere. A
`.all()`-shaped reader cannot span a checkpoint attempt because it cannot span
anything.

This is a stronger result than a measurement would have been. A load test showing
the WAL staying small would leave open whether some untested path starves it; a
grep showing no cursor API in use closes the class.

**The residual risk, stated honestly:** a future `.iterate()` added for a large
export or a streaming route reopens it. That is worth a sentence in
`docs/agent/architecture.md` if anybody ever writes one, and is not worth a
pragma today.

## What the vault says that does apply

`/workspace2/3 Resources/Data and Storage/When an Embedded Database Stops Being
the Right Answer.md` names two structural boundaries: more than one serial write
queue is needed, or the filesystem must be shared across hosts.
[GapRegister G3](../GapRegister/03-growth.md) already read this note and reached
the right conclusion — neither boundary is crossed, the write queue is
deliberately serial and the filesystem is deliberately one host's, so **SQLite is
not the constraint and swapping it would buy nothing**. This proposal confirms
that and adds only the two preconditions above.

The one thing from `Blocking the Event Loop` that *does* apply is its threshold,
and the app passes it. "Keep $\lambda B \le 0.1$ … and apply it to the **worst
observed** $B$ rather than the median." The worst synchronous database work on a
hot path here is #68's measured **0.02 ms per `run_events` insert**, and the
worst synchronous non-database work is this proposal's measured `walkRepo` at
**14.08-16.87 ms**, once per run creation rather than per request. Neither is
close to a tenth of the loop at any request rate this app sees.

## What would overturn this

Three things, and all three are checks rather than opinions.

1. **A second writing connection appearing.** Any `new Database(...)` outside
   `db.ts`'s `open()`, or any path that writes while `mayWriteDataDir()` is
   false. `grep -rn "new Database(" src/` is the check.
2. **A `.iterate(` appearing.** Then failure mode 2's precondition exists and
   `wal_autocheckpoint` becomes a real question.
3. **A measured `-wal` file that does not shrink.** `ls -la /data/*.db-wal`
   across a busy hour. **This could not be run here — `ls -la /data` returns
   `Permission denied`** — so the WAL's actual size on a real install is
   unmeasured, and this refusal rests on the mechanism rather than on an
   observation of the file.

## Score summary

| | |
|---|---|
| Files in `src/` to change | 1 (`db.ts`), plus every transaction if `BEGIN IMMEDIATE` is adopted |
| Failure modes it defends against | 2 |
| Failure modes whose precondition exists in this tree | **0** |
| Preconditions proven absent | 1 of 2 (`.iterate(` → 0). The other rests on the server lock working, which is a different invariant |
| Measured here | the WAL file itself: **no** — `/data` is unreadable |
| Verdict | **refused** |
