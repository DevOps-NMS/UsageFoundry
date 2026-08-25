# Option G — a full PTY pane

The thing the operator described: a real interactive shell in the browser, with
job control, a working `sudo`-less `apt-get` decision, curses programs, tab
completion and Ctrl-C. `node-pty` on the server, xterm.js in the page, a
bidirectional stream between them.

Headings are `01-constraints.md`'s fixed ten. Everything shared with the other
four options — the uid question, the "never a shell" reconciliation, the audit
rule, the transport survey — is in `08-terminal-problem.md` and cited rather than
repeated.

## 1. The strongest case

Every cheaper option in this directory is a guess about what the operator will
need to type, and every guess in this app's history has been wrong in the same
direction: `ISOLATED_GIT_TOOLS` was added because agents needed to commit and
could not, measured at seven refusals in one run (`orchestrator.ts:5082-5089`);
`resolveVerifyTools` was added because a conflict resolver could edit and not
verify, at **19 of 58 resolutions and $109.94 of $233.85**
(`settings.ts:290-296`). Both were allowlists that had to be widened after
somebody hit the wall, and both walls were invisible until money had been spent
against them. A shell has no wall to widen. It is also the only option here that
answers the operator's actual sentence rather than a narrower question somebody
substituted for it, and the only one under which "try Terraform, see if it helps,
throw it away" costs a minute instead of an `.env` edit and a restart. The
security objection is real and it is not new: this app already exposes
`POST /api/chat/[id]/message`, which spawns a child at `bypassPermissions` with
`--add-dir` on every mount and `UF_GITHUB_TOKEN` in its environment
(`chat.ts:1652-1653`, `:1667-1670`), bounded by nothing but a system prompt
(`docs/agent/chat.md:24`). A shell dropped to `UF_AGENT_UID` is *narrower than a
surface this app already ships behind the same cookie.*

## 2. Shape

- **`node-pty`** as a dependency, added to `serverExternalPackages` beside
  `better-sqlite3` (`next.config.ts:40`). The toolchain is present in both image
  stages (`Dockerfile:9-12`, `:127-132`) and `tini` is already PID 1 to reap
  children (`Dockerfile:605-608`).
- **`src/lib/terminal.ts`** — session registry on a **new** `globalThis` key
  (`__ufPtySessions`; `CLAUDE.md`'s "Always" — a new key, never a reused one
  whose shape changed). Holds `{pty, ring, subject, openedAt, lastSeenAt}` per
  session, an idle reaper, and a hard session cap.
- **The spawn**, and it is two constants:
  ```ts
  pty.spawn("/usr/bin/setpriv",
    ["--reuid", String(uid), "--regid", String(gid), "--clear-groups", "/bin/bash", "-l"],
    { env: terminalEnv(), cwd: "/home/node" })
  ```
  `setpriv` is present (util-linux, base image) and this is the entrypoint's own
  idiom, three uses (`docker-entrypoint.sh:145-153`, `:216-224`, `:547-552`). No
  operator byte is on that argv — `08-` §4's test, passed.
- **`terminalEnv()`** — a new function beside `childEnv`/`chatEnv`/`gitEnv`,
  stripping the same six: `UF_*`, `OTEL_*`, `ANTHROPIC_ADMIN_KEY`,
  `CLAUDE_CODE_ENABLE_TELEMETRY`, `DATA_DIR` and `NODE_OPTIONS`
  (`01-constraints.md` §3). Without it the terminal is the one child that can
  read `UF_AUTH_TOKEN` out of its own environment and the credential strip stops
  being true — and the last name earns its place as much as the first, because an
  inherited `NODE_OPTIONS` is code execution into every Node child the terminal
  starts.
- **Transport**: a WebSocket if §9's probe says the standalone server can carry
  one; otherwise SSE down plus `POST /api/terminal/[id]/input` up
  (`08-` §5). The option survives either answer at different costs.
- **Route**: `POST /api/terminal` to open, `runtime = "nodejs"`,
  `dynamic = "force-dynamic"`, `requireDataDir()` **before** the spawn
  (`serverLock.ts:441-444`), never through `jsonMaybeGzipped` on the stream half
  (`stream/route.ts:41-51`).
- **UI**: xterm.js in a **sub-route** — `/settings/terminal` — never a tenth pane
  (`08-` §6, `panes.ts:12-16`, `ui-density-audit.md:159`, `:161`). The scrollback
  region is `ui/Log`'s shape (`Log.tsx:39-54`); the composer-below-scroller layout
  is `/chat`'s (`chat/page.tsx:721-731`).
- **A new table** `terminal_commands` with its own cap — never `auditMutation`
  (`08-` §7).

Roughly: one dependency, one `src/lib/` module with tests, two routes, one client
page, one migration, one settings field.

