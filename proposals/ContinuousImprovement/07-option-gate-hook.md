# Option D — the gate hook

Keep the sentence CLAUDE.md already carries; move where it arrives. Instead of
sitting in the first user message of a fresh conversation, the gate fires as a
`PostToolUse` hook on `Edit|Write` and speaks *after* the edit the model has just
made, as its own block at the tip of the conversation. This is the strongest
actuator in the survey — it is the only option that acts at the instant the
decision is being taken rather than hours of context earlier — and it is the
option that owes the most repairs before it can ship at all. Three of them, all
mandatory, all silent if missed.

Every line number below was re-opened at commit `ee93684`, which moved several:
constraint 3's `sandboxArgs` at `src/lib/orchestrator.ts:5159` is now `:5232`.

## The strongest case

**`00-problem.md` has already measured this option's competitor and found it
declined.** 112 runs edited `src/lib/`; eleven read the doc the gate names. A rule
in the highest-authority position this app has — CLAUDE.md, delivered by the CLI
into the first user message of every run — loses roughly nine times in ten. Every
option here that injects a lesson at cycle 1 proposes to re-run that experiment;
this is the only one that changes the position rather than the wording.

**And the position it moves to is measurably a different one.** A `PostToolUse`
hook's `hookSpecificOutput.additionalContext` reaches the model as a *separate*
text block rather than as part of the tool result, wrapped as a
`<system-reminder>` and landing immediately after the result the model is already
reading (`proposals/ContextControl/02-levers-on-the-pin.md:121`–`:125`, quoting
the observed `TEXT-WITH-HOOK` line). The binary's own validation-error string
lists `additionalContext` as an accepted `PostToolUse` field
(`02-levers-on-the-pin.md:167`). None of that is inferred; it was exercised on
the pin.

**It rides the one delivery channel measured to survive `--resume`.**
`--settings <json>` and `--settings <path>` both fired on cycle 1 and on the
resumed cycles (`02-levers-on-the-pin.md:183`–`:202`). `--plugin-dir` did not:
three cycles with the flag re-sent produced two firings, and cycle 3 exited 0
with nothing on stderr (`:204`–`:217`). That is the docblock at
`src/lib/orchestrator.ts:4880` confirmed and confirmed as silent. This option
uses the surviving channel, which is also the channel this app already writes to
(`sandboxArgs`, `src/lib/orchestrator.ts:5231`–`:5237`).

**Its idle cost is a process spawn and no tokens.**

```sql
SELECT json_extract(payload,'$.name'), COUNT(*), COUNT(DISTINCT run_id)
FROM run_events WHERE kind='tool'
  AND json_extract(payload,'$.name') IN ('Edit','Write','MultiEdit','NotebookEdit')
GROUP BY 1 ORDER BY 2 DESC;   -- Edit 6616/236, Write 1445/180; no other member fired
```

8,061 firings over the eleven days, about 5,130 a week, and a hook that matches
and returns nothing adds no tokens to any conversation — against constraint 12's
re-measured **$8.14 to $8.26 per standing tool definition per week**, charged
whether the tool is ever called or not.

**And it is not a surface the agent can decline by ignoring.** Constraint 12's
other half: `Grep` was called 49 times and `Glob` twice against `Bash`'s 16,754,
with both already on every cycle's `--allowedTools` (`SEARCH_TOOLS`,
`src/lib/orchestrator.ts:4642`). A hook fires whether the agent wants it or not.

## Shape

Four pieces, two of which are repairs the option cannot ship without. The third
mandatory condition — the script ships in the image, its path fixed there, nothing
through a shell — is a property of one piece rather than a piece of its own.

**One `--settings` composer.** `sandboxArgs` is today the only producer of that
flag on a work cycle, and it returns `[]` on `arrangement === "none"`
(`src/lib/orchestrator.ts:5232`) and again when the policy is not `confined`
(`:5233`) — that is every stock install. Its output is pushed onto the argv at
`:6833`, outside `buildArgs`. A hooks payload composed into that function ships to
nobody and the run looks entirely normal. Two `--settings` flags is not the
alternative: whether the CLI merges them or lets the second replace the first is
**not established** on the pin. So the shape is one function merging the sandbox
overlay and the hooks payload into a single object and emitting `--settings`
whenever either half is non-empty; `sandboxArgsFor` (`:5241`) and its two other
callers, `src/lib/chat.ts:1689` and `src/lib/review.ts:656`, move to it unchanged.

