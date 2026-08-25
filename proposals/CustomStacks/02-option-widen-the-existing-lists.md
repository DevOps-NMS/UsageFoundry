# Option A — a third `UF_*` list, in the shape of the two that already work

Add `UF_BIN_TOOLS`: a declarative, boot-time loop that downloads pinned release
binaries into a fourth named volume, exactly as `UF_GH_EXTENSIONS` and
`UF_PY_TOOLS` do for their two package managers.

## 1. The strongest case

The operator's problem is already solved twice in this repository, and the
solution is better than the one they asked for. `UF_PY_TOOLS=ruff==0.6.9` puts
`ruff` on every agent's `PATH`, surviving `up --build`, reinstalled on a fresh
host from a line the operator keeps in a file they already back up. A terminal
gives them none of that: a command typed into a shell is not reproducible, not
reviewable, not versioned, and is gone the moment the volume is. The only reason
Terraform is not covered is that Terraform is not a Python distribution — a gap
of one package manager, not a gap in the design. Close it with a third loop that
takes `terraform@1.9.8`, resolves it against a release URL, verifies a checksum
and `install -m 0755`s it into a volume, and the request is answered with a
mechanism the codebase already argues for at length, already tests
(`src/lib/deployment.test.ts:664`, `:733`), and already documents in 110 lines of
`.env.example`. No new surface, no new endpoint, no new security model.

## 2. Shape

- **A fourth named volume**, `usagefoundry-bintools`, mounted at
  `/home/node/bintools`, declared at `docker-compose.yml:572-576` and mounted
  beside the other three at `:409`.
- **`ENV PATH="/home/node/bintools/bin:${PATH}"`** in the Dockerfile, beside
  `:281`. Directories `bin/`, and `state/` for §5, created in the image's
  `mkdir -p` at `Dockerfile:514-516` so a fresh volume inherits `node`
  ownership rather than root — which is the rule that block is written for
  (`Dockerfile:508-513`).
- **`UF_BIN_TOOLS`** in `.env.example`, in `docker-compose.yml`'s `environment:`
  block, and read by a new loop in `docker-entrypoint.sh` beside the two at
  `:169` and `:241`. Four files in one commit, per `01-constraints.md` §10.
- **The loop itself**, modelled on `Dockerfile:162-177`: for each `name@version`,
  resolve a URL from a small built-in table of known tools, `curl -fsSL`,
  `sha256sum --check`, `install -m 0755` into `bin/`, under
  `setpriv --reuid --regid --clear-groups` as `gh_as_agent` does
  (`docker-entrypoint.sh:145-153`). Skip an entry already present, best-effort,
  never fatal — all three rules copied from the loops above it.
- **`src/lib/deployment.test.ts`** gains a `describe` in the shape of `:733`.
- **No `src/` change at all**, which is the option's distinguishing property.

The URL table is the design decision. Two honest sub-shapes: a **closed table**
of a dozen known tools (safe, and every unlisted tool is a feature request), or
**`UF_BIN_TOOLS=name|url|sha256`** (open, and the operator owns the checksum).
Neither inherits a precedent. Every existing pinned download in the Dockerfile
verifies against the publisher's own published digest, fetched at build time
rather than pinned here (`Dockerfile:172-173`, `:204-205`, `:259-260`). So a
closed table would be the first place this repository chose a digest itself, and
that is a cost of the closed sub-shape rather than an argument for it.

## 3. What persists it, and what discards it

| Event | Outcome |
|---|---|
| `docker restart` | survives; the loop re-runs and skips every installed entry |
| `up --build` | **survives** — the volume is not the writable layer |
| `down -v` | volume destroyed; **the next boot reinstalls the whole list** |
| fresh host | reinstalled from `.env`, provided the release URLs still resolve |

`scripts/backup-db.mjs` does not cover it and does not need to: the durable
artefact is the `.env` line, which lives in the operator's own checkout. This is
the property that makes the option strong and the reason `01-constraints.md` §6
does not bite here.

**Not verified.** No rebuild was performed. The claim rests on
`docker-compose.yml:370-382` and the same reasoning as the three existing
volumes.

## 4. Reach

`PATH` reaches all five kinds of child, because all five inherit the server's
`PATH` untouched — `childEnv` (`orchestrator.ts:6306-6321`), `chatEnv`
(`chat.ts:2251`), `reviewEnv` (`review.ts:760`), `authEnv` (`claudeAuth.ts:258`),
`gitEnv` (`git.ts:51`, pinned by `git.test.ts:93`). A new `ENV PATH=` prepend in
the Dockerfile is inherited by the entrypoint, `exec`'d to the server
(`docker-entrypoint.sh:972`), and copied into every child.

Ownership: installed as `UF_AGENT_UID`, so the agents can upgrade and remove
what they run — `docker-entrypoint.sh:140-144`'s rule.

