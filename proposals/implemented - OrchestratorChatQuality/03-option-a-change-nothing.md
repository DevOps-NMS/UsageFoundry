# Option A — change nothing

[← The findings](02-findings.md) · [Next: Option B →](04-option-b-name-the-asking-tool.md)

The null, at its strongest, because on this evidence it is stronger than it
usually is.

## The case for it

**The measured behaviour is largely the behaviour the prompt asks for.** Set the
observed rates against the instruction that produces each:

| Instruction | Rate |
|---|---|
| *"Look before you propose"* (`chat.ts:2526`) | **89.6%** of proposing turns ran `Read`/`Grep`/`Glob`/`Bash` |
| *"The task text is the whole brief"* (`chat.ts:2557`) | median **4,946** chars; **96.9%** name a file; **97.1%** name a verification word |
| *"If a 5-hour or weekly window is nearly spent, say so"* (`chat.ts:2534`) | `get_usage` before the first proposal on **73.6%**; **83 of 125** replies mention the window |
| *"Say whether you named [a template] or left the run on the default guard set"* (`chat.ts:2560`) | **107 of 125** replies name a template or guard set |
| *"Say in your reply that they have to be approved in the same click"* (`chat.ts:2578`) | **81 of 85** dependency turns |
| *"do not repeat their full text"* (`chat.ts:2593`) | **0 of 125** replies echo >30% of the briefs |
| *"Do not edit, create or delete files in a workspace"* (`chat.ts:2512`) | **3** `Write` calls in 152 turns, all outside the mounts |
| *"Prefer proposing with the assumption stated in your reply"* (`chat.ts:2549`) | **82.2%** of turns end in a proposal; **2.0%** in a question |

Eight instructions, eight high compliance rates. The schema produced **8 genuine
refusals in 1,042 tool calls** — 0.8% — and six of those eight are one message.
This is not a surface that is failing.

**The asking rate may be right.** F1's mechanism is real, but the *number* it
produces is the number the prompt argues for. `src/lib/chat.ts:2484-2493` sets
out the reasoning:

> ```
>  * The asking paragraph is there on exactly that test and no other. …
>  * A model that never asks proposes on a guess; a model that asks freely turns
>  * a chat into a form, and every question is a turn, a card and a decision
>  * bought with an operator's attention. So the paragraph is two rules and a
>  * bound: only what the operator alone knows, prefer a stated assumption, and
>  * one is a question where four is a form.
> ```

*A model that asks freely turns a chat into a form.* At 2.0% there is no form.
And 63 of 98 conversations are single-turn — an operator who wanted a
conversation would have had one, and mostly did not. It is entirely possible
that this install's operator wants a dispatcher and has one.

**Every change here is a change to a prompt that cannot be tested.** There is no
unit test over `systemPrompt()`'s content and there cannot be one; `CLAUDE.md`'s
bar — *"A pure function whose failure mode is silent gets a unit test"* — does
not reach prose. A change to these two blocks is verified by reading chat
transcripts a fortnight later, which is the same instrument this survey used and
the same one that found nothing wrong with eight of ten instructions.

## The case against it

Three findings survive that case, and they survive it in different ways.

**F1 is not "the rate is 2%", it is "the instruction is unread."** The 1,100
characters at `src/app/api/mcp/route.ts:302-321` were written to govern a
judgement, and 95 of 98 conversations made that judgement without them. Whether
2% is the right rate is a design question this survey cannot settle. Whether the
rate is currently produced by the argument in that description is a factual
question and the answer is **no** — it is produced by three restrictive bullets
that never mention a tool. Even an operator who wants 2% should want it for the
stated reason.

**F2 is a defect with a receipt.** Six refused tool calls and a 23,626-token
message re-spent. It is rare, it is bounded by batch size, and the server catches
it — but it is the only thing in the corpus that visibly wasted an operator's
turn through no fault of the operator.

**F3 has no rate that makes it safe.** Seven `on-finish` + `continueBranch`
proposals is 3.4% of edges. The consequence, if one is approved and the upstream
run crashes, is an agent writing into a repository on a half-finished branch
believing the work is there. Nothing in this corpus proves that happened; nothing
in the surface prevents it.

## The version of A worth keeping

**Do not touch the eight instructions that measure well.** Any change proposed
downstream has to leave the look-before-proposing rate, the brief length, the
window mention and the same-click rule where they are. That is a real constraint
and it rules out the obvious global repair — *"the prompt is long, shorten it"* —
because the length is where the compliance comes from.
