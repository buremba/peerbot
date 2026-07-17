#!/usr/bin/env bash
# Lifecycle tests for make review's optional Herdr tab (CLAUDE_REVIEW_HERDR=1).
# Task worktree Herdr auto-tabs were removed — agents use their own tooling.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# shellcheck source=scripts/lib/herdr-review-lifecycle.sh
. "$repo_root/scripts/lib/herdr-review-lifecycle.sh"

tmp="$(mktemp -d /tmp/lobu-herdr-lifecycle-test.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
calls="$tmp/herdr-calls"
mode="default"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_missing() {
  [ ! -e "$1" ] || fail "expected $1 to be removed"
}

herdr() {
  printf '%s\n' "$*" >> "$calls"
  case "${1:-} ${2:-}" in
    "tab get")
      if [ "$mode" = "review-close-failure" ]; then
        printf '{"result":{"tab":{"tab_id":"workspace-a:review-tab"}}}\n'
      else
        return 1
      fi
      ;;
    "tab close")
      if [ "$mode" = "review-close-failure" ]; then
        marker="$HERDR_REVIEW_EXIT_FILE"
        (sleep 0.1; printf 'late\n' > "$marker") &
        return 1
      fi
      ;;
    "tab list")
      if [ "$mode" = "invalid-review-shape" ]; then
        printf '{}\n'
      elif [ "$mode" = "review-locator" ]; then
        if grep -q '^tab close workspace-a:located-review$' "$calls"; then
          printf '{"result":{"tabs":[{"tab_id":"workspace-a:stale-review","label":"locator-review"}]}}\n'
        else
          printf '{"result":{"tabs":[{"tab_id":"workspace-a:stale-review","label":"locator-review"},{"tab_id":"workspace-a:located-review","label":"locator-review"}]}}\n'
        fi
      else
        printf '{"result":{"tabs":[]}}\n'
      fi
      ;;
    "pane list")
      if [ "$mode" = "invalid-review-shape" ]; then
        printf '{}\n'
      elif [ "$mode" = "review-locator" ]; then
        printf '{"result":{"panes":[{"tab_id":"workspace-a:stale-review","cwd":"%s","foreground_cwd":"%s"},{"tab_id":"workspace-a:located-review","cwd":"%s","foreground_cwd":"%s"}]}}\n' "$HERDR_REVIEW_CWD" "$HERDR_REVIEW_CWD" "$HERDR_REVIEW_CWD" "$HERDR_REVIEW_CWD"
      else
        printf '{"result":{"panes":[]}}\n'
      fi
      ;;
  esac
  return 0
}

test_review_parses_current_herdr_tab_response() {
  local parsed
  parsed="$(herdr_review_parse_created_tab '{"id":"cli:tab:create","result":{"type":"tab_created","tab":{"tab_id":"workspace-a:review-tab"},"root_pane":{"pane_id":"workspace-a:review-pane"}}}')"
  [ "$parsed" = "workspace-a:review-tab workspace-a:review-pane" ] ||
    fail "current Herdr tab response parsed as: $parsed"
}

test_review_cleanup_closes_tab_and_removes_temp_files() {
  local raw="$tmp/review.raw" exit_file="$tmp/review.exit" runner="$tmp/review.runner"
  printf 'review output\n' > "$raw"
  printf '0\n' > "$exit_file"
  printf 'runner\n' > "$runner"
  : > "$calls"
  mode="default"

  herdr_review_track_files "$raw" "$exit_file" "$runner"
  herdr_review_track_tab "workspace-a:review-tab"
  herdr_review_cleanup

  grep -Fxq "tab close workspace-a:review-tab" "$calls" ||
    fail "normal review cleanup did not close its tab"
  grep -Fxq "tab get workspace-a:review-tab" "$calls" ||
    fail "normal review cleanup did not verify tab closure"
  assert_file_missing "$raw"
  assert_file_missing "$exit_file"
  assert_file_missing "$runner"
}

test_review_abort_closes_tab_but_preserves_partial_output() {
  local raw="$tmp/aborted.raw" exit_file="$tmp/aborted.exit" runner="$tmp/aborted.runner"
  printf 'partial review output\n' > "$raw"
  printf 'runner\n' > "$runner"
  : > "$calls"
  mode="review-locator"

  herdr_review_track_files "$raw" "$exit_file" "$runner"
  # Model interruption after tab creation but before create's JSON was parsed:
  # cleanup must ignore a pre-existing same-label tab and recover only the new
  # tab whose pane has this run's exact cwd.
  herdr_review_track_locator "workspace-a" "locator-review" "$tmp" "workspace-a:stale-review"
  herdr_review_abort >/dev/null 2>&1

  grep -Fxq "tab close workspace-a:located-review" "$calls" ||
    fail "aborted review cleanup did not close its tab"
  if grep -Fxq "tab close workspace-a:stale-review" "$calls"; then
    fail "aborted review cleanup closed the stale same-label tab"
  fi
  [ -s "$raw" ] || fail "aborted review output was not preserved"
  assert_file_missing "$exit_file"
  assert_file_missing "$runner"
}

