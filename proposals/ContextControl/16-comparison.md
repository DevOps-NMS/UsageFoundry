# Comparison

**A note on the numbering.** This survey ran to twelve options, so `04` through
`15` are option files and the four closing files carry on from `16`. Nothing was
renumbered: the option files cross-reference each other by letter, and the
numbering the four runs before this one wrote is left exactly as they wrote it.
The same choice `proposals/ModelRouter/12-comparison.md` records, for the same
reason.

## Two groups of options are one decision taken in different places

Say this before the table, because otherwise five rows read as five mechanisms.

### D, G and J are the same act: clear `sessionId` at a cycle boundary

All three end in a fresh conversation where a resumed one would have been. The
mechanism is one assignment to the local at `src/lib/orchestrator.ts:6319`,
which `nextPrompt` branches on (`:4330`) and `buildArgs` reads for `--resume`
(`:4874`). Not one of them changes what is sent *inside* a conversation. They
differ only in **who takes the decision and when**:

| | Decision taken by | When | What the next cycle opens with |
|---|---|---|---|
| D | this app, unconditionally | every cycle boundary | an app-assembled brief: task, `run_events`, `runDiff`, last cycle's final text |
| G | this app, on a threshold | the boundary after a ceiling is crossed | the same, or just the task plus `priorWorkNotice` (`src/lib/orchestrator.ts:4417`) |
| J | a person, at design time | a workflow block boundary | block 2's own task text, and the branch |

Three consequences follow from scoring them together rather than apart, and each
is a real difference inside one mechanism.

**J costs nothing to build and the other two do not.** `continueBranch` is a
field on the edge (`src/lib/workflows.ts:321`), validated at `:809`–`:890`,
checkboxed in the editor (`src/components/WorkflowEditor.tsx:1571`–`:1572`) and
already used by every loop pass (`src/lib/workflows.ts:4678`). D and G need a
fourth `nextPrompt` branch, a brief-builder, a settings key and one `addColumn`.

**J does not break `runs.session_id` and the other two do.**
`resumableSessions` (`src/lib/retention.ts:590`) builds `keepSessions` from one
`session_id` per run, so under D or G every earlier cycle's transcript falls to
`transcriptRetentionDays` (30, `src/lib/settings.ts:633`) **while the run is
still live**. Four blocks are four rows and four protected sessions.

**Only G can decline to act.** `03-experiment-resumed-vs-fresh.md` measured a
fresh cycle as *cheaper* than a resumed one only while it re-reads under about
3.9 KB, so on the 27% of handovers that would have hit the cache the trade is
negative. D pays that every time; G is the version that does not; J does not
arise, because a block boundary is a task boundary rather than a cycle boundary.

### E and L are the same act: cap a result before it enters the conversation

Both intercept content on its way in rather than removing it afterwards, so both
have `01-constraints.md`'s cut point at the tip — `S = D`, `T* = −1`, no
invalidation, ever. Both act on the same bytes: `Read` results, 72.1% of
tool-result bytes and 46% of a whole main-thread conversation
(`00-problem.md`; the closing pass re-measures 71.8% and 46.2%). Both leave the
model free to undo the saving by asking for the
rest. They differ only in **who does the intercepting**:

| | Executor | Where the dropped content goes | Off switch |
|---|---|---|---|
| E | a `PostToolUse` hook this app ships, on `--settings` | a file this app keeps — a fourth store | a threshold in Settings |
| L | the CLI's own `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | nowhere; the model is told to page | a compose key |

That difference is not small and it runs both ways. E can hand the operator the
whole result back, because it is a file; L cannot. L invents no store, no sweep
and no horizon, where E's fourth store holds "by construction the largest things
the runs produced" — the CLI's own equivalent is 82.1 MB on this container
(re-measured; `00-problem.md` says 81.7 MB). And E's failure is visible on the
`hook_response` event `handleStreamLine` (`src/lib/orchestrator.ts:5830`)
already reads, where L's is a typo that does nothing and says nothing.

### C and H are one shape, and are not merged

