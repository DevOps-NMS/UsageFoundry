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
# This costs roughly 250 MB, nearly all of it g++. A compiler in the runtime
# image is a deliberate trade: the alternative is an agent that cannot install
# dependencies, and a run that fails at step one is worth less than the layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates tini \
      python3 make g++ curl procps less \
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

# /data is the one path here whose permissions are the *image's* problem rather
# than the host's, because it is a named volume. Docker initialises a fresh
# volume from the directory sitting at its mount point and copies that
# directory's ownership and mode onto the volume root — so the chown below,
# plus the default 0755, hands the volume to uid 1000 and to nobody else.
# Compose then runs the container as `${UF_UID}`, which Linux operators are told
# to set to their own uid, and the first thing the app does is create
# /data/usagefoundry.db. That is EACCES on every data route, for an operator who
# has just followed the instruction meant to prevent permission problems.
#
# 0777 on this one directory is the fix that needs nothing from the operator.
# The two alternatives do not work here: a chown to a build-arg uid makes the
# image uid-specific (and stale the moment the uid changes), and an entrypoint
# chown has no root process to run as, because compose's `user:` applies before
# the entrypoint. The bind mounts need none of this — they carry the host's
# ownership, which is the uid `UF_UID` names.
#
# Only a *fresh* volume takes this mode; one created under the old arrangement
# keeps uid 1000's files, and README's "On Linux, set UF_UID and UF_GID" states
# the one-off chown for that case.
RUN mkdir -p /data /workspace /workspace2 /workspace3 /workspace4 /home/node/.claude \
 && chown -R node:node /data /workspace /workspace2 /workspace3 /workspace4 /home/node /app \
 && chmod 0777 /data

USER node
EXPOSE 3000

# tini reaps the claude child processes the orchestrator spawns; without an
# init, killed agent processes linger as zombies for the container's lifetime.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
