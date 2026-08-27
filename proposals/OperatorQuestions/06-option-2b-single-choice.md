# Option 2b — one choice from options the model writes

The question is prose plus a small list of options the model wrote, and the
operator answers by clicking exactly one. It is
[Option 2a](05-option-2a-free-text.md) with the branches named, and the only
shape in this fork that makes a one-click answer possible at all. It is not the
recommendation on its own — [Option 2d](08-option-2d-choice-with-other.md)
composes it with 2a's escape — but every argument carrying the recommendation is
made here, because the escape is a fallback and the options are the mechanism.

## What it is

An option is a `label` — what the button says — and a required `then`, what the
model would propose if it were picked. Neither is an id, a path or a guard name;
both are strings the model wrote, echoed back to it as text. Clicking one
latches the question row and delegates to `sendChatMessage`, so the next turn
receives the question and the chosen label in prose. **The click's whole effect
is text the model reads.**

## The strongest case

**It is the shape the operator's actual questions have.** 00-problem's opening
is exactly this: "clean up the tests", two mounts attached, one bit missing. So
are "fix it properly or patch it for now", "before or after the release cut",
"the failing test or the flaky one". The operator's knowledge is small, closed
and instantly available to them, and typing it is disproportionate to how much
of it there is. (That most orchestrator questions have this shape is
**unverified** — no corpus exists to count, since [F1](00-problem.md#f1) has the
prompt steering away from asking; the claim rests on the problem statement's own
worked example.)

**It is the only shape that makes one-click possible.**
[F4](00-problem.md#f4) states the blocker in one line: *"A button needs
something to send that is not free text, and there is no field on the wire that
is not free text."* Options are that field; nothing else in this fork produces
one. And with a chosen option on the row the asked/answered pair renders as a
pair, turning "what did I decide about the repository, and when" from a re-read
of six turns into a look.

## How much structure can the model be trusted to produce?

The brief asks this, and the answer is that **the options are not trusted with
anything at all.** They carry no guard, no folder, no permission mode, no
template name, and no id that resolves to a row.
[C7](01-constraints.md#c7)'s edge is what binds: it is not enough that a
question holds no guard field — *"an answer must not be able to write one
either"*, and the safe shape is that an answer's only effect is text the model
reads, *"the same standing the operator's own typing has."* So the worst a
badly-written option set can do is **waste one click** — the blast radius of a
badly-written proposal title, absorbed the same way.

The contrast is `chat_proposals`, where the model writes fields that *are* acted
on. Every one is re-checked at the door before the row exists: `proposeRun`
refuses a mount id naming no mount and a folder that fails
`resolveWorkspaceFolder`, each with a sentence naming what to call instead
(`src/app/api/mcp/route.ts:1503-1531`, read directly), and refuses past the
pending cap at `:1533-1536`. Then every one is checked *again* at approval —
`docs/agent/chat.md:12` records a deleted or decayed agent refused **by name**
*"at both moments the template is checked at: when the tool records the
proposal, where a model can act on the sentence, and again at approval, where
the operator can."* Two doors, because a proposal field becomes a run.

**A question option has no second door because it never becomes anything** —
which is the argument: this fork asks the model for more structure than it
produces anywhere else in the chat, and that is safe because it is inert.

## The `then` field, which is what carries the recommendation

**An option should carry a `then`: what the model would propose if that option
were picked.** It is the one place 2b asks for more than a label, and it earns
it twice. **As an affordance:** `conventions.md:21` fixes what an approval
surface owes its reader, and the clause that transfers is *"what the click
starts counted in words"* (verified; the app satisfies it at
`page.tsx:1067-1070` from the sentence built at `:628-644`). A question's
options are a row of buttons on that
same pane, and an option with no stated consequence asks the operator to guess
what they are choosing — the failure the consequence sentence exists to prevent,
reintroduced beside it. "Repository A" and "Repository B" are not two branches;
"Repository A — I'd propose one run rewriting the fixtures" and "Repository B —
I'd propose two, splitting the integration suite first" are.

**As a bound on asking.** A model that cannot write a `then` for each branch has
not read enough to have a question — it has an uncertainty. Requiring the field
makes that visible when the question is written rather than when it is answered,
which is [C8](01-constraints.md#c8)'s discipline exactly: the cap is *"enforced
in the tool and it explains itself to the model"*, so the model adapts rather
than being silently truncated. (That a model actually behaves this way under the
requirement is **unverified** — a claim about a child's behaviour, which
[F1](00-problem.md#f1) already routes to the unverifiable list.)
[Option 8e](24-option-8e-branch-under-each-answer.md) builds on the field and
asks what the branch under each answer owes the operator.

## What it costs

**The options can all be wrong.** A model that has misread the situation writes
a false dichotomy, and the operator's only move is to escape to prose — which is
why 2b alone is not the recommendation and
[Option 2d](08-option-2d-choice-with-other.md) is.

**Options need a cap, and the cap needs a door.** A row of eight buttons is a
form, not a question, and a form in the transcript is a surface the operator
skims. The cap belongs in the tool with a sentence attached, per
[C8](01-constraints.md#c8)'s mechanism — a refusal is
`text(message, /* isError */ true)`, a sentence the model reads and can act on
([C11](01-constraints.md#c11)). The composite takes 0..5; five is a judgement
rather than a measurement and should be argued as one.

**A choice is only worth a button when the label is short.** A question whose
options are paragraphs should have been prose, and the `then` adds text to every
option — so the label stays short and the `then` stays one clause.

## Verdict

**Recommended, with the `then` field required and a small cap on option count.**
The trust question resolves cleanly because the structure is inert: options are
labels echoed back as text, with none of the second-door validation
`chat_proposals` needs and none of the exposure that makes it necessary. The
`then` is not a nicety — it is `conventions.md:21`'s "what the click starts" for
a surface that would otherwise ship buttons with unstated consequences, and the
field that makes an unprepared question hard to write.