Both are a sentence added to `nextPrompt`'s output
(`src/lib/orchestrator.ts:4299`); both cost the same to build; both fail the
same way, which is that the model does or does not comply and nothing checks.
But they differ in *what is asked* rather than in where the asking happens, and
their arithmetic differs in sign — C makes the conversation strictly larger and
H makes it smaller. They keep separate columns and this paragraph is the note
that they are siblings.

## The criteria, and their weights, stated before the scoring

**Eleven criteria as of 2026-08-22.** Ten came from `01-constraints.md`'s closing
list and the fixed ten headings every option file answered. The eleventh —
correctness — was missing, and its absence is the one substantive defect the
closing pass did not find in itself: the survey scored twelve mechanisms on what
they cost and none on what they break. The weights encode a judgement about
*this* measurement: a bill that is 82% carried context **at a tenth of the input
rate**, a single identified waste of $173.95 a week that no lever this app holds
reaches, and a survey in which no option's prize is measured rather than
bounded. Disagreeing with the weights is the cleanest way to disagree with
`17-recommendation.md`.

### The eleventh criterion, and why it is weighted 4

Every published measurement of context compression that has been gathered since
this survey closed prices it as a **correctness** event rather than a cost one.
Four, all held in the operator's vault, all graded there, and the grades are
carried rather than flattened:

| Source | Grade | What it measures | What it says |
|---|---|---|---|
| `/workspace2/3 Resources/Sources/Governance Decay (Chen 2026).md` | `evidence: preprint`, `peer_reviewed: false`, `confidence: medium` | 1,323 episodes, seven model families; prohibited-action rate before and after one compaction | 0% → **30%** overall, 59% on the worst model. Mediated entirely by survival: "when the constraint survives the summary, violation remains 0%, but when it is dropped, violation reaches 38%" |
| `/workspace2/3 Resources/Sources/Lost in Compaction (Wang et al 2026).md` | `evidence: preprint`, `confidence: low`, `status: seed` | constraint retention through compaction | "Current compactors retain only **17%** of injected SCs on average, and most perform worse than running the same task without compaction" |
| `/workspace2/3 Resources/Sources/Toward Reliable Context Compression for Long-Horizon Agents (Min et al 2026).md` | `evidence: preprint`, `confidence: medium` | AppWorld task success under three context regimes | full context **85.7%**, summary compaction **72.8%**, FIFO **42.2%**. At a 2K budget the summary condition "terminates in only 44.6% of samples, with 37.3% using the required form, compared with 77.2%/68.1% for FIFO" |
| `/workspace2/3 Resources/Sources/Instruction Adherence in Coding Agent Configuration Files (McMillan 2026).md` | `evidence: preprint`, `confidence: medium` | 1,650 sessions, 16,050 function-level observations of config-file rule compliance | four **structural nulls** (BF 0.05–0.10 for instruction size and for conflict), and one effect: "approximately 5.6% lower odds of compliance per step (OR = 0.944)" per function generated, 95% CI [0.937, 0.951] |

**Weight 4, above every gate and below nothing.** Three reasons, and the
counter-argument, which is real.

It is the only criterion that prices the *product* rather than the bill. Every
other row asks what an option costs to build, to operate or to be wrong about;
this one asks whether the agent still does the job. An option that saves
$173.95 a week and raises the prohibited-action rate to 30% has not made the
fleet cheaper, it has made it different and worse, and no weighting of the other
ten rows would say so.

"The two endings survive" is already weighted 3, and it is a **special case of
this criterion** — one named instruction whose loss was priced at $162 over 92
runs. A general criterion cannot sit below its own instance.

And the four measurements agree on a *mediator* rather than on an effect size,
which is what makes them usable here. Chen's 0% versus 38% split turns entirely
on whether the constraint text survived; Wang's 17% is a retention rate; Min's
gap is between having the context and having a summary of it. Every one of them
scores the same thing: **how much of what the agent was told is still there,
and who chose**. That is an axis, not an anecdote.

