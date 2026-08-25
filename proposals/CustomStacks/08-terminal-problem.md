# The Terminal pane — the surface, and what it actually costs

**This is question 2 of the three in `00-problem.md` §"The three-way split".** It is
the analogue of `00-problem.md` and `01-constraints.md` for the surface half, and
like them it **does not answer the ten headings** — the option files `09-` to
`13-` do. Run 3's comparison table skips this file and reads those.

Everything below was checked against the tree at `86debce` and re-resolved
against `7c2c295`. Two claims were measured **inside this container** and say so;
everything else is code, and everything that could not be reached is in §9 with
the command that reaches it.

## 1. The request, and the one word in it that decides everything

> There is a point on the left menu called Terminal where users can run terminal
> commands on the container's CLI. The things installed by that CLI — let's take
> Terraform for an example — should then be available to all runs and sandboxed
> runs, and survive a rebuild of the container.

The persistence clause is `00-` to `07-`'s and is not re-argued here. What is
left is: **an interactive shell on this container, reachable from a browser
tab.**

The word that decides the design is *"the container's CLI"* — because this
container has two of them. Root's and `UF_AGENT_UID`'s. They see the same
filesystem and are not interchangeable, and §3 is why picking the wrong one
breaks the feature's own purpose.

## 2. The delta: what a session cookie already buys

A terminal pane is remote code execution as a product feature. That framing is
correct and it is also, on its own, useless — because **three routes in this app
already execute arbitrary code on this container from a browser form**, and the
question is only what a fourth adds.

What the credential buys today:

| Surface | What it runs | As whom | Bounded by |
|---|---|---|---|
| `POST /api/runs` (`src/app/api/runs/route.ts:358`) | a `claude` child with `Bash`, prompt from the wire | `UF_AGENT_UID` | permission mode, budget guards, `run_events` |
| `POST /api/chat/[id]/message` (`route.ts:33`) | a `claude` child at **`bypassPermissions`**, `--add-dir` on every mount, `UF_GITHUB_TOKEN` in env (`src/lib/chat.ts:1652-1653`, `:1667-1670`) | `UF_AGENT_UID`, `UF_CHAT_GID` | `--max-budget-usd`, a 10-minute timeout, and *"the system prompt is the boundary"* (`docs/agent/chat.md:24`) |
| `POST /api/plugins` | registers a directory *"whose hooks the container runs"* (`CLAUDE.md:95`) | `UF_AGENT_UID`, inside a `claude` child | containment re-proved at use time |

So arbitrary execution is not new, the agent uid is not new, and write access to
every mount is not new. **Four things are new, and only four.** They are what an
option file has to answer for, and three of them are design choices rather than
consequences of the idea:

1. **Uid.** Every existing path drops to `UF_AGENT_UID` (`src/lib/privsep.ts:252-255`,
   spread at `orchestrator.ts:6564`, `review.ts:665`, `chat.ts:1718`, `git.ts:127`,
   `:213`, `claudeAuth.ts:289`). The server is root (`docker-compose.yml:64`). A
   terminal is the first surface where the uid is a *choice*, and §3 shows that
   both answers are wrong for something.
2. **Mediation.** A model stands between the operator and the syscall on all
   three existing paths. It is a poor boundary and the tree says so, but it is
   one thing that has never typed `rm -rf`. A terminal removes it.
3. **Metering.** Every existing path is priced: `budget.ts` guards a run, and a
   chat turn carries `--max-budget-usd` and lands on `chat_turn_spend`. Keystrokes
   are free, and the install ceiling's rolling 24 hours has no column for them.
4. **Record.** A run leaves `run_events`, a transcript and a spend figure. A
   terminal leaves whatever §7 decides, and the default — nothing — is the one
   answer that is definitely wrong.

**And one thing that is *not* a delta, which is worth stating because it is the
first objection anyone will raise.** The credential does not reach the agents:
`childEnv`, `chatEnv`, `reviewEnv`, `authEnv` and `gitEnv` all strip `UF_*`
(`01-constraints.md` §3 for the first two; `docs/agent/security.md:14` and
`review.ts:760-770` / `claudeAuth.ts:258-268` / `git.ts:51-61` for the rest), so
`UF_AUTH_TOKEN` is not in any child's environment and a work-cycle agent cannot
POST to a terminal route to escape its own uid. That strip is load-bearing for
this feature specifically, and any option that introduces a *second* credential
for the terminal must inherit the same rule.

