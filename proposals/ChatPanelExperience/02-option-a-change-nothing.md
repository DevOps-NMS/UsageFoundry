# Option A — change nothing

**The case for it, at its strongest.**

Every one of the findings in [00-problem.md](00-problem.md) sits on a surface
whose safety properties are correct. Nothing here starts a run without a click.
The click covers an explicit list. No model can set a guard. A turn cannot spawn
a second child. A stranded turn is failed out rather than re-asked. A question
is a row, not a lock on the composer. Those are the properties that make the
feature safe to have, and none of the complaints in this survey touches one of
them.

The surface is also not neglected. `page.tsx` carries about 400 lines of
docblock arguing individual decisions, and several of them are arguing *against*
the obvious fix a reader would reach for. `Waiting` refuses a progress bar
because nothing knows the progress. The proposal card makes the guard set wrap
rather than truncate, and says why. The question card sends on one press only
when it is the last question open. The thread scrolls for a reader at the bottom
and nobody else. These are not defaults; somebody thought about each one.

And the volumes are small. A chat turn is a rare event on most installs. Twenty-
five pending proposals is the pathological case the cap exists to bound, not the
median — the median is two or three, and two or three fit in the column.

**What it costs.**

Six of the findings are things an operator is currently *misled* about rather
than merely not told:

1. A timeout and a routine bookkeeping note are drawn identically (F2).
2. The one failure with no permanent record is the one drawn in red (F1, F3).
3. The header's "$X this chat" is wrong by up to `chatTurnBudgetUSD` for every
   turn that was stopped or timed out (F5).
4. "Approve starts 26 unattended runs … under the guards shown on each" is a
   sentence about cards, 24 of which are off screen (C5).
5. A templated card's "guard set" is a name, and the card reads as though it has
   said what it will run under (C2).
6. "Starts after `auth-fix`. Approve them together" instructs the operator to
   find a card by a label no card displays (C3).

Each of those is a sentence the interface asserts and the code contradicts. That
is a different class of defect from "the panel could show more", and it is why
this option is not the recommendation.

**What would make it right.**

If an operator says the ten-minute wait has never bothered them and the panel
never holds more than three proposals, then D1–D7 and C5 fall away and this
option beats every other on cost. The six items above would still stand, and
five of them are answered by [05-option-d](05-option-d-legible-endings.md) and
[06-option-e](06-option-e-open-the-proposal.md) for a few dozen lines between
them.

**Score.** It is the baseline: 0 on every criterion in
[10-comparison.md](10-comparison.md), at zero cost and zero risk.
