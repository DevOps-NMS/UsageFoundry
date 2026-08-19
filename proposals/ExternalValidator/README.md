# External validator

**Question:** should a finished run get a second, adversarial reading — task text
against branch diff — that says *the work happened*, *it did not*, or *I cannot
tell*?

**State:** open. The offline spike the pitch asks for in M1 has been run and
scored; **nothing shipped.** `AssistKind` is still `"review" | "resolve"`
(`src/lib/review.ts:51`), there is no validator on the assist path, and no run is
validated today.

Read in this order:

1. **[`validator-baseline.md`](validator-baseline.md)** — the measurement the
   pitch rests on: 40 labelled `completed` runs, how often one filed as
   `completed` did not carry out its task, and how many cannot be judged from the
   artefacts at all. It measures and proposes nothing. §3 carries a correction to
   two of its own labels.
2. **[`external-validator.md`](external-validator.md)** — the pitch: appetite,
   what a validator can see, where it attaches, kill criteria, and five decisions
   somebody has to answer.
3. **[`../../scripts/validator-spike/RESULT.md`](../../scripts/validator-spike/RESULT.md)**
   — what the offline harness returned when a model was actually asked. Where it
   and the two documents above disagree, it is the measurement.

Two things the spike settled that the pitch was written without: a model agrees
with the human labels **34 of 37** on the held-out set with **zero
false-finished**, at a median **$0.125** a verdict on an upper-bound transport;
and giving the validator the run's own final turn — decision 2's recommended
default — changed **zero of eight** verdicts on the stratum where the pitch
claimed it mattered.
