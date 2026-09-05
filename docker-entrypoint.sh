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

# The Python tools UF_PY_TOOLS names, in the fourth named volume, on exactly the
# terms the gh extensions above are on.
#
# The reason this exists at all is one step further out than gh's. A plugin
# registered through `--plugin-dir` reaches the operator through its hooks and
# nothing else, and a hook whose command is not installed does not fail: the
# `|| true` every hook body ends with makes it exit 0, having done nothing, on
# every session start for as long as the plugin stays enabled. There is no
# `unknown command` to read here — measured on this install, a plugin ran 213
# times against a command that was never present, announcing itself active each
# time. So the mechanism is the same one and the symptom it prevents is quieter.
PY_TOOLS_VOLUME=/home/node/pytools
if [ -n "${UF_AGENT_UID:-}" ] && [ -d "$PY_TOOLS_VOLUME" ]; then
  want="${UF_AGENT_UID}:${UF_AGENT_GID:-$UF_AGENT_UID}"
  have="$(stat -c '%u:%g' "$PY_TOOLS_VOLUME" 2>/dev/null || echo '')"
  if [ "$have" != "$want" ] && ! chown -R "$want" "$PY_TOOLS_VOLUME" 2>/dev/null; then
    echo "[usagefoundry] cannot give $PY_TOOLS_VOLUME to $want — installing a" \
         "Python tool will fail on a directory it cannot write." >&2
  fi
fi

# The Playwright browsers, and the one part of them that is not the image's.
#
# `/opt/playwright/browsers` ships with its contents root-owned and the directory
# itself owned by `node`, so the shipped Chromium is one every agent reads and
# none can rewrite, while a repository pinning a different Playwright version can
# still put its own build alongside it. That arrangement is correct exactly while
# UF_AGENT_UID is 1000 — set it to anything else and that `playwright install`
# fails on a directory it cannot write, inside a tool call nothing here reads.
#
# Not an `-R`, and that is the difference from the three blocks above. This is a
# gigabyte of read-only browser rather than a cache the agents own, and chowning
# it recursively would copy that gigabyte into the container's writable layer on
# the first boot after every rebuild. Only the directory needs to be writable.
PLAYWRIGHT_BROWSERS_DIR="${PLAYWRIGHT_BROWSERS_PATH:-/opt/playwright/browsers}"
if [ -n "${UF_AGENT_UID:-}" ] && [ -d "$PLAYWRIGHT_BROWSERS_DIR" ]; then
  want="${UF_AGENT_UID}:${UF_AGENT_GID:-$UF_AGENT_UID}"
  have="$(stat -c '%u:%g' "$PLAYWRIGHT_BROWSERS_DIR" 2>/dev/null || echo '')"
  if [ "$have" != "$want" ] && ! chown "$want" "$PLAYWRIGHT_BROWSERS_DIR" 2>/dev/null; then
    echo "[usagefoundry] cannot give $PLAYWRIGHT_BROWSERS_DIR to $want — an" \
         "agent installing a second Playwright browser build will fail on a" \
         "directory it cannot write. The shipped Chromium still works." >&2
  fi

  # `.links` is the exception to the line above, and the `-R` is affordable
  # because it is one 67-byte file per installed package. `playwright install`
  # rewrites that file even when it downloads nothing — and an agent runs the
  # command to *check* that a browser is there, not only to fetch one. Left
  # root-owned, that check fails with EACCES under the words "Failed to install
  # browsers", which reads as "there is no Playwright here" and sends the run
  # off to download a second Chromium somewhere it can write.
  PLAYWRIGHT_LINKS_DIR="$PLAYWRIGHT_BROWSERS_DIR/.links"
  have="$(stat -c '%u:%g' "$PLAYWRIGHT_LINKS_DIR" 2>/dev/null || echo '')"
  if [ -d "$PLAYWRIGHT_LINKS_DIR" ] && [ "$have" != "$want" ] &&
     ! chown -R "$want" "$PLAYWRIGHT_LINKS_DIR" 2>/dev/null; then
    echo "[usagefoundry] cannot give $PLAYWRIGHT_LINKS_DIR to $want —" \
         "\`playwright install\` will fail with EACCES even though the browser" \
         "it would install is already installed. Rendering still works." >&2
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

# Installed as the uid that will run them, for the reason `gh_as_agent` is: a
# tool here is an executable a hook invokes, and root-owned files in a volume
# the agents own leave them unable to upgrade or remove what they run.
uv_as_agent() {
  if [ -n "${UF_AGENT_UID:-}" ]; then
    setpriv --reuid="$UF_AGENT_UID" --regid="${UF_AGENT_GID:-$UF_AGENT_UID}" \
            --clear-groups \
      env HOME=/home/node uv "$@"
  else
    env HOME=/home/node uv "$@"
  fi
}

# `--editable` only for a checkout, and never as an empty argument: passed one,
# uv looks for a package named "" and fails. Same shape as the gh helper above
# and for the same reason.
uv_install_tool() {
  if [ -n "$2" ]; then
    uv_as_agent tool install --editable "$1"
  else
    uv_as_agent tool install "$1"
  fi
}