**One script in the image**, beside the two `Dockerfile:251` already copies into
`/app/scripts/`. Its path on the hook `command` is a literal from the image, never
operator input, so constraint 11's `resolveInMount` idiom
(`src/lib/orchestrator.ts:707`, mirrored at `src/lib/plugins.ts:147`) is not on
this path — and must be added the moment anyone proposes an operator-supplied
script, because what that path becomes is a program the container runs.

**`--include-hook-events` on every cycle's argv**, in `buildArgs` beside the other
stream-shape flags (`src/lib/orchestrator.ts:4894`). Section eight explains why this is not optional.

**The rule table, composed server-side.** The script reads its stdin payload —
`session_id`, `transcript_path`, `cwd` and the event's own fields
(`02-levers-on-the-pin.md:105`–`:111`) — matches the edited path, and prints
`{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}`
or nothing. It filters on the tool name from its own payload rather than relying
on the `matcher` field, which removes an assumption: `matcher`'s tool-name
filtering is documented but was not separately probed on the pin.

**And the script cannot read the database**, which constrains the design more than
it looks: `/data` is `root:root` at mode `0700` (`Dockerfile:298`–`:299`) while the
child — and therefore its hooks — runs as `UF_AGENT_UID` (`childCredentials`,
`src/lib/orchestrator.ts:5547`; the reasoning is `Dockerfile:322`–`:329`). The rule
table travels *to* the script inside the `--settings` object, or not at all.
De-duplication has the same answer: a `/tmp` marker keyed on `session_id`, which is
stable across `--resume` (`02-levers-on-the-pin.md:187`–`:189`).

## What it learns from, and when the decision is taken

**It learns from nothing, and that is both the limitation and the safety
property.** There is no corpus behind this option: it re-delivers a rule an
operator wrote, at a moment the operator could not have chosen by hand. Every
other actuator in this survey has a write side and this one does not, which is
the whole of its answer to constraint 7.

The decision is taken at two clocks. The *rule* is chosen when the `--settings`
payload is composed, and constraint 9's question — which class — answers per
cycle, beside `enabledPluginDirs()` at `src/lib/orchestrator.ts:6763` rather than
the `settings` read at `:6452` before the loop at `:6485`, so an operator
switching the gate off reaches the next cycle rather than the next restart. The
*firing* happens inside the cycle, after the tool result and before the model's
next turn, in a script the app never waits on.

## What it does to the prefix cache

**Text at the tip, which is the good case.** Constraint 4's arithmetic for text
appended at the end of a prompt is `S = D`, `T* = 19·(S/D) − 20 = −1`: paid once at
the write rate, read at 0.1× thereafter. Nothing in the tree changes, so the "agent
maintains a file" penalty does not apply to the mechanism at all.

**And it sits behind an event that has just written the cache anyway.** The hook
fires on `Edit`/`Write`, so the repository has changed by construction, and
constraint 4 puts `gitStatus` ahead of the only breakpoint that matters. The
injected block lands in a prefix the *next* cycle re-writes regardless of this
option, which means the gate cannot be charged for an invalidation it did not
cause.

## What it does to `--resume`, retention, the DONE contract and `needs-review`

**`--resume`: the channel was chosen for this.** `--settings` survives it
(`02-levers-on-the-pin.md:183`–`:202`), and `buildArgs` rebuilds the whole argv
per cycle anyway (`src/lib/orchestrator.ts:4808`, called at `:6774`), so the
payload is re-sent whether or not the CLI restores it.

**Retention: no new store and no fourth horizon.** The `/tmp` marker is not
evidence and nothing reads it back; what the mechanism leaves behind is `log`
rows in `run_events`, expiring with everything else at `eventRetentionDays`,
default 30 (constraint 8). `StorageReport` gains no arm.

