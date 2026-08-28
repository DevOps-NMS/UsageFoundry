# Marking inferred reasoning apart from first-hand reasoning

Constraint C1, worked out. This is a cross-cutting design surface, not a badge,
and it is the part of the feature most likely to be quietly dropped under
schedule pressure — so it gets its own file and its own acceptance test.

---

## Why this is the hard part

A decision tree's failure mode is not being empty. It is being **confidently
full**.

The measured situation: run A took 297 acts and wrote 5,578 bytes of prose,
eleven-twelfths of which is stage direction. Its reasoning is empty 210 times out
of 210. Any view that shows a rationale on most of 297 nodes is showing something
nobody wrote.

And the specific fabrication risk is not hypothetical. Run A's five tool errors
are all shell typos — `ls -d */ | head` with a stray flag, an unterminated
`node -e`, a `grep` with the wrong exit code. Handed to a reconstruction, each is
a ready-made "the run tried X, found it too broad, and narrowed to Y". Five
opportunities in one run, all in the shape a model most wants to narrativise.

The operator reading this page is deciding whether to land a branch. A sentence
that reads like the run's own reasoning, and is not, is worse than no sentence:
it moves the decision *and* removes the impulse to check.

---

## The four provenance values

Every node carries exactly one, and it is set by code, never by prose.

| value | means | set when | can it be wrong |
|---|---|---|---|
| **declared** | the run said this *about this decision, at the time* | Option D's `⟦decision⟧` marker | only if the run misdescribed itself |
| **quoted** | the run's bytes, verbatim, near this act | a byte-exact substring of the transcript or the `run_events` payload | no — the bytes are the bytes |
| **structural** | derived from what happened, no interpretation | a file was edited twice; a call failed; a seam dropped N tokens | no — but it may be *uninformative* |
| **inferred** | a second model's account | anything else | **yes, and nothing detects it** |

Plus one non-value that is as important as the four:

| **absent** | no rationale is recorded, and that is the honest answer |

C2 makes `absent` the default. Given run A's numbers, **most nodes will carry
it**, and a design that finds that embarrassing will be tempted to fill it.

## The verification rule

`quoted` is not a claim the model may make about itself.

```
if (transcriptBytes.includes(node.why_quote)) node.provenance = "quoted";
else node.provenance = "inferred";
```

Byte-exact substring, checked in code, applied to every candidate. A
reconstruction that paraphrases — *"the run noted that two unknowns had become
answerable"* against the actual *"Two of Option F's stated unknowns are now
answerable from the corpus."* — loses its badge automatically, without anyone
arguing about whether the paraphrase was fair.

This is ~60 lines and it is the load-bearing part of Option C
(`05-option-c…` §"Cost to build"). It is also a pure function whose failure
mode is silent, which is precisely `CLAUDE.md`'s bar for a unit test.

## Where the mark is refused outright

Three cases where the code must not allow an inferred rationale at all,
regardless of what a model returns:

**A delegation node.** Zero sidechain records in 266,362; a sub-agent leaves one
call and one result, sometimes a `<persisted-output>` stub. There is nothing to
infer *from*. Forced to `absent`.

**A causal edge crossing a compaction seam.** Asserting that decision N+1 was
made in light of decision N, when `preservedMessages.uuids` names the four or
five records the run could actually still see, is a claim the metadata refutes.
Refused, or emitted at `confidence: low` with the seam drawn on the edge.

**A `rejected` field claimed as `quoted`.** A path not taken leaves no tool call
and no text. `rejected` is always `inferred` — except under Option D, where
`instead_of` is `declared`. There is no third possibility and the type should
not permit one.

## How it renders

Three requirements, in order of how easily they are lost:

**1. Provenance is on the node, not in a legend.** A chip in the node's own
line — `quoted` / `declared` / `structural` / `inferred` — following
`docs/agent/conventions.md`'s variant typing. Not a colour alone: colour is not
readable in every context and `proposals/OperatorInterface/` already records this
codebase's contrast obligations.

**2. Inferred text looks different from quoted text.** Quoted rationale renders
as a quotation with its anchor; inferred rationale renders as prose in a
visually distinct treatment with the chip attached. An operator skimming should
be able to tell without reading which sentences are the run's and which are
about the run.

**3. The tab states its own composition.** A header line, computed not written:

> *This tree has 297 acts. 27 carry the run's own words. 4 are compaction
> seams. 266 have no recorded rationale.*

or, with Option C on:

> *15 decisions. 6 quoted from the run. 9 reconstructed by Claude Opus 5 on
> 2026-08-28 — these are inferences about the run, not the run's own reasoning.*

The second sentence is the one that matters, and it should be impossible to
collapse. `docs/agent/git-and-review.md` records that no row may carry a success
mark it did not earn; this is the same rule applied to explanation.

## The three ways of having nothing

`docs/agent/git-and-review.md` records that the three ways of having nothing may
never render as an empty list. The same distinction applies here and the three
are genuinely different to an operator:

| | what it means | what it must say |
|---|---|---|
| **no rationale recorded** | the run acted and did not explain | "no rationale recorded" |
| **rationale not recoverable** | the transcript was swept; the tree survived | "the transcript for this run was removed on `<date>`" |
| **reconstruction unavailable** | budget guard tripped, or the model call failed | "structural view only — reconstruction did not run" |

Rendering all three as a blank cell tells the operator that the run was
inscrutable, when in two cases the system simply did not look.

## What it costs the options

| option | provenance values it can produce | rendering work |
|---|---|---|
| A — view-time | `quoted`, `structural`, `absent` | chips + the composition header; no inferred treatment needed |
| B — stored | same as A, plus "not recoverable" | + the swept-transcript state |
| C — reconstruction | all four | **the full surface** — chips, distinct inferred treatment, refusals, confidence, composition header. ~600 lines |
| D — declared | `declared`, `structural`, `absent` | chips + header; the strongest badge, the least rendering |
| E — smallest | `quoted`, `structural`, `absent` | chips + header, in a list rather than a canvas |

Only Option C pays the full price, and that price is a real part of its 8–12
days — not an afterthought to it.

## The acceptance test

One question, answerable by watching a person rather than by reading code:

> Show an operator a tree containing one fabricated rationale. Can they find it?

If the answer is no, the provenance design has failed regardless of how correct
the schema is, and Option C should not ship. This is worth running as an actual
five-minute exercise before committing to the reconstruction path — it is
cheaper than the eight days it gates.

## The rule, stated once

**Nothing in this feature may imply a `why` it did not measure.** An empty node
is a true statement about a run that did not explain itself. A filled node is a
claim, and every claim carries the mark of who made it.
