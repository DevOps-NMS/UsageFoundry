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
#   jq                — what an agent reaches for the moment a command answers in
#                       JSON, and the container had none: `gh … --json`, this
#                       app's own API and the CLI's JSONL transcripts are all
#                       read that way from memory. Absent, the failure is
#                       `jq: command not found` *inside a tool call*, which no
#                       part of the run loop reads — the cycle ends looking like
#                       the agent chose not to answer the question it was asked.
#                       It belongs in the image rather than in an agent's first
#                       Bash call for the reason the Go block below gives: apt is
#                       root's and the agents are UF_AGENT_UID, and a package
#                       installed into the writable layer is discarded by the
#                       next `up --build`. It is reachable under UF_SANDBOX for
#                       the same reason `git` is — bubblewrap binds the root
#                       filesystem read-only and the managed policy's `denyRead`
#                       names only DATA_DIR and /backups, so nothing on
#                       /usr/bin is confined away. Roughly 1 MB with libjq1 and
#                       libonig5. Debian pins 1.6, so 1.7's additions (`pick`,
#                       `abs`, `toarray`) come back as `is not defined` rather
#                       than as a feature that silently does nothing.
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
#   bubblewrap, socat — the two apt halves of the CLI's own Linux sandbox, which
#                       `docker-entrypoint.sh` can be asked to switch on with
#                       UF_SANDBOX and which is off in every stock install. The
#                       CLI's dependency check treats a missing `bwrap` and a
#                       missing `socat` as *errors* rather than warnings (the
#                       binary's own words: `bubblewrap (bwrap): not installed`,
#                       `socat: not installed`), so an install that turned the
#                       switch on without these would meet the failure this
#                       image exists to avoid — one arriving inside a tool call.
#                       bwrap builds the namespace; socat bridges the egress
#                       proxy's unix sockets to the TCP ports a sandboxed
#                       command dials. Roughly 1 MB together. `bwrap` cannot
#                       start at all until the operator also supplies the
#                       seccomp profile docker-compose.yml carries commented
#                       out — `unshare` is EPERM under Docker's default
#                       profile, measured in this container. `socat` is an
#                       ordinary tool and is on the agents' PATH from now on,
#                       which beside curl, python3, g++ and a Go toolchain is
#                       a rounding error rather than a new reach.
#
# This costs roughly 250 MB, nearly all of it g++. A compiler in the runtime
# image is a deliberate trade: the alternative is an agent that cannot install
# dependencies, and a run that fails at step one is worth less than the layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates tini \
      python3 make g++ curl jq procps less sqlite3 \
      bubblewrap socat \
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

# `uv`, which is to Python what `gh extension install` is to gh: the installer
# behind UF_PY_TOOLS, and the reason a plugin whose hooks shell out to a Python
# command can work here at all.
#
# The image ships python3 for node-gyp and nothing to install a package with —
# no pip, no ensurepip (Debian splits `python3-venv` out), and
# /usr/lib/python3.11/EXTERNALLY-MANAGED refusing a system-wide install even if
# there were. A plugin registered through `--plugin-dir` whose hook runs
# `cozempic …` therefore meets `command not found` inside a hook the CLI
# discards the stderr of, which is the quietest failure this image has: the hook
# exits 0, the session is told the plugin is active, and nothing whatever ran.
#
# `uv` over apt's `python3-venv` + `python3-pip` for two reasons that are not
# taste. It gives each tool its own environment, so two Python-backed plugins
# are not each other's dependency-resolution problem; and its bin directory
# holds launchers rather than an interpreter, where putting a shared venv's
# `bin` on PATH would shadow `python3` for every agent in the fleet — a
# fleet-wide change to what `python3` means, to install one plugin's dependency.
#
# Same shape as the `gh` and Go blocks above: the release tarball, one layer,
# and the checksum verified against Astral's own published digest because this
# container holds credentials.
ARG UV_VERSION=0.12.5
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) uvarch=x86_64-unknown-linux-gnu ;; \
      arm64) uvarch=aarch64-unknown-linux-gnu ;; \
      *) echo "no uv release for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    base="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}"; \
    curl -fsSL -O "${base}/uv-${uvarch}.tar.gz"; \
    curl -fsSL -O "${base}/uv-${uvarch}.tar.gz.sha256"; \
    sha256sum --check "uv-${uvarch}.tar.gz.sha256"; \
    tar -xzf "uv-${uvarch}.tar.gz"; \
    install -m 0755 "uv-${uvarch}/uv" /usr/local/bin/uv; \
    install -m 0755 "uv-${uvarch}/uvx" /usr/local/bin/uvx; \
    rm -rf /tmp/uv-*; \
    uv --version

