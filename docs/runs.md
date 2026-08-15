# Runs

[← Documentation index](README.md)

## How a run works

The UI calls an iteration a **work cycle**, because that is the unit a first-time
user has to reason about: Claude works, reports back, and the budget decides
whether it gets another one. Internally — settings, API payloads, the database —
it stays `iteration`.

1. You supply a workspace, a folder inside it, a task, and a budget policy.
2. Before **each** iteration, the budget is evaluated. If it fails, the run stops
   (or is refused before iteration 1, which is reported distinctly as `blocked`).
3. Otherwise one `claude -p … --output-format stream-json` process is spawned in
   that folder. Its output streams to the browser over SSE.
4. Cost and tokens are read from Claude Code's own `result` event — not
   re-derived — then accumulated.
5. Iteration 2+ sends the continuation prompt and `--resume`s the same session,
   so context carries across. The run ends when the agent replies `DONE`, the
   iteration cap is hit, or a guard fires.

### The guarantee, stated honestly

**No mode here is a hard cap.** Each run picks one of three, under *When a limit
is reached*:

**Let the cycle finish, then stop** — the default, and the original behaviour.
Guards are checked **between** iterations, not during one, so what this gives you
is *"no new work starts past the threshold"* — **not** *"spend never exceeds the
threshold"*. Overshoot is bounded by one iteration **per run that was active at
the time**. Size the cap accordingly. It is also the only mode whose accounting
is exact: every cycle runs to completion and reports what it cost.

**Stop the cycle in flight** — guards are re-read about once a minute while
Claude is working, and it is killed as soon as one trips. The bound becomes *one
model turn plus one check interval plus the kill*, which on a long cycle is a
large improvement. It is still not instant, and the reason is structural: usage
is read from the transcript files Claude Code writes as each turn *completes*, so
a turn that is still thinking or still running a tool has contributed nothing to
read yet. The work in the interrupted cycle is lost. Its cost is recovered from
your transcripts afterwards and shown separately from the figure Claude Code
reported — close, but reconstructed rather than measured.

**Stop the cycle, carry on next window** — as above, except that filling your
5-hour window parks the run instead of ending it. It resumes where it left off,
same conversation and same checkout, when the next 5-hour window opens, so one
task can stretch across several of them until the weekly percentage (or the time
limit, or the cycle cap) ends it for good.

A dropped connection is a third thing again, and it is handled in every mode.
`API Error: Connection closed mid-response`, an overloaded upstream, a burst of
429s — none of these say anything about your allowance or about the task, and
all of them clear in seconds.

Often Claude Code has already dealt with it before UsageFoundry sees it: when a
stream drops part-way, the CLI finalises what it had and carries the work cycle
on, leaving the error behind as a note. A cycle that ends that way — its own
`result`, a clean exit — is a cycle that **worked**, and the run simply carries
on with a line in its log saying what happened. (Runs used to die there, on the
note rather than on the fault.)

When the cycle really was cut short, the run waits 5, then 20, then 60 seconds
and spawns again into the same conversation, rather than ending. It
never parks for one (there is no window to wait out, and parking would hand its
folder to whatever is queued behind it), and it never retries more than three
times **in a row** — a cycle that gets through resets the count, so a long run
that meets a blip an hour is unaffected, while an upstream that is genuinely
down ends the run inside a minute and a half and says how many attempts it made.
Each attempt is one line in the run log. A bad key, a malformed request or an
exhausted credit balance is not in this category and still fails immediately:
retrying those buys three more copies of the same answer.

Only the 5-hour window is ever waited out, because it is the only limit here that
refills on its own, on a schedule, without being told anything. A weekly window
takes days to refill — and unless you have set your reset day in Settings it has
no reset instant at all, only a trailing total that decays. Your spend, your
cycles and the clock only move one way. So those all end a run; the 5-hour
window is the one that can pause it.

A parked run steps out of the way. It has no agent running and is spending
nothing, so a run you start afterwards on the same folder goes straight to work
rather than queuing behind it for hours; the parked one takes the folder back
once that run finishes. Only its own isolated checkout stays reserved, since its
commits live there. It survives a restart of UsageFoundry for 24 hours by
default, and its budget is re-checked from scratch before it starts spending
again, so it can also come back only to step aside once more.

The trade is worth knowing: if the parked run was working in the folder directly
rather than in its own checkout, it resumes into a tree the other run may have
changed. Its own conversation is intact; the files may not be what it left.

