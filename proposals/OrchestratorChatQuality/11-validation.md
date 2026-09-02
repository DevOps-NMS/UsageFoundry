# Validation: what would falsify each claim

[← The recommendation](10-recommendation.md) · [Proposal index](README.md)

Every recommendation here is a **prediction about a prompt**, and no turn was run
to test one. This file says how each would be falsified, cheapest first, and
names the one question that is not answerable from any measurement.

## The blocking question

**Does the operator want the chat to ask them more?**

Everything downstream turns on it. This survey reads the 2.0% asking rate as
designed behaviour, because `src/lib/chat.ts:2484-2493` argues for it explicitly
and 63 of 98 conversations are single-turn dispatches. On that reading, B is a
reachability fix and the *"Prefer proposing"* bullet at `src/lib/chat.ts:2549-2551`
is untouchable.

If the answer is "yes, it should ask me more", the recommendation changes shape:
B stops being the fix and becomes a **prerequisite** for one, and the change that
matters is to that bullet. The evidence pointing that way is real and is why the
question is asked at all — the operator typed *"use the question feature"* twice
in a month, in near-identical words, a month apart. That is a person reaching for
something they had to name manually.

**It is one sentence from the operator and it is not in the transcripts.**

## Falsifiers, per recommendation

### B — name the asking tool

**Prediction:** after B, `ask_operator` appears in `ToolSearch` queries on turns
where the operator did *not* name the feature.

**Falsified by:** a fortnight of chats in which `ask_operator` is still fetched
only when the operator asks for it by name. Run `scripts/verify.mjs` and read the
`fetched=/called=/both=` line — today it is `fetched=3 called=3 both=3 of 98`.

**The specific way this could be a no-op, stated because it is plausible:**
`get_usage` is also unnamed in the prompt and is fetched on 82 of 160 queries.
So a name is not *necessary* for reachability — what `get_usage` has is an
imperative sentence describing its action (`src/lib/chat.ts:2534-2535`), and B
gives `ask_operator` the same. If B ships and nothing changes, the conclusion is
that the three restrictive bullets suppress the *decision* rather than the
*lookup*, and the next move is the blocking question above rather than more
prompt text.

**Watch for over-correction:** on the one observed occasion the model read both
bounds together, it asked **4 questions** — the number `src/lib/chat.ts:2552`
names as a form and one under the ceiling `MAX_OPEN_QUESTIONS` sets. That is
n = 1. If asking becomes common after B and 4-question calls are typical, the
ceiling is outranking the warning and `MAX_OPEN_QUESTIONS` becomes worth
revisiting — **not before**.

### C — say what `promptOverride` is

**Prediction:** no further `propose_run` call carries a `promptOverride` and no
`task`; batches reuse one override string.

**Falsified by:** another instance of the F2 shape after C ships. Run
`scripts/batch.mjs`, which prints per-message override SHA-1s — distinct hashes
within one message are the failure, identical hashes are the fix working.

**Honest limit:** the failure fired **once in 152 turns**. A fortnight of chats
may contain zero instances whether or not C ships, so absence is weak evidence.
The stronger signal is the hash column: today, 39 proposals carry both fields and
the retry's six share one hash. If post-C batches show distinct overrides per
proposal, the sentence did not land even though nothing was refused.

### D — the edge pair

**Prediction:** `on-finish` + `continueBranch` becomes rarer, and
`continueBranch` on untemplated proposals is preceded by a `list_templates` call
more often than 83.9%.

**Falsified by:** the pair count staying at ~3.4% of edges. `scripts/deep.mjs`
prints it.

**What cannot be checked at all:** whether the *choices got better*. That needs
run outcomes — did an `on-finish` dependent ever open on a crashed branch — and
those live in `/data`, which is root-owned `0700`. **D is the recommendation with
the weakest verification story and it is ranked third partly for that reason.**

### F — say the order

**Prediction:** replies carrying a `dependsOn` state a sequence, and the operator
stops asking for one.

**Falsified by:** a fourth operator message asking for the approval order after F
ships — which would mean the panel is the problem, not the reply, and the fix
belongs in `src/app/chat/page.tsx`.

**The thirty-second check that should happen before F ships at all:** open the
chat page with a dependency chain in the panel and look at whether it renders the
order. No browser was driven for this survey. If the panel already shows a
readable sequence, F is a workaround for something that is not broken and its
rank drops to last.

### E — move the duplicate check

**Prediction:** `list_proposals` before the first `propose_run` rises on
second-and-later turns from 21.4%.

**Falsified by:** the split not moving, or by the discovery that no work was
being duplicated anyway.

**The measurement this survey did not make, and should have:** for each
conversation with two or more proposing turns, whether any two proposals across
turns carry the same title or the same folder-plus-issue-number. The transcripts
hold the proposal arguments, so it is computable. It was not computed because it
needs a similarity judgement rather than a count, and `scripts/` deliberately
contains nothing that guesses. **Until that runs, E rests on a trigger firing at
the wrong time and not on a single observed duplicate** — which is exactly why it
ranks fifth.

## Claims in this survey that are not verified

Listed so they are not mistaken for measurements.

- **That any proposal was ever approved.** `/data` was not read. No proposal in
  this corpus is known to have become a run.
- **That the seven `on-finish` + `continueBranch` proposals were harmful.** None
  is known to have been approved, and none to have met a crash.
- **That the 149 `continueBranch` assertions were entitled to assume isolation.**
  The default guard set is quoted in exactly one reply
  (*"bypassPermissions, own checkout, $35, 3 work cycles, 240 min"*, 2026-08-14).
  On this install it was very likely right; that is not the same as checked.
- **That work was ever proposed twice.** See E, above.
- **That the panel does not show approval order.** Three operator sentences say
  they could not find it. No screenshot was taken.
- **That the 23,626-token message in F2 cost anything in dollars.** Token counts
  are in the transcripts; prices are not, and `chatTurnBudgetUSD` in force is
  unknown.
- **Every prediction in this file.** No recommendation here has been applied and
  no turn was run against a modified prompt.

## What was deliberately not examined

Repeated from [01-the-corpus.md](01-the-corpus.md#what-was-deliberately-not-examined)
so a reader who starts at the recommendation still sees it:

`propose_workflow`'s 135-line schema (2 calls — no corpus), `BLOCK_TOOLS` /
`emit_runs` (a different subject), `get_run_diff` (0 calls),
`src/app/chat/page.tsx` (~25k, never opened), and `docs/agent/chat.md` in full.

## Verification actually performed on this branch

`npm run typecheck` — **exit 0**, with **nothing under `src/` changed by this
survey**. The only files added are under `proposals/OrchestratorChatQuality/`
plus one row in `proposals/README.md`.

All seven scripts in [`scripts/`](scripts/) run clean on this container and
reproduce every figure quoted. `scripts/batch.mjs` and `score.mjs` were run after
being written into the proposal and their output matches the tables that quote
them.
