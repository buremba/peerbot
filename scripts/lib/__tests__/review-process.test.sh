#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
process_lib="$repo_root/scripts/lib/review-process.sh"
process_fixture="$repo_root/scripts/lib/__tests__/review-process-fixture.py"

tmp="$(mktemp -d /tmp/lobu-review-process-test.XXXXXX)"
holder_pid=""
cleanup() {
  [ -z "$holder_pid" ] || kill -KILL "$holder_pid" 2>/dev/null || true
  wait "$holder_pid" 2>/dev/null || true
  pkill -KILL -f "$tmp" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

wait_for_file() {
  local path="$1" attempts=0
  while [ ! -f "$path" ] && [ "$attempts" -lt 400 ]; do
    sleep 0.01
    attempts=$((attempts + 1))
  done
  [ -f "$path" ] || fail "timed out waiting for $path"
}

test_signal_during_spawn_does_not_orphan_command() {
  local control_root="$tmp/spawn-control" rc
  mkdir -p "$control_root"
  REVIEW_PROCESS_CONTROL_ROOT_FOR_TESTS="$control_root" \
    REVIEW_PARENT_PUBLISH_DELAY_FOR_TESTS=1 \
    REVIEW_SUPERVISOR_START_DELAY_SECONDS=1 \
    PROCESS_LIB="$process_lib" MARKER="$tmp/should-not-run" bash -c '
      set -euo pipefail
      . "$PROCESS_LIB"
      trap "stop_active_review_child; exit 143" TERM
      run_review_child "$@"
    ' bash bash -c 'touch "$1"; sleep 30' bash "$tmp/should-not-run" &
  holder_pid=$!

  for _ in $(seq 1 400); do
    find "$control_root" -name supervisor.pid -type f | grep -q . && break
    sleep 0.01
  done
  find "$control_root" -name supervisor.pid -type f | grep -q . ||
    fail "supervisor did not publish spawn ownership"
  kill -TERM "$holder_pid"
  set +e
  wait "$holder_pid"
  rc=$?
  set -e
  holder_pid=""
  [ "$rc" -eq 143 ] || fail "spawn-interrupted runner exited $rc"
  [ ! -e "$tmp/should-not-run" ] || fail "command started after spawn interruption"
  [ -z "$(find "$control_root" -name supervisor.pid -type f -print -quit)" ] ||
    fail "spawn interruption left supervisor state behind"
}

test_late_grandchild_is_killed_with_process_group() {
  local control_root="$tmp/late-control" late_pid rc
  mkdir -p "$control_root"
  REVIEW_PROCESS_CONTROL_ROOT_FOR_TESTS="$control_root" \
    REVIEW_PROCESS_TERM_GRACE_SECONDS=0.3 \
    PROCESS_LIB="$process_lib" READY="$tmp/late.ready" LATE_PID="$tmp/late.pid" bash -c '
      set -euo pipefail
      . "$PROCESS_LIB"
      trap "stop_active_review_child; exit 143" TERM
      run_review_child "$@"
    ' bash python3 "$process_fixture" late-grandchild "$tmp/late.ready" "$tmp/late.pid" &
  holder_pid=$!
  wait_for_file "$tmp/late.ready"
  kill -TERM "$holder_pid"
  wait_for_file "$tmp/late.pid"
  late_pid="$(sed -n '1p' "$tmp/late.pid")"
  set +e
  wait "$holder_pid"
  rc=$?
  set -e
  holder_pid=""
  [ "$rc" -eq 143 ] || fail "late-grandchild runner exited $rc"
  if kill -0 "$late_pid" 2>/dev/null; then
    fail "late grandchild $late_pid survived process-group cleanup"
  fi
}

test_signal_during_spawn_does_not_orphan_command
test_late_grandchild_is_killed_with_process_group

echo "review process tests passed"
