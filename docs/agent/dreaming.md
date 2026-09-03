# Dreaming: what recurred, and what was written about it

> Each paragraph records a correctness or safety decision whose violation is
> silent — nothing throws, nothing fails to typecheck, and the page looks right.
> **Read before editing `src/lib/dreaming.ts`, `src/lib/dreamingLedger.ts`,
> `src/lib/dreamingRun.ts`, `src/app/dreaming/`, or `src/app/api/dreaming/`.**
> The reasoning behind the shape is `proposals/Dreaming/`, whose figures every
> constant here comes from.

**Two halves, and only one of them can be wrong.** The readout is arithmetic over
the transcript corpus: `tool_result` blocks carrying `is_error`, normalised into
signatures, counted per day. It writes nothing, needs no configuration, is
always available, and its failure mode is a bug rather than a false claim in
somebody's document store. The writer is a nightly run pointed at the operator's
vault, and that half *can* be wrong — so everything about it is built around the
question of how a wrong note gets found and taken back. **`settings.dreamingEnabled`
is off by default and is the only setting in this app that authorises an
unattended write into a store this app does not own.** A change that makes the
readout depend on the writer's configuration, or that makes the writer reachable
without that flag, breaks the split the whole feature rests on.

**Why the corpus is the error slice and not the day.** Measured in
`proposals/Dreaming/scripts/tool-corpus.mjs`: the whole tool corpus is 5,521k
tokens a night, overflows a 1,000k window on 21 of 23 days and by 12.8× on the
worst, and — the figure that actually decides it — **99.8% of it by bytes carries
no deduplication key.** An error result has a message a signature can be taken
from; a successful one has nothing to match on but a model's own judgement, which
is a nightly retrieval-then-judgement pass over 1,224 notes with no verifier. The
error slice is 0.90 MiB over 23 days, 11k tokens a night, and is 100% keyed.
Widening the corpus is not a scope decision, it is a decision to delete the
deduplication mechanism.

**The write policy is the feature, and its number is measured rather than
chosen.** `scripts/ledger.mjs` over the same 23 days: writing every distinct
signature every night produces **1,361** notes; writing each once on first sight
produces **1,177**, of which **1,100 (93.5%) are about something that never
happened again**; writing on the night a signature reaches its *second* day
produces **77**, all about something seen on two or more days. So `selectWritable`
takes `minDays` and a set of already-written signatures, and `dreamingMinDays`
defaults to 2. A ledger *alone* saves 13.5% and still doubles a 1,224-note vault
in 24 days — the deduplication everyone reaches for first is the small half. The
latency the policy costs was measured too and must not be presented as free:
median 3 days from first sighting to the night it qualifies, mean 3.8, max 20.

**A signature is a string, not a cause, and every surface has to say so.**
Normalisation collapses numbers, hex runs and path interiors, so one cause
appears as several rows — four `bwrap` denials at four paths are one denial — and
one row carries many causes, of which `Exit code N` is the worst in this corpus.
`signatureOf` matches `scripts/recurrence.mjs` **exactly**, and that is not
tidiness: the script is how every figure behind this feature was measured, so a
normalisation that drifted from it would leave `proposals/Dreaming` describing a
different feature. Roughly half the top recurring rows are not failures at all —
a person declining a tool call, a permission prompt working correctly — and
nothing separates them, which is why the page carries the caveat and the prompt
tells the run to skip them rather than write about them.

**A day is the operator's day.** `dayKey` takes a zone and `dreamingTimeZone`
supplies it, read twice: it decides when the pass fires *and* where a day begins.
UTC is the wrong boundary for a feature denominated in days — a session at 01:00
in Berlin belongs to the night the operator would call it — and the failure is
silent in the expensive direction: two sightings one local evening apart read as
two days and qualify for a note. An unknown zone falls back to UTC rather than
throwing, because a boundary off by an hour beats a blank page.

**The scan keeps its own cache and must never ride `scanUsage`'s.** `/api/usage`
already pays a cold transcript walk the dashboard is waiting on, and adding a
second parse of every file to it would put this feature's latency on a page that
has nothing to do with it. So `dreaming.ts` holds a per-file memo keyed on size
and mtime under its own `globalThis` key. Measured on the real corpus: cold 3,483
ms over 1,954 files, warm **21 ms with 0 files re-read**. The retention sweep
calls `forgetDreamingFiles` beside `forgetTranscriptFiles` — two caches over one
corpus, and a sweep that forgot only the first would leave this one holding the
parse of every transcript ever deleted for the life of the process.

