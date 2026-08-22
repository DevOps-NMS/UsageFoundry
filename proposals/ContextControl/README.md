# What a run carries between work cycles

**Closed 2026-08-21 with a recommendation against every mechanism it surveyed.
Revised 2026-08-22 against context research in the operator's vault; the
recommendation holds and holds by more.** Thirteen options for making a run
carry less — trimming what the app injects, externalising tool output,
compacting, discarding the conversation, delegating, indexing, moving the
volatile prefix, capping what a tool may return, and the provider's own
`context_management` block — weighed against a measurement that supports none of
them yet, and one instrument the measurement does support, which nobody has
built because the question was framed as shortening.

**What the revision changed.** The survey scored its options on cost. Every
published measurement gathered since prices context compression as a
**correctness** event, so `16-comparison.md` now carries an eleventh criterion at
weight 4 and the options are re-scored: Option A's lead widens from 3 points to
9, Option K takes second from Option H, and Option F falls to a clear last with
three independent measurements landing on its exact mechanism. One of the
survey's own observations turned out to be false — the CLI's compaction *does*
leave a marker in the transcript, twenty of them on this install — which makes
one of the two owed repairs smaller rather than larger.
`17-recommendation.md` opens with the decided/open split in one place.

## The recommendation

**Build no context mechanism. Ship Option A — the per-cycle composition readout
on the run page — plus two repairs that are owed whichever way the question
goes. Build nothing else until somebody re-runs
`03-experiment-resumed-vs-fresh.md` against a live model.**
[17-recommendation.md](17-recommendation.md).

Nothing in it is new capability. `scanUsage()` already produces the entries
(`src/lib/transcripts.ts:406`), the `iteration` event already carries the cycle
boundaries (`src/lib/orchestrator.ts:6652`), `agentSpend`
(`src/lib/windows.ts:528`) is the shape of the function, `RunAgentCost` is the
shape of the card, and the classifier is one comparison — `cacheWrite1h >
cacheRead` on the turn after a continuation prompt — which `00-problem.md` has
already run twice. What is missing is a pure function, a field on a DTO and a
table.

**What would overturn it:** re-run `03-`'s two arrangements with a live model in
place of the recorder, on a tree that commits between cycles, and score work
cycles and answers as well as cost. If a fresh conversation per cycle finishes
the same task in the same number of cycles with the same answers, the $152 a
week is real, this recommendation is wrong, and the answer is Option G. `03-`
prices the three runs together at single-digit dollars and gives a four-step
recipe.

**A second fact would overturn part of it in the other direction:** if somebody
runs Wang's constraint-retention experiment on a *re-injected file* rather than
on conversational turns and re-injection turns out to be immune, the correctness
criterion's weight drops, Option F's floor score rises, and below weight 2
Option H takes second place back. That experiment is not this repository's to
run.

**Runner-up:** Option K, moving the volatile prefix — it passed Option H on the
re-score, because K removes nothing from the context and is the only non-A
option the correctness criterion cannot charge. Option H is third and still wins
if two billed questions come back well: whether a cycle's `--max-budget-usd`
bounds its delegated turns, and whether this install's work is separable at all.

## The measurement, and why it says wait

From this install's own transcripts, through the app's own `scanUsage()` and
`pricing.ts`, over the rolling seven days to 2026-08-21 and re-run by the
closing pass:

| | |
|---|---|
| Share of the week's bill that is carried context | **82.1%** — 62.1% cache reads, 20.0% one-hour writes |
| What that is worth as a *discount* | the same 3.3bn tokens as fresh input would be **$16,513** against the $1,651 they cost, on a container bill of $2,700 |
| Share of a session's cost explained by carried context | **r² = 0.935**, against turn count's 0.410 and output tokens' 0.506 |
| The one identified waste | **72 of 99** work-cycle handovers re-writing a conversation nothing had changed, at a median $2.39 |
| Its size | **$173.95 a week** — and if every handover hit the cache, the whole prize is **$163.74, or 6.1%** |
| What causes it | `gitStatus`, in the CLI's own system prompt, regenerated per cycle, ahead of the only cache breakpoint that matters |
| What this app can put on an argv to reach it | one flag, worth **$1.44 to $5.02 a week** |
| Everything this app writes into a ten-cycle run | **4,982 tokens**, against a median long session's 17.8 million carried |
| A fresh conversation that re-reads what it lost | **2.59× dearer** than a resumed one; the break-even is 3.9 KB of re-reading a cycle |
| Options whose measured prize is a measurement rather than a ceiling | **none of the thirteen** |

