# The options against each other

Arithmetic in [score.mjs](score.mjs); run it rather than believing the table.
Scores are 0–3 and every one is a judgement. **The weights are the argument**,
and they are stated in the script beside each criterion.

```
                            misled×5    cannot×3      wait×3     cheap×4      safe×5  unblocks×2   total
B name the clock                   3           1           2           3           3           2      55
E open the proposal                3           3           0           3           3           1      53
G room for the list                2           2           0           3           3           3      49
D legible endings                  3           2           0           3           3           0      48
C live activity feed               2           3           3           0           1           1      35
H reach the history                1           2           0           2           3           0      34
A change nothing                   0           0           0           3           3           0      27
F amend before approving           0           3           0           1           0           0      13
```

## Which findings each option closes

| | D1 | D2 | D3 | D4 | D5 | D7 | F1 | F2 | F3 | F4 | F5 | F6 | C1 | C2 | C3 | C4 | C5 | C6 | C7 | O3 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **B** | | | ● | ● | ◐ | | | | | | ◐ | | | | | | | | | |
| **C** | ● | ● | | | ● | ● | | | | | ● | | | | | | | | | |
| **D** | | | | | | | ● | ● | ● | ● | | ● | | | | | | | ◐ | |
| **E** | | | | | | | | | | | | | ● | ● | ● | | | ◐ | | |
| **F** | | | | | | | | | | | | | | | | ● | | | | |
| **G** | | | | | | | | | | | | | | | | | ● | ● | | |
| **H** | | | | | | | | | | | | | | | | | | | | ● |

● closes it, ◐ partly. **No option scores on more than one of the three passes**
— during-the-turn, when-it-ends-badly, the-cards — which is the whole argument
for a combination.

## The four things this table decides

**1. The cheap tier is four options wide and covers three of the four passes.**
B, D, E and G together are roughly 100 lines across four files, no migration,
nothing on the approval or spawn path, and counting off the matrix above they
close **twelve of the twenty in full and three more in part**. Their combined
score (57, taking the best per criterion rather than summing) is above the best
single option (55).

**2. C is not substitutable and not cheap.** It is the only option that scores 3
on the ten-minute wait, and the only one that needs a table, a migration and a
retention decision — plus a rewrite of `parseTurnOutput`, the one function on
this path whose silent failure costs money. Nothing in the cheap tier is a
substitute: B makes the wait *bounded*, C makes it *legible*, and those are
different things.

**3. E and G are a pair, and E alone is a regression.** Measured: a card is
178.5px and the list shows 1.8 of 26 at 1440×900. Un-clipping the task takes the
card to ~290px and the list to 0.9 cards. So E's fold has to stay folded, or G
has to come with it. This is the one dependency in the directory that is
arithmetic rather than judgement.

**4. F is dominated.** It scores on exactly one finding, costs the approval
route, and the pain it addresses is plausibly caused by C1 and C2 — which E
fixes for ~40 lines and no route change. It is refused, with the reversing
sentence stated in [07-option-f](07-option-f-amend-before-approving.md).

## Where the weights could be wrong

**`safe` at 5 may be too high for this field.** Only F actually touches the
approval route; everything else scores 3 by default, so the criterion mostly
adds a constant. Drop it and the ranking above is unchanged except that F falls
further. It is kept because it is what disqualifies F, and a criterion that
disqualifies exactly one option is doing its job.

**`wait` at 3 is what puts B first.** It is there because the brief's central
question is the ten-minute wait, and without it an option that answered
everything except the wait would top the table. Set it to 0 and E leads at 53 to
B's 49 — which is the ranking somebody would produce if their priority were the
approval gate's correctness rather than the operator's wait. Both readings are
defensible and the recommendation says so.

**`unblocks` at 2 is the weakest, and it is the one that moves G.** It is doing
real work only for G (which makes E's fold safe to open) and for B (which makes
C's cost readout honest). Remove it and B and E tie at 51, D holds 48, and **G
falls from third to fourth at 43** — which is the ranking somebody would produce
who did not accept the E-needs-G arithmetic. That arithmetic is measured
(178.5px → ~290px per card against a 317px window), so the criterion stays; but
G is the option whose place in the order rests on it.