Concurrency multiplies the overshoot in every mode. `maxRunCostUSD` applies to
each run separately, so three runs with a $5 limit each is a $15 worst case, not
$5. Set **Runs allowed at the same time** in Settings if you want that bounded;
it is unlimited by default, and a run over the limit waits rather than being
refused. A parked run does not count against it — it is spending nothing.

A cap on how many runs work at once still says nothing about the total, because
nothing bounds how many *waves* there are: a slot that frees is refilled
immediately, a schedule presses Run with nobody present, and an orchestrator
block starts runs with no approval. **Settings → install limit, rolling 24
hours** is the one ceiling here that bounds the sum rather than one spender. Once
it is reached, no new run, workflow, orchestrator turn or chat message starts —
each refused with a sentence naming the install limit rather than a per-run one —
until spend ages out of the window or the limit is raised. It counts runs,
workflow blocks and chat turns together, and a run still going, or one that
finished inside the window, counts its whole spend: there is no per-hour
breakdown of a run's cost, so it over-counts rather than under-counts, which is
the direction a ceiling should err in. The dashboard shows it as its own card,
and hatched rather than empty when no limit is set. It ships off, because no
single figure is right for both a laptop and a fleet.

### Running until the limit rather than until the agent says stop

*When Claude says the task is done* can be switched from ending the run to
sending it back in. `DONE` then stops meaning anything, and the run ends only
when a limit is reached. It is worth being clear about what that is: an agent
told to carry on past a task it believes finished will find work, and not all of
that work is good. The prompt it gets (Settings → **Carry-on prompt**) points it
at verification, tests and edge cases rather than at new features, and an
isolated checkout is strongly advised so the output arrives as a branch you can
throw away.

Because `DONE` no longer ends the run, something else has to. A run with no cycle
limit is refused unless it has a time limit — the clock is the only limit that
keeps advancing whether or not a cycle survived long enough to report what it
spent.

Stopping a run signals the current work cycle and prevents any further one. If
the stop lands between cycles there is no process to signal, but the run still
ends — it is recorded as `stopped`, not as a failure.

### Picking a run back up

A run that ended — because it crashed, because Claude Code exited non-zero,
because UsageFoundry restarted under it, because you stopped it, because it hit
one of its own limits, or because the agent reported the task done — has a
button on its page: **Resume**, or **Ask for more** when it completed. It keeps
its folder, its isolated checkout and branch, its spend so far, and its Claude
Code session, so it continues the conversation rather than starting a new one.
The session is recorded as soon as Claude Code names it, not when the work cycle
finishes, so a run that crashed — or that UsageFoundry restarted underneath —
still has one to continue.

A run that genuinely never got that far starts again from the original task
instead, and says so on its page. When it had already worked, the agent is told:
the prompt opens by naming how many cycles the previous attempt ran and where its
output is — the run's own branch when it is isolated, the folder otherwise — and
tells it to read that before doing anything. There is no conversation left to
carry any of it, and an agent handed a bare task does the first thing the task
says, which is the work it is standing on.

If the session exists but Claude Code will not resume it — a transcript truncated
by a mid-turn kill is the known way that happens — the run tries once more and
then stops, saying so and naming the `claude --resume <id>` command to pick it up
by hand. It does not quietly start a fresh session: that would lose the
conversation the resume existed to keep, and it is what "picking a run back up"
means here.

The form takes a message as well as the limits. Whatever you write is sent
verbatim as the next turn of the same conversation — that is how you keep
talking to a run after it has finished, when looking at what it built shows up
the next thing to ask for. Leave it blank and a run that was cut off mid-task is
simply told to continue.

A run that reported `DONE` is the one case where blank is not "continue": the
continuation prompt asks for `DONE` when the work is complete, so replying to a
`DONE` with it buys an immediate second `DONE` and a billed cycle that did
nothing. Blank there sends the same pushback prompt as *When Claude says the
task is done* above — re-read the task, run the tests, fix what fails — which
you can edit in Settings.

That is what the agent said, not how the run ended. A run that stopped because
it used up its work cycles is *finished* in the same green sense and said
nothing of the kind, so blank tells it to continue like any other run cut off
mid-task — the pushback would open by telling it that it had reported the task
complete, and then forbid it from starting the work it was reopened to do.

Resuming asks for the limits again, pre-filled from the run, because the usual
reason a run needs picking up is that its own limits ended it. They are totals,
not top-ups: a run that used 1 of 1 cycles needs the cycle limit raised above 1,
and the button refuses and says so rather than queueing a run that would stop
again on its first check. The time limit is the exception — it runs from the
moment it starts again, since counting the hours it spent dead would refuse
every run older than its own limit. Everything else carries over untouched.