**The ledger is the retraction mechanism, and that is why the feature can ship.**
The vault is not a git repository: no history, no author field, and nothing in a
note that marks it as machine-written, so "what did this app write" is a question
only this side can answer. `dreaming_notes` is keyed on the signature itself —
the deduplication test *is* the primary-key lookup — and it is not version
control, it is the list a person deletes *from*. **`forgetNote` deletes the row
and never the file.** Retraction in the vault is a person moving a file in
Obsidian, and an app that deleted from a mount it does not own would be doing
something heavier than anything else in this codebase, against a store with no
undo. What forgetting buys is that the signature stops being suppressed, so the
next qualifying night writes it again — which is the intended repair for a note
that came out wrong.

**Signatures are claimed before the run writes, not after it reports.** A run
that crashes half way has still written some of the files, and a ledger written
only on success hands the same signatures to the next night — which is the
duplicate `_Meta/Vault Conventions.md` names as the failure mode its conventions
exist to prevent. Over-claiming loses a note; under-claiming leaves a second note
beside one that is already there, and only the second is a mess in somebody's
document store. `note_path` stays null until a report says otherwise, so a
claimed-but-unwritten row reads as "attempted, no file recorded" rather than as a
note that exists.

**`reconcileDreamingNotes` is keyed on the run and never on the night.** Two
passes share a calendar night — a press at noon and the timer at 03:04 — but not
a prompt: each run was handed only its own selection and numbered it from 1.
Indexing a night's rows as one list maps the second run's `NOTE 1` onto the first
run's first signature, attaching a real path to a row about a different failure,
and nothing reports it: both rows exist, both point at real files, and only the
pairing is wrong. It reads the **last** `assistant` event, on `cycleOutputs`'
rule — an earlier turn saying `NOTE 1 draft.md` is a plan, not a result — and
never overwrites a path it already has, so a reopened run that says nothing
cannot blank a row pointing at a real file. It runs at read time in the route
rather than in the run loop: the pane is the only consumer, and a Dreaming-shaped
branch inside the orchestrator's cycle handling would be this feature reaching
into the loop every other feature is careful not to touch.

**`recordNight`'s `selected` is sticky.** A night that had already started a run
and then found nothing left on a second pass read back as `quiet`, so the one
surface that shows this feature reported a night that wrote into somebody's vault
as a night that did nothing. A later `quiet`, `refused` or `failed` never
downgrades a night that has written; a later `selected` moves the row to the
newer run, because that is the one whose report the reconciler will read, and
adds to the count. `dreaming_notes` stays the authoritative record of what each
run claimed.

**The writer is a run, never an assist.** A run lands in `runs.spent_usd`, which
is where `installSpend`'s rolling 24 hours looks, and appears on `/runs` with a
log, a cost, a status and an origin. A third `AssistKind` would inherit the
review's ten-minute clock (`review.ts:78`), log itself as a review
(`logLine.ts:561`) and spend where the install ceiling cannot see it
(`installBudget.ts:79`) — three defects that reproduce at HEAD and that this
feature sidesteps by not being an assist. It is also never isolated: an isolated
run works in a copy and lands a branch, the vault is not a repository, and a note
written into a worktree that is later discarded is a note nobody ever sees.

**`dreamingMaxCostUSD` has no way to express "no ceiling",** on
`scheduleRefusal`'s reasoning quoted word for word: every other press of Run is
bounded by a person being there to see what it cost and decide whether to press
it again, and a clock removes the person and keeps the press. The settings door
refuses zero and below rather than storing it.

**The clock copies three of `schedules.ts`' rules and each was learned
expensively.** The timer *stops* rather than skips when the data-directory claim
is lost, because two processes deciding one night is two agents writing into one
vault. A tick already running does not stack. And **a boot never catches up**:
`reconcileDreamingOnBoot` moves the cursor to the current night whatever it
finds, so a server coming back at noon writes nothing about an 03:04 that passed
while it was down. The cursor is a night key rather than an instant, and it is
advanced *before* the work so a night that throws is not retried every minute
until midnight.