## 3. What persists it, and what discards it

**Nothing.** A PTY session is process-local state on `globalThis`; it dies with
the server, and `scripts/backup-db.mjs` has nothing to back up but the command
log. Against `01-constraints.md` §1's four events the answer is the same four
times: the *feature* persists as image and code, and **nothing an operator types
into it does** — anything written to the writable layer is gone at
`up --build`, which is the operator's own stated requirement, failed.

That is not a gap in this option, it is the boundary between question 1 and
question 2. A terminal's installs persist exactly as far as the substrate under
them: `/home/node/pytools` and `/home/node/go` survive `up --build` and not
`down -v`; `/usr/local/bin` and `/opt` survive nothing. **And the terminal cannot
close that gap itself, because there is no Docker socket in this container
(`docker-compose.yml:469-476`) — it can never rebuild the image it runs in**
(`08-` §8). Pair this with A, B, C or D from `00-`–`07-`; alone it delivers a
tool that vanishes on the next rebuild, which is the failure the request names.

## 4. Reach

`PATH` passes through all five kinds of child untouched (`orchestrator.ts:6244-6246`,
pinned at `git.test.ts:93`), so a binary the terminal installs *into a directory
already on `PATH`* is visible to the work cycle, the reviewer, the chat, an
orchestrator block and `git` — with one condition and one trap.

**The condition is the uid**, and it is this option's sharpest constraint. At
`UF_AGENT_UID` the terminal can write `/home/node/pytools/bin` and `/home/node/go`
(both chowned to the agent at boot, `docker-entrypoint.sh:90-98`, `:43-51`) and
**cannot** write `/usr/local/bin`, `/opt` or anything `apt-get` touches. At root
it can write all of them and the result is owned by root — which
`docker-entrypoint.sh:140-144` says in its own words leaves *"the agents unable to
remove or upgrade what they run"*. `08-` §3 is the full argument; the short form
is that the safe uid can only write the two directories that already have
declarative install loops in front of them, which is a real reduction in what this
option is for.

**The trap is `acceptEdits`.** Reach is not `PATH`, it is permission — a work
cycle may be refused the *invocation* (`00-problem.md` §"Missing 3"), and this
option does not touch that. It needs `07-`'s `stackTools` allowlist exactly as
much as A through E do.

## 5. Tool state, not the binary

Worse here than in any declarative option, because a terminal invites the
operator to run the tool *as themselves* and the tool then writes its state as
whoever they were.

`terraform init` writes `.terraform/` beside the config and a plugin cache under
`$HOME`. Root's `$HOME` is `/root`; the agent's is `/home/node`. A root terminal's
`terraform init` populates `/root/.terraform.d`, on no volume, and the agent's
later run re-downloads every provider — silently, as a slow cycle rather than an
error. At the agent uid it lands in `/home/node`, which is **also on no volume**
except the three subdirectories `docker-compose.yml:370-409` carved out.

Credentials are the sharper half: `terraform login`, `aws configure`, `gh auth
login` all write into `$HOME` and none of those paths is covered. An operator who
authenticates a tool in the terminal has done it in the writable layer, and
`up --build` silently unauthenticates it.

## 6. What it does to the boundaries

- **`/data` 0700 root** — crossed by a root terminal, absolutely. `sqlite3` is
  installed (`Dockerfile:127-132`), so a root shell is a SQL prompt on the
  database that holds every setting, every run and the chat capability table. At
  `UF_AGENT_UID` it is refused, which is the whole point of the mode.
- **The root/`UF_AGENT_UID` split** — a root terminal ends it. There is no
  `no-new-privileges` and no `cap_drop` in `docker-compose.yml`, so a root shell
  holds Docker's default capabilities and can re-enter either uid at will; the
  drop is one-directional only for a process that started unprivileged.
- **`UF_CHAT_GID`** — a root terminal reads any live chat's 0040 capability file
  under `/run/uf-mcp` (`chat.ts:2281`, `:2358-2364`). An agent-uid terminal is
  outside that group and cannot, which is exactly what
  `privsep.ts:266-272` engineered.
- **The CLI sandbox's write allowlist and the read guard** — neither applies. Both
  are properties of a `claude` child's configuration; a bash process has neither.
- **Worktree isolation** — bypassed by `cd`. The claim that keeps two runs out of
  one directory is a SQLite row and nothing watches the filesystem (`08-` §8);
  a terminal writing into a folder a run holds is undetected by every mechanism
  in this app, and `land.ts` merges whatever it finds.
- **What it hands an agent that the agent did not have: nothing, if
  `terminalEnv()` strips `UF_*`.** That is the one boundary this option can hold
  cleanly, and it holds only because of §2's strip.