**Against a higher weight, and it is why this is 4 and not 6.** All four are
preprints. None is peer-reviewed. None has been replicated. Each uses its own
benchmark, and two of the four also publish the fix for the problem they
measure. Chen compacts **once** per episode and measures rule violation rather
than task accuracy; Wang was read at abstract-and-listing depth only, three
weeks old, and its constraints are *issued in conversation* rather than
re-injected from a file; Min is a method paper for TRACE reporting "one point on
one benchmark under one budget setting"; McMillan's decay result is explicitly
post-hoc and exploratory, pre-registration is not stated, and it sits beside the
paper's four *primary* nulls. Most importantly for
this app: **not one of them tests a re-injected file**, which is exactly what
the survival table in `01-constraints.md` says happens to `CLAUDE.md` and
unscoped rules here. The vault says so itself — "nobody has run that experiment
on a re-injected file".

**And the baseline moved, which is why this criterion bites even on options that
do nothing.** The survey scored against a world in which nothing compacted.
`ee93684` put `--autocompact` on every cycle's argv on 2026-08-21, and 18
`compact_boundary` records are now in the corpus (`01-constraints.md`). So
"0 = no change from today" now means *as much compaction as the CLI already
does on its own*, and the correctness price in the table above is being paid on
this install today, by default, unscored. An option scoring 0 on this row is not
avoiding that price. It is declining to add to it.

| Criterion | Weight | Why that weight |
|---|---|---|
| **Correctness cost of the compression** | **4** | Added 2026-08-22. The four measurements above, and the argument for 4 rather than 3 or 6 immediately preceding. The only row that prices what the agent does rather than what it costs. |
| Measured prize | 3 | What the thing is for — and `00-problem.md` refuses the broad claim outright, so an option that cannot show a measured prize is arguing against the file that opened the survey. |
| Where in the cycle it acts | 3 | `T* = 19·(S/D) − 20` (`01-constraints.md:32`). An option that removes a tenth of a mid-life conversation waits 170 further turns, and only 807 of 11,422 turns live past index 160 at all. |
| Loudness of failure | 3 | The standing complaint (`CLAUDE.md`), and the measured shape: `--plugin-dir` not surviving `--resume` is silent, "since a session missing a hook behaves exactly like one that never had it" (`src/lib/orchestrator.ts:4828`–`:4831`), re-confirmed on the pin by this closing pass. |
| What an operator can see afterwards | 3 | This is the finding, not a nicety. "The cycle that paid $2.34 to open with *Continue working on the task* and the one that paid $0.17 for the same sentence are the same row" (`00-problem.md`). |
| Who decides what may be forgotten | 3 | `docs/agent/chat.md:10`'s split, and the one question `01-constraints.md` says an option in that shape has to argue rather than assume. A gate, not a preference. |
| The two endings survive | 3 | Priced: before `COMPLETION_NOTICE` existed, 92 runs cost $162 to say one word into a re-sent conversation (`src/lib/orchestrator.ts:4436`–`:4446`). |
| A fourth store | 2 | Three stores, three horizons, three sweeps (`docs/agent/retention.md:8`); the one that fills the disk holds `.credentials.json` (`src/lib/retention.ts:518`–`:521`). |
| Off, per run, mid-run | 2 | `01-constraints.md`'s five obligations, compressed. Weighted below the gates because every option can satisfy them with work. |
| Build cost | 2 | Real, one-off. 3 is free. |
| Rests on something unestablished | 2 | Weighted **up** for this survey specifically: `02-levers-on-the-pin.md` returns *could not establish* five times in its own verdict table and `03-` could not measure answer quality at all. An option whose case turns on one of those is not a cheaper option, it is an unmeasured one. |

**How sensitive the ranking is to the one weight most worth arguing about.**
Option A scores 0 on measured prize by construction, so its total does not move
with that weight at all; Option H scores +1 and D·G·J +2. On the ten-criteria
table, solving for where they overtake gave a weight of **7** rather than 3: H
reached +21 and D·G·J +22 against A's unchanged +20, and the recommendation
inverted. **On the eleven-criteria table that crossing moves to 12.** A is +24
regardless of the prize weight; D·G·J totals `2p` and needs `p > 12`, H totals
`10 + p` and needs `p > 14`. So a reader now has to believe the unmeasured
prize is worth **four times** what this table says before the discard family
overtakes the readout, where before it was a little over twice.

