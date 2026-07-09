#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# shellcheck source=scripts/lib/herdr-task.sh
. "$repo_root/scripts/lib/herdr-task.sh"
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
    "tab create")
      if [ "$mode" = "malformed-tab" ]; then
        printf 'warning before malformed tab json\n'
      else
        printf '{"result":{"tab":{"tab_id":"workspace-a:tab-created"}}}\n'
      fi
      ;;
    "tab get")
      if [ "$mode" = "repeat" ] && [ "${3:-}" = "workspace-a:tab-created" ]; then
        printf '{"result":{"tab":{"tab_id":"workspace-a:tab-created"}}}\n'
      elif [ "$mode" = "review-close-failure" ]; then
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
      if [ "$mode" = "review-locator" ]; then
        if grep -q '^tab close workspace-a:located-review$' "$calls"; then
          printf '{"result":{"tabs":[{"tab_id":"workspace-a:stale-review","label":"locator-review"}]}}\n'
        else
          printf '{"result":{"tabs":[{"tab_id":"workspace-a:stale-review","label":"locator-review"},{"tab_id":"workspace-a:located-review","label":"locator-review"}]}}\n'
        fi
      elif [ "$mode" = "malformed-tab" ] && grep -q '^tab create ' "$calls"; then
        printf '{"result":{"tabs":[{"tab_id":"workspace-a:orphan-tab","label":"task-label"}]}}\n'
      else
        printf '{"result":{"tabs":[]}}\n'
      fi
      ;;
    "worktree open")
      if [ "$mode" = "malformed-workspace" ]; then
        printf 'not-json\n'
      else
        printf '{"result":{"workspace":{"workspace_id":"dedicated-workspace"}}}\n'
      fi
      ;;
    "workspace list")
      if [ "$mode" = "malformed-workspace" ] && grep -q '^worktree open ' "$calls"; then
        printf '{"result":{"workspaces":[{"workspace_id":"created-workspace","label":"task-label","worktree":{"checkout_path":"%s"}}]}}\n' "$HERDR_TEST_WORKTREE"
      elif [ "$mode" = "legacy" ]; then
        printf '{"result":{"workspaces":[{"workspace_id":"other","label":"other"},{"workspace_id":"legacy","label":"task-label"}]}}\n'
      elif [ "$mode" = "current-tab" ]; then
        printf '{"result":{"workspaces":[{"workspace_id":"workspace-a","label":"task-label"}]}}\n'
      else
        printf '{"result":{"workspaces":[]}}\n'
      fi
      ;;
    "pane list")
      if [ "$mode" = "review-locator" ]; then
        printf '{"result":{"panes":[{"tab_id":"workspace-a:stale-review","cwd":"%s","foreground_cwd":"%s"},{"tab_id":"workspace-a:located-review","cwd":"%s","foreground_cwd":"%s"}]}}\n' "$HERDR_REVIEW_CWD" "$HERDR_REVIEW_CWD" "$HERDR_REVIEW_CWD" "$HERDR_REVIEW_CWD"
      elif [ "$mode" = "legacy" ] && [ "${4:-}" = "legacy" ]; then
        printf '{"result":{"panes":[{"tab_id":"legacy:task-tab","cwd":"%s/subdir","foreground_cwd":"%s/subdir"}]}}\n' "$HERDR_TEST_WORKTREE" "$HERDR_TEST_WORKTREE"
      elif [ "$mode" = "current-tab" ]; then
        printf '{"result":{"panes":[{"tab_id":"workspace-a:current-tab","cwd":"%s","foreground_cwd":"%s"}]}}\n' "$HERDR_TEST_WORKTREE" "$HERDR_TEST_WORKTREE"
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

test_task_tab_open_records_identity() {
  local worktree="$tmp/open-worktree" metadata
  mkdir -p "$worktree"
  git -C "$worktree" init -q
  HERDR_WORKSPACE_ID="workspace-a"
  HERDR_TAB_ID="workspace-a:tab-1"
  export HERDR_WORKSPACE_ID HERDR_TAB_ID
  mode="default"

  : > "$calls"
  [ "$(herdr_task_open "$worktree" "$worktree" "task-label")" = "workspace-a" ] ||
    fail "task tab open did not return its workspace"
  metadata="$(herdr_task_metadata_read "$worktree")"
  [ "$metadata" = "workspace-a workspace-a:tab-created" ] ||
    fail "task tab identity was not persisted: $metadata"
}

test_repeated_task_setup_reuses_tab_without_orphaning() {
  local worktree="$tmp/repeated-worktree" create_count
  mkdir -p "$worktree"
  git -C "$worktree" init -q
  HERDR_WORKSPACE_ID="workspace-a"
  HERDR_TAB_ID="workspace-a:caller"
  export HERDR_WORKSPACE_ID HERDR_TAB_ID
  mode="repeat"

  : > "$calls"
  herdr_task_open "$worktree" "$worktree" "task-label" >/dev/null
  herdr_task_open "$worktree" "$worktree" "task-label" >/dev/null

  create_count=$(grep -c '^tab create ' "$calls")
  [ "$create_count" -eq 1 ] ||
    fail "repeated task setup created $create_count tabs instead of reusing one"
  [ "$(herdr_task_metadata_read "$worktree")" = "workspace-a workspace-a:tab-created" ] ||
    fail "repeated setup replaced the authoritative tab identity"
}

