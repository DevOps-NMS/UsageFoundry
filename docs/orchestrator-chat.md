# The orchestrator chat

[← Documentation index](README.md)

Filling in the run form once is fine. Filling it in eleven times, once per open
GitHub issue, is the part nobody does. The **Orchestrator** page is a chat that
can read your issues and propose a run for each one — and then stops, because
proposing and starting are deliberately different things here.

Ask it something like *"check the open bugs on acme/api and propose a run for
each one that has a reproduction"*. It will list your folders, run `gh issue
list`, and write one proposal per issue into the panel beside the conversation.
Nothing is running at that point. You tick the ones you want and press Approve,
and those become real runs — queued behind whatever is already working, under
the concurrency limit you already set.

**A proposal carries a task, not a policy.** This is the whole reason the feature
is safe to have. Every guard a proposed run will start under — its budget, its
work-cycle limit, its permission mode, whether it gets its own checkout — comes
from something *you* wrote: the **template** the proposal names, or, when it
names none, the **default guard set** under Settings → Run defaults. The chat
picks which of those applies and what the work is; it cannot set, raise or
invent a single guard, and there is no field on a proposal that would let it.
Every proposal card says which guard set it will run under, spelling the
untemplated one out in full — an approval gate that does not show what is being
approved is a gate that gets clicked through.

**The prompt is the exception, deliberately.** Prompt text is the half of a run
a model may write. So a proposal can rewrite the template's prompt for that one
run when the template nearly fits — the card marks it — and `save_template` can
write a prompt back for reuse. Neither can touch a guard: a new template takes
your default guard set, and an existing one keeps the guards it already has.

**The approval is per batch and there is no way to turn it off.** Not a setting
left switched on by default — there is no setting. The route takes the explicit
list of proposals the page was showing when you clicked, so anything the chat
added in between is not swept into a decision you did not see.

**It can order runs against each other.** A proposal can carry a short label and
say it starts after another proposal in the same conversation — *on-success*
(only if that one completed) or *on-finish* (once it is out of the way either
way), optionally carrying on that run's branch so the second agent opens with the
first one's commits already there. Ask for *"fix it, then a separate run that
adds the regression test on top"* and you get two cards, the second saying what
it waits for. Approve them in the same click: the batch is created in dependency
order, and a dependent approved on its own is failed by name rather than started
with nothing in front of it. That last part is the point — a run told to wait and
started immediately is indistinguishable from a run that was never told, and both
agents then work in the same checkout in whatever order the queue felt like.

**It can propose a whole workflow, and approving one saves it.** For work with a
shape worth keeping — a nightly sweep, a fix/review/land chain, a per-repository
routine — the chat can write a [workflow](workflows.md)
rather than a handful of runs. The card lists every block with the guard set it
runs under, where it runs, what it waits for, how many runs any deciding block
may start and whether any merge block may pay to reconcile a conflict.

Approving it **saves the workflow and starts nothing**. You press Run on it
yourself, after opening the graph if you want to. That is deliberate, and it is
the same argument as everywhere else here: an orchestrator block's runs start
with nobody looking *because you fixed its folder, its guard set and its fan-out
cap when you saved the graph* — and a graph a model wrote has no such person in
it. Saving rather than starting puts one back, so two separate decisions of yours
stand behind every number in it before an agent exists.

One consequence worth knowing: the chat cannot set a **workflow budget**, for the
same reason it cannot set any other guard, so a workflow it proposed is saved
without one. It runs by hand exactly as it is; putting it on a
[schedule](workflows.md#on-a-schedule) needs a budget, which you add in the
editor. The card says so.

The one place in this tool where runs *do* start without a click is a workflow's
[orchestrator block](workflows.md#a-block-that-decides-what-to-run), and it is not this
gate switched off — it is the same gate moved. There, you approved a graph that
already named the folder, the guard set and the largest number of runs the block
may ever start. The chat has none of those fixed in advance, which is exactly
why it stops at a card.

**What the chat itself may do: anything, and it is told not to.** It runs with no
tool allowlist at all — every tool the CLI has, this app's own alongside them —
because the job of an orchestrator is to find out enough to propose good work,
and the allowlist this replaced (this app's tools, `Read`/`Glob`/`Grep`,
read-only `gh`, three `git` subcommands) refused every question it had not
anticipated: a build log, a CI run, `gh api`, `git -C <path> log`. A proposal
written without looking is still a proposal you then approve.

So the limit is the instruction rather than the mode. The system prompt says its
job is to look and propose: read code, read issues, run whatever tells it
whether something is broken — and not to edit a workspace, commit, push, or act
on anything on GitHub, because a task small enough to just fix is a proposal that
says it is small. Everything else that bounds it is unchanged and is not a matter
of instruction: nothing it can call starts a run, its MCP surface is only this
app's, its credential dies with the turn, and `chatTurnBudgetUSD` caps the spend.
The cost of the trade is worth stating plainly — the chat can now write into a
checkout you also work in, and the GitHub token in its environment authenticates
writes as well as reads.

**It can look before it proposes.** `get_usage` gives it the 5-hour and weekly
windows, so it can tell you that approving ten runs into a nearly-spent window
means ten runs that stop on their first guard check. `get_run` gives it any run's
log, spend, status and the list of files that run changed, so "why did that one
fail, and what should we do about it" is a question it can actually answer.

The one tool that is narrower than the rest is `get_run_diff`, which returns
**patch text** and only for the runs this conversation proposed (for a workflow
block: the runs of its own instance). A capability token *is* its holder's
identity, so nothing on the server can tell the chat's own turn from an agent
that read the token out of the config file of a turn in flight — and where a
work cycle is confined to the folder it started in, an unscoped `get_run_diff`
was the source of every repository this install has run against. For any other
run the chat still has `get_run`'s file summary, and it can read the folder
itself.

**A turn that is not going to finish can be stopped.** While the chat is
working, **Stop** appears beside Send. It signals the process answering — and
everything that process started, the same ladder a run's Stop button uses — and
fails the turn out with "you stopped this message", so the thread is usable
again immediately. It is a way to *end* a turn, never a way to send around one:
the chat still refuses a second message while a turn is in flight, which is what
stops two billed children on one conversation.

There is a deadline under it as well. A turn that has been in flight for more
than ten minutes is failed out by a sweeper that reads the row rather than
waiting on the child, so the bound holds even when the child dies in a way that
never reports back — the case where the only recovery used to be restarting the
server, which stops every run in flight to clear one thread. Nothing is resumed
or re-asked either way: a chat turn is a question you put minutes ago, and
re-asking it unattended is spend nobody is present to want.

**It costs money, and the cost is shown apart.** A chat turn spends against the
same 5-hour window as everything else. It is refused outright when that window is
already past the ceiling you configured, and `chatTurnBudgetUSD` (default $2,
blank for none) caps a single turn. What it has spent appears on the chat page
only — never added to a run's spend and never to the dashboard meters, the same
separation reviews already get.