That is a large move from one added row, and it should be read with suspicion
rather than satisfaction: a criterion introduced after a recommendation was
written, which then strengthens that recommendation, is exactly the shape of a
criterion chosen to strengthen it. Three things are offered against that
reading. The criterion was named by the operator's brief rather than by this
pass. Its weight was argued from the existing "two endings" row rather than
picked to produce a total. And it does **not** simply reward inaction: it moves
K ahead of H, changes B's sign, and leaves the second and third places
different from what they were — which a criterion built to protect A would not
need to do.

The next most sensitive weight is loudness, which would have to be **6** rather
than 3 before Option K displaced A on the old table — K carries the only +3 on
that axis and A only a +1. On the new table A gains 4 and K gains 0, so with
loudness at weight `L` the two are `21 + L` against `6 + 3L` and the crossing
moves from 6 to **8**.

**And the K-versus-H swap is the one crossing the correctness weight itself
controls.** H is `17 − w`, K is a flat `15`. They tie at `w = 2`; below that H
leads, at 3 and above K leads. So a reader who thinks the four preprints are
worth *something* but not much — weight 1 or 2 — keeps the old second place. The
swap is not robust to a low weight and is stated here rather than buried in the
total.

Two things are deliberately **not** scored. **Which layer an option acts on** —
the argv, the injected text, the folder, the session lifecycle, this app's
accounting, the environment of the spawn — is a position each option takes
rather than an axis it wins; it is laid out side by side below. And **how much
of the bill an option can theoretically reach** is not scored separately from
the measured prize, because rewarding reach on a question where every prize is a
ceiling on a proxy would reward the least disciplined arithmetic.

## Scores

0 = no change from today. Signed: negative is worse than today. Build cost alone
runs 3 = free. Merged columns carry the family's score, with the within-family
spread named underneath.

| | A: see it | B: trim text | C: notes | D·G·J: discard | E·L: cap the result | F: compact | H: delegate | I: index | K: move the prefix |
|---|---|---|---|---|---|---|---|---|---|
| **Correctness (×4)** | **+1** | −2 | −1 | −2 | −1 | **−3** | −1 | −2 | **0** |
| Measured prize (×3) | 0 | 0 | 0 | **+2** | +1 | 0 | +1 | 0 | +1 |
| Where in the cycle (×3) | 0 | +2 | 0 | +1 | **+3** | +2 | **+3** | +1 | +1 |
| Loudness (×3) | +1 | −1 | −2 | −2 | −1 | −2 | −2 | **−3** | **+3** |
| Operator can see (×3) | **+3** | 0 | +2 | +2 | −1 | −1 | +2 | −1 | −2 |
| Who decides (×3) | 0 | 0 | −1 | **+2** | +2 | **−3** | +1 | 0 | 0 |
| The two endings (×3) | 0 | **−3** | −1 | +1 | −1 | **−3** | 0 | 0 | 0 |
| Fourth store (×2) | 0 | 0 | −1 | −1 | −2 | +1 | +1 | **−3** | 0 |
| Off / per run / mid-run (×2) | 0 | 0 | 0 | +1 | +1 | +1 | 0 | +2 | +1 |
| Build cost (×2) | +2 | **+3** | +2 | +1 | +1 | +2 | **+3** | −2 | **+3** |
| Rests on the unestablished (×2) | **+2** | +1 | −2 | −3 | −2 | −3 | −3 | −2 | −1 |
| Weighted total, ten criteria | +20 | +2 | −8 | +14 | +5 | −19 | +17 | −19 | +15 |
| **Weighted total, eleven** | **+24** | **−6** | **−12** | **+6** | **+1** | **−31** | **+13** | **−27** | **+15** |

**Within D·G·J:** J takes +3 on build cost (nothing is built) and 0 on the
fourth store (four rows, four protected sessions) against the family's +1 and
−1; G takes +2 on "where in the cycle" against D's 0, because a threshold is
what stops the option paying $0.13 on the 27% of handovers that would have hit
the cache. Scored separately the three come out at roughly D +8, G +16, J +19 —
and J's +19 is bought entirely by the two axes on which it is not really an
option at all: it costs nothing because it ships, and it is safe because it is
what a loop block already does.

