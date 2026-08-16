#!/usr/bin/env bash
# Drive probe.sh's answer logic against stubbed binaries.
#
# The nine questions themselves cannot be run anywhere but a probe container on
# an operator's machine — they need Docker, a relaxed seccomp profile, a real
# bubblewrap and a billed CLI. What *can* be checked anywhere is the half that
# turns a command's outcome into the line somebody transcribes: that a Write
# tool escaping its allowlist reads as BASH-ONLY and not as SESSION-WIDE, that a
# credential the shell could still read is never reported as a win, that a
# missing dependency is a hard exit rather than a silent skip.
#
# Same shape as `file-health-check-issues.test.sh`: stubs on PATH, one scenario
# per assertion, no network and no money.
#
# Two questions are out of reach here and are covered by nothing: 0 runs
# `apt-get update` and 5 writes `/etc/claude-code/managed-settings.json`, both of
# which need root, and neither path is worth a knob that exists only for a test.
# What they have in common is that a wrong answer from either is loud rather than
# quiet — an apt failure and a permission error both stop the question.
#
#   ./scripts/sandbox-probe/probe.test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$HERE/probe.sh"
# Under $HOME rather than /tmp, because probe.sh refuses to run when the paths a
# question writes to sit inside the allowlist it hands the CLI — and /tmp is in
# every one of those allowlists. Overridable for a home directory that is not
# writable.
ROOT="$(mktemp -d "${UF_PROBE_TEST_ROOT:-$HOME}/uf-probe-test.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

PASS=0
FAIL=0

# ---------------------------------------------------------------------------
# Stubs. Each reads the scenario out of the environment rather than guessing,
# so a test names the outcome it is arranging.
# ---------------------------------------------------------------------------

mkdir -p "$ROOT/bin"

cat > "$ROOT/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -u
case "${1:-}" in
  --version) echo "${STUB_CLI_VERSION:-2.1.226 (Claude Code)}"; exit 0 ;;
  --help) echo "  --max-budget-usd <amount>   Cap the cost of this turn"; exit 0 ;;
esac

prompt=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-p" ]; then prompt="${2:-}"; break; fi
  shift
done

case "$prompt" in
  *"print ok"*)                       # question 2
    if [ "${STUB_Q2:-refuse}" = refuse ]; then
      echo "Error: sandbox.enabled is true but bubblewrap could not be started" >&2
      exit 1
    fi
    echo ok; exit 0 ;;
  *WRITE-TOOL-LANDED*)                # question 3
    case "${STUB_Q3:-session}" in
      session) echo "Both writes were refused." ;;
      bash)    : > "$PROBE_OUTSIDE/write-tool.txt"; echo "Write landed, Bash refused." ;;
      both)    : > "$PROBE_OUTSIDE/write-tool.txt"; : > "$PROBE_OUTSIDE/bash-tool.txt" ;;
      inverted) : > "$PROBE_OUTSIDE/bash-tool.txt" ;;
    esac
    exit 0 ;;
  *cred-check.sh*)                    # question 4 — runs the real helper, on the
                                      # path the probe actually asked for
    cmd="$(printf '%s' "$prompt" | grep -oE '/[^ ]*cred-check\.sh [^ ]+' | head -1)"
    "${cmd%% *}" "${cmd#* }"
    exit "${STUB_Q4_EXIT:-0}" ;;
  *pid-check.sh*)                     # question 7 — runs the real helper
    pid="$(printf '%s' "$prompt" | grep -oE 'pid-check\.sh [0-9]+' | awk '{print $2}')"
    if [ "${STUB_Q7:-shared}" = shared ]; then
      "$PROBE_SCRATCH/bin/pid-check.sh" "$pid"
    else
      echo "UF-Q7 pid=1 procs=3 sentinel_visible=no sentinel_signalable=no"
    fi
    exit 0 ;;
  *curl*)                             # question 6
    echo "exit status 0"; exit 0 ;;
  *WIDENED*)                          # question 5
    [ "${STUB_Q5:-widen}" = widen ] && printf 'WIDENED\n' > "$PROBE_WIDEN/widened.txt"
    echo "done"; exit 0 ;;
  *NESTED*)                           # question 8d
    if [ "${STUB_Q8D:-ok}" = ok ]; then
      printf 'NESTED\n' > "$PROBE_OUTSIDE/nested.txt"; echo "done"; exit 0
    fi
    echo "Error: the sandbox could not start: bwrap exited 1" >&2; exit 1 ;;
esac
echo "stub claude: unrecognised prompt" >&2
exit 3
STUB