### Running the same task again

Two ways, and the cheap one is worth knowing first.

**Start another like this** — a link in the header of any run page. It opens the
new-run form pre-filled from that run: the same task, the same workspace and
folder, the same isolation, the same limits, the same permission mode. Nothing
happens until you press *Start run*, and nothing about the original run changes.
This is not a resume — it is a new run that happens to be configured identically,
which is what you want when last week's task comes round again but you would
rather not touch the run that already finished.

**Templates** — a named, saved version of the same thing. The *Templates* card at
the top of the new-run form loads one into the form, or saves whatever the form
is currently holding under a name. Loading a template fills in every field and
starts nothing; you can edit anything before you run it, and editing the form
does not write back to the template.

What a template holds is the task, the limits, how it behaves, and — optionally —
the folder. *Remember the workspace and folder* is a switch on the save row,
because both answers are right for different tasks: "update the changelog for
this project" wants a folder recorded, "run the test suite and fix what fails"
wants to be asked. A template with no folder leaves the picker alone rather than
guessing.

Three things it does **not** do, each on purpose:

- **It does not carry the model.** That is a single global setting
  (Settings → *Model*), and a second place to set it is how the two drift.
- **It does not apply a live-enforcement mode quietly.** There is deliberately no
  global "default enforcement", because one edit that turns *every* run into a
  cycle-killing run is a mistake with no undo. A template is a second way to
  inherit that choice, so a template carrying *Stop the cycle in flight* (or
  *…carry on next window*) says so in a banner above the form, with a button that
  puts it back to the mode that loses no work. Same for `bypassPermissions`,
  which gets the danger banner it gets everywhere else.
- **It does not let you save something that cannot run.** A template with no
  cycle limit and no time limit is refused when you save it, with the same
  message `POST /api/runs` would give — the point of validating twice is that the
  error arrives while you are still looking at the form that caused it, rather
  than the week you finally use the template.

A template is form input and nothing more. It holds no folder, blocks no run,
occupies no concurrency slot, and deleting one cannot affect anything that has
already started — a run copies every value it needs the moment it is created.

---

## Two runs, one project

Several runs can be in flight at once. What happens when two of them want the
same folder depends on whether that folder is a git repository.

**A git repository — they run in parallel.** Each run gets its own `git worktree`
on its own branch, under `.uf-worktrees/` beside the repository, and works there.
Your own checkout is never touched while the run works: your uncommitted changes
stay yours, and you stay on your branch. When it finishes, the run page shows
what it changed and can bring the branch home — see [Reviewing and landing what a
run did](review-and-land.md).

Two consequences worth knowing before you rely on it:

- A worktree starts from your **last commit**. Uncommitted work is not carried
  over, and neither is anything gitignored — no `node_modules`, no build output.
  Your `.env` files are copied across (configurable in Settings) so the first
  command does not fail on a missing variable; everything else the agent installs
  itself. Checkouts are reused between runs, so that cost is paid once per slot.
  A pattern can name a path as well as a filename — `apps/web/.env.local` — and
  a repository can have its own list under **Per-repository overrides**, which
  replaces the global one for that folder and everything under it. When nothing
  is copied the run log says which of the two happened: nothing to seed, or a
  list that matched none of the gitignored files that are there.
- Work the agent leaves **uncommitted** stays in the worktree and never reaches
  your branch. That is why the isolated-run preamble tells it to commit as it
  goes — keep that instruction if you edit the wording.

A checkout under `.uf-worktrees/` is usable **from inside the container only**.
`git worktree` records an absolute path to its gitdir, and the container knows
your repository as `/workspace/…` while you know it as whatever you mounted — so
`cd`-ing into one of those directories on the host gives you `fatal: not a git
repository`. Nothing is lost: the *branch* lives in the real repository, which is
what the handoff card hands you. The same asymmetry runs the other way, so a
worktree **you** created on the host is not usable by a run either, and the
folder picker will say so rather than offering isolation. Two habits follow from
it: review the branch from your own checkout, not by opening the worktree, and do
not run `git worktree prune` on the host while a run is in flight — from there
those registrations point at paths that do not exist.

