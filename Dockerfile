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

# git and ripgrep are what the agent actually reaches for; ca-certificates is
# needed for outbound TLS to the Anthropic API.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates tini \
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

RUN mkdir -p /data /workspace /workspace2 /workspace3 /workspace4 /home/node/.claude \
 && chown -R node:node /data /workspace /workspace2 /workspace3 /workspace4 /home/node /app

USER node
EXPOSE 3000

# tini reaps the claude child processes the orchestrator spawns; without an
# init, killed agent processes linger as zombies for the container's lifetime.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
