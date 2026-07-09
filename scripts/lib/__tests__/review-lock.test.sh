#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=scripts/lib/review-lock.sh
. "$repo_root/scripts/lib/review-lock.sh"
# shellcheck source=scripts/lib/review-process.sh
. "$repo_root/scripts/lib/review-process.sh"

tmp="$(mktemp -d /tmp/lobu-review-lock-test.XXXXXX)"
holder_pid=""
contender_pid=""
cleanup() {
  [ -z "$holder_pid" ] || kill "$holder_pid" 2>/dev/null || true
  [ -z "$contender_pid" ] || kill "$contender_pid" 2>/dev/null || true
  wait "$holder_pid" 2>/dev/null || true
  wait "$contender_pid" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT
export TMPDIR="$tmp"
export REVIEW_LOCK_ROOT_FOR_TESTS="$tmp/host-lock"

fail() {
  echo "FAIL: $*" >&2
  exit 1
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
while [ ! -f "$tmp/held" ]; do sleep 0.05; done

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
while [ ! -f "$signal_tmp/child-pid" ]; do sleep 0.01; done
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

echo "review lock tests passed"