### Where the delta is largest, and it is not where people look

Not on a well-run install. On the two configurations this repository explicitly
supports and documents:

- **`UF_ALLOW_NO_AUTH=1`.** A blank `UF_AUTH_TOKEN` makes the container refuse to
  boot *unless* this is set (`src/lib/authGuard.ts:68-77`), and then
  `src/middleware.ts:42` is `if (!token) return NextResponse.next();` — every
  route open. `.env.example:7-9` says to set it *"ONLY if the port is bound to
  loopback and you are the only user of the machine"*, `docker-compose.yml:71-72`
  calls it *"only ever right for loopback"*, and `:76-77` binds loopback by
  default, so this is a normal, sanctioned install. On it, a terminal pane is a
  root shell for **any local process that can open a TCP connection to
  127.0.0.1:3000**, with no credential of any kind.
- **`UF_BIND_ADDRESS` moved, TLS absent.** `.env.example:136-137` already warns
  that the token is *"a shared secret over plain HTTP: anyone able to watch the
  network sees the token"*. Today that buys a billed agent. With a terminal it
  buys uid 0.

Neither is an argument that the terminal must not exist. Both are arguments that
**an option must state which of the two it is safe under**, and that the answer
"behind the same auth as everything else" is not sufficient on either.

### The CSRF shape, which is a design constraint rather than a risk

There is no CSRF token, no double-submit and no origin check anywhere in `src/`
(zero `csrf` hits). The stand-in is stated: *"`httpOnly` and `sameSite: "lax"` are
unchanged and are what stands in for CSRF protection"* (`docs/agent/security.md:25`).
`Lax` withholds the cookie from a cross-site `POST` and **sends it on a top-level
`GET` navigation**. So:

> **A terminal route must be `POST`-only and must never take a command, an
> argument or a session id from a query string.** A `GET /api/terminal/exec?cmd=…`
> is executed by any link the operator clicks, on any site, with no further
> weakness required.

That is a one-line rule and it is checkable in review.

## 3. Which uid — and why the obvious answer breaks the feature

This is the paragraph the whole surface turns on, and it resolves against the
operator's mental model.

**The repository has already decided how an operator-installed executable must be
owned, twice, in the same words:**

> Every install runs as the uid that will *run* the extension — an extension is
> an executable an agent invokes, and root-owned files here would leave the
> agents unable to remove or upgrade what they run.
> — `docker-entrypoint.sh:140-144`, and again at `:213-215` for `uv`

Both boot loops therefore install under `setpriv --reuid --regid --clear-groups`
(`docker-entrypoint.sh:145-153`, `:216-224`). And the app's own interactive
operation made the same decision for the same reason: `docs/install.md:44-50`
tells the operator **not** to `docker compose exec` as root to sign in, because
`.credentials.json` lands 0600 owned by whoever wrote it and the uid that must
open it afterwards is `UF_AGENT_UID`.

So a terminal whose purpose is installing tools for agents **must run as
`UF_AGENT_UID`**, or it reproduces, by hand, the exact failure two boot loops and
one documentation correction exist to prevent — and it reproduces it silently,
because a root-owned 0755 binary is readable and executable and only fails on the
*next* upgrade.

That terminal is one line and needs no image change. Measured in this container:
`/etc/passwd` carries `node:x:1000:1000::/home/node:/bin/bash`, `/bin/bash` is
present from the Debian base, and `/usr/bin/setpriv` is present from util-linux —
so `setpriv --reuid=1000 --regid=1000 --clear-groups bash -l` works today.

**And that terminal cannot do what the operator will type into it.** `apt-get`,
`apk`, writing to `/usr/local/bin`, writing to `/opt` — all root-owned, all
refused at uid 1000. Worse, on a root terminal they *succeed* and land in the
**writable layer**, which `docker compose up --build` discards
(`01-constraints.md` §1) — the failure `docker-compose.yml:386-391` describes in
its own words, arrived at from a new direction.