**82% of the bill being carried context is not 82% of it being waste.** A cache
read is billed at 0.1× the model's input rate (`src/lib/pricing.ts:16`), so that
share is the prompt cache's discount rather than the bill, and
`03-experiment-resumed-vs-fresh.md` measured what happens when the discount is
refused. Every prize figure in the survey descends from one proxy —
39.3% of `Read` bytes belong to files a run never mentions again — which
`00-problem.md` refuses to let anyone treat as an oracle.

## What this app can see today

| | |
|---|---|
| What a run cost | the run page and the dashboard, three sources kept apart |
| What a run *carried* | **nowhere** — no page, no event, no column reads composition |
| Whether a cycle re-wrote its whole conversation | **nowhere** — the $2.40 cycle and the $0.17 cycle are the same `iteration` row |
| What context-shaping environment a run was spawned under | **nowhere** — `childEnv` (`src/lib/orchestrator.ts:5216`–`:5231`) strips six classes and none of the seven context variables is among them |
| Whether the CLI compacted a run's conversation | **nowhere** — but the marker is *there*: a `compact_boundary` record with seven metadata fields, 20 of them on this install, and nothing reads it |
| The fixed prefix, or the retained thinking | **never**, from this source: a median 31,373 invisible tokens and 13,734 stripped thinking blocks |

The last three are live defects independent of the question, and the first two
of them are Phase 0 of
[18-implementation-sketch.md](18-implementation-sketch.md).

*Corrected 2026-08-22.* That fifth row used to read "leaves no marker in the
transcript", on `02-levers-on-the-pin.md`'s finding. It is false — `02-` drove a
session to the `PreCompact` hook but never to a completed compaction, and
generalised from the absence. The repair therefore needs a **reader** rather
than a hook, which is one `subtype` comparison inside a function
(`scanUsage()`) that already walks these files.

## Index

| File | What it is for |
|---|---|
| [00-problem.md](00-problem.md) | What a run carries and what carrying it costs, measured from this install's transcripts |
| [01-constraints.md](01-constraints.md) | What any option has to survive, and `T* = 19·(S/D) − 20` |
| [02-levers-on-the-pin.md](02-levers-on-the-pin.md) | Which levers exist, established by running the pinned binary against a recorder |
| [03-experiment-resumed-vs-fresh.md](03-experiment-resumed-vs-fresh.md) | One long conversation against k fresh ones, on the wire — **and fresh is dearer** |
| [04-option-see-it.md](04-option-see-it.md) | A: do nothing but see it — **recommended** |
| [05-option-trim-injected-text.md](05-option-trim-injected-text.md) | B: shorten what this app injects |
| [06-option-working-notes.md](06-option-working-notes.md) | C: working notes as memory — **rejected in its saving form** |
| [07-option-continuation-brief.md](07-option-continuation-brief.md) | D: an app-assembled brief, a fresh session per cycle |
| [08-option-externalise-tool-output.md](08-option-externalise-tool-output.md) | E: a `PostToolUse` hook that replaces a large result — **its store rejected, not its hook** |
| [09-option-app-driven-compaction.md](09-option-app-driven-compaction.md) | F: compaction driven by this app — **rejected by name, now with three measurements of its own mechanism; last on the re-score** |
| [10-option-context-guard.md](10-option-context-guard.md) | G: a ceiling on what a run may carry — **the answer if the experiment goes the other way** |
| [11-option-delegation-as-isolation.md](11-option-delegation-as-isolation.md) | H: push read-heavy work into delegated turns — **third on the re-score, and still what a billed answer would promote** |
| [12-option-retrieval-index.md](12-option-retrieval-index.md) | I: retrieval instead of reading — **rejected by name** |
| [13-option-shorter-units.md](13-option-shorter-units.md) | J: shorter units by construction, on `continueBranch` |
| [14-option-move-the-volatile-prefix.md](14-option-move-the-volatile-prefix.md) | K: `--exclude-dynamic-system-prompt-sections` — **runner-up on the re-score; ships beside A if anything does** |
| [15-option-cap-tool-output-at-the-source.md](15-option-cap-tool-output-at-the-source.md) | L: the CLI's own output caps — **`CLAUDE_CODE_MAX_OUTPUT_TOKENS` rejected by name** |
| [16-comparison.md](16-comparison.md) | Weighted criteria before the scores, the eleventh criterion added 2026-08-22, and the five options that are two decisions taken in different places |
| [17-recommendation.md](17-recommendation.md) | The case, the overturning fact, the runner-up, what is rejected, and what a person would have to accept to overrule it |
| [18-implementation-sketch.md](18-implementation-sketch.md) | Five phases, the invariant each must not break, what an operator sees, and which one earns a test |
| [19-validation.md](19-validation.md) | Verdict table, the re-run measurements, the re-run pin probes, what is unverifiable and every experiment gathered — plus the 2026-08-22 second pass and its seven probes |
| [20-option-api-context-management.md](20-option-api-context-management.md) | M: the provider's own `context_management` block — **rejected on reachability: no argv this app emits and no `--settings` key gets to it at CLI 2.1.226** |