**Everything the licence rests on lives in `buildDreamingPrompt`, which is why it
is pure and tested.** The vault's `AGENTS.md` forbids notes from a session that
has not read its `CLAUDE.md`; the only reason this run may write at all is that
it is pointed at the vault as its folder and told to read the conventions first.
**Nothing enforces that it does.** The managed sandbox policy carries no
path-based write restriction (`docker-entrypoint.sh:431`–`:433`), a skill is
persuasion, and a `PreToolUse` deny-on-`Write` hook — the one mechanism that
would enforce it — does not exist. So the prompt is the enforcement, and five
things it must always say are asserted in `dreaming.test.ts`: read `CLAUDE.md`
first; transcription is the claim and diagnosis is a hypothesis; a signature is a
string rather than a cause; grow an existing note rather than writing a second
one beside it; and report the paths back, which is what makes a note
retractable.

**The pane must keep three kinds of nothing apart**, and an empty table is the
wrong answer to all of them: never configured (a sentence and a link to
Settings), ran and wrote nothing (the **success** case for a write-on-recurrence
policy — six of the twenty-three measured days had no failure reach a second day,
and it must not read as a failure), and ran and failed (a link to the run).
`dreaming_nights` exists separately from `dreaming_notes` for exactly this: a
night that wrote nothing leaves no note rows, so a pane reading only the notes
cannot tell it from a night that never ran. **`present` is three-valued for the
same reason** — `true`, `false`, and `null` for "no path to check, or the vault
is unreachable" — because a mount that has gone must not report every note this
app ever wrote as deleted.

**The pane does not poll.** Its subject moves once a night, and a 120-second poll
against a table that changes at 03:04 is 720 requests for an answer that cannot
have changed, with nothing for the re-arm logic in `conventions.md` to key on. It
loads on mount and offers a rescan; a run in flight is watched on `/runs`, which
already does this properly. And **it offers no control that starts a run beyond
the explicit press**, on quick open's rule: a keystroke away from spending money
is what every approval gate in this app exists to prevent, and a readout is
exactly where a Run Now button looks convenient.

**The pane is the eighth row, directly under Knowledge, and `Pane.shortcut` is
optional because of where that leaves the digits.** It reads as a readout of what
the install did to itself, which is nearer in kind to the vault than to the two
configuration panes it used to sit below, and the operator asked for that order
knowing what it costs. The digit follows the row's position, so Dreaming is ⌘8,
API account is ⌘9, and **Settings, now the tenth row, carries no shortcut at
all** — ⌘1…⌘9 is nine digits against ten rows. The earlier arrangement put
Dreaming last and kept ⌘9 on Settings, on the ground that Settings is where
somebody goes when something is wrong; that trade was overruled, not forgotten,
and Settings stays one press away in quick open. The one thing that may never be
done is the compromise between the two — a digit that names the eighth row and
lands on the ninth is exactly the failure `panes.ts`'s position rule exists to
prevent, so moving a pane and leaving the digits alone is not an option.

Both readers that put the digit into a string — `Sidebar.tsx`'s
`aria-keyshortcuts` and `QuickOpen.tsx`'s `detail` — were unguarded and failed
*silently*: a screen reader announcing `Meta+undefined`, a palette printing
`⌘undefined`, neither a type error nor a throw. The optional field makes that a
compile-time obligation rather than a warning in a docblock, and it is why this
reordering needed no change in either reader. The docblock in `panes.ts` that
stated the ceiling was itself once wrong about which row sat on it (it said
Knowledge, which has been seventh since it moved above the two configuration
panes and is seventh still, with Dreaming under it).

**The scan deduplicates on the record, never on the signature, and the
distinction is load-bearing.** A resumed session copies its earlier records into
the new transcript, so the same failure is written twice in two different files
and a per-file pass cannot see it — `transcripts.ts` already dedupes across
files for exactly this reason. Measured: 2,567 error blocks carrying 2,435
distinct `tool_use_id`s, **132 surplus, 5.1%**. It moves the counts and not the
policy: no copied-forward record was ever found on a different day from its
original, so the same 78 signatures span two days either way. A future change
that deduplicated on the *signature* instead would silently collapse a genuine
recurrence into one sighting and stop writing notes at all, which is why
`dreamingScan.test.ts` asserts the day span as well as the instance count. This
was found by the first note the feature ever wrote — the agent re-derived the
counts from the corpus rather than trusting the ones it was handed.

