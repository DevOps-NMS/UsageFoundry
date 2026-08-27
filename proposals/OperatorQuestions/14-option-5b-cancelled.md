# Option 5b — the operator dismisses it

The middle answer in fork 5. Where [Option 5a](13-option-5a-superseded.md) reads
the operator's next message as the end of a question and
[Option 5c](15-option-5c-left-open.md) reads nothing as the end of one, this
option says only an explicit act closes it: the card carries a Dismiss control,
and until it is pressed or the question is answered, the question is open.

## The rule

The question card renders a Dismiss control beside its options. Pressing it
moves the row to `superseded` (or a fourth value; the name is not what decides
this) with its `settled_at`, and the card goes quiet in the thread exactly as
5a's does. Nothing else closes a question. An unrelated message leaves it
untouched: the operator can type an aside, read the reply, and then click the
button they were always going to click.

## The strongest case

**It is the only option where the operator decides.** 5a infers from a message
that the operator is finished with a question; 5c never concludes anything. Only
5b puts the judgement with the person who actually holds it, and the app is
never wrong about intent because it never guesses at intent.

**It fixes 5a's named annoyance exactly, and that annoyance is real.** 5a's own
cost section concedes the case: the operator means to answer, types a
clarification first, and finds the button gone. Under 5b that sequence works. An
aside is an aside. The question is still there when the aside is done. There is
no version of 5a that recovers this, which is why it is stated there as a cost
rather than argued away.

**And Dismiss is a signal the model has no other way to receive.** "Stop asking
me this" is a real thing an operator wants to say, and today there is nowhere to
say it: the answer route delivers text the model reads
([C7](01-constraints.md#c7) is emphatic that this is all an answer may ever be),
and a question the operator does not want to engage with has no expression short
of typing a sentence about it. A dismissal is a fact the next turn's prompt
could carry. That is a genuine capability the other two options do not have.

## Why it is refused anyway

### It is a click that buys the operator nothing they came for

The chat pane's action vocabulary is about work. Approve, Reject, Send, Stop —
each of those changes what the app will do next. Dismiss changes only what is on
the screen. [F10](00-problem.md#f10) describes the proposals panel's action row
as putting "the one default action at the right edge" with "a consequence
sentence in words above" it (`page.tsx:1067-1070`, built at `:628-644`); the
consequence sentence for Dismiss is that a card stops being a card. An operator
who has decided a question is not worth answering has already spent the
attention the control was meant to save, and pressing it spends more.

This alone would not be fatal. The next one is.

### It makes an abandoned question the default outcome

A control that must be pressed is a control that will not be. The operator who
ignores a question is by definition the operator who is not doing things about
that question, and asking them to perform one more act on it to close it out is
asking exactly the wrong person.

So the steady state of 5b is a question that is neither answered nor dismissed,
open for ever. The derived `awaitingAnswer` boolean on the DTOs is then
permanently true on that thread, and the sidebar marker built from it — the same
row as `page.tsx:1553-1556`, which today draws `thinking` and a
`{pendingCount} waiting` badge (read directly) — says the thread is waiting on
the operator when the conversation has plainly moved past it.

**That is [F3](00-problem.md#f3) inverted.** F3's complaint is that a thread
holding a real unanswered question shows nothing; 5b's failure is that a thread
holding a dead one shows the mark for ever. Both leave the sidebar unable to
answer "which thread needs me", and the second is worse in one respect: F3's
silence is at least not misleading, while a marker that is stuck on trains the
operator to disregard the marker. Everything this fork's parent design exists to
build is that marker. An option whose default outcome is to poison it is not
available, whatever its other merits.

[Option 5c](15-option-5c-left-open.md) reaches the same failure by a shorter
road and is refused on it for the same reason. 5b is 5c with a control the
operator is not going to press.

### The state change carries no information the thread does not already show

Dismissal needs a way in. Either a route of its own, or an action verb on the
answer route — which is currently the clean shape the shared design settles on:
one route that latches the row and delegates to `sendChatMessage`, so an answer
is text the model reads and nothing more, which is
[C7](01-constraints.md#c7)'s requirement stated as an implementation. A verb
that latches the row and delegates to *nothing* is a second mode through the
same door, and it exists to record a state the thread already displays — the
question is up there, and so is everything the operator did instead of
answering it. The app would be storing a fact it can read off `seq` order.

## The concession, and it is not a small one

**Dismiss composes with 5a.** It is additive: 5a decides what happens when the
operator does nothing, and a Dismiss control decides what happens when they act
deliberately. Adding one on top of the recommendation is a control on the card,
a verb on the existing route and no change to the supersede rule — and it
removes 5b's own fatal cost entirely, because with 5a underneath, a question the
operator neither answers nor dismisses is still closed by their next message.
The stuck marker cannot happen.

That combination is the right response if the vanishing-button annoyance turns
out to bite in practice, and it should be the first thing tried before anything
more elaborate. It is not proposed now for the reason a first version usually
declines a control: nobody has yet found out whether operators reach for the
button after typing an aside, or simply type the answer. If they type the
answer, Dismiss is a control on every card that is pressed on none of them.

## Verdict

**Refused as the mechanism; retained as a possible affordance on top of
[5a](13-option-5a-superseded.md).** As the mechanism it fails on the outcome it
makes default: a question nobody closes leaves `awaitingAnswer` true for ever
and turns the "this thread needs you" marker into noise on the threads that need
it least — [F3](00-problem.md#f3)'s defect approached from the other side. As an
addition to 5a it is cheap, it is safe because the supersede rule stands behind
it, and it is the named remedy if 5a's lost-button case proves to matter.