Every option file answers the same ten headings — the strongest case, its shape,
what leaves the context and when the decision is taken, what it does to the
prefix cache, what it does to the DONE contract / `needs-review` / `--resume` /
retention, guards and the three cost sources, what the operator sees and how
they override it, how it fails and whether loudly, what it costs to build, and
what would have to be true — so [16-comparison.md](16-comparison.md) is a table
over a fixed set rather than over twelve arguments.

**On the numbering.** The four closing files carry on from `15` rather than
taking ModelRouter's `12`–`15`, because this survey ran to twelve options and
those numbers are option files. Nothing was renumbered.

`20-option-api-context-management.md` breaks the pattern deliberately and is the
one file whose number does not say what kind of file it is. It is option **M**,
the thirteenth shape, added by the 2026-08-22 revision — and it takes `20`
rather than a number among the option files for the same reason the closing
files took `16`–`19`: **nothing is renumbered, ever**, because every citation in
this directory and in `19-validation.md`'s reference resolver is by filename.
The cost is that a reader cannot tell from the number that `20` is an option
file. The alternative was renumbering four closing files and rewriting several
hundred cross-references to save one line of explanation. A future option would
take `21`.

## Corrections made to the survey by the closing pass

*The 2026-08-22 revision added one more, and it is the largest of the set:*
**the CLI's compaction does leave a marker in the transcript.**
`02-levers-on-the-pin.md:291`–`:303` said it does not, `17-recommendation.md`
built a repair on that, and this README's own table carried it. All three are
corrected. *Easier* — the repair is a reader rather than a hook. The second
pass's other six probes and everything it could not reach are the dated section
at the end of [19-validation.md](19-validation.md).

[19-validation.md](19-validation.md) resolved every citation in `00-` through
`18-` mechanically, re-ran every measurement, and rebuilt
`02-levers-on-the-pin.md`'s recorder to re-run the pin probes — which
`proposals/ModelRouter/15-validation.md` explicitly did not do. **Eight things
were wrong and all eight were fixed in place.** Whether each made the
recommendation easier or harder:

- **Fifty bare `` `:NNNN` `` references chained off the wrong file**, across
  eight of the sixteen files. *Neither* — it is a legibility defect, and it is
  the same class `proposals/ModelRouter/15-validation.md` found, recurring after
  a commit on this branch claimed to have fixed it.
- **`docs/agent/architecture.md:131` cited for a claim it does not carry.**
  *Neither.* That pass's finding #3, recurring at a different line in a
  different proposal.
- **Option H's break-even was out by a factor of four, in H's favour** — a
  delegation pays for its own prefix at two-thirds of one mean-sized read, not
  three. **Harder.** It is the only correction that moved a number in an
  option's favour, and it is why H is the runner-up rather than a curiosity.
- **The `--autocompact` range error was quoted truncated**, dropping a tail that
  says the flag takes `200` as shorthand for 200k. *Neither.*
- **The file-read cap's paging instruction was paraphrased rather than quoted.**
  **Easier, slightly** — the real text names the file's total token count and
  the cap, so the CLI's invitation to page is more explicit than the paraphrase
  made it look, and paging is what bounds Option L.
- **The tool block re-measures at 109,800 bytes, not 111,472**, same pin, same
  28 tools. *Neither* — it makes Option I's per-tool standing cost good to 2%
  and not better, in both directions.
- **`14-`'s flag probe exits 124 with `Execution error`, not 143 with
  `Terminated`.** *Neither.* The material claim — the flag parses where an
  unknown one exits 1 — reproduces exactly.
- **`grep -c system-reminder` "over a container transcript" no longer returns
  0** on 33 of 604 container transcripts, every one of them because an agent
  grepped for the string, **this proposal's own measurement runs included**.
  *Neither* — the named file still returns 0, and the fix is to name it.

And one thing nobody had claimed, found by the re-run:
**`CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` is enforced against a
`/v1/messages/count_tokens` answer rather than a local count.** With a recorder
returning a fixed count the cap never fires at any value. That makes the
recommendation **easier**: Option L costs an extra provider round trip per large
read and stops applying silently on a network where that endpoint does not
answer, neither of which was in its file.