**DONE: a real hazard, and it is measured.** `cycleEnding`
(`src/lib/orchestrator.ts:4543`) matches `/^\s*DONE\s*$/m` and
`/^\s*NEEDS_REVIEW\s*$/m` against the cycle's own final assistant text, and its
docblock records that a task whose text merely *carried* `DONE` ended its run in a
single cycle 53% of the time against 2 of 120 without it (`:4534`–`:4536`). The
hook's own output cannot become `finalText` — a `<system-reminder>` block is not
assistant text — but a model quoting the injection back can. **So the injected
string must never contain either sentinel alone on a line**, and that is a rule
for the rule table, enforced where the table is composed rather than trusted to
whoever writes a gate.

**`needs-review`: untouched, with one unmeasured worry.** `NEEDS_REVIEW_NOTICE`
(`:4506`) tells the agent to stop when it is actually blocked. A gate that fires
and is declined repeatedly within one cycle could in principle read to a model as
a wall it cannot get past. Nothing establishes that either way; it is assumed not
to, and the per-session de-duplication above is the cheap insurance.

## Guards, the three cost sources, and who may author it

**It spends nothing of its own and creates no fourth source.** No sub-agent, no
review child, no extra API call: what it costs when it works is tokens inside the
work cycle already running, landing in `runs.spent_usd` through the CLI's own
terminal `result` event — no `run_reviews` row, nothing reaching OTLP
(constraint 5). Guard sites are unaffected; a guard reads spend, not composition.

**The write side has no author but the operator.** This is the clean answer to
constraint 7 and it holds only if the rule table stays server-side. If the table
were read out of the repository at hook time, an agent editing that file would
become an author of the next run's instructions — and `00-problem.md` makes that
concrete: CLAUDE.md is named in 54 of 67 AI conflict resolutions, the most
contended file in this tree by a factor of 3.6. A gate whose text lives in the
tree is a gate the fleet edits. Keep it in `settings`.

**Nothing agent-authored reaches an argv.** This app's own spawn site passes an
array and says so (`src/lib/orchestrator.ts:5539`–`:5541`). Whether the CLI runs a
hook `command` through a shell is **not established** on the pin, and does not
matter here: the command is a fixed absolute path with no interpolated argument,
and the rule text travels in the JSON payload.

## What the operator sees, and how they override it

**Today, nothing at all, and the defect has two halves rather than one.**

The first is constraint 6's: `grep -rn "include-hook-events" src/` returns
nothing (re-run at `ee93684`, exit 1, no output). That flag is what puts hook
dispatches on the `stream-json` channel `handleStreamLine`
(`src/lib/orchestrator.ts:5903`) already reads
(`02-levers-on-the-pin.md:101`–`:104`), and constraint 6 states the consequence:
a hook firing on a work cycle today is invisible on that run's log.

The second is not in constraint 6, and it doubles the repair.
`src/lib/orchestrator.ts:6208`–`:6221` exists precisely to log what a hook
injected — but its test, at `:6210`, is `ev.hook_event === "SessionStart" ||
ev.hook_event === "UserPromptSubmit"`, and `PostToolUse` is in neither. The raw
event would still arrive, as a `system:hook_response` log line (`:6167` onward),
and `describeEvent` drops every `system:`-prefixed message from the feed
(`src/lib/logLine.ts:520`). **So shipping `--include-hook-events` alone would
leave this option's entire mechanism invisible.** Repair (b) is the flag *and*
that test widened.

**Override is a `Settings` boolean with four doors**, and constraint 1 names all
four: the interface member, the `DEFAULTS` entry, membership of `SETTINGS_KEYS`,
and one of the `if ("key" in body)` arms in `PUT /api/settings` — miss the last
and the route answers 200 without the key while the form reverts under a "Saved"
confirmation. The rule table itself is guidance and may live in a `DEFAULT_*`;
the sentinel exclusion above may not, because it must stay true on an install
whose operator has edited the text.

**And what an operator most needs to see is compliance, which is already
queryable**: the hook's log line, then a `Read` of the named doc in the same run's
`run_events`. Same shape as `00-problem.md`'s 112-and-11 query, no new store.

## How it fails, and whether loudly

Six modes. Five are silent.