**The root terminal has a second cost that is not about persistence at all.** The
only structural defence this app has against a process killing the server is the
uid split — `kill(2)` checks the sender's uid, so an agent-uid signal at the root
server is refused (`src/lib/orchestrator.ts:5152-5161`). §8 is what happens when
that defence is absent, and it has a number on it.

**The honest conclusion: there is no single uid that makes a shell both useful and
safe.** An option may pick `UF_AGENT_UID` and tell the operator that half of what
they will type is refused; it may pick root and accept §8; it may offer both and
own the fact that the safe one is the one nobody will choose. What it may not do
is leave it unstated, because the failure of the wrong choice is silent in both
directions.

## 4. "Never a shell" — the rule, and the only reconciliation that holds

`CLAUDE.md:134` states it: *"Never a shell. Argv arrays only, at every spawn
site."* The substantive form is `docs/agent/security.md:14` — *"spawned with an
argument array and `stdio: ["ignore", "pipe", "pipe"]`, **never a shell**, so
prompt metacharacters are inert"* — and the tree keeps it: **`shell: true`
appears nowhere in this repository**, and all eight production spawn sites pass
argv arrays (`orchestrator.ts:6558`, `review.ts:660`, `chat.ts:1709`, `git.ts:124`,
`:210`, `claudeAuth.ts:302`, `:414`, `contextPruning.ts:610`), three of them with
the reason written beside the call (`orchestrator.ts:6556-6557`,
`chat.ts:1707-1708`, `review.ts:658-659`).

A feature whose purpose is running shell commands has to reconcile with that or
break it. The reconciliation is real, and it is narrower than it first looks.

**What the rule forbids is the app composing a command line.** Every quoted
comment says the same thing in different words: the danger is *interpolation* —
a prompt, a diff, an issue body, a branch name becoming syntax. `spawn("/bin/bash",
["-l"], …)` is an argv array of two constants. Nothing is interpolated, nothing is
parsed by the app, and the shell that results is the **payload**, not the
mechanism. The rule survives intact, and the test that decides it is one line:

> **No value the server holds may be concatenated into a child's command line.
> The operator's bytes go to the child's stdin and never to its argv.**

That test is stricter than it sounds, and it is what separates the option files:

- **A PTY passes it.** Constant argv, everything else through the pty master.
- **`POST {command: "terraform init"}` → `sh -c command` fails it**, and fails it
  in exactly the shape the rule names: an operator-supplied string becoming the
  shell's syntax, in an argv slot the app built.
- **`POST {argv: ["terraform","init"]}` passes it**, at the price that the client
  now owns tokenisation and `terraform init && terraform plan` does not work.
- **Splitting a string server-side fails it worse than `sh -c` does**, because a
  hand-rolled shell lexer is a shell with a bug in it.

**There is one more reason to keep the operator's bytes off argv, and it is
measured here rather than reasoned.** `/proc/<pid>/cmdline` is world-readable and
`/proc/<pid>/environ` is not — checked inside this container on 2026-08-25 at uid
1000 (`node`, the agent uid): `/proc/1/cmdline` is mode `-r--r--r--` and read back
as `/usr/bin/tini -- /usr/local/bin/uf-entrypoint node server.js`; `/proc/1/environ`
is `-r-------` and returned `Permission denied`. The repository already depends on
this asymmetry twice — `src/lib/privsep.ts:41-55` invents `UF_CHAT_GID` precisely
because *"`--mcp-config <path>` is an argv element, `/proc/<pid>/cmdline` is
world-readable"*, and `docs/agent/chat.md:22` puts the capability *"in a 0600 file
rather than into argv (where `ps` would show it)"*.

The consequence inverts the intuition: **a one-shot exec route publishes the
operator's command line — including a token typed into it — to every agent running
in this container. A PTY does not.** On this axis the PTY is the safer design.

## 5. Transport — what this app can carry, and what it would have to own

- **`output: "standalone"` (`next.config.ts:38`)**, and `CMD ["node", "server.js"]`
  (`Dockerfile:610`) runs the `server.js` Next *generates* into `.next/standalone`.
  **There is no custom server in this repository**, and no `server.js` outside
  `node_modules`.
- **Nothing in this repo has ever opened an HTTP upgrade.** Zero `WebSocket`,
  zero `ws`, zero `socket.io`, server or client.
