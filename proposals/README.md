# Proposals

Design proposals that are not yet decisions. A directory here surveys one
question, gives every candidate its strongest honest case, and ends with a
single recommendation and the fact that would overturn it. Nothing in here
describes the code as it stands — `docs/agent/` is where the invariants that
have already been decided live, and `docs/` proper is what an operator reads.
A proposal is promoted by implementing it and moving its reasoning into those
two places; until then, treat every file here as an argument rather than a
record.

Every factual claim carries a `path/file.ts:42` reference or the command whose
output it quotes. A claim that could not be verified says "assumed" in the
sentence that makes it.

| Proposal | Question | State |
|---|---|---|
| [Sandboxing](Sandboxing/README.md) | What would full containment of a run look like — filesystem, network, and between two concurrent runs? | Open; one recommendation, unverified in its central mechanism |
| [ExternalValidator](ExternalValidator/README.md) | Should a finished run get a second, adversarial reading of task text against branch diff? | Open; the offline spike has run and is scored, and **nothing shipped** — no run is validated today |
| [ModelRouter](ModelRouter/README.md) | Who picks the model a run, a review or a delegated turn costs money at, and should anything but one global text box decide it? | Open; one recommendation, and it is **against building a router** — ship the per-run field and the read-back that already have wire support. Unverified: that a cheaper model does any of this install's real tasks in the same number of work cycles, which is the ~$10 experiment that would overturn it; and every reading of the `runs` table, which is unopenable from a work cycle and gates three of the ten options |
| [ContextControl](ContextControl/README.md) | What does a run carry from one work cycle to the next, what does carrying it cost, and can this app make it carry less? | Open; one recommendation, and it is **against building any of the twelve mechanisms** — build the per-cycle composition readout, plus the two repairs the survey found while looking for something else. 82% of the bill is carried context, but at a tenth of the input rate, so that is the prompt cache's discount rather than waste; the one identified waste is 6.1% of the bill and its cause sits in the CLI's own system prompt. Unverified: that a fresh conversation per cycle finishes the same task in the same number of work cycles, which is the single-digit-dollar experiment that would overturn it; whether a compaction survives `--resume`, which gates one option entirely; and whether the API's prefix match ends at a cache breakpoint, which is the difference between $1.44 and $5.02 a week for the one flag that reaches the mechanism |
