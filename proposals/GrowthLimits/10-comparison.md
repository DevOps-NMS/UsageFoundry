# Comparison

Seven options, eight criteria, weighted, then the four places the table
misleads. The weights are justified before the scores, because a weighted table
is an argument about weights.

## The criteria and why they weigh what they do

| # | Criterion | Weight | Why |
|---|---|---|---|
| 1 | **How soon the thing it addresses actually bites, at the measured growth rate** | **8** | The brief's instruction: "Rank by what is hit soonest at the operator's real growth rate, not by what is most interesting to fix." This criterion *is* the question. Scored against the measured ≈88 transcript files and ≈69.6 MB per day ([00-problem.md](00-problem.md)), not against a hypothetical install. An unbounded cost can score here — a bound is not required to bite |
| 2 | **Is the failure it addresses silent?** | 6 | `CLAUDE.md`: "nearly every one of them fails **silently** — nothing throws, nothing fails to typecheck, and the page looks right." A bound that queues visibly has already told the operator. Frequency is criterion 1's job, so an option can score 5 here and 0 there |
| 3 | Does it let somebody know something they currently cannot? | 5 | [01-ceilings.md](01-ceilings.md)'s central finding is that nothing breaks and eleven bounds were measured against without any of them being reportable from inside the app. An option that adds knowledge is worth more here than one that moves a number |
| 4 | Code cost in `src/` | 3 | Real, and deliberately below the three criteria above it. Every option in this survey is between 0 and 8 files |
| 5 | **Free of an untaken measurement** | 3 | An option gated on a reading nobody has is not a decision yet, it is a plan to decide |
| 6 | Not already owned by a neighbouring proposal or an open issue | 2 | `proposals/README.md`'s framing is one question per proposal. A second vote by the same voter is not evidence. Low weight because ownership is a fact about the repository, not about the option |
| 7 | **Graceful degradation if the judgement is wrong** | 5 | Thirty of the thirty-one bounds in this survey degrade — a queue lengthens, a walk truncates, a scan slows. One does not, and an option that trades a graceful failure for an abrupt one is making a different kind of bet |
| 8 | Measured here rather than reasoned about | 2 | The brief: "Say plainly which numbers you measured and which you reasoned about." Low weight because it is a property of this survey's reach, not of the option's merit |

## The table

Scored 0-5, higher is better, as each option stands today with no prerequisite
work assumed.

| Option | 1 (×8) | 2 (×6) | 3 (×5) | 4 (×3) | 5 (×3) | 6 (×2) | 7 (×5) | 8 (×2) | **Total** |
|---|---|---|---|---|---|---|---|---|---|
| **A** instrument the axes | 4 | 5 | 5 | 5 | 5 | 4 | 5 | 5 | **160** |
| **D** page the run and chat lists | 5 | 4 | 5 | 2 | 5 | 1 | 4 | 3 | **138** |
| **B** report the walk truncation | 2 | 5 | 3 | 5 | 5 | 5 | 4 | 5 | **131** |
| **G** time-based audit horizon | 1 | 5 | 1 | 3 | 2 | 2 | 1 | 1 | **69** |
| **C** raise `maxConcurrentRuns` | 4 | 1 | 1 | 5 | 0 | 3 | 0 | 2 | **68** |
| **F** harden the SQLite write path | 0 | 5 | 0 | 2 | 3 | 3 | 1 | 3 | **62** |
| **E** raise the four-mount ceiling | 1 | 0 | 0 | 5 | 5 | 2 | 2 | 4 | **60** |

Maximum 170.

Four cells worth restating rather than leaving to be inferred. **D's 5 on
criterion 1** is the only 5 there is, and it is not a projection: `listRuns(100)`
against a measured 294 runs is a bound already passed. **C's 0 on criterion 7**
is the container OOM — the one failure in this survey with no partial version to
observe on the way to it. **F's 5 on criterion 2 beside its 0 on criterion 1** is
the split the weights exist to express: a five-second synchronous stall would be
entirely silent, and its precondition is provably absent (`grep -rc "\.iterate("
src/` sums to 0). **E's 5 on criterion 4** is zero files because there is nothing
to change, which is a refusal wearing a good score.

