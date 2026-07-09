#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=scripts/lib/review-lock.sh
. "$repo_root/scripts/lib/review-lock.sh"

tmp="$(mktemp -d /tmp/lobu-review-lock-test.XXXXXX)"
holder_pid=""
cleanup() {
  [ -z "$holder_pid" ] || kill "$holder_pid" 2>/dev/null || true
  wait "$holder_pid" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT
export TMPDIR="$tmp"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# A live owner blocks a second review even when it advertises another database.
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
  REVIEW_LOCK_TIMEOUT_SECONDS=0 acquire_review_lock >/dev/null 2>&1
blocked_exit=$?
set -e
[ "$blocked_exit" -eq 2 ] || fail "concurrent review was not blocked (exit $blocked_exit)"

touch "$tmp/release"
wait "$holder_pid"
holder_pid=""

# A dead owner's symlink is recovered atomically.
mkdir -p "$tmp/lobu-review-locks"
ln -s 999999 "$tmp/lobu-review-locks/full-review"
acquire_review_lock
[ "$(readlink "$tmp/lobu-review-locks/full-review")" = "$$" ] ||
  fail "stale lock was not replaced"
release_review_lock
[ ! -e "$tmp/lobu-review-locks/full-review" ] || fail "owned lock was not released"

echo "review lock tests passed"
