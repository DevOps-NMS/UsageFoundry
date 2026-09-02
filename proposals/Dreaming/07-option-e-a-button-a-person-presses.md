# Option E — a button a person presses

Same reader, same writer, no clock. A **Dream** control somewhere an operator
already is — the dashboard's day, a finished run, the `/runs` list with a date
filter — reads whatever the operator scoped it to and produces the note. Nothing
happens on any night nobody presses it.

| | |
|---|---|
| **fires** | a person, with the scope in their hand |
| **reads** | whatever the press names — a day, a run, a repository |
| **writes** | wherever the paired option writes; the press does not change the sink |
| **authors** | a model, on a person's instruction |
| **retracts** | the person who pressed it, who knows it exists |
| **costs** | per press, and zero when nobody presses |

---

## The strongest case

**It is refused by nothing.** `src/lib/review.ts:34`–`:35` is a rule about
automatic spend — "Neither is ever automatic. Both cost money, and spend nobody
asked for is spend nobody authorised" — and a press is the asking.
`proposals/ContinuousImprovement/16-recommendation.md:175`–`:177` says so in as
many words about the same shape: "A **manual** button on a finished run is
refused by none of that and costs $1.82 a press; if anybody wants this shape,
that is the one to build." Option E is that sentence applied a day at a time
instead of a run at a time.

**Every guard that ought to bound this feature already works on a press.**
`installBudgetVerdict` (`src/lib/installBudget.ts:152`) is what "every door
reads: may this install start something that spends?" A press goes through a
route handler, a route handler is a door, and the door can ask. A clock has no
door — and `installSpend` cannot see `run_reviews` anyway
(`05-option-c-failures-only.md`, defect 3), so an automatic assist spends
outside the ceiling entirely while a pressed one at least has a place to put the
check.

**The scope is the operator's, and scope is most of the quality.** The single
best artefact this whole survey found — the Inbox question at
`06-option-d-question-capture.md` — is good because a session that had just done
the research wrote it about the thing it had just been doing. A nightly pass has
no such scope: it gets whatever fell inside a timezone boundary. A press gets
whatever the person pressing it was thinking about.

**It answers the "who can retract it" question by construction.** The person who
caused the sentence to exist knows it exists, knows when, and knows what it was
about. Under any automatic option, a wrong note in a vault with no `.git` is
found by accident months later; under Option E it is found by the person who
pressed the button, on the day.

**And it is free until it is used.** Zero nights cost zero. The comparison in
`13-comparison.md` weights that heavily, because every automatic option pays on
2026-08-20 (4 sessions, $84.45) exactly what it pays on 2026-08-14 (107 sessions,
$2,356.29).

## Where it breaks

**It does not do what was asked.** The brief says *once a day, something reads
every session of that day.* Option E says: nothing reads anything unless you ask
it to. That is a different feature, and pretending otherwise would be the kind
of quiet narrowing this survey is supposed to refuse. It should be scored as
what it is — the automatic feature with the automatic part removed — and the
comparison does that by scoring "does what was asked" as its own criterion,
which Option E loses outright.

**The days nobody presses are the days it would have mattered.** The argument
for a daily cadence is that a person who has just spent eleven hours on
something is the last person who will sit down and ask what they learned. A
button relies on exactly the attention the feature exists to replace. This is
the strongest case *against* Option E and it is not answerable from measurement;
it is a claim about the operator, and the operator is the one who should settle
it.

**It inherits its sink.** A press does not license a write. Option E paired with
Option A's sink still violates `knowledge.ts:39` and `AGENTS.md:115`; Option E
paired with Option D's sink is licensed. **The press fixes authorisation, not
destination**, and the comparison scores the two separately for that reason.

**Nothing measures whether the output is worth it.** Same as everything else
here: `Does a Standing Instruction File Change What an Agent Produces.md:27`
bounds any correctness gain at "10 to 15 points and probably zero", and nobody
has run the powered test. A press is cheaper to be wrong about, not more likely
to be right.

## Where the button would go, and what it would cost

Three placements, in ascending order of how much has to be built:

1. **On a finished run.** The smallest, and already surveyed:
   `proposals/ContinuousImprovement` measured $1.82–$4.04 per assist on this
   install (`10-option-retrospective.md:311`) and priced the manual button at
   $1.82 a press. It is one `AssistKind`, one row, one card — and the three
   defects in `05-option-c-failures-only.md` all have to be fixed first, because
   a third `AssistKind` inherits a ten-minute clock and logs itself as a review.
2. **On a day, from the dashboard.** Needs a day-scoped reader over the
   transcript corpus, which is a new thing: `transcripts.ts` walks the corpus for
   tokens and tool shapes and never returns text (`:346`, `:485`). Cost per
   press is `02-what-a-day-contains.md`'s table — $0.06 to $78.31 depending on
   slice.
3. **On a repository, over a window.** Needs both, plus a scoping rule for what
   "this repository's sessions" means when the link between a session and a
   repository is a cwd slug.

## Verdict

**Keep, as the firing mechanism for whichever sink wins.** Option E is not a
Dreaming; it is the answer to "what fires it", and on the evidence it is the
only answer that is refused by nothing. Paired with Option D's sink it is the
survey's second recommendation. Paired with Option A's or C's sink it is still
refused — by the destination, not by the trigger.
