# Option H: a route through the existing MCP surface or the orchestrator chat

The brief asked for it, and it splits cleanly: one half is **unreachable** for a
documented reason, and the other half is **refused** because it pays a model to
run a `SELECT`.

## H1: a `pending_decisions` tool on `/api/mcp`

### The attractive version, and why it does not exist

The version worth wanting: the operator, on their laptop or phone, asks their own
Claude Code "does anything on UsageFoundry need me?", and a tool answers. No
service worker, no vendor, no push endpoint, no email, nothing left the box that
the operator did not pull. That is a genuinely good shape and it would be the
cheapest real latency reduction in this survey — one read tool beside the twelve
that exist.

**It is not reachable, and the reason is a decision rather than an omission.**
`src/app/api/mcp/route.ts:94-99`:

> **Why this route authenticates itself.** `middleware.ts` runs in the edge
> runtime and cannot reach SQLite or module state, so it cannot check a per-chat
> credential — the path is exempted there and the check happens here. The
> credential is *not* `UF_AUTH_TOKEN`: it is a capability minted for one chat
> turn and revoked when that turn's child exits, so a copy of it recovered
> afterwards opens nothing. Every tool below is scoped to the chat it names.

And `src/middleware.ts:63-68`:

> This is an exemption from *this* gate, not from authentication. If the check in
> `/api/mcp` is ever removed, this line makes the whole tool surface public —
> keep the two together.

So **there is no external MCP client path at all.** The only credentials that
reach this route are minted per turn, scoped to one chat or one orchestrator
block, and die with the child. An operator's own Claude Code has nothing it could
present. Making one work means either handing it `UF_AUTH_TOKEN` — which C2
forbids in the plainest words this repository has, because that token "opens every
route in the app, including the ones that spawn billed children" — or inventing a
**fifth** credential shape: long-lived, operator-held, read-only, checked inside
the route, on a path already exempt from the edge gate.

That fifth shape is not absurd. `UF_STATUS_TOKEN` is precisely that pattern
already: a second read-only credential, reaching one route, checked in the route
rather than the middleware, with the route not exempt at all while the variable is
unset. So the honest statement is that **H1 is a security-design change wearing a
notification feature**, and the change it proposes is to widen a route whose own
exemption comment says the two must be kept together.

### And the tool list is deliberately shaped against it

`route.ts:107-115` continues:

> Note what is absent from both: nothing here stops, resumes or reopens a run,
> nothing here presses Run on a workflow, nothing here writes to a folder, and
> nothing here sets a budget, a permission mode or an isolation choice.

A read-only `pending_decisions` tool would not violate that — it reads. But the
split in `toolsFor`, repeated in `callTool` "because a tool absent from a list is
not a tool absent from the wire", exists so that a capability's tools are decided
by *who it speaks for*. A tool that speaks for the operator rather than for a chat
or a block is a third subject, and the two-subject split is the mechanism.

### What it would actually be worth if the credential existed

Less than it first appears, for the reason that applies to every pull surface:
**it answers when asked.** It is Option A with a nicer client — `/api/status`
already answers "how many runs are in each state" to a purpose-built read-only
credential, and the marginal value of a tool over a `curl` is that a model can
read it in a conversation the operator is already having. Real, and not an
interrupt.

**Verdict: refused as scoped, and recorded as a question for a person.** If the
operator wants their own Claude Code to be able to ask, the thing to design is the
credential — a `UF_READ_TOKEN` on the `UF_STATUS_TOKEN` pattern — and the tool is
a consequence. That is a security decision, not a notification decision, and it is
not this survey's to take.

## H2: the orchestrator chat answers "what needs me"

**Refused, on cost, and the refusal is arithmetic.**

The orchestrator chat is a model turn. `docs/agent/chat.md`: "A turn's cost lands
on `chat_turn_spend` beside the thread's running total, because the install
ceiling reads a window and the total reads a lifetime." So asking the chat what
needs a decision spends money to have a model call a tool that runs a query whose
answer is a table of counts.

Option B renders the same answer from the same tables for zero marginal cost, on
every page, without a turn. There is no reading under which paying a model to
proxy a `SELECT` is the better mechanism, and the install-ceiling machinery exists
precisely because chat turns are a spend the operator has to bound.

One narrow case survives and is worth naming rather than dismissing: a model turn
can *summarise* — "three of these five are the same failing test" — which a table
of counts cannot. That is a real capability and it is a **triage** feature, not a
notification one. It belongs to whatever proposal owns cross-run reasoning;
`proposals/ContinuousImprovement`'s cross-run readout is the nearer neighbour, and
`proposals/GapRegister`'s observation that nine of twenty rows are one theme — the
app cannot find what it has already done — is the register entry it would sit
under. Not here.

## H3: the one part of this option that is free and should be taken

`emit_runs`'s description (`route.ts:545-552`) is worth quoting for a reason that
has nothing to do with MCP:

> Start these runs. This is NOT a proposal: what you emit is created and queued as
> soon as this turn ends, with no approval step.

An orchestrator block already starts runs unattended. Which means the *set* of
things that can happen with nobody watching is larger than `00-problem.md`'s
table: a workflow instance can be running blocks that emit runs that reach
`needs-review`, and the halt states of that instance (row 7) are on a page nobody
polls.

That is not an argument for a notification through MCP. It is an argument that
row 7 belongs in the digest, which `03-option-b-in-app-digest.md` already has it
doing, and it is recorded here because the MCP surface is where the fact lives.

## Coverage against the nine rows

H1, if the credential existed: all nine except row 3, same as Option B, on request
only. H2: the same, at the price of a model turn. Neither delivers anything to
anybody who does not ask.

## Cost

| | |
|---|---|
| H1 money | Zero |
| H1 code | ~40 lines for the tool. Plus a new long-lived credential shape, its route check, its `middleware.ts` pairing, its documentation and its threat model — which is the real cost and is not a notification feature |
| H2 money | One chat turn per question, against `chat_turn_spend` and the install's rolling 24-hour ceiling |
| H2 code | Near zero. It nearly works today |
| Dependencies | None, either way |
| Leaves the machine | Nothing, either way. **This is the option's one clean win over C, D, E and F** |
| Credential | H1 needs a fifth shape. H2 needs none |
