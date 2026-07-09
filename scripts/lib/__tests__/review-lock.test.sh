#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=scripts/lib/review-lock.sh
. "$repo_root/scripts/lib/review-lock.sh"
# shellcheck source=scripts/lib/review-process.sh
. "$repo_root/scripts/lib/review-process.sh"
# shellcheck source=scripts/lib/herdr-review-lifecycle.sh
. "$repo_root/scripts/lib/herdr-review-lifecycle.sh"

tmp="$(mktemp -d /tmp/lobu-review-lock-test.XXXXXX)"
holder_pid=""
contender_pid=""
status_holder=""
status_waiter=""
cleanup() {
  trap - EXIT INT TERM HUP
  # The close-retains-lock fixture deliberately turns TERM into a wait for its
  # runner marker. If this test itself is interrupted before the main path
  # writes that marker, a plain TERM+wait deadlocks and leaves FD 9 held. Give
  # the synthetic runner its terminal marker before stopping the fixture.
  if [ -n "$holder_pid" ] && [ -d "$tmp/close-retains-lock" ]; then
    printf '143\n' > "$tmp/close-retains-lock/review.exit" 2>/dev/null || true
  fi
  [ -z "$holder_pid" ] || kill "$holder_pid" 2>/dev/null || true
  [ -z "$contender_pid" ] || kill "$contender_pid" 2>/dev/null || true
  [ -z "$status_holder" ] || kill "$status_holder" 2>/dev/null || true
  [ -z "$status_waiter" ] || kill "$status_waiter" 2>/dev/null || true
  wait "$holder_pid" 2>/dev/null || true
  wait "$contender_pid" 2>/dev/null || true
  wait "$status_holder" 2>/dev/null || true
  wait "$status_waiter" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
export TMPDIR="$tmp"
export REVIEW_LOCK_ROOT_FOR_TESTS="$tmp/host-lock"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

wait_for_file() {
  local path="$1" description="$2"
  for _ in $(seq 1 500); do
    [ -e "$path" ] && return 0
    sleep 0.01
  done
  fail "timed out waiting for $description"
}

# A live owner blocks a second review even with a different caller TMPDIR.
TMPDIR="$tmp" bash -c '
  set -euo pipefail
  . "$1"
  acquire_review_lock
  touch "$2/held"
  while [ ! -f "$2/release" ]; do sleep 0.05; done
  release_review_lock
' bash "$repo_root/scripts/lib/review-lock.sh" "$tmp" &
holder_pid=$!
wait_for_file "$tmp/held" "initial lock holder"

set +e
REVIEW_DATABASE_URL='postgresql://user@127.0.0.1/lobu_test_other' \
  TMPDIR="$tmp/another-tmp" \
  REVIEW_LOCK_TIMEOUT_SECONDS=0 acquire_review_lock >/dev/null 2>&1
blocked_exit=$?
set -e
[ "$blocked_exit" -eq 2 ] || fail "concurrent review was not blocked (exit $blocked_exit)"

touch "$tmp/release"
wait "$holder_pid"
holder_pid=""

# A stale lock file has no ownership once its process is gone.
mkdir -p "$REVIEW_LOCK_ROOT_FOR_TESTS"
printf '999999\n' > "$REVIEW_LOCK_ROOT_FOR_TESTS/full-review.lock"
acquire_review_lock
release_review_lock

# High-contention stale recovery must serialize every successful owner.
printf '999999\n' > "$REVIEW_LOCK_ROOT_FOR_TESTS/full-review.lock"
mkdir -p "$tmp/acquired"
rm -f "$tmp/overlap"
for contender in $(seq 1 40); do
  TMPDIR="$tmp/caller-$contender" REVIEW_LOCK_TIMEOUT_SECONDS=10 \
    REVIEW_LOCK_POLL_SECONDS=0.01 bash -c '
      set -euo pipefail
      . "$1"
      acquire_review_lock >/dev/null
      if ! mkdir "$2/critical" 2>/dev/null; then
        touch "$2/overlap"
      fi
      touch "$2/acquired/$3"
      sleep 0.02
      rmdir "$2/critical" 2>/dev/null || true
      release_review_lock
    ' bash "$repo_root/scripts/lib/review-lock.sh" "$tmp" "$contender" &
done
wait
[ ! -e "$tmp/overlap" ] || fail "high-contention owners overlapped"
[ "$(find "$tmp/acquired" -type f | wc -l | tr -d ' ')" -eq 40 ] ||
  fail "not every high-contention owner acquired the lock"

# Signals stop and reap the active child before the host lock is released.
signal_tmp="$tmp/signal"
mkdir -p "$signal_tmp"
TMPDIR="$tmp/signal-caller" REVIEW_PROCESS_TERM_GRACE_SECONDS=0.3 bash -c '
  set -euo pipefail
  . "$1"
  . "$2"
  trap '\''stop_active_review_child; exit 143'\'' TERM
  trap '\''release_review_lock'\'' EXIT
  acquire_review_lock
  run_review_child python3 "$3" late-grandchild "$4/child-pid" "$4/late-pid"
' bash "$repo_root/scripts/lib/review-lock.sh" \
  "$repo_root/scripts/lib/review-process.sh" \
  "$repo_root/scripts/lib/__tests__/review-process-fixture.py" "$signal_tmp" &
holder_pid=$!
wait_for_file "$signal_tmp/child-pid" "signal-test child pid"
child_pid="$(sed -n '1p' "$signal_tmp/child-pid")"
REVIEW_LOCK_TIMEOUT_SECONDS=10 REVIEW_LOCK_POLL_SECONDS=0.01 bash -c '
  set -euo pipefail
  . "$1"
  acquire_review_lock >/dev/null
  if kill -0 "$3" 2>/dev/null; then
    touch "$2/reacquired-before-child-exit"
  fi
  late_pid="$(sed -n '\''1p'\'' "$2/late-pid" 2>/dev/null || true)"
  if [ -n "$late_pid" ] && kill -0 "$late_pid" 2>/dev/null; then
    touch "$2/reacquired-before-late-descendant-exit"
  fi
  touch "$2/reacquired"
  release_review_lock
' bash "$repo_root/scripts/lib/review-lock.sh" "$signal_tmp" "$child_pid" &
contender_pid=$!
kill -TERM "$holder_pid"
set +e
wait "$holder_pid"
signal_exit=$?
set -e
holder_pid=""
[ "$signal_exit" -eq 143 ] || fail "signal holder exited $signal_exit, expected 143"
wait "$contender_pid"
contender_pid=""
[ -e "$signal_tmp/reacquired" ] || fail "signal contender never reacquired the lock"
[ ! -e "$signal_tmp/reacquired-before-child-exit" ] ||
  fail "host lock was reacquired before the active child exited"
[ ! -e "$signal_tmp/reacquired-before-late-descendant-exit" ] ||
  fail "host lock was reacquired before a late descendant exited"
if kill -0 "$child_pid" 2>/dev/null; then
  fail "active child $child_pid survived signal cleanup"
fi

# A review invocation that never acquires the lock does not own the commit
# status. Timing out or being canceled while waiting must not overwrite the
# active owner's pending status.
status_tmp="$tmp/status-waiter"
mkdir -p "$status_tmp/bin" "$status_tmp/lock"
cat > "$status_tmp/bin/claude" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$status_tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "auth status") exit 0 ;;
  "repo view") printf 'lobu-ai/lobu\n' ;;
  "api -X") printf '%s\n' "$*" >> "$REVIEW_STATUS_CALLS" ;;
