# Option D — the question capture

The only write the destination licenses. Instead of writing a *learning*, the
pass writes a **question**: one note, into `3 Resources/Questions/Inbox/`, using
that folder's `_TEMPLATE.md`, tagged `meta/inbox`, marked on its face as not yet
vault content, and reviewed by a person before it counts as anything.

| | |
|---|---|
| **fires** | a clock, a threshold, or a person — see below |
| **reads** | any corpus; the output shape is what is constrained, not the input |
| **writes** | exactly one file, into a quarantine folder |
| **authors** | a model, and the note says so in a `> [!warning]` block |
| **retracts** | deleting one file from a folder that is by definition not vault content |
| **costs** | whatever the read costs, plus ~1–3k output |

---

## The strongest case

**This is not a design; it is a licence the vault already issued.**

> "If you are a session from another project and have not read `CLAUDE.md`, you
> do not have the writing conventions and should not write notes here. The one
> exception is a single question capture into `3 Resources/Questions/Inbox/`
> using that folder's `_TEMPLATE.md` — a quarantine that gets reviewed before
> anything counts as vault content."
>
> — `/workspace2/AGENTS.md:115`

Every other option in this directory has to argue its way past that sentence.
Option D is the sentence.

**And it has already happened, from this app, successfully.**
`3 Resources/Questions/Inbox/Does Writing Lessons From a Past Run Stop an Agent
Repeating the Mistake.md` carries `captured_by: "external session"` and
`captured_from: "UsageFoundry — a Next.js app that runs Claude Code headlessly
against a mounted folder, many runs over the same repository"`, was created
2026-08-21, and is the single most useful document this survey found — it is
where `01-constraints.md` C6, C7 and C8 come from. **A UsageFoundry session
writing one question into the operator's quarantine produced a note that then
shaped a UsageFoundry proposal.** The loop Option D closes is not hypothetical;
it has run once, by hand, and it worked.

**The quarantine is a retraction mechanism, which nothing else here has.** The
vault has no `.git` (`01-constraints.md` C4), so for every other option
retraction means a person noticing a file they did not write and deleting it.
For Option D the folder *is* the mechanism: everything in it is provisional by
construction, the note's own closing callout says "Not linked into any MOC and
not counted as vault content until reviewed: promote it …, or delete it"
(`:72`–`:73`), and `qc.py` treats `Questions/Inbox/` as a deliberate quarantine
rather than a convention violation (`_Meta/Vault Quality Control.md:91`).

**A question is the honest output shape for this corpus.** `01-constraints.md`
C6: the corpus holds transcription and not diagnosis, and unverified diagnosis is
measured at 14.2% on the nearest benchmark. A *learning* asserts a cause. A
*question* asserts that something happened and that its cause is not established
— which is exactly what a day's sessions license. The vault's own working
position, "admit transcription, mark diagnosis as a hypothesis, and never let an
unverified stated cause enter a store as a fact"
(`Can an Agent Write an Accurate Record of Its Own Failure.md:27`), describes
Option D's output and forbids Options A, B and C's.

**It is bounded by construction.** *One* note. Not one per learning, not one per
session, not one per run. The volume problem that
`11-deduplication-and-retirement.md` measures for the others does not arise,
because a single file per firing is the licence's own limit.

## Where it breaks

**One note a night is 365 notes a year into a folder that holds three, and the
three are already a backlog.** `ls "3 Resources/Questions/Inbox/"` returns five
files: `_TEMPLATE.md`, `Inbox MOC.md` and three questions, which matches
`AGENTS.md:100`. All three carry `captured_by: "external session"`; **two name
UsageFoundry in `captured_from`** and the third names a research request in
`/workspace`. They were created 2026-08-15, 2026-08-16 and 2026-08-21, all sit
at `status: seed`, `confidence: low`, and **none has been promoted.** The
newest was picked up on 2026-08-26 and its own note records the outcome: "The
triage decision is still open, and this run deliberately did not make it:
promotion means moving a file out of the inbox, and `CLAUDE.md` §11.1 requires
asking before restructuring" (`:60`).

So the licence has been exercised three times in eighteen days by hand, and the
review half of it has not happened once. A nightly capture would put a hundred
and twenty notes into that folder over the same period.

**The vault's conventions bite even in the quarantine.** `AGENTS.md:112` — "Gaps
become seed notes, not checkboxes. If your work raises a question this vault
cannot answer, leave a real note behind with a hypothesis and concrete steps to
resolve it." The Inbox note that came from this app is 74 lines, cites eleven
other notes by name, and states five concrete settlement steps with a power
calculation. **That is what a good capture looks like, and it is the product of a
session that had done the research.** A nightly pass over yesterday's tool errors
does not have that, and a capture without it is a checkbox with frontmatter.

**`AGENTS.md:113` still applies**: `python3 "_Meta/build_index.py"` rewrites
`INDEX.md` (2,633,599 bytes) and every file under `_Meta/index/`. A 2 KB note
obliges a 2.6 MB rewrite, or the next reader gets a stale map. Running a Python
script inside the operator's vault is a wider grant than writing one file, and
not running it leaves the vault in the state its own tooling calls stale.

**And the clock is still the clock.** Option D fixes the *sink* objection and
the *shape* objection. It does not fix `review.ts:34`–`:35`: fired nightly, it
is still spend on a schedule that nobody pressed. Fired by a person, it is
refused by nothing.

## The two firings, scored apart

| | nightly | on a press |
|---|---|---|
| `review.ts:34`–`:35` | refuses | permits |
| `AGENTS.md:115` | permits | permits |
| triage load | 365/year into a folder holding 3 | as many as somebody wants |
| capture quality | whatever last night held | whatever the person was looking at |
| retraction | the quarantine | the quarantine |
| `qc.py` | passes (quarantine) | passes (quarantine) |

**The press form is refused by nothing in this repository or in the vault.**
That is a stronger position than any other row in the comparison, and it is why
Option D on a press is the survey's second recommendation.

## What an operator sees

A file appearing in a folder they already review, carrying `meta/inbox`, a
`captured_by` and a `captured_from` field, and a warning callout saying it was
written by a session that did not have the conventions loaded. That is more
provenance than any other option offers, and all of it is the template's, not
this app's.

While it runs, on a press: whatever the press is attached to. If it is a run,
the run page. That is the one place in this survey where the operator can watch.

## Verdict

**Keep, on a press. Refuse on a clock.** Option D is the only option whose write
is licensed by the destination, the only one with a retraction mechanism that
exists before the mistake, and the only one whose output shape matches what the
corpus actually supports. Its nightly form fails on `review.ts:34`–`:35` and on
a triage backlog that is already visible at n=1. Its pressed form is refused by
nothing — and `14-recommendation.md` ranks it second, behind the option that
costs nothing and writes nowhere.
