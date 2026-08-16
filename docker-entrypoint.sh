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

# The CLI's own sandbox policy, written here rather than baked into the image.
#
# Generated at boot because the enforcement level has to be something an
# operator can lower without a rebuild. The seccomp relaxation this needs lives
# in docker-compose.yml and is commented out, so an install whose Docker rejects
# or never applied it has no working sandbox — and a `failIfUnavailable: true`
# compiled into the image would mean every `claude` invocation exits non-zero,
# fleet-wide, with no off switch short of building a new image. UF_SANDBOX_*
# below is that switch, and it is an `.env` edit and a restart.
#
# Blank is off and off writes nothing at all: no file, no directory, no policy,
# and a stock `docker compose up --build` behaves exactly as it did before this
# block existed. What is *not* skipped when it is off is the removal below —
# `docker restart` keeps the writable layer, so a policy written under an
# earlier setting would otherwise outlive the setting that asked for it, which
# is an off switch that does not switch anything off.
MANAGED_SETTINGS_DIR=/etc/claude-code
MANAGED_SETTINGS_FILE="$MANAGED_SETTINGS_DIR/managed-settings.json"
# What says the file is this app's to delete. Nothing about the CLI's own
# schema marks a policy's author, and an operator who put their own
# managed-settings.json in the image is not asking us to remove it.
MANAGED_SETTINGS_STAMP="$MANAGED_SETTINGS_DIR/.usagefoundry-owned"

# The domains an operator named, as the elements of a JSON array.
#
# Validated rather than interpolated: this string reaches a policy file that
# decides what the fleet may dial, and a stray quote in it would produce either
# invalid JSON or an entry that is not the one written down. Anything that is
# not domain-shaped is dropped by name — `*.example.com` is the widest form the
# CLI accepts, and it is spelled with characters this allows.
sandbox_domain_array() {
  array=""
  # Word splitting without pathname expansion. `*.example.com` is a domain the
  # CLI accepts and a glob this shell would otherwise try to match against the
  # working directory, quietly turning an allowlist entry into whichever file
  # happened to be sitting there.
  set -f
  for entry in $(echo "$1" | tr '|,' '  '); do
    case "$entry" in
      *[!A-Za-z0-9.*_-]*)
        echo "[usagefoundry] UF_SANDBOX_ALLOWED_DOMAINS entry \"$entry\" is not a" \
             "domain name — ignored." >&2
        continue ;;
    esac
    array="$array${array:+, }\"$entry\""
  done
  set +f
  printf '%s' "$array"
}

if [ "${UF_SANDBOX:-}" = "1" ]; then
  # Absent means on in one of the binary's two readings and off in the other —
  # the settings schema documents `failIfUnavailable` as defaulting to false,
  # while the normaliser rewrites an enabled policy that omits it to true. Both
  # were read out of the pinned binary and neither was executed, so it is always
  # written explicitly and the disagreement decides nothing here.
  case "${UF_SANDBOX_ENFORCEMENT:-refuse}" in
    refuse) fail_if_unavailable=true ;;
    warn)   fail_if_unavailable=false ;;
    *)
      fail_if_unavailable=true
      echo "[usagefoundry] UF_SANDBOX_ENFORCEMENT is" \
           "\"${UF_SANDBOX_ENFORCEMENT}\", which is neither \"refuse\" nor" \
           "\"warn\" — treating it as \"refuse\", so a sandbox that cannot" \
           "start stops the CLI rather than running unconfined." >&2 ;;
  esac

  # Omitted entirely when no domain was named, rather than shipped empty: an
  # empty allowlist is a fleet that cannot reach the API it bills against, and
  # a domain list this project guessed at would fail inside a tool call the run
  # loop does not read. Named, it also pins the list to *this* file —
  # `~/.claude/settings.json` is an honored source for sandbox settings and is
  # writable by the agents, so without allowManagedDomainsOnly a run widens its
  # own allowlist and the next session starts against it.
  network_block=""
  domains="$(sandbox_domain_array "${UF_SANDBOX_ALLOWED_DOMAINS:-}")"
  if [ -n "$domains" ]; then
    network_block="    \"network\": { \"allowedDomains\": [$domains], \"allowManagedDomainsOnly\": true },"
  fi

  # Built beside the destination and moved onto it only once it parses. Two
  # reasons, and neither is tidiness. A policy the CLI cannot read has its
  # whole sandbox block ignored — which takes `failIfUnavailable` with it, so
  # the fleet would run unconfined under an .env that says otherwise, and the
  # window in which that file is live is a window of exactly that. And a write
  # that fails must leave whatever was there alone: an operator who put their
  # own managed-settings.json into a derived image is not asking this app to
  # replace it, and is certainly not asking it to delete it.
  policy_tmp="$MANAGED_SETTINGS_DIR/.usagefoundry-policy.tmp"
  sandbox_policy_installed=""
  if mkdir -p "$MANAGED_SETTINGS_DIR" 2>/dev/null &&
     cat > "$policy_tmp" 2>/dev/null <<EOF
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": $fail_if_unavailable,
    "allowUnsandboxedCommands": false,
