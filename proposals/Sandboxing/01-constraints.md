# The constraints an option has to survive

Not preferences. Each is a property of the running system that an option either
preserves or breaks, and most of them break *silently* — this repository's standing
complaint about every defect it has recorded (`CLAUDE.md`, "Before you edit").

## The five crossings

**The credential.** A work cycle bills against the account's OAuth token in the
mounted `~/.claude`, read as the uid that owns it. `docs/security.md:64` bounds
every option here: *any* arrangement in which a run can work is one in which it can
read that token, and the only real fix is a credential scoped to a run, which the
subscription product does not have. So no option below contains the thing most
worth stealing. They differ in whether the run's *shell* can reach it as well as
the CLI process, and in whether a concurrent run can.

**Metering.** `src/lib/transcripts.ts` scans `PROJECTS_DIR` (`src/lib/config.ts:62`
= `$CLAUDE_HOME/projects`) for the `*.jsonl` the children write, and that scan is
the sole input to the windows and to every budget guard but one
(`src/lib/otlp.ts:5`–`17`). A sandboxed child writing its transcript where the
server cannot read produces a dashboard of zeros and guards that never fire, and
nothing throws. The loop calls `currentSnapshot()` before every cycle
(`docs/agent/architecture.md:104`), so the failure is a guard comparing against
nothing.

**Telemetry.** `telemetryEnv()` (`src/lib/orchestrator.ts:4613`) points the child's
exporter at `OTLP_SELF_URL`, default `http://127.0.0.1:${PORT}/api/otlp`
(`src/lib/config.ts:108`), authenticated by a per-run capability;
`src/middleware.ts:81` exempts that path from the shared-secret gate precisely
because the route checks the capability itself. Under live enforcement this is the
guard's input, not enrichment (`needsLiveSpendTelemetry`,
`src/lib/orchestrator.ts:4573`). Network isolation must leave that hop open, and
any option moving the child out of the server's network namespace turns a loopback
endpoint into a network-reachable one — likewise `MCP_SELF_URL`
(`src/lib/config.ts:127`, exempted at `src/middleware.ts:66`), a *tool surface*.

**The work.** An isolated run gets a worktree at
`<mountRoot>/.uf-worktrees/<repo>-<slot>` (`src/lib/orchestrator.ts:1736`), seeded
with gitignored config the server wrote and handed over by `chownForChild`, which
throws rather than warns (`src/lib/privsep.ts:173`, `src/lib/orchestrator.ts:2376`),
and it is ordered to commit into the operator's own `.git`. A worktree is **not
self-contained**:

    $ cat /workspace/.uf-worktrees/usagefoundry-721638d11c0b-1/.git
    gitdir: /workspace/UsageFoundry/.git/worktrees/usagefoundry-721638d11c0b-1

So any option giving a run a private filesystem view must expose the whole
repository's `.git`, not just the slot — most of what it was trying to hide.
Landing then needs the operator's checkout clean and on the recorded target branch
(`docs/agent/isolation-and-landing.md`), and nothing on that path has a clock on it.

**The toolchain and the arithmetic.** The image carries `gh`, Go with a persisted
cache, `python3 make g++`, `curl`, `procps`, `less` and `sqlite3` on purpose
(`Dockerfile:88`–`195`), and the pinned CLI's binary is 294,566,840 bytes on disk.
`mem_limit`, `pids_limit` and `cpus` are sized as `maxConcurrentRuns × per-cycle
budget` (`docker-compose.yml:233`–`297`); the default is `maxConcurrentRuns: 4`
(`src/lib/settings.ts:577`) and README's worked example at 25 runs is
`UF_MEM_LIMIT=44g`, `UF_PIDS_LIMIT=8192` (`README.md:744`). A per-run process
boundary multiplies whatever it adds by 25.

## Six more, less obvious and just as binding

**One process may write, and its atomicity is the event loop.** `createRun` runs
from entry to INSERT with no `await` (`docs/agent/concurrency-and-ownership.md:10`),
the only reason two agents do not land in one directory; `serverLock.ts` enforces
one writer per `DATA_DIR`. That is why the MCP tools run *in* the server process
(`src/lib/config.ts:120`), and why an option adding a second process that admits,
promotes or mutates runs is out on this ground alone.

**Four kinds of child, and a fifth is a decision**
(`docs/agent/architecture.md:102`). A supervisor or exec-helper is a fifth in
everything but name and should be argued as one.

**The child must be the mount owner** (`src/lib/privsep.ts:26`–`33`), because it is
ordered to commit into the operator's `.git` while the server must read
`.credentials.json` at 0600. An option giving each run a *different* uid has to say
what the operator's `git gc` does to objects owned by uid 10007.

**On this install, uid ownership under the workspace is presented, not enforced.**
The `fakeowner` mount in `00-problem.md` is Docker Desktop's macOS remapping;
whether a per-run uid is a real boundary there is **assumed unverified**, a
Linux-host question this container cannot answer for itself.

**Nothing may fail quietly.** `describeSeparation()` (`src/lib/privsep.ts:180`)
exists because privilege separation disappears with the page looking identical, and
an environment naming an agent uid the process cannot switch to *throws*. A sandbox
is the same shape and needs the same treatment.

**`docker compose up --build` is the deployment.** An option whose operational
story starts with "install a container runtime" has moved `docs/install.md`.

## The criteria that fall out

Isolation on five axes (filesystem, network, process, kernel, *between two runs*),
fit with the architecture above, loudness of failure, build cost, run cost, and
effect on the host's own posture — scored in `07-comparison.md` with the weights
stated before the scoring.