## 7. The operator's surface

A sub-route with a terminal in it. Open → a session with a real shell; type; close
→ the session is reaped. What they configure is in `Settings`: whether the pane
exists at all (default **off**), and which uid it opens as (default
`UF_AGENT_UID`). A restart kills every session and loses every scrollback; the
command log survives in SQLite.

Changing or removing an installed tool is whatever the tool's own uninstall is —
which is the honest advantage over every declarative option and the honest
disadvantage over all of them at once, because **nothing in the app knows what
was installed.** There is no read-back, no list, no state. `00-problem.md`
§"Missing 4" is untouched and should be scored as a loss.

## 8. How it fails, and whether loudly

**The bar is `.env.example:222-226` — 213 sessions told a plugin was active
against a command that was never present. This option clears it in one place and
fails it in five.**

Loud: an install that fails prints to the terminal, and the operator is watching.
That is genuinely better than the boot loops' best-effort stderr
(`docker-entrypoint.sh:165-168`, `:305-308`).

Silent, and each one is specific:

- **Root-owned installs.** Work today, refuse the agent's upgrade in a month
  (`docker-entrypoint.sh:140-144`).
- **The writable layer.** Everything the operator installs outside the three
  volumes works until `up --build` and is then gone with no message anywhere —
  and it fails inside a `Bash` tool call the run loop does not read, which it
  files as the agent choosing not to use the tool (`docker-compose.yml:386-391`).
- **Backpressure.** `08-` §5: `controller.enqueue` buffers rather than applying
  backpressure (`stream/route.ts:26-29`), the existing route survives it only
  because it caps replay at 2,000 rows and 4 MB, and a terminal has no such cap.
  `yes` in a background tab is unbounded server heap against a `mem_limit: 10g`
  shared with every run (`docker-compose.yml:531`).
- **The cgroup.** `pids_limit: 2048` (`:546`) is container-wide. A fork bomb takes
  down the fleet and nothing attributes it.
- **The suicide case, which has a number.** `pkill -f` from an agent killed
  fourteen runs 690ms after the restart it caused (`orchestrator.ts:5147-5150`).
  `PROCESS_KILLERS` and `SELF_HOSTING_NOTICE` are a CLI permission deny and a
  prompt notice — **both apply to `claude` children only, and a terminal passes
  through neither**. At root, `kill(2)`'s uid check does not save it either.

## 9. What it costs to build

**The most expensive option in this directory, and the estimate has a hole in it
nobody here can close.**

Floor, if the standalone server carries an `upgrade` handler: `node-pty`, a
`src/lib/` module with tests, two routes, a migration, an xterm.js page, a
settings field. **A week to two weeks.**

Ceiling, if it does not: add owning a custom server entry point — replacing Next's
generated `.next/standalone/server.js` with `http.createServer` +
`next().getRequestHandler()`, which changes `CMD` (`Dockerfile:610`), changes what
`COPY --from=builder /app/.next/standalone ./` (`:454`) suffices for, and moves
`instrumentation.ts`'s data-directory claim (`:94`) and seven boot reconcilers
(`:101-164`) relative to `listen()`. That is not a week of work, it is a permanent
maintenance commitment against Next's release cadence, taken for one pane.

Invariants that move: `docs/agent/security.md` (a fourth kind of non-agent child,
and the first that is not a `claude`); `docs/agent/architecture.md`'s child count;
`docs/agent/conventions.md` (a sub-route with a raw-keystroke region);
`docs/agent/concurrency-and-ownership.md` (a writer outside the folder claim).
And `CLAUDE.md:134`'s spawn rule needs the §4 reconciliation written into
`docs/agent/security.md` rather than left in this proposal.

Plus the colour work: sixteen ANSI colours plus foreground, background and cursor,
each probed off a real element and re-probed on theme change, because
`getComputedStyle` on a `light-dark()` token returns source text a 2D context
rejects **silently** (`conventions.md:64`). Invisible until somebody switches
theme, and not small.

## 10. What would have to be true

**Promotes it:** that the operator's requirement is genuinely *exploratory* —
"try a tool, see whether it helps, keep it or drop it" — rather than "install
these four tools". `06-` §10 names the same fact from the other side and calls it
that option's killer. It is the one fact that decides between the two ends of this
directory, and it is a question for the operator, not for the tree. **Nobody in
this proposal has asked it.**

**Kills it:** the uid probe in `08-` §9 item 3 coming back the way the code says
it will — agent-uid refused on `/usr/local/bin`, `/opt` and `apt-get`. If the safe
terminal can only write the two directories that already have declarative install
loops in front of them, then a full PTY buys nothing over `04-`'s manifest except
the ability to break things, and this option is the most expensive way in the
directory to reach a smaller result than `02-`.