| mode | what happens | loud? |
|---|---|---|
| Composed into `sandboxArgs` | `[]` on `arrangement === "none"` (`src/lib/orchestrator.ts:5232`) — ships to nobody on every stock install | no |
| Two `--settings` flags | merge-or-replace not established on the pin; one payload may be discarded | no |
| Shipped without `--include-hook-events` | fires, injects, appears nowhere on the run's log | no |
| Shipped with the flag, `injects` test unwidened (`:6210`) | same, one repair short | no |
| Malformed stdout or non-zero exit | by analogy with the `updatedToolOutput` refusal, "loud in the debug log and silent everywhere else" (`02-levers-on-the-pin.md:155`–`:159`) — assumed to behave the same for `additionalContext` | no |
| Fires and is declined | the run proceeds exactly as the 101 runs already do | **yes**, once compliance is queried |

The last row is the honest one: this option's characteristic failure is not the
machinery breaking, it is the machinery working perfectly while the model carries
on. Nothing in the mechanism detects that, which is why the compliance query
above is part of the option rather than an extra.

## What it costs to build

The mechanism is small. The repairs are the work, and two of the three are owed
whether or not this option ships — repair (a) is the precondition for *any*
`--settings`-delivered mechanism in this survey, and repair (b) is a live defect
that constraint 6 already names.

| piece | size |
|---|---|
| `--settings` composer, three call sites moved (`src/lib/orchestrator.ts:6833`, `chat.ts:1689`, `review.ts:656`), unit tests beside the existing `sandboxArgs` ones | small |
| `--include-hook-events` in `buildArgs` (`:4894`) and `PostToolUse` added to the `injects` test (`:6210`) | trivial |
| gate script, `Dockerfile` COPY, `/tmp` session marker | small |
| `Settings` field, four doors (constraint 1) | small, four ways to get wrong |
| rule table and its sentinel exclusion | the design work |
| compliance query and its readout | small |

**Now price what it costs when it works**, which constraint 13 says is the failure
to avoid: a fired gate that is obeyed makes the run open a large document into a
live conversation. All 294 runs here are `claude-opus-5` (`SELECT model, COUNT(*)
FROM runs GROUP BY model` → `claude-opus-5|294`) at $5/M input
(`src/lib/pricing.ts:38`), so a 1h cache write is $10/M and a cache read $0.50/M
(`:16`–`:18`). Document sizes are `wc -c` at `ee93684`; tokens are 4 bytes each
with a ×1.5 upper bound, the spread
`proposals/ContextControl/05-option-trim-injected-text.md:127`–`:129` measures
between its own two conversions. Carry length is the median tool calls a run makes
at or after its first edit, one API request assumed per tool call:

```sql
WITH e AS (SELECT ev.run_id, ev.ts, json_extract(ev.payload,'$.name') AS tool,
                  json_extract(ev.payload,'$.input.file_path') AS fp
           FROM run_events ev JOIN runs r ON r.id=ev.run_id
           WHERE ev.kind='tool' AND r.folder='/workspace/UsageFoundry'),
fe AS (SELECT run_id, MIN(ts) t FROM e WHERE tool IN ('Edit','Write') GROUP BY run_id)
SELECT e.run_id, COUNT(*) FROM e JOIN fe ON fe.run_id=e.run_id
WHERE e.ts>=fe.t GROUP BY 1;    -- 177 runs; mean 78.1, median 60
```

| doc | bytes | write | carried over 60 turns | per compliance |
|---|---|---|---|---|
| `docs/agent/conventions.md` | 63,394 | $0.16–$0.24 | $0.48–$0.71 | **$0.63–$0.95** |
| `docs/agent/run-lifecycle.md` | 46,235 | $0.12–$0.17 | $0.35–$0.52 | **$0.46–$0.69** |
| `docs/agent/security.md` | 22,082 | $0.06–$0.08 | $0.17–$0.25 | **$0.22–$0.33** |

Per week, at one compliance per run — the same `e` as above, filtered to writes
under `src/lib/`:

```sql
SELECT COUNT(*), COUNT(DISTINCT run_id) FROM e
WHERE tool IN ('Edit','Write') AND fp LIKE '%/src/lib/%';           -- 1792 / 112
--   ... AND ts >= (SELECT MAX(ts) FROM run_events) - 7*86400000;   --  930 /  50
```

A `conventions.md`-sized gate obeyed once by each of the 50 is **$32 to $48 a
week**, against $2,900.81 of `runs.spent_usd` over the same span:

```sql
SELECT COUNT(*), ROUND(SUM(spent_usd),2) FROM runs
WHERE created_at >= (SELECT MAX(created_at) FROM runs) - 7*86400000;   -- 172 | 2900.81
```

**1.1% to 1.6%**, and two docs per run doubles it. Because an edit is itself a
cache write (constraint 4), a run averaging 1.7 cycles pays the *write* component
roughly twice; the carry component dominates either way. And 53.5% of this
install's `Read` calls carry an `offset` or `limit` (`00-problem.md`), so a
compliant read may be partial and these are whole-file ceilings.

**Its success mode is more reading, not less, and it must be pitched that way.**
Splitting the 112 by whether they read any `docs/agent/` file:

```sql
-- `e` as above; edits = runs writing under src/lib/, readdoc = runs reading docs/agent/
SELECT (edits.run_id IN (SELECT run_id FROM readdoc)) AS complied, COUNT(*),
       ROUND(AVG(r.spent_usd),2), ROUND(AVG(r.iterations),1)
FROM edits JOIN runs r ON r.id=edits.run_id GROUP BY 1;
--   0 | 101 | 14.70 | 1.7        1 | 11 | 19.59 | 1.8
```

Eleven runs, entirely confounded by task size, cited only because they point the
same direction as the arithmetic. **So this option does not belong on the cost
ledger at all**: it is a correctness gate that buys silent invariants at one to
three per cent of the bill, or it is nothing. `d`, the displacement fraction
constraint 13 says does not exist, never enters — there is no saving to multiply.

## What would have to be true

**One thing above all: the 101-of-112 decline must be about position rather than
content.** That is the entire bet. If a rule at the top of a fresh conversation is
discounted for where it sits, then moving it to the tip of the conversation at the
moment of the edit is the highest-leverage change available anywhere in this
survey, and no other option acts that late. If the sentence is instead simply
unpersuasive, this option fires about 930 times a week in `src/lib/` alone, is
declined 930 times a week, and delivers nothing for the price of a process spawn.
`03-experiment-holdout.md`'s probe (b) is that separation, and this option should
not be built before it reports.

**Second: a path must decide which doc to name, and today it does not.** CLAUDE.md
carries sixteen gate bullets (`CLAUDE.md:33`–`:126`), and four are keyed on
something no file path can evaluate: "`src/lib/` generally" (`:33`), "every guard
site in `orchestrator.ts`" (`:44`), "`orchestrator.ts`'s run loop" (`:50`), and
"auth, path containment, spawn argv, anything holding a credential" (`:110`).
Those same four are the ones `src/lib/orchestrator.ts` falls under — the file this
install opened in 476 separate `Read` calls (`00-problem.md`) — and it is named as
a whole file by none of them. So a path-matched gate on the largest module in the
tree either names `architecture.md`, `budgets-and-guards.md`, `run-lifecycle.md`
and `security.md` together, 106,121 bytes by `wc -c`, or names nothing. Either a
coarser rule is written for the gate specifically — authoring work nobody has
done — or the gate covers the twelve bullets that *are* path-keyed and says so.

**Third: repairs (a) and (b) must be unconditional, and the sentinel exclusion
with them.** Neither repair announces itself, and constraint 6's rule is that a
mechanism invisible in the log is one whose misbehaviour reads as the agent being
stupid. The sentinel exclusion is smaller and equally absolute: a gate string
carrying `DONE` alone on a line ends runs, per `src/lib/orchestrator.ts:4534`.

What would overturn this option even if the position bet wins: a demonstration
that the gate, obeyed, does not change what the run *produces*. The arithmetic
above prices compliance at $32 to $48 a week; nothing in this repository measures
what a compliant run gets for it, and `15-comparison.md` should score this option
as an unpriced correctness bet rather than as a saving.
