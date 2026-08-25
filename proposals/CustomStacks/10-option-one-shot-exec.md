# Option H — a one-shot command runner, no PTY

A form and a transcript. The operator types one command; the server spawns it,
streams its output, and it ends. No pseudo-terminal, no session, no job control,
no `vim`, no `sudo -i`. `POST` in, exit code out.

This is what most people mean when they say "a terminal in a web app", and it is
a different feature from `09-` in more ways than the name suggests.

## 1. The strongest case

The transport question — which `08-` §5 shows is the real cost of `09-`, not the
native module — disappears entirely. A one-shot command is the shape this app
already streams: `GET /api/runs/[id]/stream` is a `ReadableStream` with a 15s
heartbeat, abort-driven cleanup and `Last-Event-ID` resume
(`stream/route.ts:156-180`, `:60-62`), and it has worked in production for the
one thing that matters most here. No WebSocket, no `upgrade` handler, no custom
server entry, **no permanent maintenance commitment against Next's release
cadence** — which is what `09-` §9's ceiling actually is. And the thing the
operator described is a *deploy*, not a debugging session: `curl -L … | tar xz`,
`uv tool install`, `gh extension install`. Those are one-shot commands with an
exit code, and an exit code is the read-back `00-problem.md` §"Missing 4" says
nothing in this app has. A PTY is what you build when you do not know what the
operator will type. This is what you build when you have read their sentence.

## 2. Shape

- **`POST /api/terminal/exec`**, `runtime = "nodejs"`, `dynamic = "force-dynamic"`,
  `requireDataDir()` before the spawn (`serverLock.ts:441-444`). **`POST`-only and
  nothing from the query string** — `08-` §2: `sameSite: "lax"` sends the cookie
  on a top-level `GET` navigation, so a `GET …?cmd=` is executed by any link the
  operator clicks.
- **The body, and this is the whole design decision**:
  ```ts
  { argv: string[], cwd?: string }     // not { command: string }
  ```
  `08-` §4's test — no value the server holds may be concatenated into a child's
  command line — is passed by an argv array and **failed by `sh -c command`**, in
  exactly the shape `CLAUDE.md:134` names. Splitting a string server-side fails it
  worse: a hand-rolled shell lexer is a shell with a bug in it.
- **The spawn**: `spawn("/usr/bin/setpriv", ["--reuid", …, "--regid", …,
  "--clear-groups", ...argv], { env: terminalEnv(), cwd, stdio: ["ignore",
  "pipe", "pipe"] })` — the entrypoint's own idiom (`docker-entrypoint.sh:145-153`),
  `stdio` matching every other spawn site here (`docs/agent/security.md:14`).
- **`terminalEnv()`** stripping the same six: `UF_*`, `OTEL_*`,
  `ANTHROPIC_ADMIN_KEY`, `CLAUDE_CODE_ENABLE_TELEMETRY`, `DATA_DIR` and
  `NODE_OPTIONS`, beside the four that exist (`01-constraints.md` §3).
- **`cwd`** through `resolveInMount()` — containment on the resolved path **and
  again after `realpathSync`**, both load-bearing (`docs/agent/security.md:11`).