$network_block
    "filesystem": {
      "denyRead": ["${DATA_DIR:-/data}", "/backups"]
    },
    "credentials": {
      "files": [
        { "path": "${CLAUDE_CONFIG_DIR:-/home/node/.claude}/.credentials.json", "mode": "deny" }
      ]
    }
  }
}
EOF
  then
    if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' \
         "$policy_tmp" 2>/dev/null &&
       mv "$policy_tmp" "$MANAGED_SETTINGS_FILE" 2>/dev/null
    then
      # Root-owned 0644, and both halves are load-bearing. Root, because the
      # agents are UF_AGENT_UID and this is the one policy surface they cannot
      # rewrite — a repository's own .claude/settings.json is agent-writable and
      # is ignored for these keys. World-readable, because the `claude` children
      # that have to *read* it are that same unprivileged uid.
      chmod 0755 "$MANAGED_SETTINGS_DIR" 2>/dev/null
      chmod 0644 "$MANAGED_SETTINGS_FILE" 2>/dev/null
      : > "$MANAGED_SETTINGS_STAMP" 2>/dev/null
      sandbox_policy_installed=1
      if ! chown 0:0 "$MANAGED_SETTINGS_DIR" "$MANAGED_SETTINGS_FILE" 2>/dev/null; then
        # Said rather than left to be noticed: a policy owned by the uid the
        # agents run as is a file a run can rewrite between cycles, which is the
        # whole of what root ownership here is for.
        echo "[usagefoundry] $MANAGED_SETTINGS_FILE could not be given to root," \
             "so the sandbox policy belongs to the same uid the agents do and a" \
             "run can rewrite it. See docs/security.md." >&2
      fi
    fi
    rm -f "$policy_tmp" 2>/dev/null
  fi

  if [ -z "$sandbox_policy_installed" ]; then
    echo "[usagefoundry] UF_SANDBOX is 1 but $MANAGED_SETTINGS_FILE could not be" \
         "written — no policy from this app is in place and every run is" \
         "unconfined. Check that this container runs as root (\`user: \"0:0\"\`" \
         "in docker-compose.yml)." >&2
  fi
elif [ -n "${UF_SANDBOX:-}" ]; then
  # Not silently read as off. The variable that switches a security boundary on
  # is the one place a typo must not be indistinguishable from a decision — and
  # the app's own boot line reads the *file*, so it will say there is no sandbox
  # while .env says there is one. This is the sentence that joins the two.
  echo "[usagefoundry] UF_SANDBOX is \"${UF_SANDBOX}\", and the only value that" \
       "switches the sandbox on is \"1\" — no policy was written and every run" \
       "is unconfined." >&2
fi

if [ "${UF_SANDBOX:-}" != "1" ] && [ -e "$MANAGED_SETTINGS_STAMP" ]; then
  rm -f "$MANAGED_SETTINGS_FILE" "$MANAGED_SETTINGS_STAMP" 2>/dev/null
  echo "[usagefoundry] UF_SANDBOX is off — removed the sandbox policy this app" \
       "wrote at an earlier boot."
fi

exec "$@"
