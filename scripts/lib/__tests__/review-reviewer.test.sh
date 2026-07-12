#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# shellcheck source=scripts/lib/review-reviewer.sh
. "$repo_root/scripts/lib/review-reviewer.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_auto_selected() {
  local expected="$1"
  shift
  local actual
  actual="$(
    unset CODEX_THREAD_ID CODEX_MANAGED_PACKAGE_ROOT CODEX_CI
    while [ $# -gt 0 ]; do
      export "${1?}"
      shift
    done
    review_select_reviewer auto
  )"
  [ "$actual" = "$expected" ] || fail "expected $expected, selected $actual"
}

assert_auto_selected codex
assert_auto_selected claude CODEX_THREAD_ID=thread-1
assert_auto_selected claude CODEX_MANAGED_PACKAGE_ROOT=/tmp/codex
assert_auto_selected claude CODEX_CI=1
assert_auto_selected codex CODEX_CI=0

[ "$(CODEX_THREAD_ID=thread-1 review_select_reviewer codex)" = "codex" ] ||
  fail "codex override was not honored"
[ "$(review_select_reviewer claude)" = "claude" ] ||
  fail "claude override was not honored"

if review_select_reviewer invalid >/dev/null 2>&1; then
  fail "invalid reviewer override unexpectedly succeeded"
fi

review_should_retry_inline 0 "" || fail "empty successful output did not request an inline retry"
review_should_retry_inline 0 $' \n\t' || fail "whitespace-only successful output did not request an inline retry"
if review_should_retry_inline 0 '{"ok":true}'; then
  fail "non-empty successful output requested an inline retry"
fi
if review_should_retry_inline 1 ""; then
  fail "failed reviewer requested an inline retry"
fi

failure_message="$(review_fail_closed_message codex "command not found on PATH")"
case "$failure_message" in
  *"Independent review could not be completed by 'codex'"*) ;;
  *) fail "fail-closed message does not name the selected reviewer" ;;
esac
case "$failure_message" in
  *"fails closed"*"will not fall back"*) ;;
  *) fail "fail-closed message does not explain fallback policy" ;;
esac
case "$failure_message" in
  *"REVIEWER_CLI=claude|codex"*) ;;
  *) fail "fail-closed message does not explain the explicit override" ;;
esac

review_script="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/review.sh"
grep -Fq 'CLAUDE_REVIEW_MODEL="${CLAUDE_REVIEW_MODEL:-fable}"' "$review_script" ||
  fail "Claude reviewer must default to the Fable model"

schema_arg_count="$(grep -F -- '--json-schema "$(cat "$SCHEMA_FILE")"' "$review_script" | wc -l | tr -d ' ')"
[ "$schema_arg_count" -eq 2 ] ||
  fail "Claude reviewer must receive the verdict schema inline and in Herdr"

grep -Fq '2> "$diagnostic_file"' "$review_script" ||
  fail "inline Codex reviewer stderr must be retained for fail-closed diagnostics"

echo "review reviewer selection tests passed"