cat > "$ROOT/bin/bwrap" <<'STUB'
#!/usr/bin/env bash
# Strips the bubblewrap options this probe uses and runs what is left, so a
# nested `bwrap … bwrap … true` and a `bwrap … claude …` both reach their inner
# command. --tmp-overlay is answered rather than run: the point of that probe is
# a write that leaves nothing behind, which a stub cannot honestly perform.
set -u
case "${1:-}" in --version) echo "bubblewrap ${STUB_BWRAP_VERSION:-0.8.0}"; exit 0 ;; esac

overlay=false
while [ $# -gt 0 ]; do
  case "$1" in
    --unshare-user|--unshare-pid|--die-with-parent|--new-session) shift ;;
    --ro-bind|--bind) shift 3 ;;
    --dev|--proc) shift 2 ;;
    --tmp-overlay) overlay=true; shift 2 ;;
    *) break ;;
  esac
done

if [ "${STUB_BWRAP:-ok}" != ok ]; then
  echo "bwrap: No permissions to creating new namespace, likely because the kernel does not allow non-privileged user namespaces" >&2
  exit 1
fi

if $overlay; then
  case "${STUB_OVERLAY:-ok}" in
    ok)           echo "UF-Q8B pid=1"; echo "OVERLAY-OK"; exit 0 ;;
    unknown-flag) echo "bwrap: Unknown option --tmp-overlay" >&2; exit 1 ;;
    refused)      echo "bwrap: Can't make overlay mount on /usr: Operation not permitted" >&2; exit 1 ;;
  esac
fi

exec "$@"
STUB

cat > "$ROOT/bin/unshare" <<'STUB'
#!/usr/bin/env bash
exit "${STUB_UNSHARE_EXIT:-0}"
STUB

chmod 0755 "$ROOT/bin/claude" "$ROOT/bin/bwrap" "$ROOT/bin/unshare"

# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------

# Runs probe.sh in a clean scenario directory. Everything after the scenario
# name is passed through to probe.sh; scenario variables come from the caller's
# environment.
run_probe() {
  local name="$1"; shift
  local dir="$ROOT/run"
  rm -rf "$dir"
  mkdir -p "$dir/home/.claude"
  # Never a real credential: what question 4 needs is a file at that path whose
  # permission bits it can arrange, and nothing ever reads its contents.
  if [ -n "${CRED_SEEDED:-}" ]; then
    printf 'not-a-token\n' > "$dir/home/.claude/.credentials.json"
    chmod "${CRED_MODE:-600}" "$dir/home/.claude/.credentials.json"
  fi
  OUT="$dir/output.txt"
  set +e
  env PATH="${STUB_PATH:-$ROOT/bin:$PATH}" \
      PROBE_HOME="$dir/home" \
      PROBE_SCRATCH="$dir/scratch" \
      PROBE_OUTSIDE="$dir/outside" \
      PROBE_WIDEN="$dir/widen" \
      PROBE_TIMEOUT=30 \
      bash "$PROBE" --force "$@" > "$OUT" 2>&1
  RC=$?
  set -e
  LAST_NAME="$name"
}

expect_line() {
  local wanted="$1"
  if grep -qF "$wanted" "$OUT"; then
    PASS=$((PASS + 1)); printf '  ok   %s → %s\n' "$LAST_NAME" "$wanted"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL %s → expected "%s"\n' "$LAST_NAME" "$wanted"
    sed 's/^/       │ /' "$OUT" | tail -25
  fi
}

expect_rc() {
  local wanted="$1"
  if [ "$RC" = "$wanted" ]; then
    PASS=$((PASS + 1)); printf '  ok   %s → exit %s\n' "$LAST_NAME" "$wanted"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL %s → expected exit %s, got %s\n' "$LAST_NAME" "$wanted" "$RC"
    sed 's/^/       │ /' "$OUT" | tail -25
  fi
}

# ---------------------------------------------------------------------------
# Refusals — the ones that must never degrade into a half-answer
# ---------------------------------------------------------------------------
echo "refusals:"

run_probe "no question selected" ; expect_rc 2
run_probe "--only with a word" --only bwrap ; expect_rc 2
run_probe "billed without consent, no tty" --only 3 --billed < /dev/null ; expect_rc 2
expect_line "stdin is not a terminal"

STUB_PATH="/usr/bin:/bin" run_probe "missing claude" --billed --yes-bill
expect_rc 2
expect_line "missing dependency: claude"

STUB_PATH="/usr/bin:/bin" run_probe "missing bwrap" --free
expect_rc 2
expect_line "missing dependency: bwrap"

run_probe "question 2 in an image that has bwrap" --only 2 --yes-bill
expect_rc 2
expect_line "question 2 needs the image WITHOUT bubblewrap"

# Not through run_probe: this one is about PROBE_SCRATCH itself.
RC=0
env PATH="$ROOT/bin:$PATH" PROBE_SCRATCH=/workspace/uf-probe-scratch \
    PROBE_HOME="$ROOT/run/home" bash "$PROBE" --force --only 3 --yes-bill \
    > "$ROOT/mounted.txt" 2>&1 || RC=$?
