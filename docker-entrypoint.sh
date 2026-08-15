#!/bin/sh
# Reclaim the data volume, then hand off to the server.
#
# `/data` is a *named volume*: Docker copies the image directory's ownership and
# mode onto the volume root the first time it creates one, and never again. The
# image now ships that directory as root-owned 0700, which is what stops the
# agents — dropped to UF_AGENT_UID by the server — from reading or writing the
# database, the settings the guards read, and the lock `serverLock.ts` keeps
# there. But an install that predates this ran the whole container as uid 1000
# and left the volume `node:node 0777`, and nothing about pulling a new image
# changes a volume that already exists. Without this line every existing
# deployment would upgrade into the same open directory it had before, with a
# Dockerfile that says otherwise.
#
# Best-effort rather than fatal. This fails exactly when the container is not
# running as root — an operator who has pinned `user:` back in an override, or
# `docker compose run --user` — and in that case there is no privilege
# separation to protect anyway: the app detects the same thing, says so in its
# own boot log, and works as it always did. Refusing to start would trade a
# security downgrade the operator chose for an outage they did not.
if ! chown 0:0 /data 2>/dev/null || ! chmod 0700 /data 2>/dev/null; then
  echo "[usagefoundry] cannot reclaim /data — not running as root, so the" \
       "database is readable and writable by every agent this app spawns." \
       "See docs/security.md." >&2
fi

# The same named-volume mechanics one requirement inverted: `/home/node/go` is
# Go's module and build cache, and the *children* are what write it. The image
# ships that directory owned by `node` (uid 1000), so a fresh volume is correct
# only while UF_AGENT_UID is 1000 — set it to anything else and every `go build`
# an agent runs fails on a cache directory it cannot write, inside a tool call
# nothing here reads, which the run loop then files as the agent giving up.
#
# Guarded on the current ownership rather than run unconditionally, because this
# one has to be recursive: a populated module cache is tens of thousands of
# read-only files, and chowning them on every boot would sit in front of the
# healthcheck's start period on every routine restart. Comparing the volume
# root's uid:gid first makes the ordinary case a single stat.
#
# Skipped entirely when UF_AGENT_UID is unset, which is the "no privilege
# separation" arrangement: the children are root there and root writes this
# regardless of who owns it.
GO_CACHE_VOLUME=/home/node/go
if [ -n "${UF_AGENT_UID:-}" ] && [ -d "$GO_CACHE_VOLUME" ]; then
  want="${UF_AGENT_UID}:${UF_AGENT_GID:-$UF_AGENT_UID}"
  have="$(stat -c '%u:%g' "$GO_CACHE_VOLUME" 2>/dev/null || echo '')"
  if [ "$have" != "$want" ] && ! chown -R "$want" "$GO_CACHE_VOLUME" 2>/dev/null; then
    echo "[usagefoundry] cannot give $GO_CACHE_VOLUME to $want — an agent's" \
         "\`go build\` will fail on a cache it cannot write." >&2
  fi
fi

exec "$@"
