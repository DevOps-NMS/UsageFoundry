# Option F — fix the reach, not the persistence

Add nothing that persists. Add the one thing missing from the chain: a
`stackTools` setting whose entries go onto `--allowedTools` beside
`ISOLATED_GIT_TOOLS` and `SEARCH_TOOLS`, so that a tool which is already
installed and already on `PATH` can actually be invoked by a work cycle.

This option is orthogonal to A through E. It pairs with any of them, including E.

## 1. The strongest case

The persistence half of this request is solved three times over and the reach
half is solved zero times, and everybody — including the operator — is looking at
the wrong half. A binary in `/home/node/pytools/bin` is on every child's `PATH`
today (`Dockerfile:281`, `orchestrator.ts:6244-6246`) and a work cycle at
`acceptEdits` may still not be permitted to run it. This app has met that exact
wall twice already and solved it the same way both times: a **named grant on
`--allowedTools`**, never a mode change. `ISOLATED_GIT_TOOLS` was added because
the isolation preamble told agents to commit and the permission mode made
committing impossible, measured at seven refusals across five phrasings in one
run (`orchestrator.ts:5082-5089`). `resolveVerifyTools` was added because a
conflict resolver could edit files and could not run one command against the
result, measured at **19 of 58 completed resolutions and $109.94 of $233.85**
(`settings.ts:290-296`). Installing Terraform and not granting `Bash(terraform:*)`
reproduces that failure a third time, for the third reason, at a third call site.
Grant it, and the whole feature is a settings field and four lines of argv
construction.

## 2. Shape

- **`stackTools: string[]`** in `Settings`, defaulting to `[]`
  (`src/lib/settings.ts`), in the shape of `resolveVerifyTools`
  (`:314`, `:743`) — the existing operator-owned tool-pattern list, which ships
  empty for a reason worth copying verbatim: *"This app runs against whatever
  repository is mounted, so there is no command it could ship that is right for
  one"* (`settings.ts:300-303`).
- **Validation at save**: entries must match the CLI's `Bash(cmd:*)` pattern
  form. An entry an operator gets wrong is silent otherwise.
- **Pushed onto the existing `--allowedTools` flag** at
  `orchestrator.ts:5525-5529`, **after** `ISOLATED_GIT_TOOLS` and **before**
  `SEARCH_TOOLS`, because the ordering there is asserted by tests and
  `SEARCH_TOOLS` is deliberately last as *"the entry that is always there"*
  (`:5520-5524`). One flag, never two — *"a second `--allowedTools` is a variadic
  option the CLI would read as a replacement rather than an addition"* (`:5521`).
- **A settings field**, beside `resolveVerifyTools`'s.
- **Unconditional, not isolation-gated**, on `SEARCH_TOOLS`'s reasoning rather
  than `ISOLATED_GIT_TOOLS`': whether a tool exists is not a fact about the tree
  the child is standing in (`:5129-5131`). That is a decision, and the opposite
  one is defensible — see §10.

Roughly 30 lines of `src/`, one settings field, one test.

## 3. What persists it, and what discards it

`stackTools` is a setting, so it is in the SQLite database in
`usagefoundry-data` — survives `restart` and `up --build`, destroyed by
`down -v`, restored by `scripts/backup-db.mjs` like every other setting
(`docs/backup-and-restore.md:33-72`). It joins workflows and schedules on the
list of things that exist nowhere else (`:139-142`).

**It persists nothing about the tool itself**, which is the point: whichever of
A-E supplies the binary supplies the persistence, and this option supplies the
permission. Paired with E, the persistence is `.env` and the permission is a
setting, and **nothing new is stored anywhere**.

`saveSettings` stores only what differs from `DEFAULTS` (`CLAUDE.md`), so an
empty list writes nothing and every install that never sets it is byte-identical
to today.

## 4. Reach

This *is* the reach option, so the table is the substance rather than a
formality:

| Child | Mode | Effect of `stackTools` |
|---|---|---|
| 1. Work cycle (`orchestrator.ts:6558`) | `acceptEdits` | **the whole point** — this is the child that needs the grant |
| 2. Reviewer (`review.ts:660`, mode `plan` at `review.ts:238`) | `plan` | none, and deliberately: a reviewer that runs the operator's toolchain is no longer reviewing |
| 3. Conflict resolver (same site, `acceptEdits` at `land.ts:1284`) | `acceptEdits` | **already has its own list** — `resolveVerifyTools` (`land.ts:1275`). Do not extend `stackTools` here; two lists on one child is one list too many |
| 4. Orchestrator chat (`chat.ts:1709`) | `bypassPermissions` (`:1652-1653`) | none needed — it can already run anything |
| 5. Workflow orchestrator block | `bypassPermissions` | as 4 |

So the grant applies to exactly **one** of the five children, which is the
smallest possible change that closes the gap.

`PATH` reaches all five already and is not touched (`git.test.ts:93` pins that
for the git child; the other four share the mechanism).

## 5. Tool state, not the binary

**Nothing.** This option is about permission and touches no filesystem path.

Which is worth saying plainly rather than skipping, because it is the option's
honest limit: granting `Bash(terraform:*)` to a child whose `$HOME` cache is
discarded on every rebuild produces a tool that is permitted to run and
re-downloads its providers every cycle. §5 of Options A, B, D and E is where that
gets solved, and this option depends on one of them for it.