# Where the tools UF_PY_TOOLS names live, and the one part of this that is not
# the image's.
#
# All three under one root so a single named volume covers them, which is the
# argument GOPATH/GOCACHE above are stated for. `bin` is on PATH because that is
# what a plugin's hook resolves the command through — `childEnv` copies the
# server's environment and strips only UF_*, OTEL_* and four named keys, so a
# PATH set here is the PATH the CLI and its hooks run with.
#
# `python` is on the volume for the case UV_PYTHON_PREFERENCE does not cover: a
# tool needing a newer interpreter than this image's 3.11 makes uv fetch one,
# and unpersisted that is a ~30 MB download repeated after every `up --build`.
# The preference is `system` rather than the default `managed` so that the
# ordinary case uses the interpreter already here and downloads nothing at all.
ENV PATH="/home/node/pytools/bin:${PATH}" \
    UV_TOOL_DIR=/home/node/pytools/tools \
    UV_TOOL_BIN_DIR=/home/node/pytools/bin \
    UV_PYTHON_INSTALL_DIR=/home/node/pytools/python \
    UV_PYTHON_PREFERENCE=system

# winnow, bundled rather than installed at boot.
#
# The reason this is in the image and not behind `UF_PY_TOOLS` is that it is no
# longer a third-party plugin an operator might want: with `--autocompact` gone
# it is the *only* thing bounding a work cycle's context, so an install where it
# failed to arrive is an install whose long cycles run to the model's whole
# window. `UF_PY_TOOLS` installs best-effort at boot and says so in a log line
# nobody reads; a `RUN` that fails fails the build, which is the right direction
# for something the run loop now depends on.
#
# Pinned to a commit rather than a branch on the `CLAUDE_CLI_VERSION` argument:
# the run loop parses this tool's `--json` receipt and prices it, so an
# unpinned rebuild would move that contract with no announcement. Set
# `WINNOW_REF=` (empty) to build without it — `contextPruning.ts` then reports
# the feature unavailable rather than silently pruning nothing.
#
# Its own virtualenv under /opt rather than a `uv tool install` into
# `/home/node/pytools`, and that is the whole reason it survives: that path is a
# named volume, and a volume takes its contents from the image exactly once, at
# creation. An install written there during a build is masked by whatever the
# existing volume already holds — which is precisely the "installed by hand,
# lost on rebuild" failure this is meant to end. /opt is in the image layer, so
# a rebuild is the only thing that can change it.
#
# Root-owned and 0755: every agent uid reads it, none writes it. A tool the run
# loop shells out to on every cycle boundary, sitting in a directory a sibling
# agent could rewrite, would be a way for one run to put its own code on every
# other run's transcript.
# Moved 2026-08-26 from 79dd165. That commit predates `winnow safe run`'s
# ability to dispatch this repository's own commands at all: `run_under_mode`
# handed argv to the inherited CLI, where `plan` and `fork` are not
# subcommands, so the two commands the argv gate deliberately allows mid-cycle
# were the two the dispatcher could not run. `contextPruning.ts`'s `planCut`
# and `forkTranscript` both need them, and on 79dd165 both fail as unknown
# commands — the observation table stays empty and the fork engine never fires,
# with nothing saying why.
#
# It also predates `fork --write` being classified by that gate: before
# `WINNOW_SUBCOMMANDS`, `subcommand_of` matched only inherited names, so every
# command this repository added fell through `refusal_for` as unclassified and
# therefore allowed.
ARG WINNOW_REPO=https://github.com/Xapicc/winnow.git
ARG WINNOW_REF=fb498020c955f092016685d2d4231af2c3bbb16c
RUN set -eux; \
    if [ -z "${WINNOW_REF}" ]; then \
      echo "WINNOW_REF empty — building without winnow; context pruning will report unavailable"; \
    else \
      git init -q /opt/winnow/src; \
      git -C /opt/winnow/src remote add origin "${WINNOW_REPO}"; \
      if ! GIT_TERMINAL_PROMPT=0 git -C /opt/winnow/src fetch -q --depth 1 origin "${WINNOW_REF}"; then \
        echo "" >&2; \
        echo "Could not fetch ${WINNOW_REF} from ${WINNOW_REPO}." >&2; \
        echo "This build has no credentials, so the repository must be public." >&2; \
        echo "To build without winnow, set WINNOW_REF to an empty value:" >&2; \
        echo "    WINNOW_REF= docker compose up --build" >&2; \
        echo "Context pruning then reports itself unavailable, and note that it" >&2; \
        echo "is the only thing bounding a work cycle's context." >&2; \
        exit 1; \
      fi; \
      git -C /opt/winnow/src checkout --detach FETCH_HEAD; \
      rm -rf /opt/winnow/src/.git; \
      uv venv --python 3.11 /opt/winnow/venv; \
      VIRTUAL_ENV=/opt/winnow/venv uv pip install --python /opt/winnow/venv/bin/python /opt/winnow/src; \
      chmod -R a+rX /opt/winnow; \
      /opt/winnow/venv/bin/python -m winnow safe env >/dev/null; \
    fi

