# The problem, from measurement

The operator's sentence is: *once a day, something reads every session of that
day, works out what was learned, and writes those learnings into the knowledge
base.*

Four nouns in it are load-bearing and three of them are measurable. This file
measures them. It does not argue for or against the feature; the options do
that.

---

## 1. "A day" — 42.8 sessions, 53.8 MB, $956

Measured over the whole readable transcript corpus,
`~/.claude/projects/**/*.jsonl` — 1,953 files, 1,370,318,045 bytes — cut into
days on each record's own `timestamp` rather than on file mtime, because a
session that spans midnight belongs to both days and that is a boundary a
nightly job has to draw for itself. Reproduce with
`node proposals/Dreaming/scripts/day-corpus.mjs ~/.claude/projects`.

| day | sessions | raw MB | prose MB | prose tokens | opus read | haiku read | day bill |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2026-08-10 | 59 | 90.90 | 7.98 | 2,325k | $11.62 | $2.32 | $1,529.66 |
| 2026-08-11 | 114 | 85.66 | 3.98 | 1,159k | $5.79 | $1.16 | $1,689.19 |
| 2026-08-12 | 26 | 30.63 | 1.77 | 515k | $2.57 | $0.51 | $724.59 |
| 2026-08-13 | 30 | 28.44 | 0.93 | 271k | $1.35 | $0.27 | $730.18 |
| 2026-08-14 | 107 | 99.66 | 0.88 | 256k | $1.28 | $0.26 | $2,356.29 |
| 2026-08-15 | 70 | 84.06 | 0.79 | 231k | $1.15 | $0.23 | $1,284.77 |
| 2026-08-16 | 78 | 93.18 | 3.29 | 957k | $4.79 | $0.96 | $1,549.86 |
| 2026-08-17 | 23 | 32.64 | 1.86 | 543k | $2.71 | $0.54 | $804.99 |
| 2026-08-18 | 35 | 27.78 | 1.32 | 384k | $1.92 | $0.38 | $591.07 |
| 2026-08-19 | 41 | 105.42 | 2.55 | 743k | $3.72 | $0.74 | $1,746.26 |
| 2026-08-20 | 4 | 4.63 | 0.03 | 10k | $0.05 | $0.01 | $84.45 |
| 2026-08-21 | 23 | 57.08 | 3.00 | 874k | $4.37 | $0.87 | $1,031.32 |
| 2026-08-22 | 35 | 68.50 | 2.25 | 655k | $3.28 | $0.66 | $1,031.56 |
| 2026-08-23 | 41 | 69.24 | 2.32 | 675k | $3.38 | $0.68 | $1,055.26 |
| 2026-08-24 | 79 | 57.62 | 1.61 | 469k | $2.34 | $0.47 | $1,221.32 |
| 2026-08-25 | 54 | 73.90 | 1.75 | 509k | $2.55 | $0.51 | $1,207.31 |
| 2026-08-26 | 23 | 51.89 | 1.00 | 290k | $1.45 | $0.29 | $854.27 |
| 2026-08-27 | 55 | 53.16 | 0.82 | 238k | $1.19 | $0.24 | $774.18 |
| 2026-08-28 | 63 | 91.91 | 3.50 | 1,020k | $5.10 | $1.02 | $1,442.74 |
| 2026-08-29 | 10 | 10.38 | 0.11 | 33k | $0.16 | $0.03 | $159.77 |
| 2026-08-30 | 25 | 38.03 | 0.26 | 76k | $0.38 | $0.08 | $412.25 |
| 2026-08-31 | 25 | 31.43 | 0.35 | 102k | $0.51 | $0.10 | $597.06 |
| 2026-09-01 | 1 | 0.01 | 0.00 | 0k | $0.00 | $0.00 | $0.00 |
| 2026-09-02 | 5 | 4.21 | 0.03 | 10k | $0.05 | $0.01 | $67.87 |
| **mean** | **42.8** | **53.76** | **1.77** | **514k** | **$2.57** | **$0.51** | **$956.09** |

