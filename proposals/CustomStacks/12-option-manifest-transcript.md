# Option J — the terminal as a *view*, never an input

The operator edits a manifest; the app applies it; the pane shows the transcript
of that application, live, in a terminal-shaped region. It looks like a terminal
and it has no cursor. Nothing typed into that pane reaches a process, because the
pane has no input.

This is `04-option-declared-manifest.md` plus the one thing that file leaves as a
line item — *"an SSE or poll for progress"* (`04-` §9) — taken seriously enough to
be the answer to the operator's Terminal request.

## 1. The strongest case

Read the operator's sentence again and notice what the terminal is *for*: *"where
users can run terminal commands on the container's CLI. The things installed by
that CLI … should then be available to all runs."* The terminal is not the goal.
It is how they imagine getting a tool installed and, crucially, **how they imagine
finding out whether it worked** — because that is what a terminal gives you that
`.env` plus a restart does not. `00-problem.md` §"Missing 4" names the same gap
from the other side: nothing in this app can see any of this, and the boot log is
the only read-back (`docker-entrypoint.sh:297`, `:306-307`). This option gives
them the read-back — scrolling output, in a monospace region, as the install
happens — and declines the input, which is the half that carries every cost in
`08-`. **It is the only option here where the security section is genuinely
short**, not because the risk was argued away but because there is no new
execution path at all: the app runs the same installs it would have run from a
declaration, and the pane is a `<pre>` with a stream behind it.

## 2. Shape

Two halves, and only the second is new.

**The manifest half is `04-` and is not re-argued here**: a `stack_tools` table
via an idempotent `CREATE TABLE IF NOT EXISTS` in `migrate()`, `src/lib/stacks.ts`
resolving rows to an ordered list of install actions with a disk-side diff,
`/api/stacks`, and the reconcile-host question at `04-` §2 that file calls *"the
design's one hard question"*. Everything in `04-` §2 through §10 applies. This
option is a **layer over** it, exactly as `04-` is a layer over `02-`/`03-`.

**The transcript half is new and is small:**

- **`/api/stacks/apply/stream`** — a `ReadableStream` on the existing pattern:
  15s `: ping` heartbeat, abort-driven cleanup with the two-flag guard
  (`stream/route.ts:66-182`), `Last-Event-ID`/`?after=` resume (`:60-62`),
  `x-accel-buffering: no` (`:190`), never through `jsonMaybeGzipped` for the
  reason its own docblock gives (`:41-51`). **This route is a copy of a route
  that has worked in production**, not a new transport.
- **Events persisted before they are published**, in `run_events`' shape: *"`emit()`
  persists to `run_events` **then** publishes. That order is what makes reconnect
  lossless"* (`CLAUDE.md`). An install transcript wants exactly that property —
  the operator closes the tab, comes back, and the apply is still legible.
- **`ui/Log` with `size="pane"`**, unmodified. It is already described in its own
  source as *"a terminal-shaped region rather than a box that grows with its
  content"* (`Log.tsx:39-41`), already out of flow for a stated reason (`:43-54`),
  already `tabIndex={0}` / `role="log"` / `aria-live="off"` (`:80-95`), already
  monospace. **The component this option needs is shipped and in use on the run
  page.**
- **`stripEscapes`** (`claudeAuth.ts:118`) for the install output, or `Log`'s own
  rendering. No ANSI colour work, no `conventions.md:64` theme-probe problem,
  because there is no canvas.
- **No input element anywhere on the page.** That is the invariant, and it is one
  sentence in a review: *the transcript pane has no `<input>`, no `<textarea>`,
  and no route that accepts text destined for a process.*

New code beyond `04-`: one streaming route, one `emit`-shaped persist, and the
`Log` already exists. **Two days on top of `04-`.**

## 3. What persists it, and what discards it

`04-` §3's, unchanged, and it is the best answer in the survey: the manifest is a
row in the SQLite database in `usagefoundry-data`, so it survives `restart` and
`up --build`, is destroyed by `down -v` **and reinstated by the reconcile on the
next boot from `scripts/backup-db.mjs`'s restore** (`docs/backup-and-restore.md:33-72`),
and reaches a fresh host with the database. The volume is a cache; the
declaration is the truth. Four events, and it is the only shape in this directory
that survives the fourth.

The transcript itself is evidence rather than truth, and belongs on
`retention.ts`'s horizons — *"nothing deletes a `runs` row; what expires is the
evidence behind it"* (`docs/agent/retention.md`) is the exact model. **An install
transcript is evidence and must expire.** No option that streams process output
into SQLite may skip that, and this is the only one whose storage is designed
rather than incidental.

## 4. Reach

`04-` §4's, unchanged: the reconcile installs under `setpriv` at
`UF_AGENT_UID` into a directory the app chose — on `PATH`, on a named volume,
owned by the uid that will run it — so all five kinds of child see it through
`PATH` (`orchestrator.ts:6244-6246`, `git.test.ts:93`).

The uid question in `08-` §3 does not arise. There is no operator process to
assign a uid to.

`acceptEdits` is untouched and this needs `07-` exactly as much as every other
option does (`00-problem.md` §"Missing 3").

## 5. Tool state, not the binary

