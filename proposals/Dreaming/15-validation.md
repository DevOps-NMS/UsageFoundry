# Validation

A pass back over this survey's own figures: how each was taken, which are
proxies, which are assumed, and which could not be taken at all. Three claims
this survey made about itself were wrong when checked and are corrected here.

---

## 1. What was measured, and how

**The corpus.** `~/.claude/projects`, reachable from this run with no special
grant. 1,953 `.jsonl` files, 1,370,318,045 bytes by `find -printf '%s'`, 994
distinct `sessionId` values, 24 days carrying records
(2026-08-10 … 2026-09-02).

Five scripts produced every number, all in `proposals/Dreaming/scripts/`. The
last two were added with the revision and are covered by §10:

```bash
node proposals/Dreaming/scripts/day-corpus.mjs  ~/.claude/projects --split
node proposals/Dreaming/scripts/slices.mjs      ~/.claude/projects
node proposals/Dreaming/scripts/recurrence.mjs  ~/.claude/projects
node proposals/Dreaming/scripts/ledger.mjs      ~/.claude/projects
node proposals/Dreaming/scripts/tool-corpus.mjs ~/.claude/projects
node proposals/Dreaming/scripts/score.mjs
```

**Pricing.** `claude-opus-5` input $5/Mtok and output $25/Mtok
(`src/lib/pricing.ts:38`); cache read ×0.1, 5m write ×1.25, 1h write ×2.0
(`:16`–`:18`); `claude-haiku-4-5` input $1/Mtok (`:56`); unknown models at the
`UNKNOWN_MODEL_PRICE` of $10/$50 (`:84`). Verified against `resolvePrice`
(`:115`–`:133`): **no long-context tier is applied** — `resolvePrice` returns
`FAST_MODE_PRICES` only on `opts.speed === "fast"`, and the Sonnet 5
introductory price only on a date test. So the day-bill column uses the same
rates the app itself would.

**Bytes to tokens** at `BYTES_PER_TOKEN = 3.6` (`src/lib/fileCostNotice.ts:87`),
the app's own constant. This is an approximation everywhere it appears and every
token figure inherits its error.

## 2. Three corrections to this survey's own claims

**a. The transcript corpus *is* reachable from a run.**
`08-option-f-workflow-block.md` originally said the containment pair
(`docs/agent/security.md:11`) put `~/.claude/projects` out of an agent's reach.
That is wrong: the pair decides which folder a run is given as its **cwd**, not
what the agent may `Read`. What decides that is the managed sandbox policy the
entrypoint writes, whose filesystem clause is exactly
`"denyRead": ["${DATA_DIR:-/data}", "/backups"]`
(`docker-entrypoint.sh:431`–`:433`), plus a credential deny for
`~/.claude/.credentials.json` (`:436`). The corpus is on neither list — which is
how every figure here was taken, from inside a run. The correction **helps**
Option F and is left in the file as a correction rather than smoothed over.

**b. `src/lib/transcripts.ts` does not extract "only `usage`".**
It also takes the shape of every tool call via `parseToolRecord` (`:11`, called
at `:485`) — a name, an id, and a result length — alongside `readTokens`
(`:346`, called at `:408`). It still takes no text, which is the claim that
matters, but the original phrasing was wrong.

**c. `describeEvent`'s defect is at `src/lib/logLine.ts:561`, not `:480`.**
The brief carried `:480` from an earlier survey. At HEAD the mislabelling
ternary is `const label = p.assist === "resolve" ? "resolve" : "review";` at
`:561`, inside `case "review":` opened at `:558`. The defect reproduces; the
line number did not.

## 3. The three latent defects, re-checked at HEAD

All three still reproduce. One has a docblock that now contradicts the code.

| claim | status at HEAD |
|---|---|
| `assistTimeoutMs` is a ternary on one member, so a third kind inherits a 10-minute clock | **Reproduces.** `src/lib/review.ts:78`–`:79`: `kind === "resolve" ? 0 : REVIEW_TIMEOUT_MS`, with `REVIEW_TIMEOUT_MS = 10 * 60_000` at `:69`. And the docblock at `:65`–`:67` now says the split is made at this function "so a third kind cannot inherit a clock by accident" — which is the opposite of what the ternary does. |
| `describeEvent` mislabels a third kind as a review | **Reproduces, at `:561`.** See §2c. |
| `installSpend()` cannot see `run_reviews`; `review.ts` never calls `installBudgetRefusal()`; `spawnAssist`'s argv carries no `--max-budget-usd` | **All three reproduce.** `installSpend` (`src/lib/installBudget.ts:79`–`:136`) sums `runs`, `workflow_instance_blocks` and `chat_turn_spend`. `grep -rn installBudgetRefusal src/` returns `installBudget.ts:162`, `installSpend.test.ts` ×3, and binary matches in `workflows.ts`, `orchestrator.ts` and `chat.ts` — **not `review.ts`**. `--max-budget-usd` is pushed at exactly one site, `src/lib/cycleInvocation.ts:1117`; `spawnAssist`'s argv (`review.ts:612`–`:656`) pushes `--permission-mode`, `--model`, agent args, `--allowedTools` and sandbox args and nothing else. |

