# Option F — the workflow the operator composes

Build nothing. Dreaming is expressed with what already exists: a one-node
workflow whose run block points at a folder, carries a prompt that says "read
today's sessions and write what was learned", and is put on a
`{kind:"daily"}` schedule. The operator composes it on `/workflows`, sets its
instance budget, and presses Save.

| | |
|---|---|
| **fires** | `src/lib/schedules.ts`, the app's existing scheduler |
| **reads** | whatever the agent's permission mode and mounts allow |
| **writes** | whatever `acceptEdits` in the mount allows — including the vault |
| **authors** | a model, inside an ordinary run |
| **retracts** | a person; the run's diff is visible, the vault write is not |
| **costs** | one work cycle a night, bounded by the workflow's instance budget |

---

## The strongest case

**Every piece of it exists and is documented.** A schedule with
`{kind:"daily", minutes}` and a `timeZone` (`src/lib/schedules.ts:65`, the
`ScheduleRow.time_zone` column at `:549`) fires a workflow;
`WorkflowNodeKind` includes `"run"` (`src/lib/apiTypes.ts:1415`); a run block
gets a folder, an agent, a template, a permission mode and an isolation choice.
Nothing has to be written, nothing has to be reviewed, and no invariant in
`docs/agent/` is touched — because the operator is doing what the feature is for.

**It is the only option that arrives with a budget refusal already attached.**
`scheduleRefusal` (`src/lib/schedules.ts:529`–`:539`) refuses to schedule a
workflow whose instance budget sets nothing, and the docblock's reasoning is
Dreaming's own case stated against it: "Every other press of Run is bounded by a
person being there to see what it cost and decide whether to press it again; a
schedule removes the person and keeps the press." So a nightly Dreaming composed
this way **cannot exist without a spending ceiling**, checked at creation and
again at every fire (`:525`–`:527`). No other automatic option in this survey
has that property; Options A, B and C all need it built.

**It is fully visible.** A workflow instance is a run. It appears on `/runs`,
has a `run_events` timeline, a log tail, a diff, a cost, a status, and an origin
of `schedule` (`src/lib/runOrigin.test.ts:229`). Every other automatic option is
invisible until its output appears. This is the only one an operator can watch,
cancel, re-read and price — and `docs/agent/run-lifecycle.md` already governs
all of it.

**And it makes the whole survey falsifiable cheaply.** Whether a written daily
learning is worth anything is unmeasured everywhere (`01-constraints.md` C8).
Option F is how somebody finds out for $10 without shipping a feature: compose
it, run it for a fortnight, read what it wrote, delete the schedule.

## Where it breaks

**The transcript corpus is reachable and the database is not**, and the survey
got this the wrong way round before checking it. The containment pair —
lexical, then after `realpathSync`, then lexical again, run against one mount at
a time (`docs/agent/security.md:11`) — decides which **folder a run is given as
its cwd**. It does not decide what the agent may `Read`. What decides that is
the managed sandbox policy the entrypoint writes root-owned to
`$MANAGED_SETTINGS_DIR`, and its filesystem clause is exactly two paths:

```json
"filesystem": { "denyRead": ["${DATA_DIR:-/data}", "/backups"] }
```

— `docker-entrypoint.sh:432`, with `~/.claude/.credentials.json` denied
separately as a credential at `:436`.

`~/.claude/projects` is on neither list. **A composed Dreaming run can read
every transcript on this install by absolute path**, which is how every figure
in this survey was taken — from inside a run, with no special grant. What it
cannot read is `/data`: the image creates it `chown root:root` + `chmod 0700`,
the entrypoint re-reclaims it on every boot precisely so agents dropped to
`UF_AGENT_UID` cannot read this app's database, and it is named in `denyRead`
besides (`src/lib/vaultSkill.ts:48`–`:52`).

So **Option F can compose Option A and cannot compose Option B.** That is a
better position than it first appears — and it comes with a consequence worth
stating plainly rather than burying: the operator's own interactive sessions,
every prompt they have typed on their own machine, are already readable by every
agent this app spawns. Dreaming does not open that door; it is the first feature
that would walk through it on a schedule.

**The vault write is unbounded rather than licensed.** A run block with
`acceptEdits` against a mount containing the vault can write anywhere in it: no
quarantine, no template, no `qc.py`, no single-file limit. `AGENTS.md:115` is a
sentence in a file the agent may not read; nothing enforces it. Option F does
not violate `knowledge.ts:39` — it goes nowhere near that module — and that is
the problem: **it gets the write by routing around the module that refuses it**,
with the app's own general-purpose write permission, and no part of this app
knows a vault write happened.

**It has no deduplication of any kind.** Every night is a fresh cold agent with
no memory of the previous night's note unless it goes and reads the folder,
which nothing makes it do. `11-deduplication-and-retirement.md` measures what
that produces.

**And `--max-budget-usd` is not the whole guard it sounds like.** It is pushed
at `src/lib/cycleInvocation.ts:1117` and bounds a *cycle*. The instance budget
bounds a press. Neither bounds the thirtieth consecutive night, and
`installSpend`'s rolling 24-hour window (`src/lib/installBudget.ts:79`) is the
only thing that does — which does watch runs, so this is the one automatic
option the install ceiling can see.

## What an operator sees

Everything, which is unique here. `/runs` shows it running, `/workflows` shows
the instance, the cost lands in `runs.spent_usd`, the origin says `schedule`,
and the diff shows what it changed **in the repository**. What the diff does not
show is what it wrote into the vault, because the vault is a different mount and
`runTouches`/`runTouchScan` reconcile against the run's checkout.

## Verdict

**Refuse as a standing feature; keep as the experiment, and it is the best
experiment here.** Option F *can* read a day's sessions — the correction above —
so it composes the literal brief with no code at all. What it cannot do is be
safe by construction: its vault write is unbounded rather than licensed, it has
no deduplication, and it gets its write by routing around the module that
refuses one. As a fortnight of nights, budget-capped by `scheduleRefusal`,
watched on `/runs`, deleted afterwards, it is the only thing in this survey that
would settle `01-constraints.md` C8 for the price of a fortnight and no code —
and `14-recommendation.md` names it as the falsifier rather than as a build.
