# Workflows

[← Documentation index](README.md)

A **workflow** is a saved graph of run blocks. Pressing *Run* on one creates
every block as a run, in one pass, with the dependencies between them already
wired: the first ones queue immediately, the rest sit `waiting` until the blocks
they follow have settled. It is the answer to "the same four steps, in the same
order, every time" — the thing templates cannot do, because a template is one
run and this is the shape of several.

There are two other kinds. An **orchestrator block** decides what to run instead
of being told, and its runs start without an approval — a real trade, with [its
own section](#a-block-that-decides-what-to-run) below. A **merge block** lands
the branches the blocks in front of it left behind, optionally paying Claude to
reconcile a conflict; it too has [a section](#a-block-that-lands-the-work).

## What a block holds, and what it does not

A block holds the **work**: a name, a workspace and folder, a task, and
optionally a prompt that replaces its template's own for this block. That is the
whole list, and the omission is the point.

A block does **not** hold a budget, a permission mode, an isolation choice or a
model. It **names a template**, and every guard comes from that template; a block
naming no template runs under the untemplated guard set in Settings → *Chat
defaults*, exactly as an untemplated chat proposal does. This is the same rule
the orchestrator chat follows and it is worth stating in full, because it is the
reason a workflow can be edited freely without anyone re-reading it for safety:

> The graph picks **what work to do**. Something a person wrote picks **what an
> agent may do**.

`--permission-mode` already has three narrowings and exactly two routes to it —
the run form and a saved template — and a workflow node was not going to become
a third. So a block that names a template which has since been deleted is
**refused by name** when you press Run, rather than quietly falling back to the
Settings guards: you saved a graph that said "under these guards", and a run
started under different ones is what the refusal exists to prevent. The detail
page marks such a block in red before you press anything.

## A block that decides what to run

The blocks above are fixed: you write the task, and that task is what runs. An
**orchestrator block** is the other kind. It holds a *brief* rather than a task,
and when the workflow reaches it the server spawns one short agent turn —
Claude Code, headless, ten-minute bound, the same child the orchestrator chat
uses — which looks at the folder and decides which runs should happen next. What
it emits **starts**. No proposal, no card, nothing to click.

That is the one place in this tool where an agent's answer becomes a billed
process with nobody looking at it, so it is worth being exact about what you are
agreeing to when you save one:

| You fix, when you save the graph | It decides, when the workflow reaches it |
|---|---|
| The workspace and folder it may start runs in | Which folders under that one, and what each run is asked to do |
| The template every run it starts runs under — budget, work-cycle limit, permission mode, isolation | Nothing about any of these |
| The most runs it may ever start | How many, up to that |
| The standing prompt every run it starts begins with | The task appended under it |

The fan-out cap is **required**. A graph with an orchestrator block and no cap
cannot be saved, for the same reason a run with no work-cycle limit and no time
limit cannot be started: the number is the whole of what you agreed to, and
without one you agreed to an unbounded number of agents.

Its emit tool carries four fields per run — a title, the task, a folder, and
which of its siblings that run should start after — and there is no fifth. There
is no argument on it that names a template, a budget, a permission mode or an
isolation choice, so the sentence above holds by construction rather than by the
model's cooperation. A folder outside the block's own workspace is refused by
name; so is a set of runs that would wait for each other in a loop.

**A block that emits nothing stops what is behind it.** "There is nothing worth
doing" is a real answer and the block is allowed to give it. But a block set to
start after it is there to review, land or follow up on work that did not
happen — started anyway, it spends a work cycle finding that out — so it is
`blocked` instead, with a reason naming the block that decided there was nothing
to do. The same is true if the turn fails.

**So the instance page says what it decided and why.** A block that starts
nothing ends that whole branch of the graph, and until you know which of the
several ways it did that, a workflow that ran, billed and stopped is
indistinguishable from one that never had anything to do. The row carries three
separate things. Its **reply** — the turn is asked to say what it emitted and
what it deliberately left out, and that answer is rendered under the block.
What **this tool** did to it, in its own line: an `emit_runs` call refused
because a folder was outside the block's workspace or the fan-out was over the
cap, a tool call the CLI declined on its own, a workflow limit that could not be
read at that moment. And the **status line**, which separates the endings that
otherwise read alike — *decided there was nothing to start* means it called the
emit tool and named nothing, *ended without emitting anything* means it never
called it at all, and those are different problems.

**Its own spend is its own.** A deciding turn's cost is bounded by Settings →
*Chat turn budget*, exactly as a chat turn's is; it lands on the block, never on
a run's spend and never on the dashboard meters. It **is** counted against the
workflow's own limit below, because it is money that press of Run spent.

Everything it starts belongs to the instance: the workflow-wide limits below
cover those runs, *Stop all* takes them down, and they appear on the instance
page saying which block started them.

## A block that lands the work

An isolated run works on a branch, which is what lets several of them share a
repository — and it means a graph that builds something finishes with the work
sitting on N branches and nothing on `main`. A **merge block** is the step that
ends that. It holds no task and starts no agent: when the workflow reaches it, it
takes every branch its predecessors left and puts each one onto the target that
branch's own run recorded when it cut it.

**The target is never named here.** A run records where it branched from, and
that is where it goes back to — so a graph that runs against three repositories
lands each branch in its own, with nothing in the block saying anything about
`main`. It is the same rule the *Land* button on a run page follows.

It goes through the **merge queue** — the same one the Branches page uses when
you tick several branches and press *Queue* — so it inherits every protection
that queue already has and adds none of its own:

- **One merge at a time**, for the whole process. Each landing changes the base
  for the one behind it, so nothing is decided in advance: each branch is
  re-previewed against git at *its* turn.
- **A conflict costs your checkout nothing.** It is reconciled on the run's own
  branch in a throwaway checkout, and a failed merge is aborted before the queue
  moves on.
- **Your own checkout must be clean and on the target branch.** This is the
  honest cost of an unattended merge and it is not weakened for a workflow:
  landing onto the wrong branch is the one mistake here with no undo. A dirty
  tree, or a HEAD on the wrong branch, refuses every branch in that repository
  and the block reports it. Leave the repositories a workflow merges into alone
  while it runs, or it will tell you it could not.

Every branch it queues gets a row on the Branches page with git's own answer for
it, and the block's own line says how many of them landed.

**Letting Claude resolve a conflict is a switch on the block**, off by default.
Saving the graph with it on *is* the authorisation — the same reason ticking the
box when you queue branches by hand is, and the reason it is not a setting:
configuration that can change under a graph already running is not authorisation.
With it off, a conflicting branch is reported and left exactly as it was. With it
on, a conflict is reconciled on the run's branch by an agent that may edit files
and may not run git, and the merge is only committed after the app has checked
that no conflict marker survived. That spend lands on the block, counts against
the workflow's own limit below, and never against a run or a dashboard meter.

**A branch with nothing to land is not a failure.** A run that completed and
committed nothing, and a branch already on its target, both leave you with
exactly what you asked for, so the block succeeds and says which branches it
skipped. What *does* fail it is a predecessor that should have had a branch and
has none — isolation having degraded at run time, which is the case where saying
nothing would leave you believing work landed.

What follows a merge block follows it on its condition, as everywhere else:
*only if it completes* waits for every branch to land, *once it finishes* runs
either way. A merge block that never ran satisfies neither.

Two things it is not. It has no checkout of its own, so it cannot be at either
end of a branch hand-over. And it needs at least one block in front of it that
runs something whose guards isolate — both refused when you save the graph, not
discovered an hour in.

## Limits for the whole workflow

A block's guards bound one block. Ten blocks under a $5 block limit is a $50
workflow, and until you set one of these nothing stands between you and that
number. Three limits sit on the workflow itself, all of them optional:

| | |
|---|---|
| **Spending limit** | Everything every block of one press of Run spends, together |
| **Stop at 5-hour usage** | Stop the whole workflow once the 5-hour subscription window passes this share |
| **Stop at weekly usage** | The same for the weekly window |

They mean exactly what the identically-named per-run guards mean, and they are
decided by the same function and the same vocabulary — a fraction guard with no
ceiling behind it is **refused, not ignored**, and every comparison is made
against the guard reading rather than the displayed one, so a model with no known
price cannot make a workflow look cheaper than it is.

These are the one thing on a workflow that is a guard rather than work, and they
live in the workflow's own form. There is no field for them on the wire when you
press Run, no override anywhere, and no route that edits a running instance's
copy — which is what stops an orchestrator block from raising its own workflow's
budget. Editing the workflow while an instance is running does not move the
guard that instance is measured against either: the limits are copied onto the
instance when Run is pressed, exactly as the graph is.

**When they are checked, and by how much a workflow can overshoot.** Before a
block starts a work cycle, never during one — the analogue of the per-run
*between cycles* mode, and the only accounting here that is exact. Blocks are
usually one cycle each, so in practice that is between one block and the next.
The cost is stated rather than hidden: **a block already working carries on until
some block reaches a cycle boundary**, so the total can overshoot by up to one
work cycle for each block running at the time, and blocks running at once
multiply that. There is deliberately no live mode: killing every block mid-cycle
would turn each one's measured cost into a reconciled estimate, in exchange for a
bound that is already one cycle in the ordinary case.

The limiting case is worth stating plainly. A graph of blocks that all start at
once, each running a single work cycle, has no boundary between them at all —
every block is already working before any of them has spent anything, so the
guard has nothing to stop. **Settings → maximum concurrent runs is the lever for
that**, and it is the same one that bounds a per-run spending limit's worst case:
with a cap of one, a five-block graph checks its workflow-wide limits five times,
once before each block starts.

When one trips, the workflow is halted through the same door *Stop all* uses, and
the instance records that its **budget guard** stopped it rather than you.

The one verdict that does **not** halt a running workflow is "no ceiling
configured". That is refused when you press Run, where refusing costs nothing.
Acting on it afterwards would mean the reading going away stops a graph
mid-flight — and on a stock install that reading is the account's own percentage
from Anthropic, which is discarded after an hour without a fresh answer, so an
unreachable host would kill every workflow carrying a fraction guard and every
in-flight cycle with it. It is not ignored: the block whose check found it writes
a line into its log saying the guard had nothing to read.

**What the figure is made of.** `spent_usd` moves only when a block's CLI emits
its `result` event, so a cycle in flight contributes nothing to it for its whole
duration — that figure is a floor and the instance page labels it as one. The
guard adds two readings on top: a reconciled estimate for cycles killed before
they could report, and Claude Code's own per-request telemetry for the cycles in
flight. Neither ever reaches `spent_usd`, the dashboard meters or any of the
three cost sources. It is the same measured-versus-guarded split the window
meters already make, drawn the same way: solid fill for what was measured, a
hatched band past it for what the guard acts on.

There is deliberately **no cycle or time limit** for a workflow, and it needs
none. A run loop needs a monotone terminus because the loop manufactures its own
next unit of work; an instance manufactures nothing. It is a finite graph created
in one pass, and every block in it already carries a terminus of its own, so a
workflow with all three limits switched off still ends — when its last block
does.

## Links between blocks

A link says "start this block after that one", and carries two things:

| | |
|---|---|
| **Condition** | *Only if it completes* (`on-success`) or *once it finishes, either way* (`on-finish`). Never defaulted: `on-success` would end a chain the operator meant to run regardless, `on-finish` would start a run on top of a dependency that crashed, and both mistakes are silent. |
| **Carry on its branch** | The successor extends the predecessor's branch instead of cutting a new one from the target. At most one link into a block may set it, and at most one block may take over any given branch. |

A block with no incoming link starts as soon as its folder is free. **Several
such blocks is the parallel case** — there is no separate "parallel" concept to
configure, and none in the interface. A block with two incoming links is a
fan-in; it starts when both have settled.

## Drawing one

The editor is a canvas. Drag a block off the palette onto it, or press Enter on
the palette to place one; drag from a block's *Link* handle onto another block
to make the second start after the first, or press Enter on the handle and then
Enter on the target. The link's own control on the canvas is where its condition
is set, and it reads *needs a condition* until it has one — a drawn link is
never quietly given a default. Delete or Backspace on that control removes the
link. Everything a block holds is edited in the panel beside the canvas, which
follows whatever is selected.

Each of those three — add a block, link two, remove a link — has a keyboard
route as well as a pointer one. Arrow keys move a selected block, Escape gets
out of linking, and nothing on the canvas is reachable only by dragging.

**A block's position is not part of the workflow.** It lives in this browser,
keyed by workflow id, and the graph is untouched by a drag: moving a block two
inches is not a change to what runs, and it does not bump the workflow's
`updated_at` or show up in what an instance records. Where nobody has dragged
anything the arrangement is derived from the edges themselves — layered left to
right, everything that starts immediately in the first column — so a graph saved
before the canvas existed opens readable, with no migration in front of it and
therefore nothing that could lose a link on the way in. The cost is the obvious
one: an arrangement you made by hand does not follow you to another browser, and
that browser draws the derived one instead.

While you draw, the editor asks the server the same question *Save* will:
`normalizeWorkflowInput`, over `/api/workflows/validate`, with the answer shown
in its own words rather than a generic "invalid graph". Nothing in the browser
decides what a workflow may be — a second copy of those rules would be a second
set to keep in step. *Save* stays pressable even while that check is refusing:
the check is advisory and can itself be unreachable, and a check that could not
run says so rather than reading as approval.

## What is refused, and when

A workflow that can be saved but never started fails weeks away from the form
that caused it, so both moments check the same things: a name, at least one
block, a task on every block, a template that exists, a workspace that is
mounted and a folder that resolves inside it, a condition on every link, no
block waiting for itself, no loop, no branch hand-over between blocks whose
guards do not isolate — nor one touching an orchestrator or merge block, neither
of which has a checkout and so neither of which has a branch — a fan-out cap on
every orchestrator block, and, on every merge block, a strategy and at least one
predecessor that runs something whose guards leave a branch. Every refusal names
the block it is about.

The workflow-wide limits are the one exception, and only in one direction: a
fraction guard with no ceiling behind it saves fine and is refused at Run. A
ceiling is a Settings value that can be typed at any moment, so such a graph is
not unstartable — only unstartable today. The editor warns beside the field; Run
refuses with a snapshot in hand.

## Pressing Run

One press creates every run in a single synchronous pass, in topological order,
so each block's dependencies already exist as rows by the time it is admitted.
That pass has no `await` in it, and that is a correctness requirement rather
than a style: the folder claim that keeps two agents out of one directory is
only atomic within one event-loop turn.

A graph with an orchestrator or merge block in it is created in stages instead,
for the obvious reason: the blocks behind one cannot name runs that a model has
not decided on yet, or that a merge block will never create at all. Those blocks
are created when the block in front of them finishes, and until then they hold
nothing at all — no folder, no checkout, no place in the queue — so they cost
exactly as much as a `waiting` run does, which is nothing. The instance page
lists them the whole time, so a block that is pending and a block that quietly
vanished never look alike.

It is **all or nothing**. Everything checkable is checked before anything is
created, so a failure part-way through should be unreachable; if one happens
anyway, the runs already created are stopped and the instance is recorded as
`not started` with the reason. Half a graph is not a smaller workflow — its
successors were never created, so what would be left running is a prefix nobody
asked for.

Starting a workflow whose previous press still has unfinished runs is
**refused**, with a count and a sentence. The second instance would point the
same blocks at the same folders, and a block set to carry on a branch would be
refused mid-pass because the first instance's run already continues it.

## Watching one

Every press of Run gets its own page, listing each block with its run's live
status, what it waited for, its cycles and its spend, and a link through to the
run itself. The runs also appear on the *Runs* page like any others — a chain
reads there as `blocked`-then-`queued` as it advances, since a `waiting` run
holds no folder, no checkout and no place in the queue until the runs ahead of
it settle.

The instance keeps its own copy of the graph and of the workflow's name, so
editing or renaming the workflow afterwards cannot rewrite what it says
happened. Deleting a workflow takes those records with it and **no run**: the
runs carry their own prompt, guards and history. It is refused while runs it
started are still going, because those records are the only thing saying where
those runs came from.

## Stopping one

*Stop all* on an instance page halts the whole press of Run, whatever state each
block happens to be in. There is one of it, and only the recorded reason differs
between an operator pressing it and an instance budget guard tripping — a second
implementation of "which blocks does this take down" is a second chance to miss
one, and a missed block goes on spending under a workflow the page says is
stopped.

What each kind of block becomes:

| Block was | Becomes | How |
|---|---|---|
| working now | `stopped` | The same kill ladder the *Stop* button on a run uses — `SIGINT` first, so a cycle that can still report its own cost does |
| queued or parked | `stopped` | Closed out before it can spawn |
| still `waiting` | `blocked` | Nothing ran and nothing was spent, which is what that status says. Everything behind it gets its own reason naming the block in front of it |
| deciding now | `failed` | Its child gets the same ladder. `failed` rather than `blocked` because that turn was billed, and the row carries what it cost |
| waiting to decide | `blocked` | Nothing was spawned and nothing spent |
| already finished | untouched | Rewriting a completed block as stopped would destroy the record of work that landed |

**The door is closed before anything is signalled.** The instance is marked
*stopping* first, in the same event-loop turn that then walks the blocks, so
nothing can join it behind the stop — and the blocks still `waiting` are closed
out *before* the working ones are signalled, because stopping a run releases
whatever was waiting on it and a block released a moment too early would start
*because* the workflow was stopped. Blocks that decide go first of all, for a
sharper version of the same reason: one left deciding while the walk ran could
start runs into a workflow that is being taken down, and every one of them would
be a block the halt had already walked past. Pressing Stop twice does nothing
the second time.

**What survives it.** Anything an agent committed is on its branch, untouched.
Anything it had not committed is still in its checkout, on that run's own branch,
and the run page's *Commit* is how it gets onto the branch — the halt never
commits, never removes a checkout and never touches a branch. Spend is accounted
for the same way a single *Stop* accounts for it: a cycle killed before Claude
Code reports its cost is estimated from the transcript into `spent_usd_est` and
never into `spent_usd`. A merge already in flight is left to finish; queued
merges for those branches are cancelled.

The instance records that it was stopped, by what, and when. A block's own
reason says which of the three it was — halted with its workflow, halted by that
workflow's budget guard, or stopped on its own run page — because ten rows
reading "Stopped by operator" say nothing about whether someone stopped ten runs
or one thing stopped all of them.

Stopping is terminal. There is no pause-and-resume for an instance: a stopped
one cannot be un-stopped, and starting the workflow again is a fresh press of
Run with fresh runs. That holds one block at a time too — the run page of a
halted block offers no *Try again* or *Resume*, and asking for one anyway is
refused with the workflow's name. Picking one block back up would have it
working, and spending, under an instance the page reads as stopped, where the
workflow's own budget guard can no longer reach it; and reopening the *stopped*
block in front of a chain would have woken the blocked ones behind it too.

## On a schedule

A workflow can press its own Run. **This is the only thing in the app that
starts a billed agent with nobody present** — the run form, the chat's approval
gate and the Run button all have somebody there at the moment the spend begins —
so it is worth being clear about what does and does not change.

What does not change: **guards**. A schedule calls exactly the same
`startWorkflow` the button does, so every block still runs under the template it
names or under the untemplated guards in Settings, the workflow's own limits
still bound the whole graph, and *Stop all* still halts it. There is no field on
the schedule form, no argument on the API and no column in the database that
could set a permission mode, a budget or an isolation choice. The schedule
decides *when*; a person already decided *what* and *how much*.

**A workflow with no limits of its own cannot be scheduled.** If *Limits for the
whole workflow* is empty — no spending limit, no 5-hour guard, no weekly
guard — the schedule form refuses with a sentence, and so does every fire if you
clear those limits afterwards. This is deliberately a refusal rather than a
warning: a warning is read once, when the schedule is created, and the spend it
is about happens every night for the next month. Any one of the three is enough.
The two window guards are the ones that bound *repetition* rather than one press,
since a graph that would start into an already-spent window is refused at the
door.

**How often.** Three choices, and no cron expression:

| | Reads as | DST |
|---|---|---|
| Every day at a time | `Every day at 09:00 (Europe/Berlin)` | follows the clocks |
| Every week on a day | `Every Monday at 07:30 (Europe/Berlin)` | follows the clocks |
| Every N hours | `Every 6 hours`, counted from when you saved it | fixed interval — unaffected |

The card states the **next fire time as an absolute instant**, not "in about an
hour". A schedule you cannot verify at a glance is one you will not leave an
unattended agent behind.

**Timezones.** The container runs in UTC and you do not, so the zone is stored
with the schedule and shown beside the time. The form fills it in from your
browser. A zone name the server's ICU does not recognise is **refused** rather
than quietly replaced with the server's — elsewhere in this app an unknown zone
falls back, because a calendar chart cut an hour out is a mistake you can see,
where a schedule an hour out is an hour out for months. On the spring-forward day
a time inside the gap (02:30 where the clocks go 02:00 → 03:00) fires an hour
later that day rather than not at all; on the fall-back day a time that comes
round twice fires once.

**A missed window is not made up.** If the container was down at the fire time,
the restart records it as missed and starts nothing — the same rule a queued run
and a queued merge already follow, that a server coming back up must not start
unattended work because of something that should have happened hours ago. The
card says what was missed and when.

**An overlap is skipped, not queued.** A workflow that is still running when its
next occurrence comes round is skipped with a reason, and the occurrence after
that is the next chance. Repeated skips read as one state with a count —
`skipped ×14 since 03:00` — rather than fourteen rows saying the same thing.

**Pause and remove.** *Pause* stops it firing and keeps everything else; the card
still says when it would fire if resumed, and the paused stretch records no
missed windows. *Remove* deletes the schedule and touches neither the workflow
nor anything it has already started.