test_review_close_failure_preserves_state_and_transport() {
  local raw="$tmp/failed-close.raw" exit_file="$tmp/failed-close.exit" runner="$tmp/failed-close.runner"
  printf 'partial review output\n' > "$raw"
  printf 'runner\n' > "$runner"
  : > "$calls"
  mode="review-close-failure"

  herdr_review_track_files "$raw" "$exit_file" "$runner"
  herdr_review_track_tab "workspace-a:review-tab"
  if herdr_review_cleanup >/dev/null 2>&1; then
    fail "unconfirmed Herdr tab close unexpectedly succeeded"
  fi
  sleep 0.2
  [ -e "$raw" ] || fail "raw output was deleted after unconfirmed close"
  [ -e "$exit_file" ] || fail "late exit marker was not preserved after unconfirmed close"
  [ -e "$runner" ] || fail "runner was deleted after unconfirmed close"
  [ "$HERDR_REVIEW_TAB_ID" = "workspace-a:review-tab" ] ||
    fail "tab ownership was forgotten after unconfirmed close"
}

test_review_invalid_success_shapes_are_never_proof() {
  local raw="$tmp/invalid-shape.raw" exit_file="$tmp/invalid-shape.exit" runner="$tmp/invalid-shape.runner" rc
  printf 'partial review output\n' > "$raw"
  printf 'runner\n' > "$runner"
  : > "$calls"
  mode="invalid-review-shape"

  if herdr_review_snapshot_tabs "workspace-a" >/dev/null 2>&1; then
    fail "structurally invalid tab snapshot was accepted"
  fi

  herdr_review_track_files "$raw" "$exit_file" "$runner"
  herdr_review_track_locator "workspace-a" "review-label" "$tmp" ""
  set +e
  herdr_review_recover_tab >/dev/null 2>&1
  rc=$?
  set -e
  [ "$rc" -eq 2 ] || fail "invalid recovery evidence exited $rc instead of ambiguous"

  herdr_review_track_tab "workspace-a:review-tab"
  if herdr_review_tab_absent "workspace-a:review-tab"; then
    fail "structurally invalid tab list falsely proved exact tab absence"
  fi
  [ "$HERDR_REVIEW_TAB_ID" = "workspace-a:review-tab" ] ||
    fail "invalid absence evidence discarded exact review ownership"
}

test_review_timeout_closes_tab_and_removes_transport_and_prompt() {
  local raw="$tmp/timeout.raw" exit_file="$tmp/timeout.exit" runner="$tmp/timeout.runner" prompt="$tmp/timeout.prompt"
  printf 'partial timeout output\n' > "$raw"
  printf 'runner\n' > "$runner"
  printf 'prompt\n' > "$prompt"
  : > "$calls"
  mode="default"

  herdr_review_track_files "$raw" "$exit_file" "$runner"
  herdr_review_track_prompt "$prompt"
  herdr_review_track_tab "workspace-a:timeout-tab"
  herdr_review_close_tab
  herdr_review_cleanup
  herdr_review_release_prompt

  grep -Fxq "tab close workspace-a:timeout-tab" "$calls" ||
    fail "review timeout cleanup did not close its tab"
  assert_file_missing "$raw"
  assert_file_missing "$exit_file"
  assert_file_missing "$runner"
  assert_file_missing "$prompt"
}

test_review_signals_remove_prompt() {
  local signal expected prompt rc lifecycle
  lifecycle="$repo_root/scripts/lib/herdr-review-lifecycle.sh"
  grep -Fq "trap 'exit 130' INT" "$repo_root/scripts/review.sh" ||
    fail "review script does not route Ctrl-C through deterministic EXIT cleanup"
  grep -Fq "trap 'exit 143' TERM" "$repo_root/scripts/review.sh" ||
    fail "review script does not route TERM through deterministic EXIT cleanup"

  for signal in INT TERM; do
    case "$signal" in INT) expected=130 ;; TERM) expected=143 ;; esac
    prompt="$tmp/signal-${signal}.prompt"
    printf 'prompt\n' > "$prompt"
    set +e
    PROMPT="$prompt" SIGNAL="$signal" EXPECTED="$expected" LIFECYCLE="$lifecycle" bash -c '
      set -euo pipefail
      . "$LIFECYCLE"
      herdr() { return 0; }
      herdr_review_track_prompt "$PROMPT"
      cleanup() {
        ec=$?
        trap - EXIT INT TERM
        herdr_review_abort
        exit "$ec"
      }
      trap cleanup EXIT
      trap "exit 130" INT
      trap "exit 143" TERM
      kill -s "$SIGNAL" "$$"
    ' >/dev/null 2>&1
    rc=$?
    set -e
    [ "$rc" -eq "$expected" ] || fail "$signal cleanup exited $rc, expected $expected"
    assert_file_missing "$prompt"
  done
}

test_review_parses_current_herdr_tab_response
test_review_cleanup_closes_tab_and_removes_temp_files
test_review_abort_closes_tab_but_preserves_partial_output
test_review_close_failure_preserves_state_and_transport
test_review_invalid_success_shapes_are_never_proof
test_review_timeout_closes_tab_and_removes_transport_and_prompt
test_review_signals_remove_prompt

echo "herdr lifecycle tests passed"
