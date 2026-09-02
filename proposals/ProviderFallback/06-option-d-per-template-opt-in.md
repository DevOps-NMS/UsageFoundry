# Option D — a per-template opt-in

Put the fallback on the run template rather than on the run, on the refusal
site, or on a workflow. A template that carries `fallbackProvider: "codex"`
produces runs that will switch at a wall; a template that does not produces runs
that park exactly as today.

The mechanism underneath is Option B's or Option C's — this option is about
**who decides and when**, not about how the switch is made.

---

## The strongest case

**The decision belongs to whoever knows the task, and a template is where this
app already records that knowledge.**

Not every task is equally suited to a provider swap. "Fix this failing test",
"apply this rename across the repository" and "update these dependency pins" are
tasks where a second agent starting from the branch loses very little. "Continue
the architecture survey you have been running for four cycles" is a task where
the conversation *is* the work, and `08-continuity.md` costs what discarding it
means.

Nothing at the refusal site can tell those apart. `refusalDisposition`
(`orchestrator.ts:1795`) receives a `RefusalKind`, a pause count and a retry
count, and is documented as pure precisely so that it *cannot* consult anything
else. Option B has to answer "is this task portable?" with a global setting;
Option D answers it per template, which is where the app already keeps per-task
decisions.

`docs/agent/agents-and-templates.md` governs the shape, and it carries a rule
that fits this option unusually well: an agent carries a **role and never a
capability**, and one field is refused by name. A fallback provider is arguably a
capability, which is a real objection to putting it on an *agent* — and is
exactly why this option puts it on a **template**, which is the thing that
carries the run's configuration rather than its persona.

## Its shape

```
run_templates   fallback_provider TEXT NULL
POST /api/runs  copies it onto the run, frozen, at creation
refusalDisposition  gains `fallbackAvailable`, sourced from the run row
```

The freeze matters and has a precedent. `docs/agent/agents-and-templates.md`
records **frozen copy versus reference** and how a deleted agent is refused; a
template edited after a run started must not change that run's disposition
mid-flight, for the same reason. So the column lands on `runs` too, copied at
creation — which means Option D is Option C's column plus a template field plus
the copying rule, not less schema than Option C.

## Continuity

**Identical to whichever mechanism it sits on**, with one genuine improvement:
the operator has, at template-authoring time, the context to answer "is this
task's conversation the work, or is the branch the work?" — and that is the exact
question `08-continuity.md` says decides how much a cross-provider handover
costs.

That improvement is real and it is also this option's whole content. Everything
else here is inherited.

## Guards and metering

Inherited from B or C, with one addition worth having: a template is where an
operator sets a policy, so a template carrying `fallbackProvider` is the natural
place to **refuse** a policy whose only money limit is a window fraction (C2).
The refusal can be at template-save time — `saveSettings`' neighbourhood in
`docs/agent/conventions.md` — which is earlier and cheaper than admission and
much earlier than the wall.

## Permission and sandbox parity

Inherited, unimproved. The gaps in
[`10-permission-and-credentials.md`](10-permission-and-credentials.md) are
properties of running a second binary and do not become smaller because a
template asked for it.

There is a **negative** worth naming. A template is reused. A gap that an
operator accepted once, thinking about one task, is then applied silently to
every run made from that template afterwards — including runs made by a schedule
(`docs/agent/workflows-and-schedules.md`) that nobody is watching. Option C's
per-run choice is re-made every time; Option D's is made once and inherited
forever.

## Review and landing

Inherited. If it sits on Option B, disclosure is per cycle and hard; on Option C,
per run and easy.

## Blast radius

**Per template**, which is the widest of the four opt-in shapes and the least
legible. A template's blast radius is "every run anybody ever makes from it,
including scheduled ones" — and unlike a per-run choice, nothing re-asks.

The orchestrator chat is out of scope for the same reason as Option C
(`docs/agent/chat.md`; `chat.ts:2104` is a separate spawn with separate guards).
Note that chat *proposals* can create runs, so a chat that proposes a run from a
fallback-carrying template propagates the opt-in without ever naming it — which
is a reason for the run form to show the inherited value rather than hide it.

## How it fails, and whether loudly

Inherits everything from its base option, and adds one of its own:

**An opt-in that outlives the reasoning for it.** A template authored in a week
of frequent walls carries the flag into a month without any, and the only way to
notice is to read the template. That is a slow, silent failure of exactly the
kind `docs/agent/` is written to prevent, and this option has no natural
mechanism against it.

## What it costs to build

Base option's cost, **plus 1–2 days**: a template column, the copy-at-creation
freeze, the form field, and the run form's display of an inherited value.

It is the cheapest *increment* in the set and the most expensive *total*,
because it cannot exist without B or C underneath it.

## What would have to be true

1. Everything its base option needs.
2. **That some tasks are portable and others are not, and that an operator can
   tell in advance.** This is the option's entire premise and it is untested.
   `proposals/ContinuousImprovement/README.md` measured a related question — a
   generated in-prompt notice complied with 56 of 66 times against a matched
   control of 7 of 175 — which is evidence that operators *can* aim an
   instruction well, but says nothing about whether they can predict task
   portability.
3. That the number of templates is small enough for a per-template flag to be
   reviewable. Unmeasured here: `run_templates` has 0 rows on this machine.
