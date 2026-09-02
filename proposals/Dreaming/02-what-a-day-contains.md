# What a day contains, and what each corpus is blind to

Three corpora could answer "what happened today", and they disagree about what
happened. This file says what each one holds, what it cannot see, and what that
does to a sentence written from it. Every option in the directory declares which
of the three it reads.

---

## The transcript corpus

`~/.claude/projects/<project>/<session>.jsonl`, the corpus
`PROJECTS_DIR` (`src/lib/config.ts:62`) and the corpus `src/lib/transcripts.ts`
walks. 1,953 files, 1,370,318,045 bytes, 994 distinct session ids across 24
days.

**It holds**, per record: a timestamp, a `sessionId`, a `uuid` and `parentUuid`,
the message with its content blocks, and `usage` when the record is an assistant
turn. Content blocks are `text` (either side), `tool_use` with its full input,
`tool_result` with its full output and an `is_error` flag, and `thinking`.

**It is blind to**:

- **Why anything was chosen.** 48,978 `thinking` blocks, thirteen non-empty,
  none from the model this app runs (`00-problem.md` §3).
- **How a run ended.** A transcript stops. It does not carry `status`,
  `exit_code`, `needs_review_reason`, whether the branch landed, whether a
  budget guard tripped, whether the run was cancelled or parked on a 429, or
  whether an operator later reopened it. All of that is in `runs`. A Dreaming
  built on transcripts alone can write "the agent tried X and the command
  failed" and cannot write "and the run was then parked for 26 minutes and
  failed `pauses-spent`."
- **Which run a session belongs to.** The link is the cwd slug and nothing
  else. `00-problem.md` §2 classifies sessions by directory prefix for exactly
  this reason, and says so as a heuristic.
- **Anything older than the retention horizon.** `expiredTranscripts`
  (`src/lib/retention.ts:591`) sweeps on `transcriptRetentionDays`, default 30
  (`src/lib/settings.ts:821`). A nightly reader is safe; a monthly comparison is
  not, and a "what did we learn this quarter" is reading a corpus that has been
  deleted underneath it.

**Its size is the design problem.** Mean 53.76 MB raw and 1.77 MB of prose a
day; 18 of 24 days exceed 200k prose tokens and three exceed 1,000k.

## This app's own rows

`runs`, `run_events`, `run_reviews`, `ops_events`, `otlp_requests`,
`workflow_instance_blocks`, `chat_turn_spend`, `request_log`.

**`run_events` knows more about what a run did than the transcript does**, which
is `proposals/RunDecisionTree/README.md`'s central finding and holds at HEAD.
`RunEventDTO.kind` (`src/lib/apiTypes.ts:1791` onward) is a fifteen-member union
— `status`, `log`, `assistant`, `subagent`, `tool`, `tool_error`, `sandbox`,
`iteration`, `budget`, `result`, `handoff`, `land`, `review`, `error`,
`replay-complete` — and four of those distinctions are ones a transcript reader
has to infer:

- `assistant` is the main thread's own words and `subagent` is a delegated
  turn's, kept apart deliberately (`:1794`, `:1797`–`:1805`) because
  `cycleOutputs` takes the last `assistant` text as the cycle's report and the
  `DONE` test runs against the main thread alone.
- `tool_error` is separate from `tool` because "a failure filed as a call is a
  row an operator reads as an attempt that went fine" (`:1811`–`:1814`), and
  **successful results are not recorded at all** — which makes the error corpus
  cheap to read and the success corpus absent.
- `sandbox` separates a sandbox refusal from an ordinary tool failure
  (`:1817`–`:1819`).
- `iteration` marks the cycle boundary and carries the prompt.

**It is blind to**:

- **Every session no `runs` row knows about.** On 2026-08-28 that is 21 of 63
  sessions — 11 container checkouts and 10 on the operator's own machine —
  carrying $366.13 of the day's $1,442.74. Over the whole corpus it is 492 of
  994 sessions and 48.5% of the counterfactual spend. A Dreaming on rows cannot
  see the day the operator spent in chat, and the chat is where the operator
  says what they were trying to do.
- **The words of a successful tool call.** Only errors are stored
  (`apiTypes.ts:1813`).
- **Anything past `eventRetentionDays`**, default 30
  (`src/lib/settings.ts:819`), and `run_events` also cascades on `runs`.

