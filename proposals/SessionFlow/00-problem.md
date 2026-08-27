# What was asked, and what the data actually holds

## The request, verbatim

> "ok new feature proposal for the usage foundry, can we make a new tab on the
> left that records what the session touched and creates a VISUAL FLOW TYPE
> representation of what the flow touched and changed."

Four claims are packed into that sentence and each is separable: a **new tab on
the left**; a thing that **records** what was touched; a **visual flow**
representation; and a subject called **the session**. This file establishes what
is true about each before any option is scored, because three of the four turn
out to be already decided elsewhere in the tree.

## F1 — Nothing "records" anything new. The recording already happens.

Every tool call a run makes is already a durable row. `src/lib/db.ts:167-173`:

```
run_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
)
```

The single insert site is `emit()` at `src/lib/orchestrator.ts:608-612`, and the
`kind: "tool"` row is written at `src/lib/orchestrator.ts:7572-7595` on the
stream's `tool_use` block. Its payload is a closed set of five fields:

| Field | Written when | Source |
|---|---|---|
| `name` | always | `orchestrator.ts:7577` |
| `input` | always | `orchestrator.ts:7578`, after `clipToolInput` |
| `truncatedFrom` | only when clipping fired | `orchestrator.ts:7579-7581` |
| `parentToolUseId` | only for a delegated call | `orchestrator.ts:7586-7588` |
| `subagent` | only when the `Task` call was seen this cycle | `orchestrator.ts:7589-7591` |

**So the whole of "records what the session touched" is already shipped.** No
new writer, no new column, no new table. Anything built here is a *reader*. That
matters for cost — the expensive half of a feature like this is usually the
instrumentation — and it matters for scope, because a reader can be deleted and
an emit site cannot.

## F2 — File paths and commands survive storage. The brief's worry is unfounded.

`clipToolInput` (`src/lib/logLine.ts:145-189`) is **field-aware, not a byte
slice**, which is the difference between a parseable payload and a truncated
JSON string. Under `MAX_TOOL_INPUT_CHARS = 4_000` serialised
(`logLine.ts:104`) the input is stored byte-for-byte untouched —
`logLine.ts:156` returns the original object identity, and
`src/lib/retention.test.ts:49` asserts exactly that. Over the cap, keys are
re-packed in `HEADLINE_FIELDS` order (`logLine.ts:174`), each string cut to
`MAX_TOOL_FIELD_CHARS = 1_000` (`logLine.ts:119`), and keys dropped once the
budget is spent (`logLine.ts:183`).

`HEADLINE_FIELDS` (`logLine.ts:57-67`) is:

```
command, file_path, notebook_path, pattern, query, url, description, prompt, path
```

`command` is **first** and `file_path` **second**, so a 200 KB `Write` keeps its
path and a `Bash` call carrying a 100 KB heredoc keeps its command — the latter
is a shipped unit test, `src/lib/retention.test.ts:72-93`. The docblock at
`logLine.ts:50-55` explains why this is a list of *field* names rather than a
table of tool names: "the CLI's tool set moves, and a tool this app has never
heard of still has a `command` or a `file_path` on it."

**There is proof in the tree that this is queryable**, and it is the single most
important finding in this survey. `readCountsFor`
(`src/lib/fileCostNotice.ts:328-363`) already runs this query in production:

```sql
SELECT rel, COUNT(*) AS n FROM (
  SELECT CASE
    WHEN instr(json_extract(e.payload, '$.input.file_path'),
               COALESCE(r.work_dir, r.folder) || '/') = 1
      THEN substr(json_extract(e.payload, '$.input.file_path'),
                  length(COALESCE(r.work_dir, r.folder)) + 2)
    WHEN instr(json_extract(e.payload, '$.input.file_path'), r.folder || '/') = 1
      THEN substr(json_extract(e.payload, '$.input.file_path'),
                  length(r.folder) + 2)
    ELSE NULL
  END AS rel
  FROM run_events e JOIN runs r ON r.id = e.run_id
  WHERE e.kind = 'tool' AND e.ts >= ?
    AND r.folder = ? AND json_extract(e.payload, '$.name') = 'Read'
) WHERE rel IS NOT NULL GROUP BY rel
```