esac
EOF
chmod +x "$status_tmp/bin/claude" "$status_tmp/bin/gh"

REVIEW_LOCK_ROOT_FOR_TESTS="$status_tmp/lock" HOLDER_READY="$status_tmp/holder-ready" bash -c '
  set -euo pipefail
  . "$1/scripts/lib/review-lock.sh"
  acquire_review_lock
  : > "$HOLDER_READY"
  sleep 30
' bash "$repo_root" &
status_holder=$!
for _ in $(seq 1 100); do
  [ -e "$status_tmp/holder-ready" ] && break
  sleep 0.02
done
[ -e "$status_tmp/holder-ready" ] || fail "status-test lock holder never started"

: > "$status_tmp/status-calls"
set +e
PATH="$status_tmp/bin:$PATH" \
  REVIEW_STATUS_CALLS="$status_tmp/status-calls" \
  REVIEW_LOCK_ROOT_FOR_TESTS="$status_tmp/lock" \
  REVIEW_LOCK_TIMEOUT_SECONDS=0 \
  bash "$repo_root/scripts/review.sh" >/dev/null 2>&1
waiter_exit=$?
set -e
[ "$waiter_exit" -eq 2 ] || fail "timed-out review waiter exited $waiter_exit"
[ ! -s "$status_tmp/status-calls" ] || fail "timed-out review waiter posted a commit status"

: > "$status_tmp/status-calls"
PATH="$status_tmp/bin:$PATH" \
  REVIEW_STATUS_CALLS="$status_tmp/status-calls" \
  REVIEW_LOCK_ROOT_FOR_TESTS="$status_tmp/lock" \
  REVIEW_LOCK_TIMEOUT_SECONDS=30 \
  REVIEW_LOCK_POLL_SECONDS=0.05 \
  bash "$repo_root/scripts/review.sh" >"$status_tmp/waiter.out" 2>&1 &
status_waiter=$!
for _ in $(seq 1 100); do
  grep -q 'another full review owns this host' "$status_tmp/waiter.out" 2>/dev/null && break
  sleep 0.02
done
grep -q 'another full review owns this host' "$status_tmp/waiter.out" 2>/dev/null ||
  fail "cancel-test review waiter never blocked on the lock"