# The agent runs inside this container, so Claude Code has to be in the image.
#
# Pinned because the run loop parses this CLI's `stream-json` output and its
# OTLP records, and both were captured from a specific build rather than read
# from a specification. An unpinned rebuild would move that contract silently:
# an unparsed line degrades to a log entry and a missing `result` event
# understates spend, so the failure would not announce itself.
ARG CLAUDE_CLI_VERSION=2.1.226
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}" && npm cache clean --force

# The third dependency of that same sandbox, and the only one that is not apt.
#
# Without it the CLI still sandboxes — the dependency check reports a missing
# seccomp applier as a *warning*, not an error: `seccomp not available - unix
# socket access not restricted`, and at wrap time `[Sandbox Linux] apply-seccomp
# binary not available - unix socket blocking disabled. Install
# @anthropic-ai/sandbox-runtime globally for full protection.` What that warning
# costs is the network boundary: the domain allowlist is enforced by a proxy on
# a unix socket, and the seccomp filter is the whole of what stops a sandboxed
# command dialling that socket directly. Absent, the allowlist is advice.
#
# Pinned on the same argument as the CLI above and as a second half of it. That
# pin protects a contract read off one build rather than a specification, and
# this adds the sandbox settings schema to what it covers: a renamed key leaves
# `sandbox.enabled` unread and the run unsandboxed, and `failIfUnavailable` does
# not catch it, because a sandbox that was never asked for is not one that
# failed. 0.0.71 is the release that was current when 2.1.226 was published
# (2026-08-07 against 2026-08-08), which is as close as anything here can get to
# "the version this CLI was built against". Move the two together.
ARG SANDBOX_RUNTIME_VERSION=0.0.71
RUN npm install -g "@anthropic-ai/sandbox-runtime@${SANDBOX_RUNTIME_VERSION}" \
 && npm cache clean --force