test_task_tab_malformed_create_response_closes_created_tab() {
  local worktree="$tmp/malformed-tab-worktree"
  mkdir -p "$worktree"
  git -C "$worktree" init -q
  HERDR_WORKSPACE_ID="workspace-a"
  HERDR_TAB_ID="workspace-a:caller"
  export HERDR_WORKSPACE_ID HERDR_TAB_ID
  mode="malformed-tab"

  : > "$calls"
  if herdr_task_open "$worktree" "$worktree" "task-label" >/dev/null 2>&1; then
    fail "malformed tab response unexpectedly succeeded"
  fi
  grep -Fxq "tab close workspace-a:orphan-tab" "$calls" ||
    fail "malformed tab response orphaned the created tab"
}

test_task_workspace_malformed_create_response_closes_created_workspace() {
  local worktree="$tmp/malformed-workspace"
  mkdir -p "$worktree"
  git -C "$worktree" init -q
  unset HERDR_WORKSPACE_ID HERDR_TAB_ID
  export HERDR_TEST_WORKTREE="$worktree"
  mode="malformed-workspace"

  : > "$calls"
  if herdr_task_open "$worktree" "$worktree" "task-label" >/dev/null 2>&1; then
    fail "malformed workspace response unexpectedly succeeded"
  fi
  grep -Eq '^worktree remove --workspace created-workspace( --force)?$|^workspace close created-workspace$' "$calls" ||
    fail "malformed workspace response orphaned the created workspace"
}

test_ordinary_terminal_owns_and_closes_dedicated_workspace() {
  local worktree="$tmp/ordinary-worktree"
  mkdir -p "$worktree"
  git -C "$worktree" init -q
  unset HERDR_WORKSPACE_ID HERDR_TAB_ID
  mode="ordinary"

  : > "$calls"
  [ "$(herdr_task_open "$worktree" "$worktree" "task-label")" = "dedicated-workspace" ] ||
    fail "ordinary terminal did not create a dedicated workspace"
  [ "$(herdr_task_metadata_read "$worktree")" = "dedicated-workspace " ] ||
    fail "ordinary terminal workspace identity was not persisted"
  herdr_task_close "$worktree" "task-label"
  grep -Fxq "worktree remove --workspace dedicated-workspace" "$calls" ||
    fail "ordinary terminal cleanup did not remove its dedicated workspace"
  if grep -q '^tab create ' "$calls"; then
    fail "ordinary terminal unexpectedly created a tab without a current workspace"
  fi
}

test_task_tab_cleanup_uses_persisted_identity_across_workspaces() {
  local worktree="$tmp/worktree"
  mkdir -p "$worktree"
  git -C "$worktree" init -q

  herdr_task_metadata_write "$worktree" "workspace-a" "workspace-a:tab-7"
  HERDR_WORKSPACE_ID="workspace-b"
  HERDR_TAB_ID="workspace-b:tab-1"
  export HERDR_WORKSPACE_ID HERDR_TAB_ID
  mode="default"

  : > "$calls"
  herdr_task_close "$worktree" "task-label"

  grep -Fxq "tab close workspace-a:tab-7" "$calls" ||
    fail "cross-workspace cleanup did not close the persisted task tab"
}

test_legacy_lookup_closes_cross_workspace_task_tab() {
  local worktree="$tmp/legacy-worktree"
  mkdir -p "$worktree/subdir"
  git -C "$worktree" init -q
  unset HERDR_WORKSPACE_ID HERDR_TAB_ID
  export HERDR_TEST_WORKTREE="$worktree"
  mode="legacy"

  : > "$calls"
  herdr_task_close "$worktree" "task-label"
  grep -Fxq "tab close legacy:task-tab" "$calls" ||
    fail "legacy cross-workspace lookup did not close the task tab"
}

test_current_task_tab_is_never_closed() {
  local worktree="$tmp/current-worktree"
  mkdir -p "$worktree"
  git -C "$worktree" init -q
  herdr_task_metadata_write "$worktree" "workspace-a" "workspace-a:current-tab"
  HERDR_WORKSPACE_ID="workspace-a"
  HERDR_TAB_ID="workspace-a:current-tab"
  export HERDR_WORKSPACE_ID HERDR_TAB_ID HERDR_TEST_WORKTREE="$worktree"
  mode="current-tab"

  : > "$calls"
  if herdr_task_close "$worktree" "task-label"; then
    fail "current-tab cleanup unexpectedly reported that it closed an owner"
  fi
  if grep -Eq '^(tab close|workspace close|worktree remove)' "$calls"; then
    fail "current task cleanup attempted to close its own tab/workspace"
  fi
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

test_task_tab_open_records_identity
test_repeated_task_setup_reuses_tab_without_orphaning
test_task_tab_malformed_create_response_closes_created_tab
test_task_workspace_malformed_create_response_closes_created_workspace
test_ordinary_terminal_owns_and_closes_dedicated_workspace
test_task_tab_cleanup_uses_persisted_identity_across_workspaces
test_legacy_lookup_closes_cross_workspace_task_tab
test_current_task_tab_is_never_closed
test_review_parses_current_herdr_tab_response
test_review_cleanup_closes_tab_and_removes_temp_files
test_review_abort_closes_tab_but_preserves_partial_output
test_review_close_failure_preserves_state_and_transport
test_review_timeout_closes_tab_and_removes_transport_and_prompt
test_review_signals_remove_prompt

echo "herdr lifecycle tests passed"