**Within E·L:** L takes +3 on build cost against E's −1, because a zero-build
variant exists — set the variables in compose and let `childEnv`
(`src/lib/orchestrator.ts:5216`–`:5231`) inherit them, which it already does. E
takes 0 on the two endings against L's −2, because
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` bounds `res.finalText`, which is exactly what
`cycleEnding` (`:4543`) matches. And E takes −3 on the fourth store against L's
0.

## The correctness row, cell by cell, and what it moved

*Added 2026-08-22.*

**A: +1, and the point is conditional on a change to Option A.** A removes
nothing, so 0 is the floor-and-obvious score. The +1 is for the one thing no
other option does: Chen's entire effect is mediated by *whether the constraint
survived the summary*, which means the operationally useful quantity is not
"did a compaction happen" but "what did it keep" — and a per-cycle composition
readout is the only place in this app that could ever show either. **This is a
new requirement on Option A rather than a free point**: the readout as specified
in `04-option-see-it.md` reports carried context and carried write, and it must
also report the compaction boundary, which `01-constraints.md` now proves the
transcript carries as a `compact_boundary` record with `preTokens`, `postTokens`
and `durationMs`. Without that addition A scores 0 and totals +20.

**B: −2, and this is the sign change worth arguing about.** B trims injected
text — the notices, the guidance, the standing instructions this app writes.
Under Chen the quantity that predicts violation is whether the constraint text
is present, and B's whole mechanism is making less of it present, permanently,
on every cycle, by design. Its existing −3 on "the two endings" was the narrow
form of this; the correctness row is the general form, and it takes B from +2 to
−6 — from a small positive to a small negative. B is no longer a free win.

**C: −1.** The agent writes notes and the notes replace history. The loss is
**recoverable** — the note is a file the agent can re-read — and the vault's own
synthesis of the 2026 literature is that recoverability is the axis that
matters: "the choice between them is not how much you lose but **whether the
loss is recoverable**"
(`/workspace2/3 Resources/AI Context and Memory/Compaction and Context Editing.md:23`).
What keeps C negative rather than 0 is that *what gets written down* is the
model's choice, which is Wang's 17% with an extra step.

**D·G·J: −2, and yes, this partly restates "rests on the unestablished".** The
two rows measure different failures and both are earned. "Rests on the
unestablished" asks whether the +2 prize is real. Correctness asks what happens
**if it is** — a fresh agent per cycle is not summary compaction and not FIFO,
it is the condition none of the four papers ran, and Min's ordering (full
85.7% > summary 72.8% > FIFO 42.2%) is monotone in how much of the context
survives, with the discard family sitting off the bottom of that ordering.
`03-experiment-resumed-vs-fresh.md` remains the experiment that would settle it,
and the correctness criterion is the reason it is now the *blocking* experiment
rather than a nice-to-have.

**E·L: −1.** A capped tool result is content that never enters the conversation,
so none of the four measurements applies directly: nothing is summarised and
nothing is evicted. It is negative rather than 0 because a truncated result is a
fact the agent did not receive, and because L truncates the model's **own
output**, which is where `cycleEnding` reads the sentinel. Within the family L
takes −2 against E's −1, for the same reason L already takes −2 on the two
endings.

**F: −3, the floor, and the only option in the survey where all four
measurements land on the mechanism itself.** F is app-driven compaction: ask a
model to summarise the conversation, continue from the summary. That is Chen's
independent variable, Wang's subject, and Min's `summary` condition, by name.
The rejection is written out with citations in
`09-option-app-driven-compaction.md`; it used to be a judgement and now it is
not.

**H: −1.** A sub-agent starts from a written brief and the parent keeps its
context, so the loss is designed, bounded and reversible by the parent. What it
is not is free: the brief is a summary, written by a model, of what the
sub-agent needs — Wang's shape at one remove. H's fall from +17 to +13 is what
costs it second place.

**I: −2.** Retrieval over history means a constraint is present if and only if it
is retrieved, which is Chen's mediator with a retrieval miss added underneath
it. Nothing in the four measurements covers retrieval, so this is the least
evidenced cell in the row and is scored on the mechanism rather than on a
number.

**K: 0, and it is the only non-A option that earns a clean zero.** Nothing
leaves the context, ever; the model receives the same information in a different
block. `14-option-move-the-volatile-prefix.md` says so in its own words — "it is
not a context-reduction mechanism at all. It changes cache geometry." Under a
criterion that prices removal, an option that removes nothing is unpriced, and
K's flat 0 against H's −1 is what moves it from third to second.

**What moved.** A stays first and its lead over second widens from +3 to +9. K
overtakes H for second. D·G·J falls from third to fourth. B changes sign. F
separates from I at the bottom and is now clear last by four points. Nothing
that was below zero rose above it.

**Why Option M is not a column.** `20-option-api-context-management.md` is the
thirteenth shape and the API layer's answer to this survey's question, and it is
rejected on reachability: at CLI 2.1.226 this app cannot emit the
`context_management` block from an argv or from `--settings`, proved by probe.
Scoring an unreachable lever on eleven criteria would put a number on a
hypothetical and invite a reader to compare it with nine real ones. Its one
scoreable property is recorded instead in words: had it been reachable,
`clear_tool_uses` replaces a tool result with **placeholder text** rather than
with a summary, which is the recoverable class the vault says is the one that
survives repetition — so M would have scored above F on this row and below K.

## What McMillan's decay curve implies for the two notices, and what it does not

The brief asks specifically whether the compliance decay bears on
`COMPLETION_NOTICE` (`src/lib/orchestrator.ts:4467`) and `NEEDS_REVIEW_NOTICE`
(`:4507`) in a long resumed conversation. **Mostly it does not, and saying so is
more useful than stretching it.**

The measured effect is "Each additional function the agent generates is
associated with approximately 5.6% lower odds of compliance per step
(OR = 0.944)", 95% CI [0.937, 0.951], p = 1.08 × 10⁻⁴⁶, median first omission at
generation position 4
(`/workspace2/3 Resources/Sources/Instruction Adherence in Coding Agent Configuration Files (McMillan 2026).md:52`–`:54`).
The grade is `evidence: preprint`, `peer_reviewed: false`, `confidence: medium`
— arXiv v1, single author, no venue, no replication. Three things stop it
transferring.

**The unit of decay is a generated function, not a turn, a token or a cycle.** A
work cycle that reads, greps, runs tests and commits generates no functions and
sits nowhere on that curve. There is no mapping from this app's unit of work to
McMillan's *x* axis, and inventing one would be the survey's own house rule
about proxies broken in the other direction.

**The dependent variable is one deliberately trivial style rule** — whether a
`// @tracked` annotation is the first line of every new or modified function,
AST-detected, across five coding tasks on two TypeScript codebases. The vault
records the boundary in its own words: "Nothing here transfers to 'match the
surrounding code' or 'state your assumptions'" (`:70`). A terminal protocol
tested by an exact-string sentinel at the end of a cycle is further from that DV
than "match the surrounding code" is.