# Playwright and one Chromium, so an agent can look at the page it just built.
#
# The gap this closes is that nothing in this image could *render*. An agent
# working on a web app could read its own JSX and curl its own HTML and still
# not know that a dialog opens behind its own backdrop or that a chart drew
# nothing — there was no way to produce a picture, and a picture is a thing the
# model reads directly. `playwright screenshot <url> shot.png` is one tool call,
# and the PNG goes straight into the transcript as an image.
#
# In the image rather than installed by hand, on exactly the argument the Go and
# gh blocks above make: a shell `npm install -g` survives `docker restart` and is
# discarded by the `docker compose up --build` this project is deployed with, so
# what an agent meets after the next upgrade is `playwright: not found` inside a
# tool call — which the run loop reads as the agent deciding not to look.
#
# This is the most expensive line in the file and the number is worth writing
# down: ~640 MB Chromium, ~340 MB for the headless shell that comes with it, and
# ~250 MB of X, mesa and font packages, against a 1.9 GB image. `--only-shell`
# would drop the first of those, but the shell is reachable only through
# `--channel=chromium-headless-shell`, so every screenshot command an agent
# writes from memory would fail — a saving paid for in failed tool calls.
# Firefox and WebKit are deliberately absent: a second and third engine answers
# a rendering-*difference* question, and what is wanted here is "does it look
# right at all". Both are one `playwright install` away for a run that needs them.
#
# `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` on the npm install because the package's own
# postinstall fetches every browser in its manifest, Firefox and WebKit included;
# the explicit `install` below is what decides what this image carries. The fonts
# are not optional either — `install-deps` pulls the CJK and emoji packs, and
# without them a screenshot an agent is asked to judge is full of tofu boxes.
#
# Pinned like the CLI beside it, though for a weaker reason: nothing here parses
# Playwright's output. What the pin buys is that the browser build (`chromium-…`)
# is a function of this version, so an unpinned rebuild silently changes which
# engine every screenshot in the fleet was taken with.
#
# `/opt/playwright/browsers` rather than the default `$HOME/.cache/ms-playwright`,
# and that is not cosmetic: `/home/node` is chowned recursively further down, and
# a recursive chown over a gigabyte of browser writes a second copy of that
# gigabyte into the image. The directory belongs to `node` while everything in it
# stays root-owned — so the shipped build is one every agent reads and none can
# rewrite, and a repository pinning a different Playwright version can still put
# its own build alongside rather than meeting EACCES inside a tool call.
#
# `.links` is chowned too, and it is a separate line because it answers a
# different failure. `playwright install` is not only how a browser arrives —
# it is what an agent runs to *check* that one is there, and it rewrites its own
# link file (the path of the package claiming the build) even on a re-install
# that downloads nothing. Root-owned, that no-op dies with EACCES under the
# words "Failed to install browsers", which reads as "there is no Playwright
# here" and sends the run off to fetch a second Chromium into a path it can
# write. An `-R` is affordable here and nowhere else on this path: one 67-byte
# file per installed package, not the gigabyte the line above is avoiding.
#
# This closes the case with the sandbox off, which is how the image ships. With
# UF_SANDBOX=1 the same command still fails — bubblewrap binds everything
# outside the working directory read-only, so `playwright install` reports "Read-
# only file system" whoever owns the file, and no ownership here can change that.
# Running the browser is unaffected in both modes; only installing is refused.
#
# Chromium's own sandbox is not usable here — `unshare` is EPERM under Docker's
# default seccomp profile, the same measurement the bubblewrap note above rests
# on — but Playwright defaults `chromiumSandbox` to false, so the CLI and an
# ordinary `launch()` both work unchanged. A script that asks for it explicitly
# is the one thing that will not.
ARG PLAYWRIGHT_VERSION=1.62.1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright/browsers
RUN set -eux; \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
      npm install -g "playwright@${PLAYWRIGHT_VERSION}"; \
    npm cache clean --force; \
    apt-get update; \
    playwright install --with-deps chromium; \
    rm -rf /var/lib/apt/lists/*; \
    chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}"; \
    chown node:node "${PLAYWRIGHT_BROWSERS_PATH}"; \
    chown -R node:node "${PLAYWRIGHT_BROWSERS_PATH}/.links"; \
    playwright --version

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# The backup and restore scripts. In the image rather than left in the
# repository because the database only exists inside the container, and the two
# moments they are wanted are a scheduled `docker compose exec` and a restore
# run through `docker compose run` against a volume the app is not holding.
# They resolve `better-sqlite3` out of the standalone bundle's own node_modules,
# which is the same build of the same addon the server uses.
COPY scripts/backup-db.mjs scripts/restore-db.mjs scripts/discord-relay.mjs ./scripts/

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
#
# `/home/node/pytools` is the fourth and is the same arrangement once more: the
# tools `UF_PY_TOOLS` names, installed at boot and run by the children. All
# three subdirectories are created rather than the root alone, because uv makes
# a missing one itself and would make it as whoever the install ran as — which
# on an install that never set UF_AGENT_UID is root, leaving the agents unable
# to upgrade or remove what they run.
RUN mkdir -p /data /workspace /workspace2 /workspace3 /workspace4 /home/node/.claude \
      /home/node/go/build-cache /home/node/.local/share/gh/extensions \
      /home/node/pytools/tools /home/node/pytools/bin /home/node/pytools/python \
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