## 4. What is a proxy, and for what

**The corpus split is a heuristic, not a recorded fact.** Nothing in a `.jsonl`
says "a run spawned me". The split reads the CLI's slugified cwd:
`-workspace--uf-worktrees-*` → run-worktree, `-Users-*` → the operator's own
machine, other `-workspace*` → container checkout. A run that ran in a
non-worktree checkout is misfiled as container, and this session is itself in
the container class. **Every claim of the form "Option B is blind to N sessions"
rests on this heuristic**, including the headline "42 of 63 on 2026-08-28" and
"502 of 994 overall".

**Error signatures are a proxy for lessons, in both directions.** Normalisation
collapses `Exit code 1` and `Exit code 127` into one row that carries no
information, and splits one `bwrap` denial across four rows because four
different files hit it. So 1,175 distinct signatures is neither an upper nor a
lower bound on the number of distinct lessons; it is a count of strings, and
`11-deduplication-and-retirement.md` says so where the number appears.

**The dedup figures are an upper bound on how well a nightly writer could
dedupe.** They dedupe strings the machine emitted. A writer would have to dedupe
*claims*, which is a judgement with no ground truth.

**"Day" is the record's own `timestamp`, in UTC.** A session spanning midnight
contributes to both days. A real Dreaming would cut on the operator's timezone
(`schedules.ts` carries `time_zone` on the row, `:549`), and the boundary would
move.

## 5. What is assumed

- **Output size.** `03-option-a-nightly-transcript-pass.md` assumes ~3k output
  tokens a night, from the 4,873-byte report `proposals/RunDecisionTree`
  measured for a whole grounding run. **No Dreaming pass has been run**, so
  every output figure here is assumed, and the option's total is dominated by
  input anyway.
- **Per-press cost for Option D.** Inherited from
  `proposals/ContinuousImprovement/10-option-retrospective.md:311`'s measured
  $1.82–$4.04 per assist on this install. Not re-measured.
- **That the corpus is complete.** `transcriptRetentionDays` defaults to 30
  (`src/lib/settings.ts`) and the window measured is 24 days, so nothing has
  aged out yet — but a longer view is not available and was not attempted.
- **That `qc.py` would fail a model-written note.** Read from
  `_Meta/Vault Quality Control.md:38`–`:49`, which lists the ERROR families.
  **`qc.py` was not run**, on this vault or on any note, and nothing was written
  into `/workspace2` to test it. `LINK/orphan` requiring an inbound link — the
  claim that a compliant write is two writes — is read from the table, not
  demonstrated.

## 6. What could not be measured, and the one-line queries that would settle it

**No run history exists anywhere reachable.**

```
$ ls -la /data
total 0            # exists, empty

$ sqlite3 /workspace/UsageFoundry/.data/usagefoundry.db \
    "select 'runs',count(*) from runs union all
     select 'run_events',count(*) from run_events union all
     select 'run_reviews',count(*) from run_reviews union all
     select 'ops_events',count(*) from ops_events union all
     select 'request_log',count(*) from request_log;"
runs|0
run_events|0
run_reviews|0
ops_events|1
request_log|8

$ sqlite3 /workspace3/UsageFoundry/.data/usagefoundry.db "select count(*) from runs;"
Error: in prepare, unable to open database file (14)
```

So the following are unknown, and each names what it would change:

```sql
-- Option B's whole score. Is there enough material a night?
SELECT COUNT(*) FROM runs WHERE created_at >= :dayStart;
SELECT kind, COUNT(*), SUM(LENGTH(payload))
  FROM run_events WHERE ts >= :dayStart GROUP BY kind;

-- Whether ContinuousImprovement's thin ending corpus is still thin.
SELECT status, COUNT(*) FROM runs WHERE created_at >= :since GROUP BY status;

-- The corpus-split heuristic's error bar: how many of a day's sessions
-- really have a runs row.
SELECT COUNT(*) FROM runs WHERE created_at >= :dayStart AND created_at < :dayEnd;

-- Whether the install ceiling would have caught anything.
SELECT COUNT(*), SUM(cost_usd) FROM run_reviews WHERE created_at >= :since;
```

**And nothing was executed against the vault.** `/workspace2` was read — 1,224
markdown files, `_Meta/`, `_Templates/`, the three quarantined questions, the
four question notes quoted throughout — and **not one byte was written into it,
nor into any mounted folder other than this checkout.** `qc.py`,
`build_index.py` and `vault_search.py` were not run.

