# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# deps — install node modules, compiling better-sqlite3 if no prebuild matches
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# node-gyp needs these only when better-sqlite3 has no prebuilt binary for the
# platform. They stay in this stage and never reach the runtime image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# No --omit=dev: Tailwind's PostCSS plugin is a devDependency and has to be
# present when the builder stage runs `next build`.
#
# No --omit=optional either, ever. Tailwind's oxide engine ships as twelve
# platform-specific optional packages, and `npm ci` picks the one matching
# *this* container rather than the host that wrote the lockfile. Regenerating
# the lockfile without optional deps drops linux-*-gnu and the image build
# fails on a missing native module.
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# builder — compile the Next.js app
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# runner — the shipped image
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    HOME=/home/node \
    DATA_DIR=/data \
    WORKSPACE_ROOT=/workspace \
    CLAUDE_HOME=/home/node/.claude \
    CLAUDE_CONFIG_DIR=/home/node/.claude

# What the agent needs on PATH to do the work, not just to be started.
#
#   git, ripgrep      — what it reaches for constantly; git additionally backs
#                       isolation, the diff view and landing a branch.
#   ca-certificates   — outbound TLS to the Anthropic API.
#   tini              — reaps the claude children (see ENTRYPOINT).
#
#   python3, make, g++ — node-gyp's toolchain. Node ships with this image but a
#                       native addon does not: `npm ci` builds from source
#                       whenever no prebuild matches, and better-sqlite3 — which
#                       this app and both projects it was built against depend
#                       on — is exactly that case. Without these an isolated run
#                       fails on its first `npm install`, which is the command a
#                       fresh worktree needs before it can run anything at all.
#                       The `deps` stage above installs the same three for the
#                       same reason; this is that gap closed on the runtime side.
#   curl              — the universal "is the server I just started answering?"
#                       and the form every README writes a smoke test in.
#   procps            — `ps`/`pkill`. Debian slim omits it, so an agent that
#                       backgrounds a dev server cannot check whether it lives.
#   less              — git's pager. Absent, `git log` still works but prints a
#                       broken-pager warning the agent then reasons about.
#
#   sqlite3           — the recovery procedures in the docs are written in it,
#                       and they were unrunnable: `docker exec … sqlite3` was
#                       `command not found`, so the only documented way out of a
#                       stuck row failed at the first word. Roughly 2 MB. The
#                       backup and restore scripts below do not need it — they
#                       go through better-sqlite3, which is guaranteed present
#                       because the app depends on it — but somebody holding a
#                       backup file at 3am wants a shell they can inspect it in.
#
# This costs roughly 250 MB, nearly all of it g++. A compiler in the runtime
# image is a deliberate trade: the alternative is an agent that cannot install
# dependencies, and a run that fails at step one is worth less than the layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates tini \
      python3 make g++ curl procps less sqlite3 \
 && rm -rf /var/lib/apt/lists/*

# Two things git cannot work out for itself inside a container, both of which
# fail in ways that read as something else entirely. `--system` so a mounted
# ~/.gitconfig or a repo-local setting still wins.
#
#   identity — an isolated run is told to commit its work (isolationPreamble),
#   but a container hostname carries no domain, so git rejects its own
#   auto-detected `node@<id>.(none)` under the strict ident every commit uses.
#   The run then ends with an empty branch and a handoff card listing nothing.
#
#   safe.directory — a bind-mounted repository carries the *host* uid, which
#   need not be this container's. git then refuses the repo outright, and
#   `probeIsolation`'s first call cannot tell that apart from "not a repo", so
#   the operator is told their repository is not one and isolation goes quiet.
#   Ownership adds nothing here that `resolveInMount` does not already enforce.
RUN git config --system user.name "UsageFoundry Agent" \
 && git config --system user.email "agent@usagefoundry.local" \
 && git config --system --add safe.directory '*'

# The GitHub CLI, which is how an agent reads an issue, opens a pull request or
# checks CI. Without it `gh` is a command not found *inside a tool call*, which
# no part of the run loop reads: the cycle ends looking like the agent decided
# not to open the PR it was asked for.
#
# From the release tarball rather than an apt source: one layer, no extra
# repository left in the image, and a version that moves when this line moves.
# The checksum is verified against the release's own manifest — same TLS trust
# as fetching a keyring, but it fails loudly if the artefact is not the one the
# manifest describes, and this container holds credentials.
ARG GH_CLI_VERSION=2.97.0
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) gharch=amd64 ;; \
      arm64) gharch=arm64 ;; \
      *) echo "no gh release for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    base="https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}"; \
    curl -fsSL -O "${base}/gh_${GH_CLI_VERSION}_linux_${gharch}.tar.gz"; \
    curl -fsSL -O "${base}/gh_${GH_CLI_VERSION}_checksums.txt"; \
    sha256sum --ignore-missing --check "gh_${GH_CLI_VERSION}_checksums.txt"; \
    tar -xzf "gh_${GH_CLI_VERSION}_linux_${gharch}.tar.gz"; \
    install -m 0755 "gh_${GH_CLI_VERSION}_linux_${gharch}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh_*; \
    gh --version

# Go, for the same reason as the compiler and `gh`: an agent pointed at a Go
# repository otherwise discovers `go: command not found` inside a tool call, and
# the run loop reads that as the agent deciding not to build. Installing it by
# hand in a shell is not the fix it looks like — the writable layer survives a
# `docker restart` and is discarded by the `docker compose up --build` this
# project is deployed with, so the toolchain disappears on the next upgrade and
# takes a working agent with it.
#
# Same shape as the `gh` block above and for the same reasons: the release
# tarball rather than Debian's `golang` (which is versions behind and pulls a
# second gcc toolchain), one layer, and a checksum verified against Google's
# own published digest because this container holds credentials. The digest is
# fetched per version rather than pinned here so `--build-arg GO_VERSION=` is
# genuinely usable; `go.dev/dl/…` serves HTML for that path, `dl.google.com/go/`
# serves the bare hash.
ARG GO_VERSION=1.26.6
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) goarch=amd64 ;; \
      arm64) goarch=arm64 ;; \
      *) echo "no go release for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    tarball="go${GO_VERSION}.linux-${goarch}.tar.gz"; \
    curl -fsSL -O "https://dl.google.com/go/${tarball}"; \
    sha="$(curl -fsSL "https://dl.google.com/go/${tarball}.sha256")"; \
    echo "${sha}  ${tarball}" | sha256sum --check -; \
    tar -C /usr/local -xzf "${tarball}"; \
    rm "${tarball}"; \
    /usr/local/go/bin/go version

# Where Go keeps the two things it must not re-fetch on every run.
#
# Both default under `$HOME`, and `$HOME` here is the image's writable layer, so
# an agent's first `go build` in a fresh container downloads every module of
# every dependency again — minutes of a billed work cycle, repeated after each
# `up --build`. Compose mounts a named volume over this directory to keep them.
# `GOCACHE` is stated rather than left at `$HOME/.cache/go-build` so that one
# mount covers both.
#
# `GOTOOLCHAIN` is left at its default (`auto`) on purpose: a repository whose
# go.mod requires a newer Go than this image ships then fetches it itself, into
# the same persisted module cache, rather than failing the cycle on a version
# nobody here can predict.
ENV PATH="/usr/local/go/bin:${PATH}" \
    GOPATH=/home/node/go \
    GOCACHE=/home/node/go/build-cache

# The agent runs inside this container, so Claude Code has to be in the image.
#
# Pinned because the run loop parses this CLI's `stream-json` output and its
# OTLP records, and both were captured from a specific build rather than read
# from a specification. An unpinned rebuild would move that contract silently:
# an unparsed line degrades to a log entry and a missing `result` event
# understates spend, so the failure would not announce itself.
ARG CLAUDE_CLI_VERSION=2.1.226
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}" && npm cache clean --force

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# The backup and restore scripts. In the image rather than left in the
# repository because the database only exists inside the container, and the two
# moments they are wanted are a scheduled `docker compose exec` and a restore
# run through `docker compose run` against a volume the app is not holding.
# They resolve `better-sqlite3` out of the standalone bundle's own node_modules,
# which is the same build of the same addon the server uses.
COPY scripts/backup-db.mjs scripts/restore-db.mjs ./scripts/

# /data is the one path here whose permissions are the *image's* problem rather
# than the host's, because it is a named volume: Docker initialises a fresh
# volume from the directory sitting at its mount point and copies that
# directory's ownership and mode onto the volume root.
#
# It belongs to root and to nobody else. What is in it is the settings every
# guard reads, the budget and status on every run, the whole record of what
# happened, and the lock `serverLock.ts` uses to decide whether a second writer
# exists — so an agent that can write this directory sets
# `chatDefaultGuards.permissionMode` to `bypassPermissions`, or rewrites a
# budget, with no HTTP request and no token. That is every approval gate in this
# app bypassed at once, and the lock meant to catch a second writer edited by
# the thing it is guarding against.
#
# It was 0777 because the whole container ran as an arbitrary `${UF_UID}` and a
# fresh volume had to be writable by whatever that was. The server is root now
# (see the `USER` note below), so it needs no such grant, and the mode is what
# excludes the children — which are dropped to that same `${UF_UID}`. The
# alternatives still do not work: a chown to a build-arg uid makes the image
# uid-specific and stale the moment the uid changes. What *has* changed is that
# an entrypoint chown is possible at last, because the container is no longer
# started as an unprivileged user — which is `docker-entrypoint.sh`, and it is
# not optional: only a *fresh* volume takes the mode below, so every existing
# install would otherwise upgrade into the same open directory it had before.
#
# The other four are the bind mounts' mount points and still belong to `node`
# (uid 1000): the host's own ownership covers them the moment compose mounts
# over them, and 1000 is the default the children are dropped to.
#
# `/home/node/go` is the second named volume and carries the *opposite*
# requirement to /data's: the children are the only thing that writes it, so it
# ships owned by `node` — which is right exactly while `UF_AGENT_UID` is the
# 1000 assumed here. `docker-entrypoint.sh` corrects it when it is not, for the
# same reason it reclaims /data: the ownership a volume is created with is never
# revisited.
#
# `/home/node/.local/share/gh` is the third, on the same terms: it is where `gh`
# keeps the extensions `UF_GH_EXTENSIONS` names, the children are what run them,
# and the directory has to exist in the image so a fresh volume inherits `node`
# rather than root. `extensions/` is created with it because `gh extension list`
# is what the entrypoint asks before installing anything, and gh reports a
# missing directory the same way it reports an empty one.
RUN mkdir -p /data /workspace /workspace2 /workspace3 /workspace4 /home/node/.claude \
      /home/node/go/build-cache /home/node/.local/share/gh/extensions \
 && chown -R node:node /workspace /workspace2 /workspace3 /workspace4 /home/node /app \
 && chown root:root /data \
 && chmod 0700 /data

# The group a chat or orchestrator-block turn runs in, and no work cycle does.
#
# It carries the per-turn MCP capability file, which is 0710/0040 owned by this
# group — the whole of what keeps one of twenty-five concurrent agents from
# reading a live capability off a sibling's `/proc/<pid>/cmdline` and speaking to
# /api/mcp as the chat. `src/lib/privsep.ts` argues out why this is a gid and not
# a second uid: the chat child must stay the uid that owns the mounted
# `~/.claude`, because that credential is what it authenticates and bills with.
#
# 65533 rather than 1001, and the distance is the point: compose defaults
# `UF_CHAT_GID` to this, and the app *refuses to boot* when it equals the gid the
# agents run as, since the mode pair would then grant exactly what it refuses.
# A number just above the operator's own is one an operator plausibly has;
# 65533 is below `nogroup` and free on this base image.
#
# Only the numeric gid decides anything — the kernel never reads /etc/group for
# a permission check, and both `spawn` and `chown` here are given numbers. The
# entry exists so `ls -l` inside the container names it, and so this default has
# one place it is written down rather than two.
RUN groupadd -g 65533 ufchat

# No `USER node`. The server runs as root and drops every child it spawns to
# `UF_AGENT_UID`/`UF_AGENT_GID` — see `src/lib/privsep.ts`, which argues out why
# the split has to be this way round rather than the other. In one sentence: the
# child must be the uid that owns the bind mounts, because an isolated run is
# ordered to commit into the operator's own `.git`, and the server must be able
# to read `~/.claude/.credentials.json`, which the CLI keeps at 0600 owned by
# that same uid — so the two cannot both be it, and the privileged half is the
# one this app wrote rather than the unattended agents reading repository
# content nobody here reviewed.
#
# Nothing about the image assumes it: with `UF_AGENT_UID` unset the app runs
# exactly as it did before, one uid for everything, and says so in its boot log.
EXPOSE 3000

# Liveness. `restart: unless-stopped` in compose sees process *exits* and
# nothing else, so a server whose event loop is wedged, whose SQLite has become
# unwritable, or which has lost its data-directory lock runs indefinitely with
# Docker reporting it as fine. This is the only other signal Docker has.
#
# Pointed at /api/health rather than at `/`: with UF_AUTH_TOKEN set — which any
# server deployment requires — `/` is a 307 to /login, which `curl -f` treats as
# success, so the naive probe passes against a server that cannot open its
# database. /api/health performs a real read and takes SQLite's write lock, and
# answers 503 when that fails; the route's own comment says what it does and
# does not detect.
#
# The numbers, and why:
#
#   --timeout=10s      the wedged-event-loop case. Nothing in the body can
#                      report a loop that is blocked outright, because the
#                      handler never runs — the probe simply never answers, and
#                      this is what turns that silence into a failure. Ten
#                      seconds is comfortably above a healthy answer (a few ms;
#                      the route touches SQLite and nothing else) and well below
#                      the 20 s a single `gitSync` may legitimately hold the
#                      loop for.
#   --start-period=180s the first transcript scan re-aggregates the whole
#                      history synchronously and can take a while on a large
#                      one. Failures inside this window do not count towards
#                      `retries`.
#   --interval=30s     often enough that a monitor watching `docker inspect`
#                      learns within a minute or two; rare enough that the probe
#                      itself is not a load.
#   --retries=5        deliberately tolerant: 5 consecutive failures across
#                      30 s intervals is ~2.5 minutes of sustained trouble
#                      before the container is marked unhealthy. The bar is high
#                      because acting on this is destructive — a restart marks
#                      every in-flight run `failed` and leaves the cycle each one
#                      was mid-way through unreconciled, so at 25 concurrent runs
#                      a spurious unhealthy is far more expensive than a slow one.
#
# What this does NOT do is restart the container. Docker Engine surfaces health
# state (`docker inspect`, and `docker ps` shows "(unhealthy)") but does not act
# on it — only Swarm and other orchestrators do. Wiring it to a restart is the
# operator's choice: an orchestrator's own policy, or a supervisor watching
# `docker inspect --format '{{.State.Health.Status}}'`. Given how expensive a
# restart is here, making that the operator's decision is the right default.
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1

COPY docker-entrypoint.sh /usr/local/bin/uf-entrypoint
RUN chmod 0755 /usr/local/bin/uf-entrypoint

# tini reaps the claude child processes the orchestrator spawns; without an
# init, killed agent processes linger as zombies for the container's lifetime.
# It stays PID 1 — the entrypoint below `exec`s the server, so there is no extra
# shell left in the process tree and signals reach node unchanged.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/uf-entrypoint"]
CMD ["node", "server.js"]