# Best-effort throughout and never fatal, on the same argument as the gh block:
# a tool that will not install is a degraded install, and refusing the boot over
# it would take the dashboard and every guard away from an operator whose
# plugins may not need it.
if [ -n "${UF_PY_TOOLS:-}" ]; then
  # Split on spaces and "|" but *not* on commas, which is where this parts
  # company with UF_GH_EXTENSIONS: a comma is meaningful inside a version
  # specifier (`cozempic>=1.8,<2`), so accepting it as a separator would turn
  # one pinned entry into two unpinnable ones.
  #
  # Read once, so ten tools on an install that already has them cost one uv call
  # rather than ten. `uv tool list` prints `<name> v<version>` for each tool and
  # indents the commands under it, which is what the pattern selects.
  installed=" $(uv_as_agent tool list 2>/dev/null \
                | awk '/^[A-Za-z0-9_.-]+ v/ { print $1 }' | tr '\n' ' ') "
  for entry in $(echo "$UF_PY_TOOLS" | tr '|' ' '); do
    # An absolute path is a *checkout* rather than a release, which is the one
    # thing an operator's own fork of a plugin's tool can be, and it gets the
    # two things a checkout wants.
    #
    # `--editable`, so the environment points at the source and an edit on the
    # host is live in the container with no reinstall at all — measured:
    # `cozempic.__file__` resolves to the mounted tree, and a version bumped on
    # the host reads back changed from the same install.
    #
    # And no skip test, so a restart re-runs it. That is not the same as being
    # unable to skip: an editable install tracks the *source* and fixes the
    # metadata — the dependencies and the console scripts — at install time, so
    # a restart is the only thing that picks those up, and it is the moment an
    # operator already reaches for. It costs under a second, and a source tree
    # too broken to build leaves the last good install in place rather than
    # removing it (also measured).
    #
    # `name@file:///path` is the other half of the pair and needs nothing here:
    # it carries a name, so it takes the ordinary path below and is copied once
    # rather than followed. That is the form for a checkout you want *pinned* to
    # the state it was installed in.
    case "$entry" in
      /*) editable=1 ;;
      *)  editable="" ;;
    esac
    if [ -z "$editable" ]; then
      # The entry goes to uv verbatim — it is a PEP 508 requirement, and uv is
      # what understands `==`, `>=`, an extra or a direct URL. Only the *name*
      # is parsed out here, and only to ask whether it is already installed.
      name="${entry%%[=<>!~[@]*}"
      # Exact-name matching rather than the substring test the gh block uses,
      # and the difference matters here: `rich` is a substring of `rich-cli`, so
      # a substring test would silently skip a tool an operator asked for on the
      # strength of an unrelated one already being there.
      case "$installed" in
        *" $name "*) continue ;;
      esac
    fi
    if error="$(uv_install_tool "$entry" "$editable" 2>&1 >/dev/null)"; then
      if [ -z "$editable" ]; then
        # Added to the list read before the loop, so a name written twice is
        # skipped the second time rather than answered with uv's "already
        # installed" as though something had gone wrong.
        installed="$installed$name "
        echo "[usagefoundry] installed Python tool $entry"
      else
        # Said differently on purpose. This line appears on every boot rather
        # than once, and what it reports is a tool whose code an operator can
        # change without reinstalling anything — which is worth being able to
        # see in a log, and worth not reading as the ordinary case.
        echo "[usagefoundry] installed Python tool (editable) $entry"
      fi
    else
      echo "[usagefoundry] could not install Python tool $entry:" \
           "$(echo "$error" | tr '\n' ' ')" >&2
    fi
  done
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
  # `enableWeakerNestedSandbox` below is what makes the sandbox able to start
  # inside a container at all, and it is not optional here. The CLI builds one
  # of two bubblewrap command lines: its default mounts a fresh procfs
  # (`--proc /proc`), and this key switches it to binding the existing one
  # (`--bind /proc /proc`). Docker masks parts of `/proc` — kcore, keys,
  # interrupts, timer_list over tmpfs, several more bound read-only — and the
  # kernel refuses a new procfs mount inside a user namespace while locked
  # over-mounts hide part of the current view. Measured on this project's own
  # image, at both uids and with the seccomp profile applied: the default shape
  # dies with "Can't mount proc on /newroot/proc: Operation not permitted" and
  # the bound shape exits 0.
  #
  # It is named "weaker" by the CLI and the name is honest: the sandboxed
  # command sees this container's `/proc` rather than one of its own, so a
  # sibling agent's processes are visible in it. That is the boundary this
  # container never had anyway — every agent here is one uid (`privsep.ts`),
  # and `PROCESS_KILLERS` plus the self-hosting notice are what stand in for it.
  # Written unconditionally rather than as a switch for the reason the two
  # `denyRead` paths are: a policy an operator can half-configure is one that
  # reports "on" and confines nothing.
  if mkdir -p "$MANAGED_SETTINGS_DIR" 2>/dev/null &&
     cat > "$policy_tmp" 2>/dev/null <<EOF
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": $fail_if_unavailable,
    "allowUnsandboxedCommands": false,
    "enableWeakerNestedSandbox": true,
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

# The other file the CLI reads a sandbox policy out of, and the only one the
# agents can write.
#
# `$CLAUDE_CONFIG_DIR/settings.json` is an *honored* source for `sandbox.*`: the
# pinned binary resolves the policy from the managed file above, from
# `--settings` on the argv, and from user settings, merged — and
# `filesystem.allowWrite` is documented as *additional* paths. That file is
# owned and writable by the uid every agent runs as, so a run appends
# `{"sandbox":{"filesystem":{"allowWrite":["/"]}}}` and every session after it —
# its own and every sibling's — starts confined to nothing. Until this block
# runs, both the managed policy above and the per-run overlay `orchestrator.ts`
# builds are narrower than what a run can hand itself.
#
# Root-owning the *file* does not close it: unlinking a file is a write to the
# directory that holds it, not to the file, and the agents own that directory.
# So the directory becomes root's as well, and the entries the CLI writes are
# handed back one at a time. Never the directory's *contents* wholesale — this
# block chowns nothing recursively except an entry it found in the wrong hands,
# so every entry not named below keeps the owner it already had, which on a
# stock install is the agent's.
#
# Off by default, and deliberately not the same switch as UF_SANDBOX. They are
# worth having one at a time in both directions: the sandbox's credential deny
# and its domain list are on other lists and are not weakened by this hole, and
# this is worth closing on an install with no sandbox at all, because
# `settings.json` also carries hooks, permission rules and environment for every
# session the CLI starts.
CLAUDE_HOME_DIR="${CLAUDE_CONFIG_DIR:-/home/node/.claude}"

# What the CLI writes at the top level of that directory, and therefore what has
# to stay the agent's after the directory stops being. `projects/` first because
# it is the metering path — `transcripts.ts` walks it for every window, every
# guard and every spend figure, and a `projects/` the CLI cannot write is a
# dashboard of zeros rather than an error anybody sees.
#
# The first six are the list `proposals/Sandboxing/09-implementation-sketch.md`
# names. `.claude.json` and `backups` are added from a measurement rather than
# from the sketch: run against a throwaway `CLAUDE_CONFIG_DIR`, CLI 2.1.226
# creates `.claude.json`, `backups/`, `projects/` and `sessions/` at the top
# level of it before it has even authenticated — `.claude.json` lands *inside*
# the config directory precisely because `CLAUDE_CONFIG_DIR` is set, which is
# not where it sits on a host that has not set it.
CLAUDE_HOME_HANDBACK='projects sessions todos shell-snapshots history.jsonl .credentials.json .claude.json backups'

# The owner of a path, or the empty string for something that is not there.
claude_home_owner() {
  stat -c '%u:%g' "$1" 2>/dev/null || echo ''
}

# `test -r`/`test -w` asked from the uid the agents actually run as, which is
# the only thing here that answers the question the operator has. Root's own
# `test -w` says yes to everything, and on a bind mount whose ownership the
# platform emulates — Docker Desktop's `fakeowner`, which is what every macOS
# install has — a `stat` after a `chown` can report the change while the kernel
# the agent meets enforces something else. Prints yes/no, or "unknown" when the
# probe itself could not run, because a `setpriv` that fails must not be read as
# a permission denied.
claude_home_agent_test() {
  setpriv --reuid="$UF_AGENT_UID" --regid="${UF_AGENT_GID:-$UF_AGENT_UID}" \
          --clear-groups \
    sh -c 'if test "$1" "$2"; then echo yes; else echo no; fi' sh "$1" "$2" \
    2>/dev/null || echo unknown
}

if [ "${UF_LOCK_CLAUDE_HOME:-}" = "1" ] && [ -n "${UF_AGENT_UID:-}" ]; then
  claude_home_agent="${UF_AGENT_UID}:${UF_AGENT_GID:-$UF_AGENT_UID}"
  claude_home_root="0:${UF_AGENT_GID:-$UF_AGENT_UID}"
  claude_home_settings="$CLAUDE_HOME_DIR/settings.json"
  claude_home_refusal=""
  claude_home_settings_was=""
  claude_home_missing=""

  # Three ways this must not start, checked before anything is touched. The
  # third is the one that matters: a locked directory is one the CLI cannot
  # create entries in, so a `projects/` that does not exist yet would never
  # exist, and the failure would be a dashboard of zeros on an install that
  # looks like it is working. The same is true of the other entries in the list
  # — `sessions/`, `todos/`, `shell-snapshots/`, `history.jsonl` — but they are
  # skipped rather than refused, because only `projects/` is silent about it and
  # because refusing over a `todos/` the CLI has not needed yet would make this
  # unturnable-on. Sign in and run one real cycle before switching this on; if
  # something is missing afterwards, create it yourself as the agent's uid, with
  # the switch off, then turn it on. Take that uid from the container: a
  # `${UF_UID}` typed at a host shell is expanded by that shell, and .env never
  # reaches it, so it is 1000 however the install is configured.
  #
  #     uid=$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)
  #     docker compose exec -u "$uid" usagefoundry mkdir -p ~/.claude/todos
  if [ ! -d "$CLAUDE_HOME_DIR" ]; then
    claude_home_refusal="$CLAUDE_HOME_DIR is not a directory"
  elif [ "$(id -u)" != "0" ]; then
    claude_home_refusal="this container is not running as root, so nothing here can change an owner"
  elif [ ! -d "$CLAUDE_HOME_DIR/projects" ]; then
    claude_home_refusal="$CLAUDE_HOME_DIR/projects does not exist yet, and a root-owned directory is one the CLI cannot create it in — sign in and run one work cycle first"
  fi

  # Hand back what exists, and check that the hand-back took. Guarded on the
  # entry's own owner and recursive only when that owner is wrong, which is the
  # same trade-off the Go cache above makes and for the same reason: `projects/`
  # is tens of thousands of transcript files on a working install, and chowning
  # them on every boot would sit in front of the healthcheck's start period on
  # every routine restart. The ordinary case is one `stat` per entry. What that
  # accepts, exactly as the Go cache does, is an entry whose root is right and
  # whose contents are not — nothing here walks a tree it was not told to.
  #
  # This runs before the directory is locked, so a failure leaves the install as
  # it was: metering intact, the hole open, and a message saying so. The reverse
  # order would trade a policy hole for a metering outage.
  if [ -z "$claude_home_refusal" ]; then
    for claude_home_entry in $CLAUDE_HOME_HANDBACK; do
      claude_home_path="$CLAUDE_HOME_DIR/$claude_home_entry"
      if [ ! -e "$claude_home_path" ]; then
        # Not created here — this hands entries back, it does not invent them,
        # and a `sessions/` this app made would be one the CLI never asked for.
        # Collected instead, and named once on the boot that takes the directory
        # (below), because after that the CLI cannot create it either. Not
        # repeated on every later boot: a permanent warning about a `todos/` the
        # installed CLI has never needed is noise, and noise is what stops the
        # next line from being read.
        claude_home_missing="${claude_home_missing:+$claude_home_missing }$claude_home_entry"
        continue
      fi
      claude_home_have="$(claude_home_owner "$claude_home_path")"
      [ "$claude_home_have" = "$claude_home_agent" ] && continue
      chown -R "$claude_home_agent" "$claude_home_path" 2>/dev/null
      claude_home_have="$(claude_home_owner "$claude_home_path")"
      if [ "$claude_home_have" != "$claude_home_agent" ]; then
        claude_home_refusal="$claude_home_path is owned by ${claude_home_have:-a stat that failed} and could not be given to $claude_home_agent"
        break
      fi
      echo "[usagefoundry] UF_LOCK_CLAUDE_HOME: gave $claude_home_path back to" \
           "$claude_home_agent"
    done
  fi

  # The file itself, before the directory, so that a failure here has changed
  # nothing at all. Root-owned 0640 rather than 0644: the agents have to *read*
  # it — it carries their hooks, their permission rules and their environment,
  # and a session that cannot read it loses all three silently — and the group
  # is the agent's own, so nothing is opened up to anyone else on the operator's
  # host. A `settings.json` that does not exist is left alone rather than
  # created: once the directory below is root's, the agents cannot create one
  # either, so its absence is closed by the same lock.
  if [ -z "$claude_home_refusal" ] && [ -e "$claude_home_settings" ]; then
    claude_home_have="$(claude_home_owner "$claude_home_settings")"
    if [ "$claude_home_have" != "$claude_home_root" ]; then
      chown "$claude_home_root" "$claude_home_settings" 2>/dev/null
      if [ "$(claude_home_owner "$claude_home_settings")" = "$claude_home_root" ]; then
        # Recorded so a failure on the directory below can put it back exactly
        # as it was found, rather than leaving half a change behind.
        claude_home_settings_was="$claude_home_have"
        chmod 0640 "$claude_home_settings" 2>/dev/null
      else
        claude_home_refusal="settings.json is owned by ${claude_home_have:-a stat that failed} and could not be given to $claude_home_root"
      fi
    fi
  fi

  # And the directory. 0750 rather than 0700: root owns it now, and the agents
  # reach `projects/` through it, so the group bit is what keeps the metering
  # path readable. Not 0755, because on the operator's host this is their own
  # `~/.claude` and it was 0700 before this ran.
  if [ -z "$claude_home_refusal" ]; then
    claude_home_have="$(claude_home_owner "$CLAUDE_HOME_DIR")"
    if [ "$claude_home_have" != "$claude_home_root" ]; then
      chown "$claude_home_root" "$CLAUDE_HOME_DIR" 2>/dev/null
      if [ "$(claude_home_owner "$CLAUDE_HOME_DIR")" = "$claude_home_root" ]; then
        chmod 0750 "$CLAUDE_HOME_DIR" 2>/dev/null
        if [ -n "${claude_home_missing:-}" ]; then
          echo "[usagefoundry] UF_LOCK_CLAUDE_HOME: $CLAUDE_HOME_DIR is now" \
               "root's and these entries" \
               "are not in it, so the CLI can no longer create them:" \
               "$claude_home_missing. If a session needs one, clear" \
               "UF_LOCK_CLAUDE_HOME, restart, let the CLI make it, and set the" \
               "variable again." >&2
        fi
      else
        claude_home_refusal="$CLAUDE_HOME_DIR is owned by ${claude_home_have:-a stat that failed} and could not be given to $claude_home_root"
        if [ -n "$claude_home_settings_was" ]; then
          chown "$claude_home_settings_was" "$claude_home_settings" 2>/dev/null
          chmod 0600 "$claude_home_settings" 2>/dev/null
        fi
      fi
    fi
  fi

  # What the agents can actually do now, asked as one of them. The three
  # answers are not equally serious, so they are not reported together: a
  # `projects/` that has stopped being writable is a metering outage and is
  # undone here, where a `settings.json` that is still writable is the hole this
  # was meant to close still being open — bad, loud, and not worth breaking an
  # install over.
  if [ -z "$claude_home_refusal" ]; then
    claude_home_open=""
    claude_home_broke=""
    claude_home_unknown=""

    # `projects/` first, because if two of these are wrong it is the one that
    # decides what happens: a metering outage outranks a policy hole.
    case "$(claude_home_agent_test -w "$CLAUDE_HOME_DIR/projects")" in
      no) claude_home_broke="cannot write $CLAUDE_HOME_DIR/projects, which is every usage figure and every budget guard" ;;
      unknown) claude_home_unknown=1 ;;
    esac
    case "$(claude_home_agent_test -w "$CLAUDE_HOME_DIR")" in
      yes) claude_home_open="the directory itself" ;;
      unknown) claude_home_unknown=1 ;;
    esac
    if [ -e "$claude_home_settings" ]; then
      case "$(claude_home_agent_test -w "$claude_home_settings")" in
        yes) claude_home_open="${claude_home_open:+$claude_home_open and }settings.json" ;;
        unknown) claude_home_unknown=1 ;;
      esac
      case "$(claude_home_agent_test -r "$claude_home_settings")" in
        no) [ -n "$claude_home_broke" ] ||
              claude_home_broke="cannot read $claude_home_settings, which carries its hooks, permission rules and environment" ;;
        unknown) claude_home_unknown=1 ;;
      esac
    fi

    if [ -n "$claude_home_broke" ]; then
      # All or nothing, and this is the "nothing": put the directory and the
      # file back rather than leave an install metering zeroes. `settings.json`
      # goes back whenever it is root's, not only when this boot took it —
      # half-undoing leaves a file the CLI cannot write inside a directory the
      # agents can, which is neither state.
      chown "$claude_home_agent" "$CLAUDE_HOME_DIR" 2>/dev/null
      chmod 0700 "$CLAUDE_HOME_DIR" 2>/dev/null
      case "$(claude_home_owner "$claude_home_settings")" in
        0:*) chown "$claude_home_agent" "$claude_home_settings" 2>/dev/null
             chmod 0600 "$claude_home_settings" 2>/dev/null ;;
      esac
      claude_home_refusal="an agent $claude_home_broke — the lock was undone and $CLAUDE_HOME_DIR is back at $(claude_home_owner "$CLAUDE_HOME_DIR")"
    elif [ -n "$claude_home_open" ]; then
      echo "[usagefoundry] UF_LOCK_CLAUDE_HOME is 1 and the chown reported" \
           "success, but an agent can still write $claude_home_open — the" \
           "ownership change did not reach the kernel that enforces it (a" \
           "bind mount whose ownership the platform emulates does this). A run" \
           "can still widen its own sandbox policy. See docs/security.md." >&2
    elif [ -n "$claude_home_unknown" ]; then
      # Not folded into the success line. The chowns reported success and the
      # ownership reads back as root, but the one check that speaks for the
      # kernel rather than for `stat` did not run, and saying "locked" on the
      # strength of a probe that never happened is how a boundary comes to be
      # believed in.
      echo "[usagefoundry] UF_LOCK_CLAUDE_HOME is 1 and $CLAUDE_HOME_DIR now" \
           "reads as root's, but \`setpriv\` could not ask an agent's own uid" \
           "what it can still do — nothing here has confirmed the lock, and" \
           "docs/verification.md's two probes are the only thing that will." >&2
    else
      # Every line this block prints carries the variable's name, success
      # included, so one `grep UF_LOCK_CLAUDE_HOME` over the logs answers
      # "is it on?" rather than four different greps.
      echo "[usagefoundry] UF_LOCK_CLAUDE_HOME is 1 and $CLAUDE_HOME_DIR is" \
           "root-owned: a run cannot rewrite or replace its settings.json, and" \
           "$claude_home_agent still writes projects/."
    fi
  fi

  if [ -n "$claude_home_refusal" ]; then
    echo "[usagefoundry] UF_LOCK_CLAUDE_HOME is 1 but $claude_home_refusal." \
         "Nothing was left half-changed: $CLAUDE_HOME_DIR is as it was, so" \
         "metering is unaffected and a run can still rewrite the sandbox" \
         "policy in its settings.json. See docs/install.md." >&2
  fi
else
  # Off, or no agent uid — and off has to undo, or it is not an off switch.
  #
  # Undone from the state rather than from a stamp on purpose. A stamp would
  # live in the writable layer, which `docker compose up --build` discards while
  # the bind mount keeps every ownership change this made, so the one boot that
  # most needs to hand the directory back is the one that would have forgotten
  # it did anything. The signature used instead is narrow: root owns the
  # directory *and* the agents own `projects/` inside it, which is this block's
  # own arrangement and not one anything else produces. A `~/.claude` that is
  # root's all the way down is somebody who ran compose under sudo, and this
  # leaves it alone.
  if [ -n "${UF_LOCK_CLAUDE_HOME:-}" ] && [ "${UF_LOCK_CLAUDE_HOME}" != "1" ]; then
    echo "[usagefoundry] UF_LOCK_CLAUDE_HOME is \"${UF_LOCK_CLAUDE_HOME}\", and" \
         "the only value that locks $CLAUDE_HOME_DIR is \"1\" — it was left" \
         "writable by the agents, and a run can rewrite its sandbox policy." >&2
  elif [ "${UF_LOCK_CLAUDE_HOME:-}" = "1" ]; then
    # Skipped rather than attempted, on the same condition as the chown blocks
    # further up: with no UF_AGENT_UID the children are root, and root is not
    # stopped by an owner or a mode. Said out loud because believing in a
    # boundary that is not there is worse than not having it.
    echo "[usagefoundry] UF_LOCK_CLAUDE_HOME is 1 but UF_AGENT_UID is unset, so" \
         "every child runs as root and no ownership would stop one — nothing" \
         "was changed. Set UF_UID in .env to separate them first." >&2
  fi

  if [ -n "${UF_AGENT_UID:-}" ] && [ -d "$CLAUDE_HOME_DIR" ]; then
    claude_home_agent="${UF_AGENT_UID}:${UF_AGENT_GID:-$UF_AGENT_UID}"
    claude_home_settings="$CLAUDE_HOME_DIR/settings.json"
    case "$(claude_home_owner "$CLAUDE_HOME_DIR")" in
      0:*)
        if [ "$(claude_home_owner "$CLAUDE_HOME_DIR/projects")" = "$claude_home_agent" ]; then
          chown "$claude_home_agent" "$CLAUDE_HOME_DIR" 2>/dev/null
          chmod 0700 "$CLAUDE_HOME_DIR" 2>/dev/null
          case "$(claude_home_owner "$claude_home_settings")" in
            0:*) chown "$claude_home_agent" "$claude_home_settings" 2>/dev/null
                 chmod 0600 "$claude_home_settings" 2>/dev/null ;;
          esac
          if [ "$(claude_home_owner "$CLAUDE_HOME_DIR")" = "$claude_home_agent" ]; then
            echo "[usagefoundry] UF_LOCK_CLAUDE_HOME is off — gave" \
                 "$CLAUDE_HOME_DIR back to $claude_home_agent, which a boot" \
                 "with it on had taken."
          else
            echo "[usagefoundry] UF_LOCK_CLAUDE_HOME is off but" \
                 "$CLAUDE_HOME_DIR is still root's and could not be handed" \
                 "back — the CLI cannot create anything new in it. Run" \
                 "\`chown $claude_home_agent $CLAUDE_HOME_DIR\` as root, or" \
                 "start this container as root once." >&2
          fi
        fi ;;
    esac
  fi
fi

# The Discord relay, and the unset under it is the load-bearing half.
#
# `notify.ts` POSTs one generic signed body and will not learn a vendor's shape;
# Discord's incoming webhooks accept only their own, so a bare Discord URL
# answers 400 and the notification is lost. This is the shaping layer, and it
# lives here rather than beside the container so that an operator has one thing
# to start rather than two — the failure it replaces is a relay nobody
# remembered to run, which is silent at both ends.
#
# It listens on loopback *inside* this container, so nothing about it is on any
# network. UF_WEBHOOK_URL has to name it; blank still means notifications off and
# is left alone, because that meaning is load-bearing everywhere else.
#
# DISCORD_WEBHOOK_URL is then removed from the environment before the server is
# exec'd, and that is not tidiness. `orchestrator.ts` builds every agent's
# environment as `{ ...process.env }`, so a variable this process still holds is
# one every unattended agent can read — and this one posts to your channel on
# possession alone. The relay keeps it because it was started before the unset;
# it runs as root, so its /proc/<pid>/environ is unreadable by the agent uid.
if [ -n "${DISCORD_WEBHOOK_URL:-}" ]; then
  case "${UF_WEBHOOK_URL:-}" in
    "")
      echo "[usagefoundry] DISCORD_WEBHOOK_URL is set and UF_WEBHOOK_URL is" \
           "empty, which still means notifications are off. Set" \
           "UF_WEBHOOK_URL=http://127.0.0.1:${RELAY_PORT:-8787}/uf to send" \
           "them through the relay." >&2 ;;
    *127.0.0.1:*|*localhost:*) : ;;
    *)
      echo "[usagefoundry] DISCORD_WEBHOOK_URL is set but UF_WEBHOOK_URL does" \
           "not name this container's relay. The relay is starting and will" \
           "receive nothing; notifications are going to" \
           "$UF_WEBHOOK_URL instead." >&2 ;;
  esac

  # Restarted rather than started once: a relay that died at 03:00 is
  # indistinguishable from a quiet fleet, which is the whole failure this
  # channel exists to end. The delay bounds a misconfigured binary's log spam.
  (
    while :; do
      node /app/scripts/discord-relay.mjs || true
      echo "[usagefoundry] discord relay exited; restarting in 5s" >&2
      sleep 5
    done
  ) &

  unset DISCORD_WEBHOOK_URL DISCORD_MENTION_USER_ID
fi

# winnow's intake filter, when WINNOW_FILTER is on.
#
# ## What it is
#
# A loopback proxy in front of api.anthropic.com. A tool result that a rule
# marks as spent — a `Glob`, an `ls`, a passing `npm test` — is sent in full on
# the one request where the agent acts on it, placed *after* the last
# cache_control breakpoint so the API never writes it to the prompt cache, and
# dropped from the next request. The bytes cost 1.0x once instead of a 2.0x
# cache write plus a 0.1x read on every later turn.
#
# It has to be a proxy rather than a hook because the decision it makes is where
# the cache breakpoint goes, and no hook sees the request body. It has to run
# *inside* this container because that is where the agents run: a proxy on the
# operator's own machine is not reachable from here.
#
# ## Why ANTHROPIC_BASE_URL is exported here and not set in compose
#
# `orchestrator.ts`'s childEnv passes it through untouched — its own comment
# says proxy settings are the operator's decision to make — so an export before
# the exec below reaches every agent. Setting it in compose instead would let an
# operator point the URL at a proxy that never started, and the symptom is every
# agent request failing with a connection refused, inside a tool call, on an
# unattended run.
#
# ## Why the ledger and the switch live on a named volume of their own
#
# Not in the writable layer, which is not durable enough. `/home/node/.winnow`
# is where the ledger started and a restart discarded it — measured, not
# predicted: a restart on 2026-08-25 took 52 ledger lines with it and left the
# sessions they described permanently unattributable. The ledger is what tells
# `winnow inspect` and `winnow fork` which bytes the transcript still holds but
# the API never received, so losing it is not losing a log, it is losing the
# correction.
#
# And not under /data, which is where it went next and stayed until this process
# stopped running as root. /data is root-owned 0700, and that mode is the whole
# of what keeps an agent out of the database, the settings every guard reads and
# the lock `serverLock.ts` keeps beside them — so nothing at UF_AGENT_UID can
# traverse into it, and opening it by one bit to let the filter back in would
# trade this file's privilege defect for a far worse one.
#
# What the directory mode used to do is done per file instead, and both of the
# things it did still hold. The directory is root's 0755: the filter may
# traverse and read it and may not add to or remove from it, which is what keeps
# `filter-off` an operator's switch rather than something a run can throw to
# stop paying for its own transcript. The ledger is root's too, group
# UF_AGENT_GID and 0620 — appendable by the filter, readable by root alone, and
# neither chmod-able nor removable by the uid that appends to it. The ledger
# names the commands whose output was dropped, the agents have no business
# reading it, and they still cannot.
#
# ## Turning it off
#
# Two ways, and they are not equivalent. `WINNOW_FILTER=` blank plus a restart
# is the full off: no proxy, no ANTHROPIC_BASE_URL, boot identical to before
# this block existed. Without a restart, what can be turned off is the
# *rewriting* and not the proxy — `touch /var/lib/winnow/filter-off` and the
# next request is relayed untouched.
#
# Only the second one is safe to do to a running install, and the asymmetry is
# worth stating: ANTHROPIC_BASE_URL is fixed in an agent's environment when the
# server spawns it, so a listener that goes away takes every in-flight and
# future agent request with it. Killing this process does not turn the filter
# off, it turns the API off.
#
# ## Why a failure here is not fatal
#
# Same argument as the gh and Python tool blocks: a filter that will not start
# is a *degraded* install, not a broken one, and the degradation is that runs
# cost what they cost today. So this waits for the port, and if nothing is
# listening it says so and leaves ANTHROPIC_BASE_URL unset — every agent then
# talks to the API directly, exactly as it does with the switch off. The one
# outcome that must not happen is a boot that exports the URL and no listener.
if [ "${WINNOW_FILTER:-}" = "1" ]; then
  # WHERE THE FILTER'S CODE COMES FROM, and why this is not just a default.
  #
  # This image already builds a pinned winnow at /opt/winnow/src - the same
  # `WINNOW_REF` the pruner runs from - yet the filter looked only under
  # /workspace, so an operator who set WINNOW_FILTER=1 on a stock image was
  # told to "clone winnow under the workspace this container mounts": a second
  # copy of something already inside the container, at a version that could
  # then differ from the one the pruner uses.
  #
  # MEASURED, which is why this is worth changing rather than documenting: on a
  # tool-heavy run the filter kept 12,096 bytes off the wire and saved 3.67% of
  # that run's cost, of which 2.3% is the avoided 2.0x cache write and needs no
  # assumptions. That saving sat behind an install step for a checkout the
  # image already had.
  #
  # An operator's own checkout still wins when they have one - they may be
  # tracking a different ref on purpose - and an explicit WINNOW_FILTER_PATH
  # still wins over both. This only supplies the fallback that stops the answer
  # being "clone what you already have".
  WINNOW_PATH="${WINNOW_FILTER_PATH:-}"
  if [ -z "$WINNOW_PATH" ]; then
    if [ -f /workspace/winnow/pyproject.toml ]; then
      WINNOW_PATH=/workspace/winnow
    elif [ -f /opt/winnow/src/pyproject.toml ]; then
      WINNOW_PATH=/opt/winnow/src
    else
      WINNOW_PATH=/workspace/winnow
    fi
  fi
  WINNOW_PORT="${WINNOW_FILTER_PORT:-8789}"
  WINNOW_STATE_VOLUME=/var/lib/winnow

  if [ ! -f "$WINNOW_PATH/pyproject.toml" ]; then
    echo "[usagefoundry] WINNOW_FILTER=1 but no checkout at $WINNOW_PATH, and" \
         "this image has none vendored either — agents will talk to the API" \
         "directly. Build with a WINNOW_REF, clone winnow under a mounted" \
         "workspace, or set WINNOW_FILTER_PATH." >&2
  else
    # The volume root, reclaimed on the terms /data's is at the top of this
    # file: Docker copies the image directory's ownership and mode onto a fresh
    # volume once and never revisits it, so an install that created this one
    # before these modes existed keeps whatever it was made with. Inside the
    # branch rather than beside the other three, because a volume nothing writes
    # needs no modes — this runs on the boot that switches the filter on.
    if ! mkdir -p "$WINNOW_STATE_VOLUME" 2>/dev/null ||
       ! chown 0:0 "$WINNOW_STATE_VOLUME" 2>/dev/null ||
       ! chmod 0755 "$WINNOW_STATE_VOLUME" 2>/dev/null; then
      echo "[usagefoundry] cannot reclaim $WINNOW_STATE_VOLUME — the filter's" \
           "off switch is writable by the agents, so a run can stop the filter" \
           "rewriting its own transcript." >&2
    fi

    # The ledger is handed over by name rather than by opening the directory,
    # and it has to be created here: a 0755 root directory is exactly what stops
    # the filter making it, and `_append_ledger` is best-effort — a ledger it
    # cannot write costs one line on stderr and is silent everywhere else,
    # including on the card that reads it.
    touch "$WINNOW_STATE_VOLUME/filter.jsonl" 2>/dev/null || true
    if [ -n "${UF_AGENT_UID:-}" ] &&
       ! { chown "0:${UF_AGENT_GID:-$UF_AGENT_UID}" "$WINNOW_STATE_VOLUME/filter.jsonl" 2>/dev/null &&
           chmod 0620 "$WINNOW_STATE_VOLUME/filter.jsonl" 2>/dev/null; }; then
      echo "[usagefoundry] cannot give $WINNOW_STATE_VOLUME/filter.jsonl to the" \
           "agent uid — the filter will rewrite every request and record none" \
           "of it, and the correction will read as zero." >&2
    fi

    # Carried over once from where the ledger used to live, so an install
    # upgrading into the uid drop keeps its record rather than starting an empty
    # one beside a file only root can still reach.
    if [ -s /data/winnow/filter.jsonl ] &&
       [ ! -s "$WINNOW_STATE_VOLUME/filter.jsonl" ]; then
      cat /data/winnow/filter.jsonl >>"$WINNOW_STATE_VOLUME/filter.jsonl" 2>/dev/null || true
    fi

    # The virtualenv belonged to root on every boot before this, and `uv run` at
    # the agent uid cannot write one it does not own. Handed over rather than
    # left to be rebuilt: the rebuild is the ninety seconds below, and on a
    # `restart` — which keeps the writable layer — it would be spent again on
    # every boot and then fail anyway.
    if [ -n "${UF_AGENT_UID:-}" ] && [ -d /home/node/.winnow-venv ]; then
      winnow_want="$UF_AGENT_UID:${UF_AGENT_GID:-$UF_AGENT_UID}"
      winnow_have="$(stat -c '%u:%g' /home/node/.winnow-venv 2>/dev/null || echo '')"
      if [ "$winnow_have" != "$winnow_want" ] &&
         ! chown -R "$winnow_want" /home/node/.winnow-venv 2>/dev/null; then
        echo "[usagefoundry] cannot give /home/node/.winnow-venv to" \
             "$winnow_want — the filter cannot build the virtualenv it runs in" \
             "and will not start. Remove that directory and restart." >&2
      fi
    fi

    # Everything below runs at UF_AGENT_UID, and both halves of that matter.
    #
    # `$WINNOW_PATH` is a checkout inside a workspace bind mount, which every
    # agent can write, and `uv run` executes what is there — the project's build
    # backend when it syncs, then winnow's own module. As root that is one run
    # putting its own code on every other run's transcript at uid 0, holding
    # this script's whole environment and root's reach into /data and
    # ~/.claude/.credentials.json. It is the argument `gh_as_agent` and
    # `uv_as_agent` are wrapped for, one step further along: those two exit,
    # this one keeps running for the life of the container.
    #
    # The environment is an allowlist rather than the inherited one because the
    # drop is what makes that matter. A root process's `/proc/<pid>/environ` is
    # out of the agents' reach; the same process at their own uid is not, so
    # UF_AUTH_TOKEN, ANTHROPIC_ADMIN_KEY, UF_GITHUB_TOKEN and UF_WEBHOOK_SECRET
    # left in it would be handed over by the very change that took root away —
    # the reason the Discord relay is started before its variable is unset, one
    # uid down. Nothing here needs a credential: the proxy relays the caller's
    # own headers upstream and reads no key of its own. A WINNOW_* knob added to
    # compose has to be added to this list as well or it arrives nowhere.
    #
    # UV_PYTHON_* are forwarded rather than dropped with the rest: without the
    # preference `uv` fetches a ~30 MB interpreter instead of using the one this
    # image already has, and without the directory it fetches it into the
    # writable layer, once per rebuild.
    winnow_filter_as_agent() {
      if [ -n "${UF_AGENT_UID:-}" ]; then
        setpriv --reuid="$UF_AGENT_UID" --regid="${UF_AGENT_GID:-$UF_AGENT_UID}" \
                --clear-groups \
          env -i "$@"
      else
        env -i "$@"
      fi
    }

    # HOW THE FILTER IS LAUNCHED, and why it is not always `uv run`.
    #
    # An operator's checkout is a project uv should resolve: it may be a
    # different ref and its lock is the one to honour. The tree this image
    # vendors is not - the Dockerfile already installed it into
    # /opt/winnow/venv and then made the source read-only with `chmod -R a+rX`,
    # so `uv run --project` there fails on `Cannot update time stamp of
    # directory 'src/winnow.egg-info'`: the build backend wants to write into a
    # tree that is deliberately not writable. It also has no reason to build at
    # all, because the venv beside it is that build.
    #
    # So the vendored copy is run from its own interpreter and everything else
    # goes through uv exactly as before.
    WINNOW_RUN_PATH="$PATH"
    if [ "$WINNOW_PATH" = /opt/winnow/src ] && [ -x /opt/winnow/venv/bin/python ]; then
      # No launcher at all: the venv goes on PATH so the plain `python` below
      # is that interpreter. Prepending beats naming the binary because the
      # command that follows is shared with the uv branch.
      WINNOW_LAUNCH=""
      WINNOW_RUN_PATH="/opt/winnow/venv/bin:$PATH"
    else
      WINNOW_LAUNCH="uv run --frozen --project $WINNOW_PATH"
    fi

    # UV_PROJECT_ENVIRONMENT is load-bearing, not tidiness. The checkout is a
    # bind mount shared with the operator's own machine, and `uv run` in a
    # project whose .venv was built by a different OS *deletes and rebuilds it*
    # — so without this, starting the filter destroys the virtualenv the
    # operator works in, on every boot.
    (
      while :; do
        winnow_filter_as_agent \
            PATH="$WINNOW_RUN_PATH" \
            HOME=/home/node \
            UV_PROJECT_ENVIRONMENT=/home/node/.winnow-venv \
            UV_PYTHON_INSTALL_DIR="$UV_PYTHON_INSTALL_DIR" \
            UV_PYTHON_PREFERENCE="$UV_PYTHON_PREFERENCE" \
            WINNOW_FILTER=1 \
          $WINNOW_LAUNCH \
            python -m winnow filter \
              --port "$WINNOW_PORT" \
              --ledger "$WINNOW_STATE_VOLUME/filter.jsonl" \
              --off-file "$WINNOW_STATE_VOLUME/filter-off" || true
        echo "[usagefoundry] winnow filter exited; restarting in 5s" >&2
        sleep 5
      done
    ) &

    # Up to 90s, because the first boot after a checkout builds a virtualenv and
    # every boot after it does not. Polled with the interpreter that is already
    # required to be here rather than a netcat the image does not ship.
    winnow_up=""
    i=0
    while [ "$i" -lt 90 ]; do
      if python3 -c "import socket,sys; s=socket.socket(); s.settimeout(1); sys.exit(s.connect_ex(('127.0.0.1', $WINNOW_PORT)))" 2>/dev/null; then
        winnow_up=1
        break
      fi
      i=$((i + 1))
      sleep 1
    done

    if [ -n "$winnow_up" ]; then
      export ANTHROPIC_BASE_URL="http://127.0.0.1:$WINNOW_PORT"
      # Pointing ANTHROPIC_BASE_URL anywhere but the API turns the CLI's tool
      # *deferral* off, and that is a bill the filter's own ledger never shows.
      # Deferred loading sends a tool's name and withholds its JSON schema until
      # the model asks for it through ToolSearch; with a custom base URL the CLI
      # stops offering ToolSearch at all and every schema rides every request.
      # Measured 2026-08-27 in this container, one variable changed and nothing
      # else: 30,845 tokens direct against 48,074 through the proxy on the real
      # spawn argv — 17,229 tokens on the cold write and again at the cache-read
      # rate on every turn after it. On the corpus the same step is visible as a
      # cliff: 528 sessions before it opened at a median 36,597 and the 63 after
      # at 51,388, the change landing 2026-08-24T14:05, which is when this block
      # was first switched on.
      #
      # Setting it to "1" restores exactly the behaviour of talking to the API
      # directly — 30,849 measured on the same argv, back within 4 tokens — so
      # this is not a new mode, it is the one the filter took away. It belongs
      # inside this branch rather than in compose because it is only ever wrong
      # when the base URL above is unset.
      export ENABLE_TOOL_SEARCH=1
      echo "[usagefoundry] winnow intake filter on 127.0.0.1:$WINNOW_PORT;" \
           "agents routed through it. To stop it rewriting without a restart:" \
           "docker compose exec usagefoundry touch $WINNOW_STATE_VOLUME/filter-off" >&2
    else
      echo "[usagefoundry] winnow filter did not open 127.0.0.1:$WINNOW_PORT" \
           "within 90s — agents will talk to the API directly. The supervisor" \
           "is still retrying; its output is above." >&2
    fi
  fi
fi

exec "$@"