**And the decay is the post-hoc result, beside four primary nulls.** The four
factorial factors — instruction size, position in the file, file architecture,
and a directly contradictory instruction in an adjacent `AGENTS.md` — all come
back null. Size and conflict carry Bayes factors of **0.05–0.10**, evidence
*for* the null rather than a failure to reject; position and architecture are
failures to reject with power sufficient to exclude effects larger than **6
percentage points** (`:49`). Pre-registration is *not stated*, and the author
labels the decay itself post-hoc and exploratory (`:41`) — so the strongest
result in the paper is the one with the weakest inferential standing, and it
should not be leaned on.

**One thing here is actionable, and it is the nulls rather than the curve.**
Option B's implicit premise is that a shorter notice is a better-obeyed notice.
The only measurement anyone has of that premise is a Bayes factor supporting the
null, on the axis B is aimed at. So trimming the notices buys tokens and, on the
available evidence, buys **no compliance** — which removes the second half of
B's case and is part of why B's sign changed above. The same nulls remove the
grounds for Option B's sibling argument about *where* in the injected text the
endings sit.

**And one thing is worth naming even though no option addresses it.** If
compliance decays with work done rather than with context length, then this
app's repair — re-issuing `NEEDS_REVIEW_NOTICE` on every continuation cycle
(`nextPrompt`, `:4331`–`:4362`) — repairs *presence* at the cycle boundary, and
the decay, if it is real at all, lives *inside* a cycle. No option in this
survey has a lever there, Option A's readout would not show it, and inventing
one on the strength of a post-hoc analysis of a TypeScript naming rule would be
exactly the sort of thing `01-constraints.md` exists to refuse. Recorded as a
place a lever would have to go, not as a lever.