- **One long-lived stream exists**: `GET /api/runs/[id]/stream`, a `ReadableStream`
  with a 15s `: ping` heartbeat (`route.ts:156-161`), abort-driven cleanup
  (`:163-180`), `Last-Event-ID`/`?after=` resume (`:60-62`), `x-accel-buffering: no`
  (`:190`), **and no server-side timeout at all**. It is the pattern a terminal
  would copy.

**So the WebSocket cost is not the protocol, it is the ownership.** Taking
`upgrade` means replacing the generated standalone entry with a hand-written
`http.createServer` + `next().getRequestHandler()`, which changes `CMD`, changes
what `COPY --from=builder /app/.next/standalone ./` (`Dockerfile:454`) is
sufficient for, and moves `instrumentation.ts`'s boot ordering — the data-directory
claim at `:94` and seven reconcilers at `:101-164` — relative to `listen()`. That
is a permanent maintenance commitment against Next's release cadence, taken for
one pane.

Two facts that cut the other way and should not be suppressed:

- **The native module is nearly free.** `better-sqlite3` is a direct dependency
  with `hasInstallScript: true`, `next.config.ts:40` already carries
  `serverExternalPackages: ["better-sqlite3"]`, and `python3 make g++` are
  installed in **both** the `deps` stage (`Dockerfile:9-12`) and the runtime stage
  (`Dockerfile:127-132`, justified at `:60-68`, cost accepted at `:124-126`).
  Debian bookworm, glibc, Node 22, both stages. A second addon such as `node-pty`
  is the same shape as one that already builds. `tini` is PID 1 specifically to
  reap children (`Dockerfile:605-608`), which is what a PTY-spawning server wants.
- **SSE cannot compress and a WebSocket can.** Streaming routes are excluded from
  `jsonMaybeGzipped` **by name**, with the reasoning in the route's own docblock
  (`src/app/api/runs/[id]/stream/route.ts:41-51`): *"buffering a stream to compress
  it is the wrong shape"*. `GZIP_FLOOR_BYTES = 1400` (`src/lib/http.ts:48`) would
  decline per-keystroke frames anyway. `permessage-deflate` is the one thing a
  WebSocket offers here that nothing else does — and terminal output, unlike a run
  log, is exactly the high-frequency small-frame traffic it was designed for.

**The SSE-plus-POST alternative works today with no new ownership**: SSE
downstream on the existing pattern, `POST /api/terminal/input` upstream, one
round trip per keystroke burst. On a loopback install that is imperceptible. Over
a WAN it is not, and it is the shape that will read as "the terminal is laggy"
without anyone knowing why.

**Two things nobody here can settle by reading**, both in §9 with their commands:
whether an `upgrade` handler attached to the generated standalone server works at
all, and whether `node-pty` builds in this image.

**And one inherited gap.** `stream/route.ts:26-29` records that
`controller.enqueue` *"buffers rather than applying backpressure"*, which is why
it caps replay at 2,000 rows and 4 MB. A terminal has no such cap available: `yes`
produces unbounded output at line rate, and the buffer between an unread socket
and a running process is the server's heap. **Every option that streams process
output must state its output cap.** None of the existing code has one to copy.

## 6. The pane — the operator's word for it is the one thing that is refused

There is no room on the left menu, and this is not a style preference.

`src/components/shell/panes.ts:12-16`:

> The digit follows the row's position rather than the pane's age […] **Nine is
> the ceiling and Knowledge is the ninth — a tenth destination has no digit, and
> a row without one is a row two of the four readers cannot describe.**

`PANES` is nine flat entries (`panes.ts:27-38`), each with a required `shortcut`
that `AppShell.tsx:248` dispatches with `PANES.find(p => p.shortcut === e.key)` —
a single-character match — and that `Sidebar.tsx:176` announces as
`aria-keyshortcuts={\`Meta+${pane.shortcut}\`}`. A tenth row announces a chord
nothing can send. `docs/agent/ui-density-audit.md:159` puts *"A tenth pane"* on
the may-never-be-used list, `:166-167` says *"Ten is where it stops, and there it
stops for the reason it always gave"*, and `:160-161` gives the prescribed
alternative: **"New destinations are sub-routes under an existing pane."**