kill -TERM "$status_waiter"
set +e
wait "$status_waiter"
waiter_exit=$?
set -e
status_waiter=""
[ "$waiter_exit" -eq 143 ] || fail "canceled review waiter exited $waiter_exit"
[ ! -s "$status_tmp/status-calls" ] || fail "canceled review waiter posted a commit status"

kill "$status_holder" 2>/dev/null || true
wait "$status_holder" 2>/dev/null || true
status_holder=""

# Once the invocation acquires the lock and starts the pending status, an early
# failure still finalizes that owned status as an error.
: > "$status_tmp/status-calls"
set +e
PATH="$status_tmp/bin:$PATH" \
  REVIEW_STATUS_CALLS="$status_tmp/status-calls" \
  REVIEW_LOCK_ROOT_FOR_TESTS="$status_tmp/lock" \
  REVIEW_DATABASE_URL='postgres://localhost/production' \
  bash "$repo_root/scripts/review.sh" >/dev/null 2>&1
owner_exit=$?
set -e
[ "$owner_exit" -eq 2 ] || fail "early-failing review owner exited $owner_exit"
[ "$(grep -c 'state=pending' "$status_tmp/status-calls")" -eq 1 ] ||
  fail "review owner did not post exactly one pending status"
[ "$(grep -c 'state=error' "$status_tmp/status-calls")" -eq 1 ] ||
  fail "review owner did not finalize its pending status as error"

# A signaled review whose exact Herdr tab cannot yet be closed must retain the
# host lock until its runner termination is confirmed. A second review cannot
# enter the destructive suite during that ambiguous interval.
close_tmp="$tmp/close-retains-lock"
mkdir -p "$close_tmp/lock"
REVIEW_LOCK_ROOT_FOR_TESTS="$close_tmp/lock" \
  REVIEW_CLOSE_RETRY_SECONDS_FOR_TESTS=0.01 \
  LOCK_LIB="$repo_root/scripts/lib/review-lock.sh" \
  LIFECYCLE_LIB="$repo_root/scripts/lib/herdr-review-lifecycle.sh" \
  CLOSE_TMP="$close_tmp" bash -c '
    set -euo pipefail
    . "$LOCK_LIB"
    . "$LIFECYCLE_LIB"
    herdr() {
      case "${1:-} ${2:-}" in
        "tab close") : > "$CLOSE_TMP/close-attempted"; return 1 ;;
        "tab get") printf '\''{"result":{"tab":{"tab_id":"workspace-a:review-tab"}}}\n'\'' ;;
        "tab list") printf '\''{"result":{"tabs":[{"tab_id":"workspace-a:review-tab"}]}}\n'\'' ;;
        *) return 1 ;;
      esac
    }
    cleanup() {
      ec=$?
      trap - EXIT INT TERM HUP
      herdr_review_abort_until_safe_to_release_lock
      release_review_lock
      exit "$ec"
    }
    trap cleanup EXIT
    trap "exit 143" TERM
    acquire_review_lock
    raw="$CLOSE_TMP/review.raw"
    exit_file="$CLOSE_TMP/review.exit"
    runner="$CLOSE_TMP/review.runner"
    printf partial > "$raw"
    printf runner > "$runner"
    herdr_review_track_files "$raw" "$exit_file" "$runner"
    herdr_review_track_locator workspace-a review-label "$CLOSE_TMP" ""
    herdr_review_track_tab workspace-a:review-tab
    herdr_review_mark_runner_may_be_live
    : > "$CLOSE_TMP/holder-ready"
    while true; do sleep 0.05; done
  ' &
holder_pid=$!
wait_for_file "$close_tmp/holder-ready" "close-failure lock holder"
kill -TERM "$holder_pid"
wait_for_file "$close_tmp/close-attempted" "exact Herdr close attempt"

set +e
REVIEW_LOCK_ROOT_FOR_TESTS="$close_tmp/lock" REVIEW_LOCK_TIMEOUT_SECONDS=0 \
  bash -c '. "$1"; acquire_review_lock' bash "$repo_root/scripts/lib/review-lock.sh" >/dev/null 2>&1
blocked_exit=$?
set -e
[ "$blocked_exit" -eq 2 ] || fail "second review acquired lock while Herdr runner might still live"

printf '143\n' > "$close_tmp/review.exit"
set +e
wait "$holder_pid"
holder_exit=$?
set -e
holder_pid=""
[ "$holder_exit" -eq 143 ] || fail "signaled close-failure owner exited $holder_exit"

REVIEW_LOCK_ROOT_FOR_TESTS="$close_tmp/lock" REVIEW_LOCK_TIMEOUT_SECONDS=0 \
  bash -c '. "$1"; acquire_review_lock; release_review_lock' bash "$repo_root/scripts/lib/review-lock.sh"

echo "review lock tests passed"