## Reading the interesting cells rather than the totals

**The `Measured prize` row is the finding, not a tiebreak.** Nothing scores
above +2, and the +2 is a bet rather than a measurement: D·G·J removes the
largest identified line in the bill — $173.95 a week in the re-measured window,
26.3% of the container's cache-write line — *conditional on a fresh agent
finishing the same task in the same number of work cycles*, which `03-` says in
as many words it could not test, because "no model answered any of the five
questions; the recorder returned fixed strings". Every other +1 is a ceiling on
a proxy `00-problem.md` explicitly refuses to call an oracle. **Nine options,
and not one of them can name a dollar it would certainly save.**

**Option A is the only +3 on "what an operator can see", and that column is the
whole argument of `17-recommendation.md`.** It is not a chart. 72 of 99
work-cycle handovers in the re-measured rolling week re-wrote a conversation
nothing had changed, at a median $2.39; 27 paid $0.171 for the identical prompt.
Neither the run page, the dashboard nor `run_events` distinguishes them, because
all three read cost and none reads composition. Every other option in this
survey is a bet on a number nobody can currently read back, and six of them — D,
E, G, I, K and L — say so in their own files, each naming Option A's readout as
the thing that would let it be scored.

**Option K's +3 on loudness is the only one in the table and it is worth the
whole of its case.** `--exclude-dynamic-system-prompt-sections` either parses or
exits 1 at the parser before any API call, measured on this pin against
`--not-a-real-flag`. That is `01-constraints.md`'s "loud, by moving the failure
earlier" shape, and no other option here has it: E's schema mismatch is refused
in a debug line and nowhere else, L's typo does nothing and says nothing, F's
refusal ("fixed prefix ~83280 > threshold 67000 — compaction cannot help") is a
debug line, and C's, H's and I's failure is a model quietly not complying. The
counterweight is named in K's own file and is real: one flag, fleet-wide, that
fails every spawn on a version bump.

**Option F's −3 on "who decides" and −3 on the two endings are one sentence
twice.** A compaction summary is written by a model, and `custom_instructions`
is a field on the `PreCompact` payload that no argv this app emits reaches. So
the option cannot promise that `COMPLETION_NOTICE`
(`src/lib/orchestrator.ts:4466`) or `NEEDS_REVIEW_NOTICE` (`:4506`) survive it —
and a compaction at turn 90 of a *first* cycle removes both from a conversation
that will receive no continuation prompt before it ends, which is precisely the
state the $162 over 92 runs measured. The mitigation `09-` finds in the tree
repairs cycle 2 onwards and not cycle 1, and cycle 1 is where the measured
failure lives.

**Option I's −3 on loudness is a different kind of failure from everything else
here.** Every other option's failure mode is *more expensive*. A stale index is
*wrong*: a fragment returned from an index built before the last three commits
is a confident, well-formed answer against code that no longer exists. Nothing
throws. And its −3 on the fourth store is the only one in the table, because it
is the only store with no liveness question the database can answer —
`docs/agent/retention.md`'s "every sweep asks the database what is live; never a
file's age" has no clean answer for an index, which is stale when *files*
change.

**Options E, H and L share the best arithmetic in the survey and reach different
amounts of it.** All three intercept content before it lands, so all three have
`T*` undefined rather than large. E's ceiling is the biggest number in the
survey at about $213 a week plus about $93 on the write line; H's per-unit ratio
is the best at roughly $0.145 → $0.033 per large read moved; L's is E's
mechanism for free. And all three are bounded by the same fact: the model can
ask for the content back, and `02-levers-on-the-pin.md` shows the CLI
*instructing* it to — "Call Read with offset=388 limit=387 for the next page".

**Option B's −3 on the two endings is what decides it, and its own file says
so.** `COMPLETION_NOTICE` and `NEEDS_REVIEW_NOTICE` are 1,082 of the 1,873 bytes
this app writes per resumed cycle, and they are the two it may not touch. The
four strings it *may* touch are the four an operator can already edit, and on
any install that has pressed Save they are materialised into the stored blob and
a shortened default reaches nobody (`docs/agent/conventions.md:14`). The prize
on the whole exercise is about $4 to $6 a week against a container bill of
$2,700.14.