So the surface, if it is built, is `/settings/terminal` or `/account/terminal` or
a `SegmentedControl` view on an existing pane — never a tenth row. Every option
file below assumes that and none of them re-argues it.

**A correction the tree needs and that this proposal cannot make** (it is under
`docs/`, which run 2 may not edit): `docs/agent/conventions.md:50` still says the
list is *"closed at eight, because ⌘1…⌘8 has eight digits"* and forbids *"a ninth
pane"*, while `conventions.md:57` in the same file says *"The set covers the nine
panes"* and `panes.ts:15` says nine. `ui-density-audit.md:115` also still says
*"Eight."* The ban is right and the number is one behind in two places.

### Against the seven affordances

`conventions.md:50` closes grouping at seven — pane, sub-route, card, labelled
`ListGroup`, `Disclosure`, `SegmentedControl` tab strip, `Sheet` — and forbids
seven more, and states that *"a **region** is not an eighth affordance"*.

**A terminal is not a grouping affordance and does not want to be an eighth.** It
is a leaf control, and the vocabulary already contains its read-only half:
`ui/Log` with `size="pane"`, described in its own source as *"a terminal-shaped
region"* (`src/components/ui/Log.tsx:39-41`) — out of flow rather than `flex-1`
for a stated reason (`:43-54`: an in-flow box reports its *content* as intrinsic
height, and a log is thousands of lines), `tabIndex={0}`, `role="log"`,
`aria-live="off"`, monospace. **The transcript pane every option below needs is
already built and shipped.** What `Log` does not have is an input, and `/chat`'s
scroller-above-composer layout (`src/app/chat/page.tsx:721-731`, `:789-793`) is
the shipped pattern for that.

Three things a terminal adds that the vocabulary genuinely does not cover, and
each is a real cost rather than a formality:

1. **Focus and keystroke capture.** `AppShell.tsx:235-236` gates its one global
   listener on `isTextEntry(e.target) && !isCommitChord(e)` then
   `isPlainCommandChord(e)`, and the latter is `e.metaKey && !e.ctrlKey && …`
   (`shortcuts.ts:49-56`). **Ctrl-C, Ctrl-D, Tab and the arrows are never
   intercepted** — a terminal is safe on the keys it cares about. But ⌘1…⌘9 and
   ⌘K *are* `preventDefault`ed, and the `isTextEntry` bypass only covers
   `<input>`, `<textarea>`, `<select>` and `contentEditable`. xterm.js keeps a
   hidden textarea and is therefore covered; a bare focusable `<div>` is not, and
   ⌘1 typed into it navigates away mid-command.
2. **Colour.** `conventions.md:64`'s canvas rules apply to any canvas or WebGL
   renderer: a colour may never be read from a custom property, because every
   token is a `light-dark()` no `@property` registers and `getComputedStyle`
   returns source text a 2D context rejects **silently**. An emulator needs
   sixteen explicit ANSI colours plus foreground, background and cursor, each
   probed off a real element and **re-probed on a theme change**. That is the
   single largest piece of UI work in the PTY option and it is invisible until
   somebody switches theme.
3. **`QuickOpen`'s rule, which a terminal contradicts head-on.** `QuickOpen.tsx:73-77`:
   *"Navigation and nothing else. It cannot start a run, approve a proposal or stop
   anything, and that is a rule about what this component is allowed to be rather
   than a feature not yet written: **a keystroke away from spending money is the
   one thing the approval gates in this app exist to prevent.**"* A terminal is a
   keystroke away from everything. An option must say what stands in for the
   approval gate — a confirm on open, a per-session arm, an explicit uid choice —
   or admit it has removed one.

**And a terminal is a writer.** Read-only mode here is not a flag: it is
data-directory ownership, decided by `serverLock.ts` and re-asked at the moment of
every write (`ownsDataDir()`, `:370-372`; `mayWriteDataDir()`, `:429-431`;
`requireDataDir()`, `:441-444`), surfaced by `ReadOnlyNotice` on a **60-second**
poll of `/api/health`. A terminal must gate the spawn server-side on
`requireDataDir()`. Greying a button out is a minute late.

## 7. What a terminal should audit, and where it must not land

