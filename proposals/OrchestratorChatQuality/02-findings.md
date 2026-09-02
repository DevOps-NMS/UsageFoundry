# The findings

[← The corpus](01-the-corpus.md) · [Next: Option A →](03-option-a-change-nothing.md)

Eight findings. Each names the exact instruction that causes it and quotes it.
Two are near-refutations of things that looked like defects and are reported as
such, because a survey that only lists faults reads as a fault list rather than
as evidence.

| | Finding | Severity | Rests on |
|---|---|---|---|
| [F1](#f1) | The asking instruction is read only by a model that has already decided to ask | **High** | Observed, 98 conversations |
| [F2](#f2) | A large batch writes the brief into `promptOverride` and drops the required `task` | **High** | Observed, 1 message, 6 refusals |
| [F3](#f3) | `on-finish` + `continueBranch` is the hazard the prompt names and the schema permits | **Medium** | Observed 7×; consequence unverifiable |
| [F4](#f4) | `continueBranch` asserts an isolation guarantee nothing tells it to check | **Medium** | Observed 149×; correctness unverifiable |
| [F5](#f5) | The duplicate check runs on the turn that cannot duplicate and is skipped on the turns that can | **Medium** | Observed, 125 proposing turns |
| [F6](#f6) | Guard vocabulary reaches the brief — and is mostly narrative, not an attempt to set a guard | **Low, near-refuted** | Observed, 450 proposals |
| [F7](#f7) | The operator spends whole turns asking what order to approve in | **Medium** | Observed 3× in operator's own words |
| [F8](#f8) | "Be brief" loses to the sentence it shares a paragraph with | **Low** | Observed, 125 replies |

---

## F1 {#f1}

### The asking instruction is read only by a model that has already decided to ask

**Observed.** `ask_operator` was called **3 times in 152 turns (2.0%)**. All
three came after the operator explicitly asked to be asked:

| Conversation | What the operator typed | Questions asked |
|---|---|---|
| `0de38db5`, 2026-08-27 | *"can you use the new question interface to ask questions about preferences and such that deciedes the direction of the client?"* | **4** |
| `ef6218c5`, 2026-08-28 | *"…Please ask some questions with the tool you have to shape this more accurately"* | 3 |
| `c9a292e6`, 2026-08-30 | *"…if you have questions use the question feature to ask me them"* | 1 |

It does not route around the tool either. Only **4 of 147** replies contain a
sentence ending in a question mark, and three of those are markdown fragments my
matcher caught — **at most one** genuine prose question exists in the whole
corpus. So this is not a model asking in the wrong channel. It is a model that
does not ask.

### The mechanism

The chat child's CLI **defers MCP tool schemas**. The model sees the tool
*names* and has to fetch a schema before it can call anything. Across the
corpus: **160 `ToolSearch` calls in 85 of 98 conversations**, and **159 of the
160 are of the form `select:mcp__uf__…`** — explicit fetches by name, not
keyword searches. Which names get fetched:

| Tool | Named in *n* of 160 `ToolSearch` queries | Times called |
|---|---|---|
| `list_templates` | 86 | 147 |
| `propose_run` | 85 | 686 |
| `list_folders` | 84 | 152 |
| `get_usage` | 82 | 140 |
| `list_runs` | 71 | 130 |
| `list_proposals` | 71 | 117 |
| `list_agents` | 69 | 92 |
| `list_workflows` | 46 | 67 |
| `get_run` | 39 | 40 |
| `propose_workflow` | 35 | 2 |
| `get_run_diff` | 10 | 0 |
| `save_template` | 8 | 12 |
| **`ask_operator`** | **3** | **3** |

And the correlation is exact. Of 98 conversations, `ask_operator`'s schema was
fetched in **3**, called in **3**, and **both in the same 3**. It has never been
fetched and not used, and never used without being fetched. The tool is called
precisely when, and only when, the model went looking for it.

This matters because of where the instruction lives. The comment above the
declaration says so outright — `src/app/api/mcp/route.ts:292-300`:

> ```
> // The description below is the whole of what the model is told about
> // asking, and it is long for `systemPrompt()`'s stated reason: the
> // tool-calling half of the orchestrator's instructions lives here, where it
> // cannot drift from the schema, and is deliberately not repeated in the
> // prompt. The sentence that must never be cut is the second one.
> ```

That description (`src/app/api/mcp/route.ts:302-321`) is 1,100 characters of
carefully-reasoned judgement — *"Ask only what the repository cannot tell you:
which of two jobs matters more, what \"done\" means here, whether a risk is
acceptable, which of several folders they meant"*, *"never ask for permission to
propose"*, *"Offer concrete choices whenever the answer is a choice"*. **On 95 of
98 conversations the model never read a word of it**, because it never fetched
the schema.

### Why the model never goes looking

The system prompt is where a model decides what to fetch, and it has a paragraph
on asking — `src/lib/chat.ts:2543-2554`:

> ```
> "Asking the operator:",
> "- Ask only for what only they know: which of two designs they want, what",
> "  an ambiguous word meant, whether something they own is in scope.",
> "  Anything in the repository, in `git log`, in the issues or in a template",
> "  you can already read is yours to go and find out, and asking for it says",
> "  you did not look.",
> "- Prefer proposing with the assumption stated in your reply. A proposal is",
> "  rejected in one click; a question costs the operator a decision and you",
> "  a turn.",
> "- One question is a question and four are a form, and a form gets skimmed.",
> "  If one answer would not get you to a proposal, say what is unclear",
> "  instead.",
> ```

Two things about it, and the second is the finding.

**It never names the tool.** `ask_operator` is one of **two** tools the system
prompt does not name anywhere in its 99 lines. The prompt names `list_folders`
(`:2530`), `list_proposals` (`:2536`), `list_agents` (`:2539`, `:2565`),
`propose_run` and `propose_workflow` (`:2502`), `save_template` (`:2567`),
`promptOverride` (`:2561`) and `dependsOn` (`:2575`).

**Every sentence in it is restrictive.** Three bullets: *ask only for*, *prefer
proposing*, *four are a form*. There is no sentence that says asking is
something to do, and none that implies a *tool* rather than a turn of phrase. A
model reading this paragraph learns when not to ask and is never told what to
call.

**The honest counter-evidence**, because it is real: `get_usage` is also unnamed
and is fetched 82/160 and called 140 times. So an unnamed tool is not
automatically an unreachable one. The difference is that the prompt describes
`get_usage`'s *action* imperatively at `src/lib/chat.ts:2534-2535` —

> ```
> "- If a 5-hour or weekly window is nearly spent, say so — approving ten runs",
> "  into a full window means ten runs that stop on their first guard check.",
> ```

— which is a thing to go and do, and "usage" is the obvious name for the tool
that does it. The asking paragraph has no equivalent sentence. `ask_operator` is
the only tool in the surface whose *use is a judgement the prompt spends a
paragraph on* while the paragraph never connects to the tool.

### On `MAX_OPEN_QUESTIONS`

The brief asks whether 5 (`src/lib/chat.ts:289`) reads as a target. **On this
evidence it cannot**, because the number is only visible inside the deferred
description — `src/app/api/mcp/route.ts:316` interpolates it into the sentence
*"keep it to a couple of questions (at most 5)"* — and the model reads that
sentence in 3 conversations out of 98.

But on the three occasions it did read it, look at what happened: the first call
asked **4 questions**. The prompt's own line is *"One question is a question and
four are a form, and a form gets skimmed"* (`src/lib/chat.ts:2552`); the
description's is *"keep it to a couple of questions (at most 5)"*. Both were in
context. The model chose 4 — the largest number the prompt names as bad and one
under the ceiling the description names as the cap. That is n = 1 and is scored
as a hint, not a finding. What it hints is that when the two bounds are read
together, the *ceiling* wins over the *warning*, which is the thing to watch if
F1 is fixed and asking becomes common.

Everything about the three real calls was otherwise good: choices offered on
**8 of 8** questions, `allowText` left true on all 8, and each question carried
its own context by name (*"InvestmentManager rules ranking out twice on purpose:
`docs/project-definition.md:59` lists…"*). The description works when it is
read. It is almost never read.

---

## F2 {#f2}

### A large batch writes the brief into `promptOverride` and drops the required `task`

**Observed, once, and it is six of the corpus's eight refusals.**

Conversation `da349f53`, 2026-08-14T20:02–20:08. One assistant message of
**23,626 output tokens** — the largest in the corpus — emitted ten `propose_run`
calls:

| # | `task` chars | `promptOverride` chars | Result |
|---|---|---|---|
| 1 | **0** | 7,053 | refused |
| 2 | **0** | 8,381 | refused |
| 3 | 1,683 | 0 | ok |
| 4 | **0** | 7,002 | refused |
| 5 | 1,740 | 0 | ok |
| 6 | 1,693 | 0 | ok |
| 7 | **0** | 7,680 | refused |
| 8 | 1,856 | 0 | ok |
| 9 | **0** | 7,341 | refused |
| 10 | **0** | 6,921 | refused |

Every call is **either** `task` **or** `promptOverride`, never both. All six
task-less calls were refused with

> `A proposal needs a task. It is the whole brief the agent gets besides the template's own prompt.`

The model then re-issued all six in a following message of 15,930 tokens — and
the repair tells you what went wrong. Every one of the six retries carries a
`promptOverride` that is the **same string, byte for byte** (SHA-1 `06a95436`,
5,058 characters), plus its own `task` of 1,814–3,297 characters. Two later
proposals in the same conversation reuse that identical override again.

So the failing message spent roughly **44,000 characters writing six
near-duplicate standing-instruction blocks**, one per proposal, and the field
that got squeezed out was the required one. This was not an API truncation:
`stop_reason` was `tool_use` on every record and no message in the corpus ended
at `max_tokens`.

### The instruction that causes it

`promptOverride` — `src/app/api/mcp/route.ts:383-388`:

> ```
> promptOverride: {
>   type: "string",
>   description:
>     "Replaces the template's own prompt for this run only. Use when " +
>     "the template nearly fits; the task is still appended below it.",
> },
> ```

Three words do the damage: **"for this run only"**. They are true — the override
does not persist — but read as a writing instruction they say *compose a fresh
one per proposal*, which is exactly what the model did six times. Nothing in the
description says the override is *standing* text that will normally be identical
across a batch, and nothing says it is not a substitute for `task`.

**The sentence that would have prevented this is already written, on a different
tool.** `save_template.prompt` — `src/app/api/mcp/route.ts:280-285`:

> ```
> prompt: {
>   type: "string",
>   description:
>     "The standing instructions every run from this template starts " +
>     "with. The per-run task is appended below it.",
> },
> ```

*"The standing instructions"* and *"the per-run task"* draw exactly the
distinction `promptOverride` needs and does not have. `src/lib/chat.ts:2480-2482`
warns about the inverse of this — *"Before deleting a sentence from a
description over there, check it is not the only copy left"* — and here a
sentence that is load-bearing in two places exists in one.

The prompt's own line on the pair (`src/lib/chat.ts:2561-2562`) is about a
different failure and does not help:

> ```
> "- Use promptOverride rather than contradicting the template inside the task,",
> "  and say that you rewrote it.",
> ```

That tells the model to prefer the override when the two would conflict. It says
nothing about `task` remaining mandatory.

**Corpus-wide the pair is otherwise used correctly:** of 450 proposals, 39 carry
both fields, 405 carry `task` alone, and the 6 that carry `promptOverride` alone
are this one message. `promptOverride` is present on 45 proposals (10.0%),
median 5,058 characters, max 9,147. So the failure is not chronic — it is what
happens at the top of the batch-size distribution, and the top of that
distribution is **20 proposals in one turn**.

---

## F3 {#f3}

### `on-finish` + `continueBranch` is the hazard the prompt names, and the schema permits it

**Observed 7 times.** The consequence was not observed and could not be — see
[what could not be observed](01-the-corpus.md#what-could-not-be-observed).

The system prompt names this failure in one clause — `src/lib/chat.ts:2575-2577`:

> ```
> "- dependsOn has no default edge: pick the one you mean, because on-success",
> "  ends a chain the operator meant to run regardless and on-finish starts",
> "  work on top of a run that crashed.",
> ```

*"on-finish starts work on top of a run that crashed"* is the exact hazard. Now
add `continueBranch` — `src/app/api/mcp/route.ts:449-455`:

> ```
> continueBranch: {
>   type: "boolean",
>   description:
>     "Carry on that run's branch instead of cutting a fresh one, " +
>     "so this agent starts with its commits already there. Only " +
>     "when both runs work in a checkout of their own, and only " +
>     "one proposal may continue any given run.",
> },
> ```

Set both and you get: start on the branch of a run that crashed, with whatever
half-finished state it left committed. Of **206 dependency edges** in the corpus,
**175 are `on-success` and 31 are `on-finish`**; **7 of the 31 also carry
`continueBranch`**.

The task text on those seven shows the model believed the prior work was
present:

| Proposal | Depends on | Task says |
|---|---|---|
| *"Shape the external run-completion validator"* | `validator-baseline`, on-finish + continueBranch | *"You are on the branch of the measurement run before you; **its commits are already here**."* |
| *"Mark GapRegister's frontend axis as shipped, in the register and in docs"* | `fe-small`, on-finish + continueBranch | *"**Documentation only.** … You are c…"* |
| *"GapRegister F4+F6: log filter, settings field search, unsaved-edit guard"* | `fe-reachability`, on-finish + continueBranch | *"You are continuing the branch of the run that implemented GapRegister **F1** and **F2**…"* |

The second row is the clearest failure available. It is a run whose entire job is
to record that other work shipped, told to start **once the shipping run is out
of the way either way**, on that run's own branch. If `fe-small` crashes
half-way, this agent opens a checkout holding half the change and writes into
the register and the docs that the axis is done.

### Why the surface allows it

Neither field's description mentions the other. The `edge` enum
(`src/app/api/mcp/route.ts:442-448`) says:

> ```
> edge: {
>   type: "string",
>   enum: ["on-success", "on-finish"],
>   description:
>     "on-success starts only if that run completed; on-finish " +
>     "starts once it is out of the way either way.",
> },
> ```

*"out of the way either way"* is a scheduling statement. It says nothing about
the **state of the branch** in the failing case, and `continueBranch` sits
directly beneath it saying *"starts with its commits already there"* — a promise
that is only true on the `on-success` path. The one place in the whole surface
that connects the two is the system-prompt clause above, which is 40 lines away
from the schema and phrased as a warning about picking an edge, not as a
constraint on combining two fields.

`dependsOn`'s own description (`src/app/api/mcp/route.ts:428-434`) does not help
either — it is about *when* to order, not which edge:

> ```
> "Proposals this one starts after — by the id you gave them, in " +
> "this chat. Use it when two runs would edit the same files, or " +
> "when one reviews or builds on another. Both must be approved in " +
> "the same click, or the earlier one must already have started.",
> ```

**Scored honestly:** 7 of 206 edges is 3.4%, and none is known to have been
approved, let alone to have hit a crash. This is a mechanism finding with a
concrete instance, not a measured incident.

---

## F4 {#f4}

### `continueBranch` asserts an isolation guarantee nothing tells it to check

**Observed on 149 of 450 proposals (33.1%).** Of those 149, **only 30 (20.1%)
name a `templateId`** — the other 119 run on the operator's default guard set.

`continueBranch`'s description says *"Only when both runs work in a checkout of
their own"* (`src/app/api/mcp/route.ts:453-454`). Whether they do is a **guard**,
and the model cannot set it. It comes from the template, or from the default
guard set (`src/lib/chat.ts:2519-2524`):

> ```
> "What decides what an agent may do — the budget, the work-cycle limit, the",
> "permission mode, whether it works in its own checkout — is never yours to",
> "set. It comes from the template a proposal or a workflow block names, or,",
> "when it names none, from the operator's default guard set in Settings.",
> ```

So a `continueBranch` on an untemplated proposal is the model asserting a
condition about a setting it did not choose. It *can* find out —
`list_templates` reports it (`src/app/api/mcp/route.ts:161-163`):

> ```
> "List saved run templates, with the guards each one supplies — budget, " +
> "work-cycle limit, permission mode, isolation — and the default guard " +
> "set a proposal that names no template runs under.",
> ```

— and **125 of the 149 (83.9%)** did call `list_templates` in the same turn.
One reply quotes the default set in full: *"all under the default guard set
(bypassPermissions, own checkout, $35, 3 work cycles, 240 min)"*. So on this
install the assumption was very likely correct, most of the time.

The finding is not that it got it wrong — that cannot be checked from here. The
finding is that **the check is nowhere in the instruction that needs it**.
`continueBranch`'s description states the precondition as a fact about the world
(*"Only when both runs work in a checkout of their own"*) rather than as
something to go and verify, and does not name where the answer lives. An
operator who turns isolation off in their default guard set breaks 119 of these
149 assertions silently, and nothing in the surface would have told the model to
re-check.

---

## F5 {#f5}

### The duplicate check runs on the turn that cannot duplicate, and is skipped on the turns that can

**Observed.** `list_proposals` exists for exactly one reason —
`src/app/api/mcp/route.ts:256-260`:

> ```
> name: "list_proposals",
> description:
>   "The proposals already made in this conversation and what became of " +
>   "them, so the same work is not proposed twice.",
> ```

Split the 125 proposing turns by whether they are the **first** proposing turn of
their conversation:

| | Called `list_proposals` before the first `propose_run` |
|---|---|
| First proposing turn of a conversation | **60 / 97 (61.9%)** |
| Second and later proposing turns | **6 / 28 (21.4%)** |

That is backwards. On the first proposing turn of a conversation there is
nothing in the panel to duplicate, so 62% of those calls buy nothing. On a
second or later turn the panel holds everything the last turn proposed — the one
case the tool was built for — and it is consulted **one time in five**.

The likely cause is placement. The system prompt mentions `list_proposals` once,
in the "Reading the state of things" block — `src/lib/chat.ts:2536`:

> ```
> "- list_proposals carries the id you gave each proposal in this chat.",
> ```

That is the *orientation* block, read at the top of a turn along with
`list_folders` and the window check, and it frames the tool as a way to recover
**ids for `dependsOn`** rather than as a duplicate check. The duplicate-check
purpose lives only in the tool's own description, and the "Proposing a run" block
(`src/lib/chat.ts:2556-2568`) never mentions it. So the model calls it early,
with the other read tools, for the reason the prompt gives — and the reason the
description gives is not the reason it calls it.

`list_runs` has the same purpose against a different corpus
(`src/app/api/mcp/route.ts:168-173`, *"so work already in flight is not proposed
a second time"*) and is called before proposing on **79 / 125 (63.2%)** of turns,
with the same first-turn skew.

**What is not established:** whether any work was actually proposed twice.
`list_proposals` returns pending proposals from the unreadable database, so the
corpus shows the calls and not their contents. This is a finding about the
tool's placement, not a count of duplicates.

---

## F6 {#f6}

### Guard vocabulary reaches the brief — and is mostly narrative

**Reported as near-refuted**, because it is the finding I expected to be worst
and it is not.

`src/app/api/mcp/route.ts:613-614`, on the block tool next door, predicts the
failure:

> ```
> // that believes it can set guards writes a task explaining what guards it wants.
> ```

Measured on 450 proposals:

| Pattern in the `task` text | Proposals | |
|---|---|---|
| isolation / worktree / own checkout | 173 | **38.4%** |
| budget or a dollar figure | 111 | 24.7% |
| work cycle / iteration | 101 | 22.4% |
| permission mode / `acceptEdits` / `bypassPermissions` | 37 | 8.2% |
| *"do not exceed"* / *"stop when you"* / *"within one"* | **3** | **0.7%** |
| **Any of the above** | 228 | **50.7%** |

Half of every brief touches guard vocabulary — and reading the actual sentences,
almost none of it is an attempt to set anything. The overwhelming majority is
**context an unattended agent genuinely needs**: *"You are running unattended in
your own checkout"*, *"You are on the branch of the measurement run before you"*,
or the subject matter itself (*"A run that ends by exhausting `maxIterations` is
stored as `completed`"* is a bug report about this app). Of 99 tasks naming
"budget", **2** quote a dollar figure, and one of those is describing a log line.

The one recurring pattern worth naming is a single sentence, repeated verbatim
across at least six vault-writing proposals in one turn:

> *"If budget or work cycles run short, finish fewer notes properly and seed the
> rest — thin notes are worse than absent ones."*

That is the model writing **fallback policy** into the brief because it cannot
set the budget and does not know whether the default one is enough. It is good
instruction — it is arguably the single most useful sentence in that brief — and
it is the only shape in the corpus that resembles the predicted failure. It
argues, mildly, that the prompt's flat prohibition (`src/lib/chat.ts:2519-2524`)
leaves a real gap: the model knows the guards from `list_templates` and is told
only that they are not its to set, never that saying what to do when one binds is
legitimate.

**No change is recommended for this on its own.** It is filed so that a later
pass that tightens the guard language does not tighten it into forbidding the
one useful thing here.

---

## F7 {#f7}

### The operator spends whole turns asking what order to approve in

**Observed 3 times, in the operator's own words**, in three separate
conversations:

> *"can you give me the run order in which to approve them?"* — reply 1,201
> characters, zero tool calls
>
> *"ok, whats the execution steps now, tell me what to approve in what order?"*
> — reply 1,972 characters
>
> *"can you not use the run after feature so i can just approve all and they run
> in the correct order?"* — reply 3,103 characters

The third is the operator asking the orchestrator to **stop using `dependsOn`**
because they cannot tell what to do with the result.

This is not the prompt failing to say the thing. The instruction is followed:

`src/lib/chat.ts:2578-2579`:

> ```
> "- Say in your reply that they have to be approved in the same click. A",
> "  dependent approved on its own is failed by name rather than started.",
> ```

**81 of the 85 turns carrying a `dependsOn` (95.3%) said "same click" or an
equivalent in the reply.** The instruction is complied with at a higher rate than
almost anything else in the corpus, and the operator still asked three times.

What the instruction produces is a *rule* — approve them together — where what
the operator asked for is an *order*. Those are different sentences. On this
install the difference is large: **142 of 175 `on-success` edges also carry
`continueBranch`**, which serialises the chain, and one observed turn proposed a
**7-deep strictly serial chain** (`kit → shell → dashboard → runform → settings
→ rundetail → workflows`), every link `on-success` + `continueBranch`. A reply
that says "approve them in the same click" and does not say "and here is the
order they will run in" leaves an operator holding seven cards and no sequence.

That reply did in fact number them 1–7 with `← kit`-style arrows, which is why it
is a good chat. But numbering is not asked for anywhere; the prompt's only
ordering sentence is the same-click rule, and the three turns above are what
happens when a model does the minimum the prompt asks.

**Bounded honestly:** the panel itself may already show this. No browser was
opened. But three operator sentences asking for it is evidence that whatever the
panel shows was not enough on those three occasions, and the prompt-side repair
costs one clause.

---

## F8 {#f8}

### "Be brief" loses to the sentence it shares a paragraph with

**Observed.** The closing instruction — `src/lib/chat.ts:2591-2593`:

> ```
> "Be brief. When you have proposed, reply with a short list of what you",
> "proposed and what you deliberately left out. The proposals appear in the",
> "panel beside this conversation, so do not repeat their full text.",
> ```

Measured over the 125 proposing turns, the final reply is median **2,188
characters**, p90 2,793, max 3,492 — roughly 350 words for a "short list".

The half that works is the third sentence. **0 of 125** replies echo more than
30% of their proposals' opening task sentences; the model does not paste the
briefs into the chat. It also uses the reply for the things the prompt asks for
elsewhere: **107 of 125** name the template or guard set, **83 of 125** mention
the usage window, **81 of 85** state the same-click rule.

So a 2,188-character reply is what you get when one paragraph says "be brief" and
four other paragraphs each require a sentence. This is the **lowest-severity
finding in the survey** and is filed mainly to say that the obvious repair —
tightening "be brief" — would delete compliance with the other four instructions.
Any fix here is a fix to the *list* of required sentences, not to the adjective.

---

## Two things the corpus says are working

Filed because they bound what a change should not break.

**The look-before-you-propose instruction works.** `src/lib/chat.ts:2526-2527`
says *"Look before you propose. Each tool's own description says what it returns
and what it is for; what follows is only the part those do not say."* Observed:
**89.6%** of proposing turns ran `Read`/`Grep`/`Glob`/`Bash` first, 957 `Bash`
calls in total, median 5 per turn. Tasks name a concrete file **96.9%** of the
time and a `file:line` **31.8%** of the time.

**The don't-do-the-work instruction works.** `src/lib/chat.ts:2512-2517` forbids
editing a workspace with one exception for scratch space. Across 152 turns there
are exactly **three** `Write` calls, and all three land outside the mounts:
`/tmp/uf-ws/PWNED.txt` (an operator's own probe), `/tmp/uf-issue-earlier-chats.md`,
`/tmp/claude-1000/external-validator-mockup.html`. No `Edit`, no `git commit`, no
`gh` mutation anywhere in the corpus. Under `bypassPermissions` with every mount
on the argv, that is the instruction doing the entire job — and
`docs/orchestrator-chat.md:87-96` is right that it is the only thing there.