The "what did sessions touch" query is not a thing to invent. It exists, it is
scoped to `Read`, it is fleet-wide over a folder rather than per-run, and its
`ELSE NULL` drops any path outside the run's own directories. That last clause is
a decision this proposal inherits and re-litigates in [F6](#f6).

## F3 — A tool call cannot be joined to its own failure.

`b.id` — the `tool_use` id — **is captured but never persisted.**
`orchestrator.ts:7552` reads it, `:7562-7565` puts it in an in-process map
(`acc.toolCalls`), and the emitted payload at `:7576-7594` does not carry it.

Meanwhile the failure event does. `ToolFailure`
(`orchestrator.ts:7326-7336`) is `{name, command, text, toolUseId,
parentToolUseId?, subagent?}` and is emitted as `kind: "tool_error"`.

So the two halves of one call are stored with **no shared key**. The only join
available is `tool_error.command` against `toolArgs(tool.input)` — a
whitespace-flattened string clipped to `MAX_ARG = 160` (`logLine.ts:69`,
`:76-79`). Two `Read`s of the same file in one run are indistinguishable under
that join, and so are two `Bash` calls whose commands agree in their first 160
characters. **Any view that wants to mark a touch as failed is doing fuzzy string
matching**, and it will be wrong in exactly the case an operator most wants it
right: a loop retrying the same command.

Two further degradations are stated in the code. A `tool_result` whose call was
not seen in the same cycle degrades to the literal name `"tool"` and an empty
command (`orchestrator.ts:7424-7425`). And `is_error` is tested with an explicit
`!== true` (`orchestrator.ts:7415`) so that a CLI field rename records *nothing*
rather than flagging everything — a deliberate fail-quiet, documented at
`:7386-7389`.

## F4 — Success is never recorded, and that is a decision with a reason.

`orchestrator.ts:7343-7344`, in the docblock over `TOOL_ERROR_TEXT_CHARS`:

> "`run_events` already grows without bound, so a tool result is recorded when it
> failed and never otherwise."

`src/lib/apiTypes.ts:1695` says the same on the DTO: "Errors only — a successful
result is not recorded at all."

**The brief's guess was that a failed `Read` and a successful one are
indistinguishable. That is wrong, but only just, and the correction narrows
rather than widens what can be drawn.** They *are* distinguishable — a failure
leaves a `tool_error` row — but success is inferred from *absence*, and by F3
that absence cannot be attributed to a specific call. There is no duration, no
byte count, no exit code, and no positive success record anywhere.

The consequence for a picture: **an edge in any flow view means "attempted",
never "succeeded".** A run that tried to read forty files that do not exist draws
forty edges identical to forty real reads, unless the fuzzy join happens to
land. This must be stated on screen or the picture is a confident lie.

## F5 — There is a second per-tool source, and it cannot draw files.

`src/lib/toolComposition.ts` builds a per-tool rollup from the **transcripts**
rather than from `run_events`. Its `ToolCall` is:

```ts
export interface ToolCall {
  id: string;              // tool_use.id — the dedupe key run_events lacks
  ts: number;
  name: string;            // "Bash", "Read", "mcp__…__navigate"
  isSidechain: boolean;
  resultChars: number | null;
}
```

It has the id `run_events` is missing, it pairs a call with its `tool_result`
(`resultChars` is null only while no result has been seen), and it therefore
knows the size of every *successful* result — the fact F4 says `run_events`
throws away. **And it carries no input at all**, so it cannot name a single file.

That is the shape of the whole data problem in one sentence: the source that
knows *which file* does not know *whether it worked*, and the source that knows
*whether it worked* does not know *which file*. Neither is a defect to fix
casually — `docs/agent/metering.md:44` records that a `byTool` rollup was
deliberately not made a sixth, and `toolComposition.ts`'s own docblock explains
that the id is what makes deduplication across a resumed session possible.

## F6 — "Touched" and "changed" are two sources with different lifetimes.

The **changed** side is `runDiff` (`src/app/api/runs/[id]/diff/route.ts:22-31`),
which reports `kind: "range"` over `base..branch`. It reads *refs*, not the
checkout — and `docs/agent/retention.md:22` states that the checkout sweep
"removes a *directory* and never a ref: `worktree remove` without `--force`".
`docs/agent/retention.md:8` states the governing rule: "A run's row is
permanent; everything behind it is evidence, and evidence has a horizon."

So:

| Source | Horizon | Setting | Sweep |
|---|---|---|---|
| Tool events (**touched**) | 30 days | `eventRetentionDays`, `src/lib/settings.ts:819` | `src/lib/retention.ts:145-151` |
| Branch diff (**changed**) | none | — | never; refs are not swept |
| Checkout on disk | 7 days | `checkoutRetentionDays` | `retention.ts`, per `docs/agent/retention.md:22` |

**At day 31 the Changes tab still renders and the touch history is gone.** A
combined view therefore has one half that outlives the other by an unbounded
margin, and the failure is silent: an empty touch list next to a full diff reads
as "this run changed files without reading any", which is a false and alarming
claim rather than a missing one.

The diff has its own empty states and they are *reasons*, not blanks —
`src/lib/diff.ts:354` returns "Branch {branch} is gone — it was deleted after
this run finished." and `:381` "The agent committed nothing to this branch." Any
touch view owes the same, and the wording already exists for the analogous
problem (see [F8](#f8)).

**The reconciliation is genuinely three-way, not two-way**, and the third
category is the one nothing currently answers:

1. **Touched and changed** — read or edited, and present in `base..branch`.
2. **Touched, not changed** — read and never written, or edited and reverted.
   Invisible today in aggregate.
3. **Changed, not touched** — present in the diff with no tool event naming it.
   Produced by a `Bash` call that wrote files (`sed -i`, a formatter, a codegen
   step, `git checkout`), and by any edit whose event has aged out. This is the
   category an operator should be most interested in and it has no surface at
   all.

`readCountsFor`'s `ELSE NULL` (`fileCostNotice.ts:343`) drops a fourth: a path
outside both `runs.work_dir` and `runs.folder`. That is a *touch outside the
checkout*, which the brief correctly identifies as its own kind of event. The
existing query discards it because a price list for this repository has no use
for it; a flow view would be the first reader that does.

## F7 — Only a run has an event log. This settles "what is the session".

The question was left open by the request. The data closes it.

- `run_events.run_id` references `runs(id)` (`db.ts:167-173`). Nothing else may
  key a row.
- **A chat writes no events.** `grep -c "run_events\|emit(" src/lib/chat.ts`
  returns **0**. Chats have `chat_sessions` (`db.ts:550`), `chat_messages`
  (`db.ts:598`) and `chat_turn_spend` (`db.ts:1171`) — no tool-call log of any
  kind.
- A **workflow instance** spans runs via `workflow_instance_runs`
  (`db.ts:419`); it has no events of its own, only its constituent runs'.
- A **work cycle** is a boundary *within* a run's event stream, marked by
  `kind: "iteration"` rows (the kind union is at `src/lib/apiTypes.ts:1670-1718`),
  not a separate log.

So "the session" can only be **one run**, or a union over the runs of a workflow
instance. It cannot be a chat, because a chat has nothing to draw. This is an
empirical answer rather than a design preference, and it is the one question in
the brief that needed no judgement at all.

## F8 — What reaches the page is capped twice more, and only one cap is announced.

Even inside the 30-day horizon, the run page does not hold the run's events. The
SSE route replays the **newest** `REPLAY_LIMIT = 2_000`
(`src/app/api/runs/[id]/stream/route.ts:17`) within
`REPLAY_BYTE_BUDGET = 4 * 1024 * 1024` (`:31`).

That is announced, in three separately-worded places, and the app has already
solved the "empty because truncated" problem this proposal would otherwise have
to solve again:

- `stream/route.ts:135` — `… {n} earlier events not shown. The full log is in
  the database.`
- `src/app/runs/[id]/page.tsx:1595` — `{n} earlier events were never sent to
  this page, so nothing in them can match`
- `src/components/RunTasks.tsx:102-104` — `{n} earlier events never reached this
  page, so a task that started in them is missing here.`

The machine-readable `droppedEvents` rides beside the sentence
(`stream/route.ts:141`) specifically so a reader need not parse the prose — the
comment at `:136-140` says so. **The third wording is the closest precedent for a
touch view and should be adopted rather than a fourth invented.**

The practical consequence is a routing decision: a flow view built over the
page's in-memory event array silently draws only the newest 2,000 events. It must
read the database through its own route, or inherit a truncation whose only
symptom is a smaller picture.

**Storage itself has no per-run row cap** — `orchestrator.ts:7343` and `:7382`
both state `run_events` grows without bound, and unlike `context_samples`
(`docs/agent/retention.md:14`) there is no insert-side cap. So within the
horizon, every tool call of every cycle is present and nothing is thinned by
count. The caps are all read-side.

## F9 — Two comments in the tree are stale, and both were found looking for something else.

Neither affects a recommendation. Both are cheap and both are the kind of thing
that costs an hour to rediscover.

1. **`src/lib/orchestrator.ts:9876`** asserts "`run_events` has no retention." in
   the docblock over `FOLDER_TAKEN_REASON`, as part of an argument about why a
   parked run's reason is a constant. `src/lib/retention.ts:145-151` deletes
   `run_events` on a 30-day horizon, and has since the retention design landed.
   The *argument* the comment supports is unaffected — writing a log line every
   60 seconds per parked run is still wrong — but the supporting fact is false.
2. **`src/lib/forceLayout.ts:7`** says the world/screen transform and hit testing
   "lives in `canvasView.ts` and is imported by both." **`src/lib/canvasView.ts`
   does not exist.** `glob src/lib/canvasView.ts` finds nothing and a repo-wide
   grep for `canvasView` returns exactly one hit: that comment. Nor is there a
   "both" — there is one 2D canvas in the app (see
   [01-constraints.md](01-constraints.md#c7)). This one *does* bear on an option
   and is picked up in [06-option-e](06-option-e-file-tool-graph.md).

## What this survey could not do

- **See a single stored payload.** `/data` is readable and **empty** (`ls -la
  /data`: `.` and `..` only). No `*.db` or `*.sqlite*` exists anywhere in the
  checkout outside `node_modules`; `DB_PATH` would be
  `DATA_DIR/usagefoundry.db` (`src/lib/config.ts:283`) and no `.data/` directory
  exists in this worktree. **Every payload shape in this document is read from
  the emit site rather than from a row**, and every count of anything is
  therefore assumed. The nearest real measurement in the tree is a figure quoted
  in a source comment — 131,572 `run_events` rows scanned in 38 ms
  (`fileCostNotice.ts:296-297`) — and one in a comment at
  `orchestrator.ts:7729-7732`, "72,307 of 113,073 `run_events` rows (64%) and
  16.4 MB of 47 MB of payload in eight days", which was a kind since dropped.
- **Open a browser or start a container.** Docker is unavailable here. Nothing in
  this directory is a judgement about how anything looks, and no assertion about
  a hairball's legibility was made by looking at one.
- **Count the touched files of a real run.** This is the number the whole
  recommendation turns on and it is stated as the falsifier in
  [12-recommendation.md](12-recommendation.md).