"Prose" is every `text` block, from either side of the conversation — the
operator's instructions, the agent's replies, and the injected
`<system-reminder>` and hook output that arrive dressed as user text. It is not
the whole of a session and it is not the decision-bearing part of one; it is the
part in words.

**Bytes are converted at `BYTES_PER_TOKEN = 3.6`** (`src/lib/fileCostNotice.ts:87`),
the app's own constant, and priced at `src/lib/pricing.ts`'s rates for
`claude-opus-5` — input $5/Mtok, output $25/Mtok (`:38`), cache read ×0.1, 5m
write ×1.25, 1h write ×2.0 (`:16`–`:18`). The **day bill** column is
counterfactual in the sense `docs/agent/metering.md` uses: what the same tokens
would have cost on the API. This install runs on a subscription and is not
billed this way.

Three readings matter:

- **Reading a day's prose once costs $2.57 at the mean and $11.62 on the worst
  day** — 0.27% of that day's bill. Cost, on this slice, is not the objection.
- **Reading the whole day's raw corpus once costs $78.30 at the mean and
  $153.52 on 2026-08-19** — 8.2% of a day's bill, every night. That figure is
  what turns "read every session" into a different feature from "read what the
  sessions said."
- **The prose slice does not fit.** 18 of 24 days exceed 200k tokens; three
  exceed 1,000k (2026-08-10 at 2,325k, 08-11 at 1,159k, 08-28 at 1,020k). A
  single-pass reader fails outright on 12.5% of days and needs chunking on 75%
  of them, and chunking is where a cross-session synthesis stops being
  cross-session.

## 2. "Every session" — three corpora, and they are different sizes

The same measurement, split on the project directory a session was written
under. `--split` reports it. This is a heuristic and not a recorded fact:
nothing in a `.jsonl` says "a run spawned me", so the split reads the CLI's
slugified cwd — `/uf-worktrees/…` is a run's checkout, `/Users/…` is the
operator's own machine, and a bare `/workspace…` is a container checkout, which
is this app's own agents and anything else started inside the container.

| class | sessions | prose | counterfactual spend | thinking blocks / non-empty |
|---|---:|---:|---:|---|
| run-worktree | 502 | 16.99 MB | $11,819.45 | 23,025 / 9 |
| container-checkout | 256 | 6.66 MB | $4,168.44 | 7,112 / 0 |
| operator-host | 180 | 18.70 MB | $6,945.69 | 18,819 / 0 |
| other | 56 | 0.03 MB | $12.84 | 39 / 4 |

On one ordinary day, 2026-08-28: 63 sessions, of which **42 run-worktree, 11
container-checkout, 10 operator-host** — carrying $1,076.61, $116.14 and $249.99
respectively.

So the choice of corpus is not a detail of implementation. **A Dreaming that
reads this app's own `runs` table sees 42 of 63 sessions and 75% of the money.
A Dreaming that reads the transcripts sees all 63.** The 21 it would otherwise
miss include every minute the operator spent in chat, and — on the whole corpus
— the single largest prose class, 18.70 MB against run-worktree's 16.99 MB.
The operator's own sessions are where the *reasons* are said out loud, because
that is the half of the corpus with a person in it.

## 3. "What was learned" — the corpus does not contain it

**48,978 `thinking` blocks across the readable corpus. Thirteen have a
non-empty body.** Nine are in run worktrees and four in scratch directories; all
thirteen are probe sessions. Every block produced by `claude-opus-5`, the model
this install runs, is empty.

That confirms `proposals/RunDecisionTree/README.md`'s 28,857-blocks-zero-bytes
finding on a corpus roughly 1.7× larger and eleven days newer, and it is not the
only place the reasoning is removed: `src/lib/orchestrator.ts:6675`–`:6704`
iterates the assistant's content blocks and handles exactly two of them,
`b.type === "text"` and `b.type === "tool_use"`. Everything else — including
`thinking`, were it ever non-empty — is dropped by name, never reaching a
`run_events` row.