## 6. What it does to the boundaries

Small, but not zero, and one part of it deserves care.

- **It widens what a work cycle may execute** — that is the feature. The widening
  is by exact command prefix, chosen by the operator, never by the model, and
  additive to a mode that still governs everything unnamed
  (`settings.ts:296-298`).
- **`PROCESS_KILLERS` still wins.** `--disallowedTools` beats
  `--permission-mode`, verified against the pinned CLI: *"a `bypassPermissions`
  session is still refused these"* (`orchestrator.ts:5178-5179`). So no
  `stackTools` entry can re-open `pkill`/`killall`. **Not re-verified here** —
  quoted from the tree — and the interaction of `--allowedTools` with
  `--disallowedTools` for the *same* command is not measured anywhere. An
  operator writing `Bash(pkill:*)` should be refused at save rather than relied
  upon to lose the race.
- **A prefix is broader than it looks.** `Bash(terraform:*)` grants
  `terraform apply -auto-approve` as readily as `terraform plan`. This app
  already knows that a prefix is coarse — `ISOLATED_GIT_TOOLS` covers
  `git commit -am …` and not `git -c user.name=… commit`
  (`orchestrator.ts:5099-5102`) — and accepted it there. Here the blast radius is
  larger, because the operator's example tool changes infrastructure outside this
  container.
- **`/data` 0700**, **uid split**, **`UF_CHAT_GID`**, **read guard**, **worktree
  isolation**, **CLI sandbox** — no interaction. Under `UF_SANDBOX=1` the write
  set is unchanged, so a permitted tool that needs to write still fails
  (`orchestrator.ts:5979-5982`) — this option does not paper over that.

## 7. The operator's surface

One field on the settings page, in the same group as `resolveVerifyTools`, with
copy that says what it is: *the commands your agents may run without asking.*
Empty by default. No restart — settings are read per spawn.

That is a much smaller surface than a terminal, and it is the surface that
actually changes what a run can do. An operator who has installed Terraform and
cannot use it will look for exactly this control.

## 8. How it fails, and whether loudly

- **The silent failure this option exists to remove** is the loudest thing about
  it: without the grant, a refused command is a tool call the run loop does not
  read, and the run finishes `completed` having done nothing
  (`orchestrator.ts:5086-5089`). That is measured twice in this tree.
- **A malformed pattern is silent** unless validated at save. `Bash(terraform)`
  without `:*`, or a bare `terraform`, will simply never match, and the operator
  sees the identical symptom they were trying to fix. §2's validation is not
  optional.
- **A grant for a tool that is not installed** is inert and silent — the command
  is permitted and absent, which is `unknown command` inside an unread tool call.
- **Over-granting is silent by definition.** Nothing reports what a run was
  permitted to do. The row carries the permission mode (`orchestrator.ts:3538`,
  emitted onto the argv at `:5508`) and nothing carries the allowlist. A run
  page line naming the granted patterns would be the honest companion change,
  and it is small.

## 9. What it costs to build

One settings field, one validator, one push onto an existing argv array, one
settings-page control, and one test in the shape of the existing `--allowedTools`
ordering assertions. **One to two days.**

No schema change, no route, no volume, no `docker-compose.yml` edit, no
`Dockerfile` edit, no pane. `docs/agent/run-lifecycle.md` gains a sentence about
a third contributor to the `--allowedTools` flag; nothing moves.

## 10. What would have to be true

**Promotes it** — and this is the single measurement the whole survey turns on:
that a work cycle at `acceptEdits` is refused when it invokes an arbitrary
installed binary. **The probe, in full, because it costs one work cycle and
nobody has run it:**

```
1. docker compose up -d --build
2. Set UF_PY_TOOLS=ruff==0.6.9 in .env, restart, confirm the boot log line
   "[usagefoundry] installed Python tool ruff==0.6.9" (docker-entrypoint.sh:297).
3. Start a run, permission mode acceptEdits (the default), on any mounted repo,
   with the task: "Run `ruff --version` and report exactly what it printed.
   Then run `ruff check .` and report the first line."
4. Read the run's log for a "This command requires approval" refusal, and read
   the run's own report text.
```

Four outcomes, and each decides something different:

- **Both refused** → this option is required before any of A-D is worth
  building, and `06-` plus this file is the recommendation.
- **`--version` allowed, `check .` refused** → the CLI's read-only
  classification is doing real work; the grant is needed only for mutating
  commands, and `stackTools` can ship with narrower guidance.
- **Both allowed** → the reach half is not broken, this option is unnecessary,
  and the survey collapses to a straight choice among A, B, D and E.
- **Refused with a different message** → whatever it says is new information
  about the pinned CLI and belongs in `docs/verification.md` either way.

**Kills it:** the third outcome above. It is a real possibility — the two
existing measurements are both of `git`, which the CLI may classify specially,
and neither is of an unknown binary.

**And one decision this file does not make:** whether the grant should be
per-run rather than install-wide. `ISOLATED_GIT_TOOLS` is gated on isolation and
`SEARCH_TOOLS` is not (`orchestrator.ts:5527-5528`, `:5129-5131`), so both
patterns have precedent. Install-wide is proposed here because a tool is a
property of the container rather than of a checkout — but an operator with four
mounted repositories and one that needs Terraform has a fair objection, and
run 3's recommendation should settle it rather than inherit it.