OUT="$ROOT/mounted.txt"; LAST_NAME="scratch inside a mounted workspace"
expect_rc 2
expect_line "is a path this app mounts"

# A target inside the allowlist would land every write and report that nothing
# is confined, which is the wrong answer rather than no answer.
RC=0
env PATH="$ROOT/bin:$PATH" PROBE_HOME="$ROOT/run/home" PROBE_SCRATCH="$ROOT/run/scratch" \
    PROBE_OUTSIDE=/tmp/uf-probe-outside PROBE_WIDEN="$ROOT/run/widen" \
    bash "$PROBE" --force --only 3 --yes-bill > "$ROOT/inside.txt" 2>&1 || RC=$?
OUT="$ROOT/inside.txt"; LAST_NAME="write target inside the allowlist"
expect_rc 2
expect_line "is inside the allowlist"

# ---------------------------------------------------------------------------
# The unbilled questions
# ---------------------------------------------------------------------------
echo "questions 1 and 8 (unbilled):"

run_probe "bwrap starts" --only 1 ; expect_line "Q1: BWRAP-OK"

STUB_BWRAP=blocked STUB_UNSHARE_EXIT=1 run_probe "bwrap blocked" --only 1
expect_line "Q1: BWRAP-BLOCKED"
expect_line "user-namespaces-refused-too"

run_probe "overlay available" --only 8 --free
expect_line "Q8a: BWRAP-VERSION 0.8.0"
expect_line "Q8b: OVERLAY-OK"
expect_line "Q8c: NEST-OK"

STUB_OVERLAY=unknown-flag run_probe "no --tmp-overlay on this bwrap" --only 8 --free
expect_line "Q8b: OVERLAY-UNAVAILABLE"

STUB_OVERLAY=refused run_probe "overlayfs refused by the kernel" --only 8 --free
expect_line "Q8b: OVERLAY-REFUSED"

# ---------------------------------------------------------------------------
# The billed questions, with the CLI stubbed
# ---------------------------------------------------------------------------
echo "questions 2-8d (stubbed CLI):"

STUB_PATH="/usr/bin:/bin:$ROOT/bin-nobwrap" \
  mkdir -p "$ROOT/bin-nobwrap" && cp "$ROOT/bin/claude" "$ROOT/bin-nobwrap/claude"
STUB_PATH="$ROOT/bin-nobwrap:/usr/bin:/bin" run_probe "CLI refuses with no bwrap" --only 2 --yes-bill
expect_line "Q2: REFUSED"

STUB_PATH="$ROOT/bin-nobwrap:/usr/bin:/bin" STUB_Q2=run \
  run_probe "CLI runs anyway with no bwrap" --only 2 --yes-bill
expect_line "Q2: RAN-UNSANDBOXED"

STUB_Q3=session run_probe "sandbox around the session" --only 3 --yes-bill
expect_line "Q3: SESSION-WIDE"

STUB_Q3=bash run_probe "sandbox around Bash only" --only 3 --yes-bill
expect_line "Q3: BASH-ONLY"

STUB_Q3=both run_probe "policy confined nothing" --only 3 --yes-bill
expect_line "Q3: INCONCLUSIVE"
expect_line "both writes landed"

# A credential the sandboxed shell can still open is the answer that must never
# be reported as a win, so it is arranged first.
CRED_SEEDED=1 run_probe "credential still readable" --only 4 --yes-bill
expect_line "Q4: DENY-INEFFECTIVE"

# A file this uid cannot open stands in for a deny entry that works. The turn
# still exits 0, which is the other half of the question: denied to the shell,
# and the session still authenticated.
CRED_SEEDED=1 CRED_MODE=000 run_probe "credential denied to the shell" --only 4 --yes-bill
expect_line "Q4: DENY-WORKS"

run_probe "no credential mounted at all" --only 4 --yes-bill
expect_line "Q4: INCONCLUSIVE"
expect_line "no credentials file at"

STUB_Q7=shared run_probe "pid namespace shared" --only 7 --yes-bill
expect_line "Q7: PID-SHARED"

STUB_Q7=isolated run_probe "pid namespace unshared" --only 7 --yes-bill
expect_line "Q7: PID-ISOLATED"

run_probe "task cost sampled" --only 6 --yes-bill
expect_line "Q6: MEASURED"

STUB_Q8D=ok run_probe "the two layers nest" --only 8 --yes-bill
expect_line "Q8d: NEST-OK"

STUB_Q8D=fail run_probe "the two layers do not nest" --only 8 --yes-bill
expect_line "Q8d: NEST-FAILED"

# ---------------------------------------------------------------------------
echo ""
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
