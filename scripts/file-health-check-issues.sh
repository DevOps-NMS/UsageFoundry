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
#
# `file-health-check-issues.test.sh` beside this runs it against a stubbed gh.
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

# The labels this repository actually defines, so an undefined one can be
# dropped per label instead of failing the whole `gh issue create` and costing
# the labels beside it. Read once — it is the same answer for every section.
# If the query itself fails (no network, no permission) every label is passed
# through unfiltered, which is exactly today's behaviour, and the `||` fallback
# below is still there to catch the failure.
declare -A KNOWN_LABELS=()
known_labels_read=0
if labels_list="$(gh label list --repo "$REPO" --limit 200 --json name --jq '.[].name' 2>/dev/null)"; then
  known_labels_read=1
  while IFS= read -r name; do
    if [ -n "$name" ]; then KNOWN_LABELS["$name"]=1; fi
  done <<< "$labels_list"
fi

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
  labels_line="$(printf '%s' "$body" | grep -oP '^\*\*Labels:\*\* \K.*' || true)"
  body="$(printf '%s' "$body" | grep -v '^\*\*Labels:\*\* ')"
  body="$(printf '%s\n\n---\nFound by an automated code health check of `%s`.\n' \
    "$body" "$(git -C "$ROOT" rev-parse --short HEAD)")"

  # `--label` is repeatable, and cobra splits a comma-separated value without
  # trimming it: `--label "bug, dead-code"` reaches the API as `bug` and
  # ` dead-code`, and that leading space makes the second one unknown even when
  # the label exists — so one flag per label, each trimmed here.
  apply=()
  skipped=()
  while IFS= read -r label; do
    if [ -z "$label" ]; then continue; fi
    if [ "$known_labels_read" = 1 ] && [ -z "${KNOWN_LABELS[$label]:-}" ]; then
      skipped+=("$label")
    else
      apply+=("$label")
    fi
  done < <(printf '%s\n' "$labels_line" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')

  if gh issue list --repo "$REPO" --state all --search "\"$title\" in:title" \
       --json title --jq '.[].title' | grep -qxF "$title"; then
    echo "skip (exists): $title"
    continue
  fi

  if [ ${#skipped[@]} -gt 0 ]; then
    dropped="$(printf '%s, ' "${skipped[@]}")"
    echo "$title: no such label in $REPO, skipping: ${dropped%, }" >&2
  fi

  if [ -n "${DRY_RUN:-}" ]; then
    # One bracket per label, so a label still carrying whitespace or a comma is
    # visible here rather than only in what gh rejects.
    if [ ${#apply[@]} -gt 0 ]; then
      shown="$(printf '[%s] ' "${apply[@]}")"
      shown="${shown% }"
    else
      shown="[none]"
    fi
    echo "would file: $title  $shown"
    continue
  fi

  label_args=()
  for label in ${apply[@]+"${apply[@]}"}; do label_args+=(--label "$label"); done

  # --label is still best-effort: a label the repo has not defined makes gh fail
  # the whole call, and losing the issue over a missing chip is the wrong trade.
  gh issue create --repo "$REPO" --title "$title" --body "$body" \
    ${label_args[@]+"${label_args[@]}"} \
    || gh issue create --repo "$REPO" --title "$title" --body "$body"
done