**Option A's +2 on "rests on the unestablished" is the largest such cell and it
is the quiet reason it wins.** Every input it needs exists: `scanUsage()`
(`src/lib/transcripts.ts:406`) produces the entries, the `iteration` event
carries the cycle boundaries (`src/lib/orchestrator.ts:6652`), `agentSpend`
(`src/lib/windows.ts:528`) is the shape of the function, and `RunAgentCost` is
the shape of the card. Nothing in it waits on a pin verdict, a model's
compliance, or a billed experiment. It is the only option in the survey of which
that is true.

## Which layer, side by side

`01-constraints.md` does not enumerate the layers; the option files do, in their
`Shape` headings, and the distribution is informative:

- **This app's own accounting.** A alone, and G in part — G reads the same
  figure A displays and acts on it. That is the whole distance between an
  instrument and an actuator, and `docs/agent/metering.md` already refuses the
  second without the first for every window guard.
- **The text this app injects.** B, C, H. The layer that needs nothing from the
  CLI and can never fail loudly. `02-levers-on-the-pin.md` has no verdict to
  give about any of the three.
- **The session lifecycle.** D, G, J — and this is the layer the tree contains
  an argument *against*: `looksLikeResumeFailure` stops a run rather than
  starting over, "the honest move is to stop and name the command rather than
  quietly start a fresh session and lose the conversation the resume existed to
  keep" (`src/lib/orchestrator.ts:7113`–`:7117`).
- **The argv.** E (`--settings`), F (`--autocompact`), K
  (`--exclude-dynamic-system-prompt-sections`). The layer where a failure can be
  a non-zero exit, and the layer `buildArgs` already rebuilds per cycle
  (`:6701`) so that nothing has to be re-sent by hand.
- **The environment of the spawn.** F in part, L entirely. The layer that is
  **already live and unrecorded**: `childEnv` (`:5216`–`:5231`) strips six
  classes and none of the seven context-shaping variables is among them, so an
  install whose compose sets one is running a different context regime and
  nothing in this app can tell.
- **The folder.** I alone, which is why it is the largest build: everything else
  reuses a channel this app already has.

## Two things every option owes, and what it costs to leave them out

**A readout.** `01-constraints.md`'s third obligation: "a mechanism whose effect
is invisible in the log is one whose misbehaviour reads as the agent being
stupid." Six option files name Option A's readout as the thing that would let
them be evaluated — D ("this option needs Option A's readout in order to be
evaluated, and does not supply it"), E, G, I, K and L. Only A supplies it, and
only J gets a partial one for free, because four blocks are four rows in the
runs list with four spend figures.

**An honest statement of what the prize is a proxy for.** `00-problem.md` names
the trap in advance: 39.3% of `Read` bytes belong to files a run never mentions
again, and that figure "is a lower bound on what a perfect oracle could have
dropped and an upper bound on nothing". Four options — C, E, I and L — carry a
number derived from it, all four say so, and the survey is better for it. An
option that quoted the $84 or the $213 without the sentence would be quoting a
different measurement.

## Two shapes the survey did not have, and why neither is added

**`--fork-session`.** `02-levers-on-the-pin.md` established it: a new session
id, a **new transcript file**, and the prior conversation carried into the
forked request. A fork per cycle therefore changes nothing about what is sent —
it changes only which file the turns land in, which multiplies transcript count
and breaks `resumableSessions` (`src/lib/retention.ts:590`) the way D does, for
no saving at all. It is the cost of Option D without its mechanism.

**`--no-session-persistence`.** Also established: a fresh id, one message, and
**no transcript file written**. That removes the file `scanUsage()` reads, so a
run under it would cost real money and appear nowhere in `buildSnapshot()`
(`src/lib/transcripts.ts:406` → `src/lib/windows.ts:669`) — every window meter,
every guard fraction and every figure in `00-problem.md` comes from those files.
It is not an option; it is a way of making the whole of this proposal
unmeasurable, and it is named here so that nobody reaches for it later as a
tidiness.
