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

# The `gh` extensions UF_GH_EXTENSIONS names, installed into the third named
# volume before the server starts.
#
# Boot is where this belongs rather than the image, because which extensions an
# install wants is the operator's answer and not this project's: baking one in
# would version it with the app and still not reach the next one. And boot
# rather than by hand, because `gh` keeps extensions under $HOME/.local/share/gh
# — the writable layer — so a shell install survives `docker restart` and is
# discarded by the `docker compose up --build` this project is deployed with.
# What an agent meets after that upgrade is `unknown command` inside a tool
# call, which the run loop reads as the agent deciding not to use it. The
# volume is what keeps them; this block is what puts them there the first time.
#
# Ownership first, for the same reason and on the same guard as the Go cache
# above: a fresh volume inherits `node` from the image, which is right exactly
# while UF_AGENT_UID is 1000.
GH_DATA_VOLUME=/home/node/.local/share/gh
if [ -n "${UF_AGENT_UID:-}" ] && [ -d "$GH_DATA_VOLUME" ]; then
  want="${UF_AGENT_UID}:${UF_AGENT_GID:-$UF_AGENT_UID}"
  have="$(stat -c '%u:%g' "$GH_DATA_VOLUME" 2>/dev/null || echo '')"
  if [ "$have" != "$want" ] && ! chown -R "$want" "$GH_DATA_VOLUME" 2>/dev/null; then
    echo "[usagefoundry] cannot give $GH_DATA_VOLUME to $want — installing a" \
         "gh extension will fail on a directory it cannot write." >&2
  fi
fi

# Every install runs as the uid that will *run* the extension — an extension is
# an executable an agent invokes, and root-owned files here would leave the
# agents unable to remove or upgrade what they run. That is root only where
# UF_AGENT_UID is unset, which is the arrangement whose children are root
# anyway, the same condition the chown above is skipped under.
gh_as_agent() {
  if [ -n "${UF_AGENT_UID:-}" ]; then
    setpriv --reuid="$UF_AGENT_UID" --regid="${UF_AGENT_GID:-$UF_AGENT_UID}" \
            --clear-groups \
      env HOME=/home/node GH_TOKEN="$UF_GITHUB_TOKEN" gh "$@"
  else
    env HOME=/home/node GH_TOKEN="$UF_GITHUB_TOKEN" gh "$@"
  fi
}

# `--pin` only when a version was asked for: passed an empty one, gh looks for a
# release literally named "" and fails.
gh_install_extension() {
  if [ -n "$2" ]; then
    gh_as_agent extension install "$1" --pin "$2"
  else
    gh_as_agent extension install "$1"
  fi
}

# Best-effort throughout, and never fatal: an extension that will not install is
# a degraded install rather than a broken one, and refusing the boot over it
# would take the dashboard, the run history and every guard away from an
# operator whose agents may never reach for the tool.
if [ -n "${UF_GH_EXTENSIONS:-}" ]; then
  if [ -z "${UF_GITHUB_TOKEN:-}" ]; then
    # Named rather than attempted. `gh` refuses every API call with no
    # credential — a public repository included — so each install would fail
    # with an authentication error naming neither this list nor the variable
    # that fixes it. UF_GITHUB_TOKENS is not a substitute: those tokens are
    # keyed by the folder a run works in, and this runs before any run exists.
    echo "[usagefoundry] UF_GH_EXTENSIONS names extensions but UF_GITHUB_TOKEN" \
         "is blank — gh cannot reach the API without a token, so none were" \
         "installed." >&2
  else
    # Read once, so a list of ten extensions on an install that already has them
    # costs one gh call rather than ten. Commas and "|" are accepted beside
    # spaces because the other list-valued variables in .env are "|"-separated
    # and an operator should not have to remember which of them this is.
    installed="$(gh_as_agent extension list 2>/dev/null || true)"
    for entry in $(echo "$UF_GH_EXTENSIONS" | tr '|,' '  '); do
      case "$entry" in
        *@*) repo="${entry%@*}"; tag="${entry##*@}" ;;
        *)   repo="$entry";      tag="" ;;
      esac
      # Matched on the repository rather than the command name, because the
      # command is not derivable from the slug: `Xapicc/gh-layer10` installs as
      # `gh layer10`, and `gh extension list` is where the two are put side by
      # side. A pinned entry whose pin has moved is *not* reinstalled — see the
      # note in .env.example: silently replacing an executable that runs with a
      # GitHub token in its environment is not something a restart should do.
      case "$installed" in
        *"$repo"*) continue ;;
      esac
      if error="$(gh_install_extension "$repo" "$tag" 2>&1 >/dev/null)"; then
        # Added to the list read before the loop, so a name written twice is
        # skipped the second time rather than answered with gh's "already
        # installed" as though something had gone wrong.
        installed="$installed $repo"
        echo "[usagefoundry] installed gh extension $entry"
      else
        echo "[usagefoundry] could not install gh extension $entry:" \
             "$(echo "$error" | tr '\n' ' ')" >&2
      fi
    done
  fi
fi

exec "$@"