`04-` §5's, and `11-` §5's mitigation is available for the same reason: the app
composes the environment, so `UV_TOOL_DIR`-style redirection into a volume is a
per-verb decision the app can make and a human at a prompt cannot. A tool that
hardcodes `~/.config` is still lost at `up --build`, and a tool needing an
interactive login is still out of scope — **more firmly out of scope here than in
`11-`, because there is no stdin at all.**

## 6. What it does to the boundaries

**None, and this is the shortest §6 in the directory for a reason that is
structural rather than rhetorical: there is no new process under operator
control.** The reconcile is the app installing what the app was told to install,
at the uid it already uses, into directories it already owns.

- `/data` 0700 root — untouched.
- The root/`UF_AGENT_UID` split — preserved; no root path exists.
- `UF_CHAT_GID` — untouched.
- The CLI sandbox write allowlist and read guard — unaffected; not a `claude`
  child.
- Worktree isolation and the folder claim — **untouched**. No `cwd` in a mount,
  so `08-` §8's undetected-writer problem does not arise.
- What it hands an agent that the agent did not have: a binary on `PATH`.

Two things it genuinely must get right, and both are `04-`'s:

- **`/api/stacks` is a mutating route and must not be an MCP tool.** `04-` §6
  names the exclusion; an orchestrator chat that can edit the manifest can install
  arbitrary software by declaring it, which turns a model into an installer.
- **The stream route is behind the same session gate as everything else.** It is
  not one of `middleware.ts`'s exemptions and must never become one — the
  exemptions each stay paired with the check that stands in for them
  (`docs/agent/security.md:23`), and a transcript route has no such check to
  offer.

## 7. The operator's surface

`04-` §7's page — declared, installed, failed, the error, a reapply button — with
the transcript pane beside it. Press Apply, watch it run.

The honest thing to say about this surface is what it is *not*: it is a terminal
in appearance and a form in behaviour, and an operator who wanted a shell will
notice within a minute. **If they came to the pane to debug something — "why is
`terraform` not on `PATH`" — this pane cannot answer, because answering that means
running `which`, and running `which` means an input.** That is a real refusal and
the option should be judged on it rather than around it.

Removal is a row delete plus a reconcile. Changing a version is editing a row.

## 8. How it fails, and whether loudly

**Loudly, and it is the only option that is loud on both halves.** `11-` is loud
about exit codes; this is loud about exit codes *and* shows the output that
produced them, live, with the stream persisted so a reconnect is lossless.
`.env.example:222-226`'s 213 sessions is precisely the failure this shape ends.

What still fails quietly, all inherited from `04-` §8:

- **The reconcile-timing race** — a run admitted before the reconcile finishes
  meets a missing command, and nothing in the run loop reads that.
- **A manifest that is right and a volume that is stale**, if the disk-side diff is
  wrong. That diff is the pure function that earns the unit test.
- **A restore bringing back a manifest for a tool whose release URL has since
  404'd** — loud on the page, silent to a run started before anybody looks.
- **The reach gap** (`00-problem.md` §"Missing 3"), made worse here in the same
  way as in `11-` §8: the page says `installed`, and the app has not checked that
  a work cycle can invoke it.

And one this option adds: **a transcript that scrolls past its retention horizon
looks like an install that never happened.** Evidence expiring is correct
(`docs/agent/retention.md`); a page that does not say *why* the transcript is gone
is the same silent shape this whole survey keeps finding.

## 9. What it costs to build

**`04-`'s week to two weeks, plus two days.** The streaming route is a copy of an
existing one, the `Log` component is shipped, and the persist-then-publish shape
is `emit()`'s.

It carries `04-` §9's cost honestly, including the sentence that file ends on:
*"the reconcile-host decision in §2 and whatever that drags in."* If installing a
toolchain has to become a `runs` row to get a log and a status, this option costs
a week plus a permanent distortion of the table three subsystems read — and the
transcript half is what makes that temptation strongest, because a `runs` row
comes with `run_events` and a stream for free. **Resisting that is the design work
in this option.** The right answer is almost certainly a `stack_applies` table
with its own events and its own retention horizon, paying the duplication rather
than the distortion.

Invariants that move: `docs/agent/architecture.md` (a module and a second
streaming route), `docs/agent/retention.md` (a fourth horizon), and
`docs/agent/conventions.md` gains a second `Log size="pane"` caller. **No security
invariant moves at all**, which is unique in this file set.

## 10. What would have to be true

**Promotes it:** that what the operator wanted from a terminal was *feedback*
rather than *control*. The tell is in their own sentence — the emphasis falls on
what happens to the installed thing afterwards ("available to all runs … survive a
rebuild"), not on the typing. If the terminal was a means to an install they could
see, this is that, with none of `08-`'s cost.

**Kills it:** the operator wanting to *diagnose*, not just install. `06-` §10 puts
the same fact the other way round — *"the operator's real requirement being
interactive — try a tool, see whether it helps, keep it or drop it"* — and half of
that sentence this option serves well (declare it, watch it install, delete the
row) while the other half it refuses outright. **A pane that cannot answer "why is
this not on `PATH`" is a pane somebody will ask for a shell beside within a
month**, and if that is foreseeable now it should be decided now rather than
arrived at by accretion.
