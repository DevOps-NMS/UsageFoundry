# Option D — the image *is* the stack: build args and a layer

The operator's tools go into the container image, through a documented
`docker-compose.override.yml` plus a `Dockerfile.stack` that `FROM`s the shipped
image and adds their `RUN` lines. `docker compose up --build` does not merely
*preserve* the stack — it is what *installs* it.

## 1. The strongest case

Every other option in this directory fights the container model; this one uses
it. "Survive a rebuild" is a strange requirement to engineer around when the
rebuild is the mechanism that puts things in a container in the first place. A
tool in an image layer is reproducible, versioned in a file the operator commits,
identical on every host, immune to `down -v`, immune to volume masking, backed up
by whatever backs up their git repository, and — uniquely among the options here
— **root-owned and agent-unwritable**, which is the ownership every security-
sensitive binary in this image already has (`Dockerfile:311-314`,
`/opt/playwright/browsers` at `:413-414`). It needs no volume, no manifest, no
route, no reconcile, no new failure mode and, in its minimal form, **no code
change at all** — only documentation, because Docker already supports it and this
repository already tells operators to reach for an override file for exactly this
class of problem (`.env.example:263-273`).

## 2. Shape

Minimal form — documentation only:

```dockerfile
# Dockerfile.stack, in the operator's checkout
FROM usagefoundry:latest
RUN set -eux; \
    curl -fsSLo /tmp/tf.zip https://releases.hashicorp.com/terraform/1.9.8/terraform_1.9.8_linux_amd64.zip; \
    echo "<sha256>  /tmp/tf.zip" | sha256sum --check; \
    unzip -d /usr/local/bin /tmp/tf.zip; rm /tmp/tf.zip; \
    terraform version
ENV TF_PLUGIN_CACHE_DIR=/home/node/go/../tf-cache
```

```yaml
# docker-compose.override.yml
services:
  usagefoundry:
    build:
      dockerfile: Dockerfile.stack
```

Supported form — one `ARG` in the shipped Dockerfile, in the shape of the six
that already exist (`GH_CLI_VERSION` at `:162`, `GO_VERSION` at `:194`,
`UV_VERSION` at `:249`, `WINNOW_REPO`/`WINNOW_REF` at `:315-316`,
`CLAUDE_CLI_VERSION`): a `UF_STACK_SCRIPT` build arg naming a shell script in the
build context, run after the toolchains and before the app. Plus a
`.dockerignore` entry, plus a documented example.

Either form needs one thing the repository does not currently ship: the image is
built from source by `docker compose up --build` rather than pulled, so
`FROM usagefoundry:latest` requires the operator to have tagged a build. The
supported form avoids that by keeping one Dockerfile.

## 3. What persists it, and what discards it

| Event | Outcome |
|---|---|
| `docker restart` | survives — it is a layer |
| `up --build` | **survives, and is reinstalled by the same command** |
| `down -v` | **entirely unaffected** — no volume is involved |
| fresh host | **rebuilt from the operator's own files** |

**The only option in the directory that survives all four**, and it does so
without a backup mechanism, because the durable artefact is a text file in the
operator's checkout. `scripts/backup-db.mjs` does not need to cover it for the
same reason it deliberately does not cover the agents' git branches
(`docs/backup-and-restore.md:129-137`).

It also sidesteps the volume-masking trap in `01-constraints.md` §2 completely,
because there is no volume to mask — the trap that forced `/opt/winnow`
(`Dockerfile:303-309`) and the Playwright browsers (`docs/agent/environment.md:33`)
out of volumes in the first place. **This option is the same decision those two
already took, generalised.**

**Not verified.** No image was built. Docker is unavailable in this container.
The claim is the documented behaviour of image layers and this repository's own
statements of it.

## 4. Reach

Best in the directory, and for a reason none of the others can copy.

`PATH` reaches all five children as everywhere else. But because the binary lands
in `/usr/local/bin` — root-owned 0755, like `gh` (`Dockerfile:175`), `uv`
(`:262`) and everything apt installed (`:127-132`) — it is in the same position
as every other tool the agents already use. Executable by every agent uid,
writable by none. That is the ownership `Dockerfile:311-314` argues for by name:

> Root-owned and 0755: every agent uid reads it, none writes it. A tool the run
> loop shells out to on every cycle boundary, sitting in a directory a sibling
> agent could rewrite, would be a way for one run to put its own code on every
> other run's transcript.

So this option adds **no** new agent-writable directory to the server's `PATH`,
which is the hazard Options B and C carry (`contextPruning.ts:76-83`).

`acceptEdits` still gates invocation, exactly as in every other option here. §4
of every file in this directory ends at the same wall.

## 5. Tool state, not the binary

