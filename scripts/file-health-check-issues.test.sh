#!/usr/bin/env bash
# Exercise file-health-check-issues.sh against a stubbed `gh` and a fixture
# report. Not part of `npm test` — that compiles src/**/*.test.ts — so run it
# directly:
#
#   ./scripts/file-health-check-issues.test.sh
#
# The stub reproduces the one piece of gh behaviour this script has to get
# right: `--label` is a cobra string slice, so it splits a comma-separated
# value and does *not* trim the pieces. Without that, the bug this file pins
# would be invisible here and visible only against the live API.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT:-$HERE/file-health-check-issues.sh}"
KNOWN="bug,documentation,enhancement"

failures=0
check() { # check <what> <expected> <actual>
  if [ "$2" = "$3" ]; then
    echo "ok   $1"
  else
    echo "FAIL $1"
    echo "       expected: $2"
    echo "       actual:   $3"
    failures=$((failures + 1))
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- the fake repository the script runs against ------------------------------
ROOT="$TMP/repo"
mkdir -p "$ROOT/scripts"
cp "$SCRIPT" "$ROOT/scripts/file-health-check-issues.sh"
chmod +x "$ROOT/scripts/file-health-check-issues.sh"

cat > "$ROOT/HEALTH-CHECK.md" <<'REPORT'
# Fixture report

### 1. Two labels the repo defines

**Labels:** bug, documentation

Section one body.

---

### 2. One defined label and one it does not

**Labels:** bug, dead-code

Section two body.

---

### 3. A single defined label

**Labels:** documentation

Section three body.

---

### 4. A single label the repo does not define

**Labels:** dead-code

Section four body.

---

### 5. No labels line at all

Section five body.

---
REPORT

git -C "$ROOT" init -q
git -C "$ROOT" -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m fixture

# --- the gh stub --------------------------------------------------------------
BIN="$TMP/bin"
mkdir -p "$BIN"
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
known() { printf '%s\n' "$GH_STUB_LABELS" | tr ',' '\n'; }

case "${1:-}:${2:-}" in
  label:list)
    if [ -n "${GH_STUB_LABEL_LIST_FAILS:-}" ]; then
      echo "stub: label list unavailable" >&2
      exit 1
    fi
    known
    ;;
  issue:list)
    # No issue ever already exists, so every section is filed.
    ;;
  issue:create)
    shift 2
    title=""; body=""; labels=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --title) title="$2"; shift 2 ;;
        --body)  body="$2";  shift 2 ;;
        --repo)  shift 2 ;;
        --label)
          # cobra splits a comma-separated string slice and leaves the
          # surrounding whitespace on the pieces.
          while IFS= read -r part; do labels+=("$part"); done < <(printf '%s\n' "$2" | tr ',' '\n')
          shift 2 ;;
        *) shift ;;
      esac
    done
    applied=""
    for label in ${labels[@]+"${labels[@]}"}; do
      if ! known | grep -qxF -- "$label"; then
        echo "could not add label: '$label' not found" >&2
        exit 1
      fi
      applied+="$label|"
    done
    printf 'CREATE\t%s\t%s\t%s\n' "$title" "$applied" \
      "$(printf '%s' "$body" | tr '\n' '~')" >> "$GH_STUB_LOG"
    ;;
esac
STUB
chmod +x "$BIN/gh"

LOG="$TMP/created.log"
export GH_STUB_LABELS="$KNOWN" GH_STUB_LOG="$LOG"
export PATH="$BIN:$PATH"

field() { # field <title> <column> — column 3 is labels, 4 is body
  grep -F "	$1	" "$LOG" | head -1 | cut -f"$2"
}
creates() { grep -cF "	$1	" "$LOG"; }

# --- real filing --------------------------------------------------------------
: > "$LOG"
REPO=fixture/repo "$ROOT/scripts/file-health-check-issues.sh" > "$TMP/out" 2> "$TMP/err"
check "run exits 0" 0 $?

check "both defined labels are applied" \
  "bug|documentation|" "$(field 'Two labels the repo defines' 3)"
check "a defined label survives an undefined one beside it" \
  "bug|" "$(field 'One defined label and one it does not' 3)"
check "a single defined label is unchanged" \
  "documentation|" "$(field 'A single defined label' 3)"
check "a single undefined label files with no labels" \
  "" "$(field 'A single label the repo does not define' 3)"
check "a section with no Labels line files with no labels" \
  "" "$(field 'No labels line at all' 3)"

check "each section is filed exactly once" \
  "1 1 1 1 1" "$(creates 'Two labels the repo defines') $(creates 'One defined label and one it does not') $(creates 'A single defined label') $(creates 'A single label the repo does not define') $(creates 'No labels line at all')"

body="$(field 'Two labels the repo defines' 4)"
check "the Labels line is stripped from the body" \
  "absent" "$(case "$body" in *'**Labels:**'*) echo present ;; *) echo absent ;; esac)"
check "the body itself survives" \
  "present" "$(case "$body" in *'Section one body.'*) echo present ;; *) echo absent ;; esac)"

check "a skipped label is named, with the section it came from" \
  "present" "$(grep -qF 'One defined label and one it does not: no such label in fixture/repo, skipping: dead-code' "$TMP/err" && echo present || echo absent)"

# --- dry run ------------------------------------------------------------------
: > "$LOG"
DRY_RUN=1 REPO=fixture/repo "$ROOT/scripts/file-health-check-issues.sh" > "$TMP/dry" 2>/dev/null
check "dry run files nothing" "" "$(cat "$LOG")"
check "dry run prints labels as a list" \
  "present" "$(grep -qF 'would file: Two labels the repo defines  [bug] [documentation]' "$TMP/dry" && echo present || echo absent)"
check "dry run prints no labels as [none]" \
  "present" "$(grep -qF 'would file: No labels line at all  [none]' "$TMP/dry" && echo present || echo absent)"

# --- the label list itself being unreadable -----------------------------------
# Nothing can be filtered, so every label is passed through as its own flag and
# the existing `|| gh issue create` fallback is what catches an undefined one.
: > "$LOG"
GH_STUB_LABEL_LIST_FAILS=1 REPO=fixture/repo "$ROOT/scripts/file-health-check-issues.sh" >/dev/null 2>&1
check "unfiltered: defined labels still both applied" \
  "bug|documentation|" "$(field 'Two labels the repo defines' 3)"
check "unfiltered: an undefined label still falls back to no labels" \
  "" "$(field 'One defined label and one it does not' 3)"

echo
if [ "$failures" -eq 0 ]; then
  echo "all checks passed"
else
  echo "$failures check(s) failed"
  exit 1
fi
