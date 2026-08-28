# Option B — Extracted once when the run ends, stored as a tree

Same fold as Option A, run once at the moment the run reaches a terminal status,
and written to the database. The tab reads rows. The transcript is never touched
at view time and may be deleted afterwards without consequence.

Option A's fold is the engine; this option is a decision about *when* it runs and
*what outlives it*.

---

## What a node is

Identical to Option A — cycle / branch / act, plus seam and terminus. The
difference is that they become rows.

```sql
-- migrate() in db.ts, idempotent, additive
CREATE TABLE IF NOT EXISTS run_decisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES run_decisions(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,   -- sequence within the parent
  level       TEXT NOT NULL,      -- 'cycle' | 'branch' | 'act' | 'seam' | 'terminus'
  subject     TEXT,               -- file path, command key, or null
  ts          INTEGER NOT NULL,
  rationale   TEXT,               -- the quoted bytes, or null
  provenance  TEXT NOT NULL,      -- 'quoted' | 'structural' | 'absent'
  anchor      TEXT,               -- record uuid, so evidence can be re-fetched while the transcript lives
  payload     TEXT NOT NULL       -- JSON: tool name, byte counts, compaction metadata, exit code
);
CREATE INDEX IF NOT EXISTS run_decisions_run ON run_decisions(run_id, parent_id, ord);
```

`ON DELETE CASCADE` on `runs(id)` is the one design decision in that schema that
matters: it puts the tree on the **run's** retention horizon rather than the
transcript's, which is the entire point of the option (C4, C9).

Sizing, from the real run: run A's tree is 5 + ~42 + 297 + 4 + 14 ≈ **362 rows**.
At a generous 400 bytes of payload each that is ~145 KB per run — against a
3.84 MB transcript it replaces, and against `docs/agent/retention.md`'s existing
stores it is small. A hundred runs is ~15 MB.

## What an edge means

`parent_id` + `ord`. Sequence within a scope, as Option A. Storing the tree
*as a tree* rather than as a flat event list is what makes the read a single
indexed query instead of a second fold.

## Where the "why" comes from, and how faithful

Exactly Option A's four first-hand sources — commit messages, assistant text,
the final report, `compactMetadata` — frozen at extraction time.

Two properties follow, and they cut in opposite directions.

**Freezing is a feature for evidence.** A quoted commit message stored in
`rationale` still reads correctly in six months, after the transcript is swept
and the branch is deleted. The `anchor` uuid degrades gracefully: while the
transcript lives it is a link to the full record; afterwards it is an
identifier, and the view says so.

**Freezing is a defect for the fold.** Options A's tree improves retroactively
when the fold improves; Option B's does not. Ship a version that misses heredoc
commit messages and every run extracted before the fix keeps its blank
rationales forever. The mitigation is a `schema_version` column and a re-extract
path — and a re-extract only works while the transcript is still there, which is
precisely the window the option exists to survive past.

This is the honest tension at the centre of Option B: **it preserves data past
the transcript's life by committing to an interpretation of that data before the
interpretation is any good.**

The repository has an opinion about this shape. `docs/agent/architecture.md`
records `runs.file_cost_notice` as deliberately frozen against the cached prefix,
and `docs/agent/agents-and-templates.md` records frozen copy versus reference and
how a deleted agent is refused. Frozen state is an established pattern here; it
is also established that the freeze has to be *chosen*, not inherited.

## When it runs

At the terminus, and "the terminus" is more places than it first appears.
`docs/agent/run-lifecycle.md` records what may be waited out and what parks a
run; the extraction has to fire on **every** way a run stops being live:
`done`, `failed`, `cancelled`, `needs-review`, and the set-aside path — and it
must be idempotent, because `reopenPrompt`/`reopenFleet` can make a finished run
live again.

Concretely: `DELETE FROM run_decisions WHERE run_id = ?` then insert, inside a
single `db.transaction`, keyed on the run's current `session_id`. A reopened run
that produces more work re-extracts and replaces; that is correct and cheap
(362 rows).

The cost has to sit somewhere the run lifecycle already accounts for.
`docs/agent/concurrency-and-ownership.md` records the no-`await` window in
`createRun` and the constants bounding what one turn may do — the symmetric
constraint applies at the other end: a 40–80 ms fold in the terminal path is
fine, and it must not be in a path holding the server lock
(`src/lib/serverLock.ts`).

## Sub-agents, forks, resumes

**Sub-agents:** as Option A — a leaf, explicitly unexpandable, with the
`<persisted-output>` case labelled. Storing it does not make it richer.

