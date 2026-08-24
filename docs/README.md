# UsageFoundry documentation

[← Back to the project README](../README.md)

## Start here

- **[Installation and setup](install.md)** — Docker, signing the container in,
  required environment, Linux `UF_UID`, multiple workspaces, GitHub access, and
  finding a field on the Settings page without losing an unsaved edit.
- **[Backup and restore](backup-and-restore.md)** — every run, every cost, every
  workflow and every schedule is one file in one volume with no second copy.
  How to snapshot it while runs are working, how to put it back, and why `cp`
  is not a backup here.
- **[Limits and accuracy](limits-and-accuracy.md)** — the two unrelated things
  called "your Anthropic limits", what the subscription view cannot see, where
  percentages come from, and how exact each figure is. **Read this before
  trusting a number.**

## Using it

- **[Runs](runs.md)** — the run loop, the guarantee stated honestly, budget
  policy, the **Needs review** ending an agent asks for when it cannot finish,
  picking a run back up, finding a run afterwards — the paged history, `⌘K` and
  the log's filter — and two runs on one project.
- **[Workflows](workflows.md)** — saved graphs of blocks, orchestrator blocks
  that decide what to run, merge blocks that land it, whole-graph budgets, and
  schedules.
- **[The orchestrator chat](orchestrator-chat.md)** — a conversation that
  proposes runs and workflows; nothing it writes starts until you approve it.
- **[Reviewing and landing](review-and-land.md)** — diffs, the on-demand
  reviewer, AI conflict resolution, the merge queue, and branch cleanup.

## Under the hood

- **[Architecture](architecture.md)** — module map and incremental transcript
  parsing.
- **[Security](security.md)** — what the container holds and what is scoped away
  from whom.
- **[Verification log](verification.md)** — what has been exercised by hand
  against a real CLI, and an explicit list of what has **not**.
- **[A fourth ending: `needs-review`](needs-review.md)** — **a design record, not
  a reference.** The feature is implemented and the durable description of it is
  [Runs](runs.md) plus `docs/agent/`; this is the argument behind each decision,
  and it warns in its own first paragraph that every line reference in it has
  drifted. Read it when you want to know *why*, not *what*.

For the reasoning behind the load-bearing design decisions — why a window is
derived rather than rounded, why a guard charges unpriced models a fallback
rate, why the folder claim has no `await` in it — see [`CLAUDE.md`](../CLAUDE.md)
in the repository root.

**Not here, deliberately.** Two kinds of document used to sit in this directory
without being listed in it, which read as an operator page nobody had indexed:

- The **UI density audit** is a brief written for build runs, all five of which
  have landed. It is `docs/agent/ui-density-audit.md`, beside the invariant it
  settles — `docs/agent/conventions.md` cites it as the reasoning behind the
  closed grouping vocabulary.
- The **external validator** pitch and the baseline measurement it rests on are
  [`proposals/ExternalValidator/`](../proposals/ExternalValidator/README.md).
  Nothing in them shipped: no run is validated today. `proposals/` is where an
  argument lives until it becomes a decision, and that framing is the point of
  the move.
