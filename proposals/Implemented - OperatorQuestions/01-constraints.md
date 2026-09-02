# What bounds the field

Fourteen constraints. Every one was read out of the tree or out of
`docs/agent/` at the head of this branch; each carries the `file:line` it came
from. An option that violates one of these without naming it is not an option.

C1 is the one that kills the most obvious design, and it kills it twice.

---

## <a id="c1"></a>C1 — A tool call cannot wait for a human, and the reason is a deadlock before it is a timeout

**The turn is killed at ten minutes and its answer is discarded.**

`src/lib/chat.ts:247-248`, verbatim:

```ts
/** A chat turn that has not finished in this long is not going to. */
export const CHAT_TIMEOUT_MS = 10 * 60_000;
```

The timer is armed inside `runOrchestratorChild` (`chat.ts:1734-1740`) and sets
a `timedOut` flag before SIGTERM, then SIGKILL five seconds later. At settle
(`chat.ts:1758-1764`):

```ts
settleOnExit(child, (code) => {
  if (timedOut) {
    land({ status: "failed", error: o.timedOutMessage });
    return;
  }
  land(parseTurnOutput(stdout, stderr, code));
});
```

`parseTurnOutput` is not called. Everything the child had written — the reply
text, `total_cost_usd`, the `session_id` — is thrown away. `finishTurn` adds
zero to `cost_usd` (`chat.ts:1959-1960`), writes no `chat_turn_spend` row (the
`> 0` guard at `chat.ts:1975`), and leaves `session_id` untouched via
`COALESCE(NULL, session_id)` (`chat.ts:1952`). The operator gets
`TIMED_OUT_REASON` (`chat.ts:1316-1317`) as a `system` message.

A second, independent path backstops it: `sweepStuckChats` (`chat.ts:1431-1443`)
runs every `CHAT_SWEEP_MS = 30_000` (`chat.ts:261`) and fails out any `thinking`
row older than `CHAT_TIMEOUT_MS + STALE_TURN_MARGIN_MS` (`chat.ts:1339`,
`:258`) — eleven minutes — because the in-closure timer waits on a `close` that
may never arrive.

**And the operator physically cannot answer while that turn is alive.**
`sendChatMessage` refuses twice on `thinking`: the fast check at `chat.ts:1480`
and the authoritative conditional claim at `chat.ts:1498-1499`, both returning

```ts
const ALREADY_THINKING: ChatOutcome = {
  ok: false,
  reason: "This chat is still working on the last message.",
};   // chat.ts:1251-1254
```

which `message/route.ts:24-26` returns as a 400.

**And there is no channel to deliver the click on.** `/api/mcp` speaks MCP over
HTTP by hand, and its answers are plain JSON rather than SSE
(`src/app/api/mcp/route.ts:84-85`); `GET` is refused outright with
`-32601 "No server stream"` and HTTP 405 (`route.ts:710-715`).

So a blocking `ask_operator` is not a design with a ten-minute risk attached. It
is a turn holding a door shut against the only person who could open it, for as
long as it holds it. **Every option in this survey assumes the question ends the
turn.**

## <a id="c2"></a>C2 — A question that spans turns costs nothing extra, because continuity is already free

A turn is a headless `claude -p` resumed against `chat_sessions.session_id`:
read off the freshly-claimed row (`chat.ts:1816`), pushed as `--resume`
(`chat.ts:1698`), stored back with `COALESCE` at settle (`chat.ts:1952`). With a
session id present, `chatPrompt` sends the bare message and replays nothing
(`chat.ts:639`).

So "ask in turn N, read the answer in turn N+1" is the *natural* shape here, not
a workaround: the model's own memory of asking is in the resumed session, and
nothing has to be restated to it.

Two caveats bound how far that can be leaned on:

- With **no** session id — a thread's first turn, or a CLI that reported none —
  `chatPrompt` replays the newest `THREAD_REPLAY_MESSAGES = 20` messages inside
  `THREAD_REPLAY_BYTES = 20_000` (`chat.ts:243-244`, `:655-666`) from
  `listMessages` alone. Anything held outside `chat_messages` is not in that
  replay ([F8](00-problem.md#f8)).
- A CLI that answers under a *different* session id is detected and noted as a
  `system` message (`chat.ts:1988-1993`), and the thread continues under the new
  one. Continuity is best-effort, not guaranteed.

## <a id="c3"></a>C3 — The page polls, on two cadences, and nothing else pushes

`POLL_IDLE_MS = 10_000` and `POLL_ACTIVE_MS = 3_000`
(`src/app/chat/page.tsx:51-52`). The interval is chosen at `page.tsx:361`:

```ts
const period = chat?.status === "thinking" ? POLL_ACTIVE_MS : POLL_IDLE_MS;
```

with `chat?.status` in the effect's dependency array (`:364`), so the cadence
re-keys correctly when the status changes. There is no `visibilitychange`
handler anywhere in `src/` and no backoff: a failing poll keeps its cadence and
sets `pollError` (`page.tsx:322-327`), rendered at `:705`.

Consequence: **a question appears up to ten seconds after the turn that asked it
settles**, unless something moves that chat onto the active cadence. Whether it
should be moved is a real question — nothing server-side is going to change
while a question waits, so the fast poll would be burning requests to watch a
row that only the operator can move.

## <a id="c4"></a>C4 — A chat's state has three values and ten equality tests, none of them exhaustive

`export type ChatStatus = "idle" | "thinking" | "failed";` (`chat.ts:92`),
mirrored on the wire at `src/lib/apiTypes.ts:2485` and `:2498`, with the column
comment at `db.ts:556-559`.

The sites that read it are listed at [F3](00-problem.md#f3). Every one is an
`===` against a literal. **There is no `Record<ChatStatus, …>` anywhere on the
page**, so a fourth value type-checks clean and fails open at all ten: a chat in
a new status is not-thinking, so it polls slowly, shows no waiting row, shows no
Stop button, and leaves Send enabled.

The contrast worth holding onto: `PROPOSAL_TONE` (`page.tsx:118-123`) is an
`as const` object indexed at `page.tsx:1498`, so a new *proposal* status is a
compile error. Chat status has no such reader. That asymmetry is the whole cost
of [Option 4b](12-option-4b-awaiting-answer-status.md).

The writers, for completeness: `createChat` inserts `'idle'` (`chat.ts:275`);
`claimTurn` sets `'thinking' WHERE status<>'thinking'` (`chat.ts:1284-1288` —
note **not** `='idle'`, so a `failed` row is retryable, and so would a fourth
value be); `endTurn` and `finishTurn` both latch on `WHERE status='thinking'`
(`chat.ts:1366-1369`, `:1949-1953`); `reconcileChatsOnBoot` fails out `thinking`
rows and only those (`chat.ts:2052-2060`, called from
`src/instrumentation.ts:123-124`); and `review.ts:379` counts `thinking` rows
toward the assist-concurrency limit.

## <a id="c5"></a>C5 — `chat_messages` has three roles, no updates, and a globally-ordered `seq`

`export type ChatRole = "user" | "assistant" | "system";` (`chat.ts:93`), with
`db.ts:602-604` defining `system` as *"this app speaking about the chat rather
than the model speaking in it"*.

Two properties of the table that constrain storage options:

- **Nothing updates a message row.** `appendMessage` (`chat.ts:318-340`) is the
  only writer and it only inserts; there is no `UPDATE chat_messages` anywhere
  in `src/`. A design that needs mutable per-question state (open → answered)
  would be making this table mutable for the first time.
- **`seq` is a single global sequence, and it is never null.** The INSERT takes
  it inline — `(SELECT IFNULL(MAX(seq), 0) + 1 FROM chat_messages)`
  (`chat.ts:330-331`), with the comment explaining that one statement is the
  only shape in which the next number cannot be handed out twice. `listMessages`
  orders by `seq` alone (`chat.ts:312-316`), and the migration backfills
  `seq = rowid` **on every boot**, not just the one that added the column
  (`db.ts:915-916`). So `seq` is a safe anchor for interleaving something else
  into the thread.

The rendering rule that governs how a role reads on screen is
`docs/agent/conventions.md:21` — quoted in [F6](00-problem.md#f6), and it is the
reason a question cannot simply be a `system` message.

## <a id="c6"></a>C6 — Chat threads never expire, and there is deliberately no terminal state to key on

`src/lib/retention.ts:632-634`, verbatim:

```
// Every chat, whatever its status and however old. A thread is resumed by the
// operator typing into it, which they may do at any time — there is no
// terminal state to key on, and the set is one row per conversation.
```

That paragraph is about which transcripts a sweep may delete, and it decides two
things for this design. First, **anything stored per question is permanent**: an
abandoned question is a row that lives as long as the install. Second, **a
question may not acquire a clock.** Expiring one after a day would be inventing
the terminal state this comment says a chat does not have, and it would do it on
a horizon nobody configured.

## <a id="c7"></a>C7 — Guards, budgets and permission modes are never the model's, and a question must not become a route to one

`docs/agent/chat.md:8`:

> `planProposal` is where a proposal becomes a run, and the branch that matters
> is the one that is *not* in it: no value off a proposal sets a budget, a
> permission mode or an isolation choice.

`db.ts:616-621`, on the proposals table:

> What it deliberately does *not* hold: guards, a permission mode, a model. […]
> Storing a budget here would make the chat the second route to
> `--permission-mode` that `reopenRun` refuses to become the third.

and the prompt's own statement of it, `chat.ts:2114-2119`.

For this design the rule has a specific edge. It is not enough that a question
holds no guard field: **an answer must not be able to write one either.** A
question whose answer route sets a field on a `chat_proposals` row would be that
route, however innocuous the field looked, because the card the operator
approved would no longer be the card they read. The safe shape is that an
answer's only effect is *text the model reads* — the same standing the operator's
own typing has.

## <a id="c8"></a>C8 — A model's output on this surface gets a hard cap, and the reason transfers

`chat.ts:231-241`, verbatim:

> How many undecided proposals one chat may hold.
>
> The failure this bounds is specific and cheap to reach: "open a run for every
> issue" against a repository with four hundred of them. Nothing downstream
> would break — proposals are inert — but **an approval list nobody can read is
> an approval gate that gets clicked through, which is the same as not having
> one.** The tool refuses past this and says so, so the model asks for a filter
> instead of silently proposing the first twenty-five.

`export const MAX_PENDING_PROPOSALS = 25;` — enforced at the door in
`route.ts:1533-1536` and `:1323-1326`, with the refusal text built by
`pendingLimitMessage` (`route.ts:1357-1366`).

The transferable part is the mechanism as much as the number: **the cap is
enforced in the tool and it explains itself to the model**, so the model adapts
rather than being silently truncated. Fork 3 is the same decision at a much
smaller number.

## <a id="c9"></a>C9 — Every turn is billed, gated and recorded, and the gate is not per-chat

`chat.ts:1492-1493`: `const refusal = (await assistRefusal()) ?? installBudgetRefusal();`
— the only `await` before the claim.

`docs/agent/chat.md:26` says why there is nothing finer:

> A chat turn is spend with no `evaluateBudget` behind it. It passes the same
> gate a review does […] and nothing else, because there is no per-chat fraction
> and **inventing one would be a threshold nobody set.**

The ceiling inside the child is `settings.chatTurnBudgetUSD` (default $2, null
disables) as `--max-budget-usd` (`chat.ts:1700-1705`). Each settled turn with
non-zero cost writes one dated row to `chat_turn_spend` (`chat.ts:1975-1981`;
table at `db.ts:1171-1180`), which is what the install-wide 24-hour ceiling reads
(`installBudget.ts:28`, `:74`).

Two things follow. A question costs a turn and its answer costs another
([F7](00-problem.md#f7)). And **a "question budget" expressed as money or as a
setting would be exactly the threshold nobody set** that this paragraph refuses;
whatever bounds asking has to be structural or prose.

## <a id="c10"></a>C10 — Where a sentence lives is already decided, and the test is written down

`chat.ts:2078-2088`, verbatim:

> **The half about calling tools lives in `src/app/api/mcp/route.ts` and is
> deliberately not repeated here.** The tool list and this string arrive in the
> same request, so every sentence describing what `list_folders` returns or what
> `agentId` does was being paid for twice per turn — and the schema is the copy
> that cannot drift from the tool, because it *is* the tool. What survives here
> is only what no schema can carry: an instruction to look before proposing, the
> facts a description has no field to hang on […] and **what to *say* in the
> reply, which is about this conversation rather than about a call.** Before
> deleting a sentence from a description over there, check it is not the only
> copy left.

That last clause is a usable test, and fork 8 is decided by applying it: *is
this sentence about a call, or about this conversation?* Mechanics of the tool —
what a field means, that it does not block, that a second call is refused — are
description-side. When asking beats proposing, and the budget on asking, are
prompt-side.

House style for a description, from `route.ts:287-291`:

```ts
      description:
        "Propose one run for the operator to approve. This does NOT start " +
        "anything: it records a proposal that a person approves or rejects by " +
        "hand. Guards come from the template — or from the operator's default " +
        "guard set when no template is named — and cannot be set here.",
```

Prose, ~76 columns, second person, SCREAMING emphasis on the critical negation,
and the negative space stated explicitly. Every leaf property in an
`inputSchema` carries its own `description`; there is no Zod and no schema
builder, and every argument is re-parsed defensively in the handler.

## <a id="c11"></a>C11 — A new chat tool is three edits, and the block refusal is free

To exist, a chat-only tool needs: the definition object pushed into `CHAT_TOOLS`
(`route.ts:247-521`), and a `case` in the `callTool` switch (`route.ts:805-1016`).
That is all — because `toolsFor` (`route.ts:628-633`) selects by subject, and
`callTool`'s door check (`route.ts:790-800`) is a membership test over the same
arrays:

```ts
790    const chatId = subject.kind === "chat" ? subject.chatId : null;
791    if (chatId === null && (CHAT_TOOLS.some((t) => t.name === name))) {
792      return text(`${name} is not available to an orchestrator block. Use emit_runs.`, true);
793    }
```

So the orchestrator-block refusal that [F9](00-problem.md#f9) worries about
costs nothing. The subject union it rests on is `chat.ts:1176-1178`.

A tool that throws returns its error as tool *output*, not as a protocol error
(`route.ts:764-769`), and every refusal in this file is
`text(message, /* isError */ true)` (`route.ts:777-779`) — a sentence the model
reads and can act on.

## <a id="c12"></a>C12 — Schema changes are idempotent statements in `migrate()`, and an additive one does not bump the version

`CLAUDE.md`, "Always": *"Schema changes are idempotent statements in `migrate()`
in `db.ts`. A destructive one is the exception and runs inside a single
`db.transaction`."*

The two shapes in use: a `CREATE TABLE IF NOT EXISTS` inside the large `db.exec`
(`db.ts:550-631`), and `addColumn` (`db.ts:1667-1679`), which reads
`PRAGMA table_info` and is therefore idempotent by construction.

`SCHEMA_VERSION = 1` (`db.ts:67`) is **not** bumped for an additive change — its
own docblock (`db.ts:52-66`) says the ~50 `addColumn` calls stay idempotent by
reading the live schema and that what the version records is *"that a rebuild
has completed, and that the file was last written by a build newer than this
one."*

The precedent for a per-chat child table with the right cascade is
`chat_proposals` (`db.ts:25-50`, installed at `:622`) — `chat_id TEXT NOT NULL
REFERENCES chat_sessions(id) ON DELETE CASCADE` — and its index at `:628-629`.

## <a id="c13"></a>C13 — A pure function whose failure is silent gets a test, and this feature has two

`CLAUDE.md`, "Always": *"A pure function whose failure mode is silent gets a
unit test."* `npm test` runs `node --test` over `src/**/*.test.ts` and covers
"a deliberately short list of pure functions whose failure modes are silent and
expensive"; `docs/agent/testing.md` records what each existing test earned, and
that is the bar.

The precedent nearest to this design is `planApprovalBatch` — pure and
unit-tested, per `docs/agent/chat.md:16`, *"for `planProposal`'s reason with
`releasableRuns`' failure modes"*. The parallel is exact: something that turns
what a model wrote into what a person acts on, where a wrong answer is silent.

## <a id="c14"></a>C14 — The UI vocabulary is closed, and it already says where a conversation's turns go

`docs/agent/conventions.md:50` closes the grouping vocabulary. Two entries bear
here:

> a **`SegmentedControl` tab strip**, for two to five mutually exclusive views
> of one subject, one strip per page, and never as a way of moving between
> *subjects* […]; and a **`Sheet`**, for a decision that must be answered first
> or an action that is destructive, irreversible or handles a credential.

The chat's own side strip currently holds up to three (`page.tsx:210`,
`:587-595`), so a fourth is within the cap — but only *"when there is something
behind it"*, and `page.tsx:195-209` records that nothing switches tabs on its
own. A clarifying question is not destructive, not irreversible and handles no
credential, so **a modal is out by name.**

`conventions.md:21` then decides the rest of the placement question, and is worth
having in full because five separate clauses of it bind:

> The chat's transcript says who is speaking with structure, never with colour.
> The answer is the pane: plain prose at a readable measure with nothing drawn
> round it, because it is what the reader came for. The operator's own words are
> a bezelled block pulled right […] A `system` turn is this app speaking and
> keeps its own treatment […] **Proposals are rows of one grouped box and
> selection is a `--selection` wash rather than a border** […] the action row
> puts the one default action at the right edge […] Everything that makes a
> proposal card approvable is unchanged and must stay […] The composer is pinned
> to the foot of the pane and takes **⌘↩** as well as Enter […] The waiting state
> stays legible frozen […] and it claims no progress it does not have.

The composer's own rules are load-bearing for any design that touches it: the
textarea is deliberately **never `disabled`** (`page.tsx:493-495` — it stays
typable while a turn is in flight and the guard is inside `send()` at `:496`),
and the mention popover claims the arrows, Tab and Esc but **never Enter or ⌘↩**
(`page.tsx:880-892`), because this composer sends on Enter.

Available and already imported: `Badge`, `Button`/`ButtonRow`, `Card`,
`CardTitle`, `Empty`, `Disclosure`, `Hint`, `Icon`, `ListGroup`, `Notice`,
`SegmentedControl`, `Spinner`, `Markdown` (`page.tsx:23-36`). Not imported but
available: `src/components/ui/Field.tsx` (Input/Textarea/Field). **`Icon`'s name
union is closed (`Icon.tsx:19-52`) and contains no question-mark glyph** — worth
knowing before a card is designed around one.