**Resumes: Option B is materially better here, and it is the strongest argument
for the option after retention.** Because extraction is keyed to the run rather
than to whatever `runs.session_id` currently points at, a run resumed under a
new session id can *append*: extract cycle 1–3 from session X at the first
terminus, then cycles 4–6 from session Y at the second, into the same
`run_decisions` tree. Option A, reading only the current `session_id`, shows the
post-resume segment as the whole run.

This requires storing the session id per row (add `session_id TEXT` to the
schema above) and refusing to re-extract a segment already extracted. It is real
work, and it buys the one thing Option A cannot do at all.

**Forks:** as Option A, not present in this corpus.

## The compaction seam, explicitly

Identical handling to Option A — a `level = 'seam'` row whose `payload` carries
`trigger`, `preTokens`, `postTokens`, `cumulativeDroppedTokens` and the
`preservedMessages.uuids` list.

With one advantage worth naming: **the seam metadata is the part of the
transcript most worth preserving, and Option B is the only option that
preserves it.** After retention takes run A's 3.84 MB file, the fact that it
compacted four times and dropped 626,408 cumulative tokens is otherwise
unrecoverable — the `otlp_requests` telemetry has per-request costs, not
compaction events. Four rows of ~300 bytes keep it.

## Cost per run

| | |
|---|---|
| model tokens | **zero** |
| CPU | one 40–80 ms fold, at the terminus, once |
| storage | ~362 rows, ~145 KB per run |
| view-time cost | one indexed `SELECT` |

The view-time figure is the reason to prefer this over A on a busy page: it
removes a 3.8 MB parse from in front of the Land button (C3) and replaces it
with a query on `(run_id, parent_id, ord)`.

## Cost to build

Option A's cost plus persistence, minus the view-time walk.

| piece | size | notes |
|---|---|---|
| Option A's fold | ~350–450 lines | shared, unchanged |
| `migrate()` statement | ~15 lines | idempotent, additive, `CLAUDE.md`'s rule |
| extraction hook + idempotence | ~80 lines | every terminal path in `orchestrator.ts`; `db.transaction` |
| `GET /api/runs/[id]/decisions` | ~30 lines | reads rows |
| `RunDecisions.tsx` + canvas | ~400–500 lines | identical to A |
| retention placement | ~10 lines + a doc edit | `ON DELETE CASCADE` does the work; `docs/agent/retention.md` must say so |
| backfill for existing runs | ~60 lines | optional, and only works while transcripts survive |
| unit tests | ~300 lines | the fold, plus idempotence of re-extract |

**3–5 days.** The extra day and a half over Option A is almost entirely the
terminal-path plumbing and its idempotence, not the schema.

## How it degrades

| situation | what the operator sees |
|---|---|
| transcript compacted | the full tree with seams — same as A, and now durable |
| **transcript swept by retention** | **the full tree.** The option's whole reason to exist. Evidence links go dead and say so |
| run crashed mid-task | a partial tree — provided the extraction fires on the failure path, which is the thing most likely to be got wrong |
| run killed such that no terminal handler runs | **nothing, forever.** Unlike A, there is no second chance once the transcript expires |
| run reopened and extended | re-extraction replaces the tree; correct if idempotent, duplicated if not |
| fold improved after extraction | old runs keep the old tree until re-extracted, and re-extraction needs the transcript |

Rows two and four are the pair to weigh against each other. Option B converts
"the transcript is gone" from a total loss into a non-event, and converts "the
process died in an unusual way" from a recoverable gap into a permanent one.
Option A has the opposite profile. Neither is strictly better; B is better if
retention is on, A is better if it is off.

## Where it is strongest

- **It survives retention**, which is the one thing Option A cannot do and the
  thing `expiredTranscripts` guarantees will eventually matter.
- **It preserves seam metadata** that nothing else in the system records.
- **It handles resume correctly**, by appending segments keyed to the run rather
  than reading one session id.
- **It takes the walk off the read path**, in front of Land (C3).

## Where it is weakest

- **It freezes an interpretation** before that interpretation has been iterated
  on, and the window to re-derive closes when the transcript does.
- **New schema, new migration, new retention obligation** — the largest
  persistent-state footprint of the five options, for a fold that is otherwise
  identical to A's.
- **It still has 13 annotations for 297 acts.** Storing thin rationale durably
  produces durable thin rationale. Option B fixes *where the tree lives*; it does
  not fix *what the tree says*, which is Option C's and D's subject.
