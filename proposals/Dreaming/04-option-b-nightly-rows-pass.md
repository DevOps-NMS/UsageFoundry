# Option B — the nightly rows pass

The same clock, a different corpus. Instead of the transcripts, the child is
handed what this app recorded for itself: the day's `runs` with their endings,
their `run_events` timeline, any `run_reviews`, and the `ops_events` around
them. It writes the same kind of note into the vault.

| | |
|---|---|
| **fires** | a clock — `{kind:"daily", minutes}` (`src/lib/schedules.ts:65`) |
| **reads** | `runs`, `run_events`, `run_reviews`, `ops_events` |
| **writes** | markdown into `/workspace2` |
| **authors** | a model, unattributed |
| **retracts** | a person, by deleting a file |
| **costs** | unknown — see "the measurement that was not taken" |

---

## The strongest case

**The rows know things the transcript cannot.** `RunEventDTO.kind`
(`src/lib/apiTypes.ts:1791` onward) is a fifteen-member union written from
stdout as the run happens, and four of its distinctions are ones a transcript
reader has to guess at: `assistant` versus `subagent`, `tool` versus
`tool_error` versus `sandbox`, and `iteration` marking the cycle boundary with
the prompt on it. Beside them sit `runs.status`, `runs.exit_code`,
`runs.needs_review_reason`, `runs.spent_usd` and the landing outcome. **A
learning about an *ending* can only be written from here.** "The agent tried X
and the command failed" is available to Option A; "and the run then failed
`pauses-spent` after three parks" is available only to Option B.

**It is bounded and it is small.** `run_events` stores errors and never
successful tool output (`apiTypes.ts:1813`), so the corpus is already filtered
to what went wrong plus the narrative spine. Where Option A reads 53.77 MB a
night, Option B reads whatever a day of rows weighs — which, on the shape of the
event kinds, is closer to the 0.90 MB error corpus than to the raw transcripts.

**It has no corpus-boundary problem.** A day is a `WHERE ts BETWEEN` and
nothing else. No cwd-slug heuristic, no midnight-spanning session, no
retention-horizon surprise beyond the one the sweep already documents.

**It composes with the app's own vocabulary.** `runs.origin` distinguishes
`form`, `chat`, `workflow`, `schedule` and `orchestrator-block`
(`src/lib/workflows.ts:4661`, `src/lib/chat.ts:1273`,
`src/lib/runOrigin.test.ts:154`–`:291`), so a note can say *which kind of press*
produced the day's failures. Nothing in the transcript carries that.

## The measurement that was not taken

**This option is unscored, and it is unscored for a reason that is not
laziness.** Every database this survey could reach is empty:

```
$ sqlite3 /workspace/UsageFoundry/.data/usagefoundry.db \
    "select 'runs',count(*) from runs union all
     select 'run_events',count(*) from run_events union all
     select 'run_reviews',count(*) from run_reviews union all
     select 'ops_events',count(*) from ops_events;"
runs|0
run_events|0
run_reviews|0
ops_events|1
```

`/data` exists and is empty. `/workspace3/UsageFoundry/.data/usagefoundry.db`
and `/workspace4/…` are 278,528 bytes each and `sqlite3` answers
`Error: in prepare, unable to open database file (14)`.

So the following are **not known** and every one of them changes Option B's
score:

```sql
-- how much material a night actually has
SELECT COUNT(*) FROM runs WHERE created_at >= ?;
SELECT kind, COUNT(*), SUM(LENGTH(payload))
  FROM run_events WHERE ts >= ? GROUP BY kind;

-- whether the ending corpus is thin, as ContinuousImprovement found, or not
SELECT status, COUNT(*) FROM runs WHERE created_at >= ? GROUP BY status;
SELECT COUNT(*) FROM runs
 WHERE created_at >= ? AND needs_review_reason IS NOT NULL
   AND needs_review_reason <> '';

-- what share of the day's sessions have a row at all
SELECT COUNT(DISTINCT id) FROM runs WHERE created_at >= ?;
```

The last one is the decisive one, and the transcript corpus gives a proxy for
it: **on 2026-08-28, 42 of 63 sessions were in a run worktree; over the whole
corpus, 502 of 994.** If that proxy holds, Option B is blind to roughly a third
of the day's sessions and **48.5% of the counterfactual spend** — the operator's
own machine plus the container checkouts. `proposals/ContinuousImprovement`
counted 294 runs and two ending-level failures in its eleven days, so the
ending corpus at least *was* thin; whether it still is, nothing here can say.

## What refuses it

Everything that refuses Option A except the corpus-size argument.
`knowledge.ts:39` refuses the write identically. `review.ts:34`–`:35` refuses
the clock identically. `AGENTS.md:115` refuses the author identically. `qc.py`
rejects the output identically. Option B is a narrower Option A, not a different
kind of thing, and narrowing the input does not answer an objection about the
output.

One thing does change in its favour and one against:

- **In favour**: the corpus is machine-established rather than self-reported.
  `run_events.kind = 'tool_error'` is a fact the app recorded, not a claim the
  agent made about itself. That is the same defence
  `proposals/ContinuousImprovement/10-option-retrospective.md:53`–`:57` mounts
  for the strongest form of Option G — "retrospect only on machine-established
  failures, never on the run's self-report" — and it genuinely works, as far as
  it goes.
- **Against**: it cannot see the operator. The one corpus with a *person* in it,
  where intent is stated in words rather than inferred from actions, is the one
  Option B discards — 180 sessions and 18.70 MB of prose, the largest prose
  class in the install.

## What an operator sees

The same as Option A: nothing while it runs, a file at 03:04, and deletion as
the only correction. Option B could plausibly write a `run_events` row of its
own for each run it read — but that is a fourth kind of thing writing into a
table whose `kind` union is closed and documented, and
`11-deduplication-and-retirement.md` explains why a per-run marker does not
solve a cross-day duplicate anyway.

## Verdict

**Refuse, and note that it is unscored.** Its corpus is the better one for
endings and the worse one for intent, its write path is refused by exactly the
same three things as Option A's, and the figure that would decide whether it has
enough material to be worth the collision — `SELECT COUNT(*) FROM runs WHERE
created_at >= ?` and its `run_events` sibling — is unavailable from a work
cycle. If someone runs those queries against the live install and the day's
event corpus turns out to be large and error-dense, Option B moves ahead of
Option A on input quality. It still does not move ahead of anything on the write
path, which is where all of these die.