- **Output**: an SSE stream on the existing pattern, with an **explicit byte cap**
  this time (`08-` §5's inherited backpressure gap), truncating loudly.
- **UI**: a sub-route, an input, a `ui/Log` transcript (`Log.tsx:39-54` is already
  *"a terminal-shaped region"*), an exit-code badge. No xterm.js, **no ANSI
  colour work** — `claudeAuth.ts:118`'s `stripEscapes` already exists for exactly
  this and is the second-cheapest thing in the option.
- **`terminal_commands`** table with its own cap, storing argv, cwd, exit code,
  duration and byte count. Never `auditMutation` (`08-` §7).

Roughly half of `09-`'s code and none of its transport risk.

## 3. What persists it, and what discards it

Identical to `09-` §3 and for the same reason: the feature is code and image, and
**what the operator installs through it persists exactly as far as the substrate
under it and no further**. Four events, same four answers. No Docker socket
(`docker-compose.yml:469-476`), so it cannot rebuild the image and cannot make its
own work durable. `scripts/backup-db.mjs` covers the command log and nothing else.

Pair with A, B, C or D from `00-`–`07-`.

**One difference worth noting, and it favours this option.** A one-shot command is
*a record* in a way a shell session is not: `terminal_commands` holds the exact
argv, so an operator who wants to know what they installed has an answer, and a
future `04-`-style manifest could be **seeded from it**. That is a bridge `09-`
cannot build, because a PTY's scrollback is not structured data.

## 4. Reach

Same as `09-` §4 in every respect — `PATH` reaches all five kinds of child
untouched (`orchestrator.ts:6244-6246`, `git.test.ts:93`), the uid decides which
directories are writable, and `acceptEdits` may still refuse the *invocation*
(`00-problem.md` §"Missing 3", `07-`).

One reach question this option has and `09-` does not: **without a shell there is
no `&&`, no `|`, no `>` and no `cd` that outlives the command.** `curl -L … |
tar xz -C /home/node/pytools/bin` — the single most likely thing an operator types
for a release-tarball binary, which is precisely the gap `02-` says the existing
loops do not cover — **is not expressible.** Neither is `export PATH=…`.

There are three answers and all three are worse than they sound. Ship a
`Bash(…)`-style escape hatch, and you have `sh -c` with extra steps. Ship
`/bin/bash -lc` as a *permitted argv[0]*, and the rule in `08-` §4 is broken
deliberately rather than accidentally, which is at least honest. Or tell the
operator to write the pipeline into a file first — which needs an editor, which is
`09-`. **This is the option's central weakness and it is not fixable within the
option.**

## 5. Tool state, not the binary

Every word of `09-` §5 applies unchanged: `$HOME` differs by uid, `/root` and
`/home/node` are both on no volume except the three carved subdirectories, and a
tool authenticated through the runner is unauthenticated by the next
`up --build` with nothing saying so.

One thing is worse. **A one-shot command cannot answer an interactive prompt.**
`terraform login` opens a browser flow and waits on stdin; `gh auth login` is a
menu; `apt-get` without `-y` asks. With `stdio: ["ignore", …]` all three hang
until the timeout and report failure with output that looks like success up to
the point it stopped. That is a silent failure mode this option creates and `09-`
does not — and it is the same shape as the one `claudeAuth.ts` was built to
solve, which is why that module is 600 lines of URL-scraping and state machine
rather than a spawn.

## 6. What it does to the boundaries

The list is `09-` §6's, with two genuine reductions and one that is illusory.

**Genuinely narrower:**

- **No session.** Nothing holds a shell open across requests, so there is no
  long-lived credential problem, no session reaper, and no `globalThis` registry
  that survives a request. The per-turn capability pattern (`chat.ts:1205-1209`,
  minted per turn, revoked in `land()` at `:1749`) transfers cleanly here and does
  **not** transfer to `09-` — a bounded command is exactly the shape that pattern
  was designed for, and this is the strongest structural argument for this option
  over the last.
- **A timeout is natural.** `chat.ts`'s 10-minute cap (`CHAT_TIMEOUT_MS`, `:248`)
  is the precedent, and it is meaningless against a PTY.

**Illusory:** every boundary in `09-` §6 that the *uid* decides is decided the
same way here. A root one-shot runner is `sqlite3 /data/usagefoundry.db` in one
POST; it reads a live chat's 0040 capability file; it kills the server. Nothing
about dropping the PTY narrows any of that. **The uid is the boundary, not the
transport** — which is `08-` §3's point arriving from a second direction.

And `cd` into a folder a run holds is still undetected (`08-` §8): the folder
claim is a SQLite row, nothing watches the filesystem, and `land.ts` merges what
it finds.

## 7. The operator's surface

An input, a transcript, an exit code, a history list they can re-run from. What
they configure: whether it exists (default **off**) and which uid
(default `UF_AGENT_UID`).

Better than `09-` in one way that matters and is easy to undersell: **the history
is a list of commands, so the app can show what was run and offer it again.** That
is a partial answer to `00-problem.md` §"Missing 4" — not a manifest, not a
reconcile, but the first thing in this whole survey that lets somebody open a page
and read what was installed here.

Removal is still whatever the tool's uninstall is, and the app still does not know
what a command *did*.

## 8. How it fails, and whether loudly

Loud, and more loudly than `09-`: an exit code is a fact, it is stored, and it is
in front of the operator. `.env.example:222-226`'s 213-session failure — a plugin
reported active against a command that was never present — could not happen
through this surface, because a non-zero exit is recorded against the command that
produced it.

Silent, and the list is short but sharp:

- **The interactive hang in §5**, which is new in this option.
- **Root-owned installs** (`docker-entrypoint.sh:140-144`) and **the writable
  layer** (`01-constraints.md` §1) — both inherited unchanged from `09-` §8.
- **A partial pipeline the operator hand-assembled** out of several one-shot
  commands, half-applied when one fails. No transaction, no rollback.
- **The output cap truncating something load-bearing.** Mitigated by saying so in
  the transcript rather than by raising the cap.
- **The cgroup**, unchanged: `pids_limit: 2048`, `mem_limit: 10g`, container-wide
  (`docker-compose.yml:546`, `:531`).
- **The suicide case** (`orchestrator.ts:5147-5150`) is unchanged at root and
  refused by `kill(2)` at the agent uid, exactly as in `09-` §8.

## 9. What it costs to build

**Two to four days**, and — unlike `09-` — that estimate has no hole in it,
because nothing here depends on a question nobody can answer by reading. No
`node-pty`, no `upgrade` handler, no custom server entry point, no ANSI colour
probe, no xterm.js.

Files: one route pair, one `src/lib/` module with tests (argv validation and the
containment check are pure functions whose failure is silent, which is
`CLAUDE.md`'s bar), one migration, one client sub-route, one settings field.

Invariants that move: `docs/agent/security.md` gets the `08-` §4 reconciliation
and a fourth kind of non-`claude` child; `docs/agent/architecture.md`'s child
count; `docs/agent/concurrency-and-ownership.md` gets a writer outside the folder
claim. **`docs/agent/conventions.md` moves less than under `09-`** — a form and a
`ui/Log` are inside the existing vocabulary, where a raw-keystroke region is not.

## 10. What would have to be true

**Promotes it:** that the `09-` §9 probes come back badly — the standalone server
not carrying an `upgrade` handler, or `node-pty` not tracing into
`.next/standalone`. Either answer turns `09-`'s cost from a fortnight into a
standing commitment, and this option is then the only interactive one left
standing. The commands are in `08-` §9 items 1 and 2 and they cost an afternoon.

**Kills it:** the pipeline gap in §4 being what operators actually type. If the
first three things anyone tries are `curl … | tar xz`, `cd foo && make` and
`export PATH=…`, this option is a form that refuses the request in three different
ways and sends them to `docker compose exec` anyway — which is `13-`, more
expensively. **Somebody could settle this in ten minutes by asking the operator
for the five commands they expect to run.** Nobody in this proposal has.
