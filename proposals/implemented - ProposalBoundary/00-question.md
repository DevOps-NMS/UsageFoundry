# The question, and how it was asked

## The question

**Does an approved proposal become the run the card described, every time — and
when it does not, is the operator told?**

The companion survey owns everything the operator sees and clicks. This one owns
whether the click does what the card promised.

## What "the card promised" is taken to mean

A proposal card is the whole of what a person agrees to. `ChatProposalDTO`
(`src/lib/apiTypes.ts:2607`) is the closed list of what it can say, and four of
its fields are promises about the run rather than descriptions of the proposal:

- `guardsSource` and `guardsLabel` — where the guards come from, and either the
  template's name or the untemplated set written out (`src/app/api/chat/dto.ts:213`).
- `folderLabel` — where it runs, in the folder picker's words (`:239`).
- `agentName` / `agentMissing` — who the run is, said outside the guard clause
  so the card never words an agent as though it narrowed anything.
- `promptRewritten` — that the chat replaced the template's prompt.

So "became the run the card described" means: the run that exists afterwards has
the guards, the folder, the agent and the prompt that card named, or the
operator was told in a sentence they can act on why it does not. The
`docs/agent/chat.md` invariant is the same sentence from the other side:

> A proposal that names a template that has since been deleted is refused by
> name rather than falling back to the defaults: the operator approved the card
> that said "Fix a bug", and a run under different rules than the card stated is
> what this gate exists to prevent.

That paragraph is about a deleted template. This survey asks whether the
property it states holds generally.

## Method

Everything here was read from the tree at `0b96534` and then, where it could be,
driven against the real compiled code.

**Read.** `src/lib/chat.ts` in full for the functions named in the brief;
`src/app/api/chat/[id]/proposals/route.ts`, `.../message/route.ts`,
`.../questions/route.ts`, `.../route.ts` and `src/app/api/chat/dto.ts` in full;
`propose_run`, `propose_workflow` and `ask_operator` in
`src/app/api/mcp/route.ts`; `createRun`, `admitDependencies`, `dependencyCycle`,
`topologicalOrder` and `releasableRuns` in `src/lib/orchestrator.ts`;
`approveWorkflowProposal` and the orchestrator-block turn in
`src/lib/workflows.ts`; `chatGuards` in `src/lib/settings.ts`;
`agentRefusal`/`agentKnowledgeOf`/`agentDefinition` in `src/lib/agents.ts`;
`installBudgetRefusal` and `installSpend` in `src/lib/installBudget.ts`;
`dataDirRefusal` in `src/lib/serverLock.ts`; `reconcileChatsOnBoot`'s caller in
`src/instrumentation.ts`; the chat tables in `src/lib/db.ts`; and
`docs/agent/chat.md` and `CLAUDE.md` first, as the brief required.

**Driven.** Five scripts in [`scripts/`](scripts/) exercise the real exported
functions against a throwaway SQLite database, a throwaway workspace and (for
one of them) a fake `claude` binary. Each exits 0 when the behaviour it names
reproduces. Every number and every quoted refusal sentence in this proposal is
that script's own output rather than a paraphrase.

**A documented invariant is treated as a fact about the design, not a finding.**
Several things that look wrong at first reading are decided on purpose and say
so — the approval route dropping a stale id where the answer route refuses the
whole call, `planApprovalBatch` deliberately not re-deciding what
`admitDependencies` decides, a chat turn never being resumed after a restart.
Where a finding sits next to one of those, it says which side of the line it is
on and why.

## What is a finding

The brief's bar, applied literally: the exact `path/file.ts:42`, the input or
sequence that triggers it, what happens against what should happen, and the
reading behind it. Anything short of that is in
[`03-suspected-but-unverified.md`](03-suspected-but-unverified.md) and nowhere
else.

Each finding also says whether the fix is a **repair** — the code does not do
what it clearly intends, usually with its own comment as the witness — or a
**design change**, where it does what it intends and the intent is what is
wrong. The two get handled differently: a repair can be made by whoever finds
it, a design change is a decision.