**Steering an agent to consult the vault is cheaper than letting it
investigate, and the steering belongs in the skill rather than in every prompt.**
Three runs on 2026-09-02, same question about the `bwrap` and `git add` failures
the first night had written up:

| | vault searches | cost | time | tool calls | errors |
|---|---:|---:|---:|---:|---:|
| unsteered, old skill | **0** | $1.63 | 369s | 52 | 24 |
| steered by prompt | 7 | $0.75 | 83s | 15 | 2 |
| unsteered, **widened skill** | 1 | $0.90 | 190s | 14 | 6 |

The first two differ only in one paragraph of prompt; the third differs from the
first only in `renderVaultSkill`'s text. **The skill was enabled for all three
and the first never searched it** — availability is not what makes an agent
check, the trigger is, and the old description's trigger was reactive ("when
asked what is known"). Widening it to name *investigating a failure* recovers
most of the gain with no prompt-level steering at all: 45% cheaper, 73% fewer
tool calls, 75% fewer tool errors than the same question unsteered.

The clause costs **54 tokens on every cycle of every run**, which is the honest
price of a description: about $0.03 a day at a hundred cycles, and one avoided
rediscovery pays for a month of it. It was trimmed from 76 tokens for exactly
this reason — the description is the one part of a skill that is never free.

Two findings from those runs that bear on the whole feature. The unsteered run
reached a confident conclusion from n=19 that **contradicts** the vault's n=9,269
measurement, which is the failure the store exists to prevent. And the
vault-reading run did not merely relay: it found that the note's own advice
(gitignore `.bash_profile`) was incomplete, because git stops at the first
refusal and ten more character devices sit behind it. A reader that verifies is
worth more than one that quotes, and the skill's grading table is what keeps the
difference legible.

**The cursor is an instant and never a day, and this is the fault that would
have stopped the feature dead.** `reconcileDreamingOnBoot` exists to stop a
restart replaying a window it missed — `reconcileSchedulesOnBoot`'s rule. It set
a `YYYY-MM-DD` day key, and the tick returned whenever `cursor === today`, so a
boot closed **the rest of that calendar day** along with the window it meant to
close. This server restarts on every `docker compose up --build` and on every
host reboot, so on a machine rebuilt most days the nightly pass would have fired
approximately never, with an empty Nights tab and no error anywhere.
`schedules.ts` keys on an instant for precisely this reason. `dreamingDue` is
split out from the tick so the clock can be tested without a timer, and a cursor
that has never been set does **not** fire — it arms instead, so a fresh install
or a restored backup cannot start an agent because of a window it has no record
of deciding.

**Enabling the setting arms the clock, because `startDreaming` at boot alone was
a switch with no timer behind it.** `armDreaming` sets the cursor only when
there is none: the settings page re-sends every field on every save, so
re-arming unconditionally would push the cursor past a window about to fire and
give a nightly job that silently skips any day the operator opened Settings. And
turning the switch on never fires a window that has already passed — that is a
press of Save, not a press of Run, and the pane carries an explicit button for
the case where the operator does want it now.

**A night refuses while the previous one is still running.** Nothing else
stopped two nights overlapping, and what they would overlap in is the operator's
live document store — `knowledge.ts:39`–`:44` refuses a background writer over
exactly that hazard, and two of our own agents editing one vault is the same
hazard with this app on both ends of it. `liveDreamingRun` keys on the
`dreaming:` prefix in `origin_ref`, because `origin` is `schedule` or `form` and
every other run in the app uses both. Every non-terminal status counts as in
flight, `queued` and `paused` included. The run also carries a wall-clock cap:
six cycles has no bound in time, and the thing being bounded is how long an
agent holds somebody's vault open.

**There is no eviction bound on the scan memo and that is deliberate**, which is
the one place this feature does not follow `transcripts.ts`. That cache holds
parsed turns and needs `TRANSCRIPT_CACHE_MAX_ENTRIES`; this one holds a
size/mtime stamp per file plus the error results, and the whole error corpus is
0.90 MiB across 23 days. It is bounded by the retention horizon through
`forgetDreamingFiles`. If it ever holds successful results it needs both.

**Both lists on the pane say when they are cut.** `git-and-review.md`'s rule,
and it matters most here: the notes table is the record of what this app has
written into a store with no version control, so a list that silently stopped at
500 would read as complete when it is not.