**Checkouts are a bounded pool, and running out refuses the run.** A repository
gets up to 64 slots under `.uf-worktrees/`, reused between runs — but a checkout
left holding uncommitted work is never reused, because reusing it would destroy
that work, and nothing clears one on its own. So the pool only shrinks: every
run interrupted mid-cycle retires a slot until you commit or purge what is in
it. When a repository has none left, a run that asked for isolation is **refused
with a sentence** naming the repository, the store and what took the slots. It
is not quietly moved into your own checkout — that would put an agent on your
current branch, unable even to commit, which is the one thing isolation is for.
The **Branches** page lists slot pressure per repository as soon as the first
checkout is retired, with each one's uncommitted path count, so this is visible
long before it stops a run. Commit or purge from that page to free them.

You can turn this off per run with **Isolation → work in the folder itself**, in
which case it behaves like the case below.

**Anything else — they take turns.** A plain folder has no repository to branch
from, so a second run on it is **queued**, not refused, and starts on its own when
the folder frees up. The folder picker marks what is busy and what is waiting, and
the run page shows a queued run's position in line.

"The same folder" is more inclusive than string equality, deliberately: a run
started on the **whole workspace** holds every folder inside it, two workspaces
pointing at one directory count as one, and on macOS a name differing only in case
is the same folder. Queueing is strictly first-come — a run waiting on the whole
workspace is not overtaken by smaller runs submitted after it.

If the server restarts mid-run, the run is closed out as failed rather than left
holding its folder forever, and the stop reason carries the `claude --resume`
command to pick the session up by hand. Queued runs are cancelled rather than
started later, so nothing spawns unattended from a prompt you have forgotten about.

### Budget policy

| Rule | Behaviour |
|---|---|
| `maxIterations` | Cap on iterations. `null` disables it, but only alongside `maxDurationMinutes`. |
| `maxRunCostUSD` | Stop when this run's own spend reaches it. `null` disables it. |
| `maxDurationMinutes` | Wall-clock cap, **including time spent parked**. `null` disables it. |
| `maxWeeklyFraction` | Stop at N% of the weekly window (cost-denominated). **Needs a reading** — Anthropic's own percentage, or a ceiling you set. Always ends the run. |
| `maxSessionFraction` | Stop at N% of the 5-hour window (cost-denominated). **Needs a reading**, as above. Parks the run instead under `live-resume`. |
| `enforcement` | `between-cycles` \| `live` \| `live-resume` — when a tripped rule is acted on. Under `live-resume` a run also parks when **Claude itself** refuses a cycle for want of allowance, which needs no fraction and no ceiling. |
| `continueAfterDone` | Ignore the agent's `DONE` and send it back to the same task. |

A fraction guard with **nothing to read** — no ceiling set and Anthropic's own
percentage unavailable — is refused when you start or reopen the run, where you
can do something about it. It never ends a run that is already going: on a stock
install that reading is the account's own percentage, which is discarded after an
hour without a fresh answer, so acting on its absence would turn an unreachable
host into every fraction-guarded run in the install stopping at its next cycle
boundary. The run logs, once, that the guard cannot be enforced and carries on
under its remaining guards.

`maxRunCostUSD` is the one guard that needs **no ceiling** — it is absolute. Use
it on day one, before you have enough history to calibrate.

The loop always needs a **monotone terminus**: at least one of `maxIterations` or
`maxDurationMinutes`. Those two are the only quantities that move one way and
keep moving — this run's own spend stops accruing the moment a cycle is killed
before it could report, and both window fractions can fall. A policy with
neither is refused at creation, and refused again as `no_terminus` if it reaches
the guard by some other route.

### A work cycle that goes quiet

Every rule above bounds what a cycle *spends*, and none of them bounds a cycle
that has stopped doing anything at all. A `claude` wedged on a socket read never
exits, so nothing in the run loop ever comes back: the run sits at *running*,
holding its folder against every other run in that project, its checkout, and one
of your concurrent-run slots, until the container is restarted.

So a cycle also has a deadline — **Settings → Unattended runs → Silent cycle
limit**, two hours by default. It measures *silence*, not duration: the clock is
the time since Claude Code last printed anything, and any output resets it. A
cycle that is still reporting is working however long it takes, which is why a
run is never ended for taking its time here — ending one for its wall clock is
what `maxDurationMinutes` under `live` enforcement is for. The default is
generous on purpose, because the stream is silent for the whole of one model turn
and the whole of one tool call: a run whose test suite takes an hour is silent for
an hour and perfectly healthy.

When it fires the child is signalled the same way *Stop* signals one — `SIGINT`
first, so the cycle may still report what it cost — the run ends as **failed**
with a stop reason naming the deadline, and its folder and checkout go to
whatever was queued behind it. It cannot be switched off; the shortest it can be
set to is five minutes.