Handled the same way the image already handles it for four other tools:
`ENV` in the Dockerfile, pointing the tool's state at a durable path
(`Dockerfile:224-225` for Go, `:282-285` for uv, `:440` for Playwright,
`contextPruning.ts:86` for winnow). `ENV` set in a `FROM`-derived image is
inherited by the entrypoint and thence by every child, because `childEnv` strips
only six classes and none of them is a tool variable (`01-constraints.md` §3).

The state directory itself still has to be somewhere persistent-and-writable,
which is a volume — so this option does not *eliminate* the volume question, it
separates it: the **binary** is a layer, the **cache** is a volume, and only the
cache needs the volume-masking care. That separation is correct and is the shape
the repository already uses for Go: `/usr/local/go` is a layer
(`Dockerfile:206`), `/home/node/go` is a volume (`docker-compose.yml:383`).

## 6. What it does to the boundaries

The least movement of any option that adds a capability.

- **root / `UF_AGENT_UID`** — the binary is root-owned and agent-unwritable,
  which is the *stronger* side of the split (§4). The two boot loops chose the
  other side deliberately, so the agents can upgrade what they run
  (`docker-entrypoint.sh:140-144`) — here upgrading is a rebuild, which is the
  operator's job and not the agent's. That is a defensible difference and the
  file should not pretend the two rules agree.
- **`/data` 0700**, **`UF_CHAT_GID`**, **read guard**, **worktree isolation** —
  no interaction.
- **CLI sandbox** — the binary runs (`/` bound read-only still permits exec); its
  cache still needs a `BUILD_CACHE_DIRS` entry
  (`orchestrator.ts:5996-5999`) if `UF_SANDBOX` is ever switched on. Identical to
  every other option.
- **One new boundary the others do not touch:** an operator's `RUN` line executes
  at build time as root with network access, and nothing in this repository
  reviews it. That is true of any Dockerfile and is the operator's own machine,
  so it is a note rather than an objection — but it is the reason this must never
  become a UI that writes Dockerfile lines from model output.

## 7. The operator's surface

Two files in their own checkout and the command they already run. No page, no
button, no read-back inside the app — `docker compose exec usagefoundry
terraform version` is the check, which is the same shape as the two commands
`.env.example:209-210` and `:293-294` already prescribe for the existing loops.

**This is the furthest of any option from what was asked for.** The operator asked
for a point on the left menu and this is a Dockerfile. It should be scored as
what it is: the best engineering answer and the worst answer to the actual
request.

Two real costs, and neither is small:

- **Build time.** `docker compose up --build` already carries ~250 MB of
  compiler (`Dockerfile:124-126`), a Go toolchain, a Chromium, and a pinned CLI.
  Adding to it lengthens every upgrade, and layer caching only helps while the
  operator's `RUN` sits above nothing that changes.
- **Upgrade friction.** A `FROM usagefoundry:latest` derived image has to be
  rebuilt on every upstream release, and an operator who forgets is running an
  old app with a current stack and no warning.

## 8. How it fails, and whether loudly

**The loudest of the five, and this is the option's second real strength.** A
`RUN` that fails fails the build. That is precisely the argument the repository
already makes for putting winnow in the image rather than behind `UF_PY_TOOLS`:

> `UF_PY_TOOLS` installs best-effort at boot and says so in a log line nobody
> reads; a `RUN` that fails fails the build, which is the right direction for
> something the run loop now depends on.
> — `Dockerfile:293-295`

What still fails quietly:

- **The forgotten rebuild** — an operator on an old base image, indefinitely.
- **`__NEXT_PRIVATE_STANDALONE_CONFIG`** — a shell inheriting it from a
  UsageFoundry container makes `next build` die with
  `TypeError: generate is not a function` (`CLAUDE.md`, Commands). An operator
  rebuilding *from inside an agent session* — which is exactly how someone would
  try this — hits it, and the error names nothing relevant.
- **`NODE_ENV=production` and a bare `npm ci`** — the same section's other trap.
- **`acceptEdits`** — as everywhere.

## 9. What it costs to build

**Minimal form: documentation only.** One page under `docs/`, or a section in an
existing one. **Half a day**, zero risk, no test, no invariant moved.

**Supported form:** one `ARG`, one `RUN` guard, a `.dockerignore` line, and one
`deployment.test.ts` assertion in the shape of `:913`'s pin test. **One to two
days.**

Nothing in `src/` moves in either form. That is unique here.

## 10. What would have to be true

**Promotes it:** that operators building this app from source already are
comfortable with a Dockerfile. They run `docker compose up --build` as the
documented deployment path (`CLAUDE.md`, Commands), so the tool is in their hands
already; the question is only whether they will accept it as *the* answer rather
than a workaround.

**Kills it:** the request being genuinely about *interactivity* — "I want to try
something and see if it works, without a five-minute rebuild". If that is what
"deploy from the web interface" means, this option answers a question nobody
asked, and the right move is to ship it as documentation *alongside* whichever
option the recommendation picks, rather than instead of one.
