# Does Dreaming close a loop, or add an arrow?

The brief asks it directly, and it is the question with the least code in it and
the most consequence. The vault already feeds this app. Dreaming would make this
app feed the vault. If both directions run automatically, the vault becomes a
store that is written by a model and read by a model, and the operator is
outside the circuit.

---

## What runs today, in each direction

**Vault → app, three channels, all live.**

1. **`/api/knowledge/*` — seven routes** (`graph`, `health`, `note`, `notes`,
   `search`, `skill`, `status`), over a module that is read-only end to end
   (`src/lib/knowledge.ts:39`). The vault is browsable, searchable and
   graphable from inside this app.
2. **The vault skill**, generated per spawn and handed to every child with
   `--plugin-dir` (`src/lib/vaultSkill.ts:13`–`:14`). Every agent this app runs
   is told the vault exists, where it is, and how to search it.
3. **A proposal in this directory was revised against it.**
   `proposals/README.md:21` records `ContextControl` as "**Revised 2026-08-22**
   against context research in the operator's vault", and says the revision
   moved the recommendation's margin from 3 points to 9 and changed the
   runner-up. That is the strongest evidence anywhere that the vault→app arrow
   carries real weight: a decision in this repository was changed by it.

**App → vault, one channel, manual, exercised three times.**

`ls "/workspace2/3 Resources/Questions/Inbox/"` returns `_TEMPLATE.md`,
`Inbox MOC.md` and three question notes. All three carry
`captured_by: "external session"`. Two name UsageFoundry in `captured_from`
(created 2026-08-16 and 2026-08-21); the third names a research request in
`/workspace` (2026-08-15). All three are `status: seed`, `confidence: low`, and
**none has been promoted out of the quarantine** — the newest records its own
untriaged state at `:60`.

So the arrow exists, it has been used three times in eighteen days, and its
review half has run zero times.

## What Dreaming would change

Not the existence of the arrow. **Its cadence, its volume, and its
quarantine.**

- Cadence: three by hand in eighteen days becomes one a night.
- Volume: three notes becomes ~120 over the same period.
- Quarantine: the three sit in a folder whose contents are "not counted as vault
  content until reviewed" (`Does Writing Lessons…md:73`). Options A, B, C and F
  write into the vault proper.

**That is what turns an arrow into a loop.** With a person at the quarantine,
the circuit is: app writes → **person reviews** → vault holds → app reads. With
a nightly unquarantined writer, the person is gone from the circuit and it is:
app writes → vault holds → app reads → app writes.

## Why the loop is worse than the sum of its arrows

Three mechanisms, and none of them is speculative.

**1. Nothing marks a note as machine-written, and the retrieval that reads it
back does not care.** `searchKnowledge` (`src/lib/knowledge.ts:1403`–`:1438`)
scores on where the match landed and nothing else: title exact 100, alias 70,
title substring 50, tag 30, otherwise 10, then sorts on score and title. **It
reads neither `confidence:` nor `status:`.** So a `status: seed`,
`confidence: low` note a model wrote last night and a `status: evergreen`,
`confidence: high` note the operator graded against four peer-reviewed sources
rank identically if they match the same way — and the vault's own trust markers,
which `AGENTS.md:56`–`:73` exists to teach an agent to read, are invisible to
the app's own search.

The vault says the same thing at a higher level:
`Does an Agent Defer to a Stale Memory Over What It Can Observe.md:31` — "**no
memory system found so far authenticates what wrote a memory**, so on read-back
a record that was correct in March and a record that was never correct are the
same tokens carrying the same authority."

**2. Retrieval selects, it does not average** (`:33`, and AgentPoison at
sub-0.1% for over 80% attack success). A model-written note does not get diluted
by 1,224 hand-written ones. It gets retrieved on the query it matches, and on
that query it is the whole of what the reader sees.

**3. The reader is disposed to agree with it.**
`[[Sycophancy and Agreement Bias]]` (`confidence: high`, quoted at
`Does an Agent Defer…:37`): "models follow a stated position, with one assistant
wrongly admitting error on 98% of challenges and the best tested folding 32% of
the time." A note in the vault is a stated position; the agent that reads it
back tomorrow is measurably inclined to take it.

Put together: **a loop in which both ends are model-written is a loop with no
authority gradient in it.** Every arrow preserves confidence, nothing checks it,
and the retrieval layer that closes the circuit is scored on string position.
The vault's value to this app — the thing that let it revise `ContextControl` —
is that its notes are *graded*, by a person, against sources. A channel that
writes ungraded notes into the same namespace does not add to that value; it
dilutes the property the value rests on.

## What the operator's own vault says about this exact circuit

It is not silent. `_Meta/Research Protocol.md` defines the evidence grades and
the confidence ceiling; `_Meta/Vault Conventions.md:28` makes rule 4 "no note's
`confidence` exceeds the evidence grade of what it cites"; and `qc.py`'s
`CONF/*` family enforces it at ERROR/WARN (`_Meta/Vault Quality Control.md:47`).

**So the vault already has the authority gradient the app's search ignores.** A
Dreaming note derived from a day's tool errors cites nothing peer-reviewed and
would sit at `confidence: low` if it complied — and `searchKnowledge` would rank
it beside `confidence: high` regardless.

That is a fixable asymmetry and it is worth naming as its own small piece of
work, independent of Dreaming: **`searchKnowledge` could read `confidence:` and
`status:` and use them.** It does not need a model, does not write anything, and
it is the one change that would make the existing vault→app arrow safer whether
or not the reverse arrow is ever built.

## The answer

**Dreaming as posed closes a loop, and the loop is the objection.** As an
arrow — one more manual capture into a quarantine a person reviews — it is what
already happens and it has demonstrably worked. As a nightly unquarantined
writer, it removes the only human check in the circuit and adds a channel that
writes ungraded notes into a namespace whose whole value to this app is that its
notes are graded.

`06-option-d-question-capture.md` is the option that keeps the arrow and refuses
the loop, and it does so by keeping the person at the point the vault itself put
them.