A day's sessions therefore record, in order: what was asked, what was done, what
came back, and what was said about it. They do not record why any of it was
chosen. **A nightly reader is reading a log of actions, not a record of
judgement**, and every sentence it writes about *why* something happened is a
reconstruction. `02-what-a-day-contains.md` prices what that leaves.

## 4. "The knowledge base" — reachable, strict, and not under version control

The vault is at `/workspace2`, mounted and readable from this run: 1,224
markdown files in PARA layout (`1 Projects`, `2 Areas`, `3 Resources`,
`4 Archive`) with `_Meta/`, `_Templates/`, `_Attachments/` and a 2,633,599-byte
generated `INDEX.md`.

Three properties decide most of this survey and all three are the vault's own
words, not inferences:

- **`_Meta/Vault Conventions.md:23`–`:30`, the six non-negotiables.** Complete
  frontmatter with `updated:` bumped; at least three outgoing wikilinks and a
  `## Related` section explaining each; namespaced tags registered in
  `[[Tag Index]]`; every claim sourced and `confidence` never exceeding the
  evidence grade of what it cites; no orphans; gaps left behind as seed notes.
  `_Meta/qc.py` enforces these and "exits non-zero on any violation"
  (`_Meta/Vault Quality Control.md:17`), with `FM/*`, `TAG/*`, `LINK/broken`,
  `LINK/sparse`, `LINK/orphan`, `SEED/*` and `PATH/*` all at ERROR
  (`:38`–`:49`).
- **`AGENTS.md:115` addresses this feature directly.** "If you are a session
  from another project and have not read `CLAUDE.md`, you do not have the
  writing conventions and should not write notes here. The one exception is a
  single question capture into `3 Resources/Questions/Inbox/` using that
  folder's `_TEMPLATE.md` — a quarantine that gets reviewed before anything
  counts as vault content." A UsageFoundry-spawned child is exactly the session
  that sentence is about.
- **`ls -a /workspace2` shows no `.git`.** The vault is not a repository.
  There is no `git revert` for a wrong note, no diff of what last night added,
  and no author field. Retraction is a person deleting a file. That single fact
  reorders the whole comparison, because every option here writes something that
  will eventually be wrong.

And the vault already holds a note about this feature. `3 Resources/Questions/
Inbox/Does Writing Lessons From a Past Run Stop an Agent Repeating the
Mistake.md` was captured on 2026-08-21 with `captured_from: "UsageFoundry — a
Next.js app that runs Claude Code headlessly against a mounted folder, many runs
over the same repository"`, sits at `status: seed`, `confidence: low`, and
records at `:60` that its own triage is still open. `01-constraints.md` reads
what it and its three children establish, because between them they are the best
evidence anywhere about whether Dreaming's output is worth writing.

## 5. What could not be measured

**No run history exists anywhere this survey could reach.** The in-checkout
database, `/workspace/UsageFoundry/.data/usagefoundry.db`, holds:

```
runs|0
run_events|0
run_reviews|0
ops_events|1
request_log|8
```

`/data` exists and is empty; the two neighbouring checkouts under `/workspace3`
and `/workspace4` carry a 278,528-byte `usagefoundry.db` apiece that `sqlite3`
answers `unable to open database file (14)` for. So every figure above comes
from the transcript corpus, and **nothing in this survey counts a `runs` row, a
`run_events` row, an `otlp_requests` row or a `run_reviews` row.** That gates
`04-option-b-nightly-rows-pass.md` entirely, and the queries that would settle it
are named there and repeated in `15-validation.md`.

Read `01-constraints.md` next: three of the six things it lists are refusals
this feature walks into, and one of them is the module it would have to be
written in.