## 7. Two internal consistency checks that passed

**a. The counterfactual bill against a neighbour's measurement.** This survey
computes $11,819.45 of run-worktree spend over 24 days ≈ $493/day, from
transcript `usage` at list rates. `proposals/ContinuousImprovement` measured
$4,303.70 of `runs.spent_usd` over 294 runs in an eleven-day window ≈ $391/day,
from the database. Different instruments, different windows, same order — which
is the only agreement available given §6, and it is reported as a consistency
check rather than as corroboration.

**b. The thinking-block finding against `RunDecisionTree`.** That survey
measured 28,857 blocks with zero non-empty bytes for `claude-opus-5` across
266,362 records. This one measures **48,978 blocks with 13 non-empty** across a
corpus roughly 1.7× larger and eleven days newer — and the 13 are Haiku 4.5 and
scratch-directory probe sessions, exactly the exception that survey named. The
finding replicates on fresh data.

## 8. The corpus moved while it was being measured

`day-corpus.mjs` was run three times during this survey and 2026-09-02's day
bill read $64.83, then $67.87, and its container-checkout total moved from
$4,162.92 to $4,168.44. **The session writing this survey is in the corpus it is
measuring**, and appends to it on every tool call. Figures for 2026-09-02 are
therefore a partial day and are excluded from every argument; the means include
it, which drags them down slightly. The `--split` container-checkout figures are
similarly inflated by this session's own work.

## 9. What a reader should distrust most

In order:

1. **Every count of sessions by class**, which is a directory-prefix heuristic
   (§4).
2. **Every statement about Option B**, which scores a corpus nobody counted (§6).
3. **The claim that `qc.py` would reject a nightly note**, which is read from a
   table rather than demonstrated (§5).
4. **Any token figure**, which passes through a single 3.6 bytes-per-token
   constant.
5. **The ledger's 77**, which counts recurring *signatures* and is called a count
   of learnings nowhere in §10 but reads like one everywhere else.
6. **Nothing about whether the feature would work**, because that is unmeasured
   everywhere — including in the operator's own vault, where the question sits
   open at `confidence: low` with UsageFoundry named as what prompted it.


## 10. The revision's own figures, and what to distrust in them

Added with `16-option-h`, `17-option-i` and `18-the-dreaming-pane`. Re-run on the
host on 2026-09-02; files 00–15 were measured in a container on 2026-08-28.

**Reproduced.** `recurrence.mjs` returns 1,177 distinct signatures against the
original 1,175 and 2,549 instances against 2,547, with every percentage unchanged
to one decimal. The drift is 2026-09-02's own sessions accumulating while the
scripts ran, which is §8's effect appearing again.

**Measured, and trustworthy to the extent the signature is.** `ledger.mjs`'s
1,361 / 1,177 / 77 and `tool-corpus.mjs`'s 5,521k tokens, 91% overflow and 0.2%
keyed share are arithmetic over the corpus, re-runnable in under 10 seconds each.

**What is a proxy here, and it is the same proxy as §4's.** *A signature is a
lesson* is assumed by every figure in the ledger table. It is false in both
directions — four `bwrap` signatures are one cause, `Exit code N` is one
signature over many causes — so **77 is not a count of lessons**, it is a count of
strings that recurred. The direction of the error is not known: collapsing causes
pushes it down, splitting them pushes it up.

**What is assumed and not measured.**

- **That a run whose cwd is the vault actually reads `CLAUDE.md`.** The licence
  argument in `16-option-h` §1 turns on this and nothing enforces it. It is a
  claim about how somebody composes a run, not about the code.
- **That an errors-only note is checkable.** "A person can verify `pdftoppm is
  not installed` by running one command" is stated, not demonstrated, and it is
  the load-bearing difference between Option I's corpus score of 4 and Option
  A's of 1.
- **That a 1,000k window is the right fit test.** `tool-corpus.mjs` compares
  against the largest context this install has. A reader that summarises as it
  goes has a different bound, and that bound is not measured here.

**One figure that reads like evidence and is not.** "34 of 77 notes (44%)
describe something that occurred again after the note existed" is a property of a
23-day window, not a benefit. Nothing in this corpus knows whether a note was
read, and the 43 that did not recur are equally consistent with "the problem was
fixed" and "the problem stopped by itself".

**Verified rather than asserted, in `18-the-dreaming-pane`.** The tenth-pane
claims were each checked against the tree: `QuickItem.detail` is optional at
`QuickOpen.tsx:47` and guarded at `:373`; `Sidebar.tsx:176` and
`QuickOpen.tsx:208` both interpolate `pane.shortcut` unguarded; `PANES` has nine
entries with Settings at `shortcut: "9"`; and the docblock's "Knowledge is the
ninth" contradicts the array, where Knowledge is seventh. That last one is a
defect in the codebase found by this survey, not a claim about it.
