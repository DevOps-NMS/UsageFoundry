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

# The agent runs inside this container, so Claude Code has to be in the image.
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

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
