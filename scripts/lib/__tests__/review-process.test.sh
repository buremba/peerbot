#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=scripts/lib/review-process.sh
. "$repo_root/scripts/lib/review-process.sh"

tmp="$(mktemp -d /tmp/lobu-review-process-test.XXXXXX)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

HERDR_WORKSPACE_ID='test-workspace'
REVIEW_HERDR_PANE_ID=''
REVIEW_HERDR_PANE_NAME='test-review-pane'
REVIEW_HERDR_RAW_FILE="$tmp/raw"
REVIEW_HERDR_EXIT_FILE="$tmp/exit"
touch "$REVIEW_HERDR_RAW_FILE" "$REVIEW_HERDR_EXIT_FILE"

herdr() {
  case "$1 $2" in
    'pane list')
      printf '%s\n' '{"result":{"panes":[{"label":"test-review-pane","pane_id":"test-pane"}]}}'
      ;;
    'pane close')
      printf '%s\n' "$*" >> "$tmp/herdr-calls"
      # Simulate the pane racing to write its exit marker during close.
      touch "$REVIEW_HERDR_EXIT_FILE"
      ;;
    *) return 1 ;;
  esac
}

close_review_herdr_pane
grep -Fx 'pane close test-pane' "$tmp/herdr-calls" >/dev/null ||
  fail "Herdr pane was not closed"
[ ! -e "$tmp/raw" ] || fail "Herdr raw file survived cleanup"
[ ! -e "$tmp/exit" ] || fail "late Herdr exit file survived cleanup"
[ -z "$REVIEW_HERDR_PANE_ID" ] || fail "Herdr pane ownership was not cleared"

echo "review process tests passed"
