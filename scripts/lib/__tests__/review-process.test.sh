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

# A process group we lack permission to signal must end teardown, not crash it
# and not spin on it. `group_alive` reports such a group as alive, so a denied
# signal that raised would surface as a Python traceback replacing the
# reviewer's real error, and one that was merely swallowed would hang the
# escalation loop against a group it can never kill.
test_denied_signal_ends_teardown() {
  python3 - "$repo_root/scripts/lib/review-process-supervisor.py" "$tmp/denied-control" <<'PY' ||
import importlib.util
import signal
import sys

# Importing by path would otherwise leave a __pycache__ beside the tracked
# script, and nothing in the repo ignores it.
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("supervisor", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

calls = []


def denied(process_group, sig):
    calls.append(sig)
    raise PermissionError(1, "Operation not permitted")


module.os.killpg = denied

# Every killpg is denied, so the supervisor sees a group that stays alive and
# never becomes signallable — exactly the shape that spins a retrying teardown.
signal.alarm(20)
sys.argv = ["supervisor", "--control-dir", sys.argv[2], "--", sys.executable, "-c", ""]
status = module.main()
signal.alarm(0)

if status != 0:
    raise SystemExit(f"supervisor returned {status} for a command that exited 0")
# The liveness probe from group_alive, then the single TERM that ends teardown.
if calls != [0, signal.SIGTERM]:
    raise SystemExit(f"unexpected killpg sequence: {calls}")
PY
    fail "denied process-group signal did not end teardown cleanly"
}

test_signal_during_spawn_does_not_orphan_command
test_late_grandchild_is_killed_with_process_group
test_denied_signal_ends_teardown

echo "review process tests passed"