`request_log` holds *"the method, the URL's `pathname`, the response status, the
id […], how the caller authenticated, the first-hop source address, and how long
it took"* (`src/lib/requestLog.ts:15-17`) and **deliberately no body** (`:19-33`,
because *"`POST /api/login` carries the master token in its body"*). The cap is
`RETENTION_ROWS = 20_000` (`:68`) and eviction is unconditional on **every**
insert (`:118-121`).

`docs/agent/chat.md:22` already names that as a weapon: auditing `/api/mcp`'s
credential-free 401 *"made `request_log`'s 20,000-row cap a lever anyone who could
reach the path could pull — twenty thousand refusals and every line naming a run
that was started or a sign-in that failed is evicted."* The fix was to wrap only
the handler that already holds a subject, leave `DELETE`'s 405 unaudited, and send
the refusal to stdout, which nothing caps.

**A terminal is a much bigger lever, and it is one the authorised operator pulls
by working.** At three commands a second a terminal evicts the entire audit
history in under two hours. And the row it writes is worthless anyway: no body is
captured, so it reads `POST /api/terminal 200` with the command — the only fact
worth keeping — absent by design.

Three rules follow, and they are the same three for every option:

1. **A terminal's per-command record goes in its own table with its own cap**,
   not through `auditMutation`. `request_log` may carry the session's *open* and
   *close* and nothing per command.
2. **Whatever is recorded must not be the keystrokes.** A password typed at a
   prompt, `TF_TOKEN_app_terraform_io=…`, a `git remote add` with a PAT in the URL
   — a terminal that logs stdin logs all three, into SQLite, in `/data`, in every
   `scripts/backup-db.mjs` snapshot, in the `/backups` bind mount. Commands
   submitted, exit codes and byte counts are defensible; a raw stdin transcript is
   a credential store nobody asked for.
3. **A refusal answered before any credential is checked must not write a row** —
   the `/api/mcp` rule (`src/app/api/mcp/route.ts:635-652`), inherited verbatim.

## 8. Concurrency, ownership, and the operator killing the server they are typing into

**A terminal is invisible to the folder claim.** Occupancy is a synchronous
check-then-insert over SQLite rows, `createRun` runs entry-to-INSERT with no
`await`, and *"never key occupancy on `isRunning()`"*
(`docs/agent/concurrency-and-ownership.md:10`). Nothing watches the filesystem —
there is no `fs.watch`, no `chokidar`, no `inotify` anywhere in `src/`. The only
filesystem probe is `git status --porcelain` against **candidate `.uf-worktrees`
slots for a new run**, capped at `MAX_SLOT_PROBES_PER_ADMISSION` and memoised
negatives-only. It never looks at a folder a live run holds.

So a shell that `cd`s into a mount and runs `git checkout` while a run is working
there is undetected by every mechanism in this app. The run's agent sees a tree it
did not produce; `land.ts` merges whatever is there; and the landing path's
precondition — the operator's checkout clean and standing on the recorded target
branch (`docs/agent/isolation-and-landing.md`) — is broken by the easiest thing to
type. `docs/agent/concurrency-and-ownership.md:14`'s *"`unclaimed` is not a
refusal"* is precisely the door a terminal-launched process walks through.

**And the suicide case is not hypothetical — it happened, from an agent, and it
was counted** (`src/lib/orchestrator.ts:5147-5150`):

> Measured, not reasoned: a run issued `pkill -f "next-server|next dev"` to clean
> up a dev server it had started on 3100. tini lost its child,
> `restart: unless-stopped` brought the container back, and `reconcileOnBoot`
> marked **fourteen runs failed 690ms later — including the one that ran it.**

The defences added afterwards are `PROCESS_KILLERS = ["Bash(pkill:*)",
"Bash(killall:*)"]` (`orchestrator.ts:5181`) and `SELF_HOSTING_NOTICE` — a CLI
permission deny and a prompt notice, **both of which apply to `claude` children
only and neither of which a terminal passes through**. The one structural defence
is the uid check in `kill(2)`, and §3 already said what root does to it. There is
no `no-new-privileges` and no `cap_drop` in `docker-compose.yml`, so a root shell
holds Docker's default capability set and can re-enter the agent uid at will; the
drop is one-directional only for a process that started unprivileged.

Three more, briefly:

- **`docker compose` from inside is not available and that is good.** There is no
  `/var/run/docker.sock` mount anywhere in `docker-compose.yml`, and the file says
  why in a sentence worth keeping: *"nothing like mounting the Docker socket,
  which is root on the host wearing a unix socket"* (`:469-476`). The consequence
  for this feature is blunt: **the terminal cannot rebuild the container, so it
  can never make its own installs durable.** Every option's persistence answer
  comes from `00-`–`07-`, not from the pane.
- **`npm run dev` in a checkout of this repo** is the other documented incident —
  `next dev` runs `instrumentation.ts`, an inherited `DATA_DIR` pointed it at the
  live database and *"it closed out three runs whose agents were mid-cycle and
  went on working for another minute"* (`src/instrumentation.ts:86-89`). The
  server lock now makes the second process read-only, but only after it claims.
- **The cgroup is shared with the fleet.** `pids_limit: 2048`
  (`docker-compose.yml:546`) and `mem_limit: 10g` (`:531`) are container-wide. A
  fork bomb or a `cargo build -j` in the terminal takes down every run in flight,
  and nothing attributes it.

## 9. What could not be reached, and the exact commands

Docker is not installed in this container, so nothing below was observed. Every
option file's cost estimate depends on the first two.

1. **Whether the generated standalone server can carry an HTTP upgrade.** The
   decisive unknown for the PTY option: if a plain `server.on("upgrade", …)`
   attached from `instrumentation.ts` works, the WebSocket cost collapses from
   "own a custom server" to "twenty lines". Nobody here can settle it by reading —
   it depends on whether Next's generated entry exposes the `http.Server`.
   ```bash
   env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build
   node -e 'const s=require("http").createServer();console.log(typeof s.on)'   # sanity
   grep -n "createServer\|module.exports\|globalThis" .next/standalone/server.js | head -40
   #   what to look for: whether the http.Server instance is reachable from
   #   module scope or a global, or whether it is closed over and unreachable.
   ```
2. **Whether `node-pty` builds and traces into the standalone bundle.** Two
   separate questions — the addon compiling, and Next's tracer copying the `.node`
   into `.next/standalone/node_modules`.
   ```bash
   npm i node-pty --no-audit --no-fund          # compiles? bookworm, node 22, g++ present
   node -e 'const p=require("node-pty");const t=p.spawn("/bin/bash",["-l"],{});t.onData(d=>process.stdout.write(d));setTimeout(()=>t.kill(),500)'
   # then, with serverExternalPackages: ["better-sqlite3","node-pty"] in next.config.ts:
   env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build
   ls .next/standalone/node_modules/node-pty/build/Release/   # expect pty.node
   ```
3. **That an agent-uid shell is actually usable.** Cheap, and it decides whether
   §3's recommendation is livable at all.
   ```bash
   uid=$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)
   gid=$(docker compose exec -T usagefoundry printenv UF_AGENT_GID)
   docker compose exec -T usagefoundry setpriv --reuid="$uid" --regid="$gid" \
     --clear-groups bash -lc 'id; echo $PATH; touch /usr/local/bin/probe; \
       touch /home/node/pytools/bin/probe; apt-get install -y --dry-run jq'
   #   expected: /usr/local/bin refused, /home/node/pytools/bin written,
   #   apt-get refused. That triple is the whole argument in §3.
   ```
4. **What the standalone server does with a stream nobody reads.** The
   backpressure gap in §5, which no existing route can answer because all of them
   are capped.
   ```bash
   docker compose exec -T usagefoundry sh -c 'yes | head -c 500000000 > /dev/null'  # baseline
   #   then the same output through whichever transport an option picks, with the
   #   browser tab throttled to "offline", watching the server RSS.
   ```
5. **Nothing about a real terminal emulator.** No xterm.js was installed, no PTY
   was opened, no theme probe was written. The colour cost in §6 is reasoned from
   `conventions.md:64` and has not been paid by anyone here.

And one thing that is a gap in the tree rather than in this survey:
**`Dockerfile:10` is stale.** It says of `python3 make g++` that *"They stay in
this stage and never reach the runtime image"*, which `Dockerfile:127-132`
contradicts by installing all three in the runner — deliberately, with its own
justification at `:60-68`. It is a comment a future editor would reason from, and
it is the kind of correction `06-option-build-nothing.md` §2 exists to collect.
