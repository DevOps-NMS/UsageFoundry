#!/usr/bin/env bash
# File the findings in HEALTH-CHECK.md as GitHub issues.
#
# Split out from the report itself because filing needs credentials the health
# check does not: run this wherever `gh auth status` already passes. It is
# idempotent by title — an issue whose title already exists (open or closed) is
# skipped rather than duplicated, so a partial run can simply be re-run.
#
#   ./scripts/file-health-check-issues.sh            # file them
#   DRY_RUN=1 ./scripts/file-health-check-issues.sh  # print what would be filed
set -euo pipefail

REPO="${REPO:-Xapicc/UsageFoundry}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT="$ROOT/HEALTH-CHECK.md"

command -v gh >/dev/null || { echo "gh CLI not found. Install it or run this elsewhere." >&2; exit 1; }
[ -f "$REPORT" ] || { echo "No $REPORT" >&2; exit 1; }

# Sections are `### <n>. <title>` down to the next `###` or `---` at column 0.
# awk rather than a markdown parser: the report's shape is fixed and checked in
# beside this script, so a dependency would buy nothing.
mapfile -t NUMBERS < <(grep -oP '^### \K[0-9]+(?=\.)' "$REPORT")

for n in "${NUMBERS[@]}"; do
  title="$(grep -oP "^### $n\. \K.*" "$REPORT")"
  body="$(awk -v n="$n" '
    $0 ~ "^### " n "\\. " { grab = 1; next }
    grab && /^### / { exit }
    grab && /^---$/ { exit }
    grab { print }
  ' "$REPORT")"

  # Labels live on a `**Labels:**` line inside the section; drop it from the
  # body so it does not render as text next to the real label chips.
  labels="$(printf '%s' "$body" | grep -oP '^\*\*Labels:\*\* \K.*' || true)"
  body="$(printf '%s' "$body" | grep -v '^\*\*Labels:\*\* ')"
  body="$(printf '%s\n\n---\nFound by an automated code health check of `%s`.\n' \
    "$body" "$(git -C "$ROOT" rev-parse --short HEAD)")"

  if gh issue list --repo "$REPO" --state all --search "\"$title\" in:title" \
       --json title --jq '.[].title' | grep -qxF "$title"; then
    echo "skip (exists): $title"
    continue
  fi

  if [ -n "${DRY_RUN:-}" ]; then
    echo "would file: $title  [${labels:-none}]"
    continue
  fi

  # --label is best-effort: a label the repo has not defined makes gh fail the
  # whole call, and losing the issue over a missing chip is the wrong trade.
  gh issue create --repo "$REPO" --title "$title" --body "$body" \
    ${labels:+--label "$labels"} \
    || gh issue create --repo "$REPO" --title "$title" --body "$body"
done