## Where the table misleads

Four places, and the first is the one that decides how to read the result.

### 1. The table returns the answer the brief invited, which is a reason to check it harder

The brief said "be willing to recommend raising nothing and instrumenting
instead", and the table puts the instrument-only option 22 points clear. A survey
whose weighted table agrees with its own instructions has proved nothing yet.

So here is the check. Take criterion 1 alone — the only criterion that measures
soonness, and the one the brief weighted highest — and A does **not** win it. D
does, 5 to 4. Remove criterion 6 (ownership), which is the only criterion that
exists to stop D winning, and D reaches 136 against A's 152: still second. A's
margin comes from criteria 2, 3, 7 and 8, where it scores 5, 5, 5, 5 — and those
four are about *knowing what is happening*, not about *cost avoided*. Which is
the part of the result worth trusting: the reason to instrument is not that
instrumenting is cheap, it is that eleven bounds were measured from a scratch
harness outside the app and **none of the eleven is visible from inside it**.

### 2. D is first on the question and third in the recommendation, and that is an ownership call rather than a technical one

Option D scores 138 and is the only option addressing a bound this install has
**already passed**. It is nonetheless handed back to
[GapRegister G1/G2](../GapRegister/03-growth.md) rather than recommended, on
criterion 6 alone — a weight of 2 out of 34.

That is a small weight carrying a large decision, and it should be visible.
Stated plainly: **if the reader disagrees that a neighbouring proposal's
ownership matters, D is this survey's recommendation and A is second.** The
technical case for paging is intact, GapRegister ranks it first of its own three,
and this proposal contributes a measurement to it
([06-option-d](06-option-d-make-the-history-reachable.md)) rather than an
argument against it.

### 3. The bottom four are one scoring step apart and the table does not rank them

G 69, C 68, F 62, E 60. Four options inside nine points on a 170-point scale,
which is inside the measurement error of scores assigned by hand. **The table
does not distinguish them, and the distinction that matters is not a score at
all:**

- **C is deferred.** It is unmeasured. One `docker stats` reading closes it in
  either direction.
- **E, F and G are refused.** Each has a specific reason that does not depend on
  a future measurement: E's ceiling is already raisable and documented, F's two
  failure modes lack their preconditions, G's shape was chosen deliberately and
  is load-bearing in a security argument.

Deferred and refused are kinds, not quantities. Criterion 5 at weight 3 is the
only place the table tries to express it, and it undervalues it — a fair reading
would put C above the other three regardless of the arithmetic.

### 4. Criterion 4 rewards E and C for costing nothing to *not* do

E scores 5 on code cost because there is no cap in `src/` to raise, and C scores
5 because raising a default is one line. Both are true and neither is a point in
the option's favour: E's zero is the reason it is refused, and C's one line is
the cheapest part of a change whose real cost is a possible OOM kill mid-cycle.

Cheapness is only a virtue once an option has established that it should happen
at all. Criteria 1 through 3 are where that gets established, and E scores 1, 0,
0 across them.

## What the table does not contain

**Any run history.** `.data/usagefoundry.db` in the checkout is a stale
2026-08-19 copy and `/data` under `DATA_DIR` is `Permission denied` to the agent
uid. So no option is weighted by how often its target state has actually
occurred — the 294-run figure behind D's criterion-1 score comes from the
transcript corpus by way of [ContinuousImprovement](../ContinuousImprovement/README.md),
not from `runs`.

**Any concurrency measurement.** Docker is unavailable in this container, so no
option was scored against an observed multi-run install. Every figure in
[01-ceilings.md](01-ceilings.md) was taken single-process. C's criterion 8 score
of 2 is that gap, and it is C's own subject.

**More than two repositories.** n = 2 mounts, one repository each, both an order
of magnitude below `MAX_WALK_ENTRIES` and two orders below
`MAX_FOLDERS_PER_MOUNT = 400`. B's criterion 1 score of 2 and E's of 1 both rest
on that sample, and a survey with n = 2 on an axis should be read as having no
opinion about it.