**And this survey could not count any of it.** `runs`, `run_events` and
`run_reviews` are all 0 rows in the only database it can open
(`00-problem.md` §5). Every claim in this section about the *shape* of the rows
is read from the type and its docblocks; every claim about their *quantity*
would need the queries in `15-validation.md` and none of them were run.

## OTLP and the day's spend rollups

`otlp_requests` (`src/lib/otlp.ts:290`) holds one row per request: `request_id`,
`ts`, `run_id`, `model`, `cost_usd`, tokens. `src/lib/windows.ts`,
`planUsage.ts` and `repoSpend.ts` roll the transcript corpus up five ways.

**This is the corpus that knows what a day cost and nothing about what happened
in it.** It has no text of any kind. It can date a spike, name the run and the
model, and say which five-hour window it landed in; it cannot say what the money
was spent doing. As Dreaming's input it produces exactly one class of sentence —
"this cost more than that" — which is a sentence the dashboard already draws
without paying a model to write it.

One structural note for any option that routes through `src/lib/review.ts`:
assists deliberately carry **no** telemetry, because "`otlp_requests.run_id` is
compared against the run's own spend, and these requests would corrupt that
comparison" (`review.ts:46`–`:47`). A Dreaming child that emitted OTLP under a
run's id would break that comparison in the same way.

## The three, side by side

| | transcripts | rows | OTLP |
|---|---|---|---|
| sees the operator's own sessions | **yes** — 180 of 994 | no | no |
| sees run-spawned sessions | yes — 502 of 994 | yes | yes |
| sees a run's ending | **no** | yes | no |
| separates a sub-agent's words | no | yes (`subagent`) | n/a |
| holds successful tool output | yes | **no** | no |
| holds a reason for a choice | no | no | no |
| holds money | per request, via `usage` | per run, per block, per chat turn | per request |
| bounded by retention | 30 days | 30 days | swept with the rest |
| countable from this run | **yes** | no — 0 rows | no — 0 rows |

The row that decides the survey is the last content row but one: **none of the
three holds a reason.** Whatever Dreaming reads, the "what was learned" step is
inference over an action log, and `01-constraints.md` C6 prices what inference
of that kind is measured to be worth.

## What "read every session" costs, by slice

At `BYTES_PER_TOKEN = 3.6` and `claude-opus-5` input at $5/Mtok, per night, mean
over 24 days. Measured by
`node proposals/Dreaming/scripts/slices.mjs ~/.claude/projects`:

| slice | bytes/day | tokens/day | opus | haiku-4-5 | share of $956.09 |
|---|---:|---:|---:|---:|---:|
| whole raw corpus | 53.770 MB | 15,662k | **$78.31** | $15.66 | 8.19% |
| tool_result output | 14.467 MB | 4,214k | $21.07 | $4.21 | 2.20% |
| tool_use inputs | 3.684 MB | 1,073k | $5.37 | $1.07 | 0.56% |
| prose, all `text` blocks | 1.766 MB | 514k | **$2.57** | $0.51 | 0.27% |
| — user side | 1.302 MB | 379k | $1.90 | $0.38 | 0.20% |
| — assistant side | 0.463 MB | 135k | **$0.68** | $0.14 | 0.07% |
| tool results with `is_error` | 0.037 MB | 11k | $0.06 | $0.01 | 0.006% |

Two of those rows say something the totals hide. **The user side outweighs the
assistant side nearly three to one** (31.26 MB against 11.12 MB across the
corpus) and almost none of it is the operator: injected `<system-reminder>`
blocks, hook output and skill text all arrive as user `text`. So "read what was
said" is mostly reading this harness talking to itself. And **the whole error
corpus is 0.90 MB — 2,548 blocks in 24 days.** The one slice that is entirely
machine-established costs six cents a night to read at Opus rates.

Two things fall out of that table:

1. **The cheap slice is the useless one and the useful slice is the expensive
   one, but neither is expensive in the way the objection assumes.** $2.57 a
   night for all the words spoken in a day is 0.27% of the day's bill. On money
   alone this is affordable and it would be dishonest to refuse it on money.
2. **The gap between $2.57 and $78.30 is the whole design space.** "Read every
   session" means the second figure; "read what the sessions said" means the
   first. They are different features and the operator's sentence does not
   choose between them.