**And that is where the reach stops.** Child 1 (work cycle, `acceptEdits`) and
child 3 (conflict resolver, `acceptEdits`) may not be able to *invoke* it —
`00-problem.md` §"Missing 3". Children 4 and 5 at `bypassPermissions`
(`chat.ts:1652-1653`) can. Child 2 at `plan` (`review.ts:238`) is meant not to.
**This option does nothing about that**, which is `07-`'s subject and is the
strongest argument for pairing them.

## 5. Tool state, not the binary

Handled, and this is where the option earns its keep over a terminal. The same
loop that installs the binary exports the tool's state variables in the image, as
`Dockerfile:282-285` already does for uv:

```
ENV TF_PLUGIN_CACHE_DIR=/home/node/bintools/state/terraform/plugin-cache \
    TF_CLI_CONFIG_FILE=/home/node/bintools/state/terraform/terraformrc
```

Those are not `UF_`-prefixed, so `childEnv` passes them through
(`01-constraints.md` §3) — which is exactly why `GOPATH`/`GOCACHE`
(`Dockerfile:224-225`) reach an agent today and `UF_*` would not. A terminal
cannot do this: an operator typing `export TF_PLUGIN_CACHE_DIR=…` in a shell
sets it for that shell and no child.

The cost is that each supported tool needs its own two-or-three-line relocation,
which is real work per tool and is the honest limit of the closed-table shape.
`$HOME/.npm` is the standing example of what happens when nobody does it
(`00-problem.md` §"Missing 2").

## 6. What it does to the boundaries

- **`/data` 0700** — untouched; the volume is under `/home/node`.
- **root / `UF_AGENT_UID`** — the installed files are agent-owned by design, on
  the loops' own rule. That means an agent can rewrite them, which is fine for a
  tool an agent invokes and **not** fine for anything the *server* runs. A new
  agent-writable directory on the server's `PATH` widens exactly the hazard
  `contextPruning.ts:76-83` documents and works around. Mitigation is the same:
  nothing in `src/` may resolve a command from this directory by name.
- **`UF_CHAT_GID`** — no interaction; the chat child differs by gid, not by
  `PATH`.
- **CLI sandbox** — under `UF_SANDBOX=1`, the tool *runs* (a write config binds
  `/` read-only, which still permits exec) but **cannot write its state**:
  neither `/home/node/bintools` nor the relocated cache is in `writeSet`
  (`orchestrator.ts:6043-6068`, `5996-5999`). Fixing that means a third entry in
  `BUILD_CACHE_DIRS` — a two-line `src/` change this option would otherwise not
  need.
- **Read guard** — no interaction (`Read` tool only, `readGuard.ts:225`).
- **Worktree isolation** — no interaction; it changes cwd only.

## 7. The operator's surface

An `.env` edit and `docker compose restart`. Read-back is the boot log, same as
today (`docker-entrypoint.sh:297`, `:306-307`). Changing a pin means editing the
line and removing the old binary by hand, because both existing loops skip an
already-installed entry deliberately — *"a restart is not a good moment to
silently swap out an executable that holds a token"* (`.env.example:204-207`,
repeated at `:288-290`). A third loop inherits that and the same two-command
recipe.

**This is worse than the operator asked for, and the file should say so.**
They asked for a button. This is a text file and a restart.

## 8. How it fails, and whether loudly

- **Install failure is a log line and nothing else** — `[usagefoundry] could not
  install …` on stderr, best-effort and never fatal
  (`docker-entrypoint.sh:305-308`, and the rule at `:165-168`). Nothing in the UI
  shows it. That is the same silence as the two existing loops, and the same
  silence that let 213 sessions run against an absent command
  (`.env.example:222-226`).
- **A typo in a variable name is total silence** — compose has no `env_file`, so
  a name `docker-compose.yml` does not forward never reaches the container
  (`docs/agent/environment.md:27`). `deployment.test.ts:961` is what catches it.
- **A tool installed but not invokable** under `acceptEdits` fails inside a tool
  call the run loop does not read (§4). The run finishes `completed`.
- **Loud, at least:** a checksum mismatch, a 404 on a release URL, and a
  non-numeric `UF_AGENT_UID` (`privsep.ts:105`, pinned by `privsep.test.ts:68`).

## 9. What it costs to build

Four files, no `src/` change unless `UF_SANDBOX` support is wanted (then five,
for `BUILD_CACHE_DIRS`). `deployment.test.ts` grows one `describe`, copied from
`:733`. No `docs/agent/` invariant moves. `.env.example` grows ~40 lines, which
is this repository's normal rate for a variable of this weight.

**Two to three days**, most of it the URL table and its checksums. Per additional
supported tool afterwards: an hour, plus §5's relocation.

## 10. What would have to be true

**Promotes it:** that a work cycle can invoke an arbitrary binary under
`acceptEdits`. Then this option alone closes the whole request and nothing in
`07-` is needed. One work cycle settles it.

**Kills it:** that operators actually want *arbitrary* tools rather than a dozen
known ones. A closed table is a feature request queue with a rebuild in it, and
if the real demand is "whatever I happen to need this week", this option is
answering a different question — and `03-` or `04-` is the answer.
