#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=scripts/lib/review-commit-lock.sh
. "$repo_root/scripts/lib/review-commit-lock.sh"

tmp="$(mktemp -d /tmp/lobu-review-commit-lock-test.XXXXXX)"
holder_pid=""
cleanup() {
  trap - EXIT INT TERM HUP
  [ -z "$holder_pid" ] || kill "$holder_pid" 2>/dev/null || true
  wait "$holder_pid" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT
export REVIEW_LOCK_ROOT_FOR_TESTS="$tmp/locks"

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

sha_a="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
sha_b="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

# A live owner refuses a duplicate review of the same commit.
bash -c '
  set -euo pipefail
  . "$1"
  acquire_commit_review_lock "$2"
  touch "$3/held"
  while [ ! -f "$3/release" ]; do sleep 0.02; done
' bash "$repo_root/scripts/lib/review-commit-lock.sh" "$sha_a" "$tmp" &
holder_pid=$!
wait_for_file "$tmp/held" "same-sha lock holder"

set +e
acquire_commit_review_lock "$sha_a" >/dev/null 2>&1
dup_exit=$?
set -e
[ "$dup_exit" -eq 2 ] || fail "duplicate same-commit review was not refused (exit $dup_exit)"

# A DIFFERENT commit reviews concurrently — no cross-commit serialization.
bash -c '
  set -euo pipefail
  . "$1"
  acquire_commit_review_lock "$2"
' bash "$repo_root/scripts/lib/review-commit-lock.sh" "$sha_b" ||
  fail "review of a different commit was blocked by an unrelated owner"

touch "$tmp/release"
wait "$holder_pid"
holder_pid=""

# Ownership ends with the owner: the same commit is acquirable again, even
# though the previous owner's pid is still written in the lock file.
bash -c '
  set -euo pipefail
  . "$1"
  acquire_commit_review_lock "$2"
' bash "$repo_root/scripts/lib/review-commit-lock.sh" "$sha_a" ||
  fail "same commit not acquirable after the owner exited"

# A SIGKILLed owner cannot wedge the commit: kernel flock dies with the
# process tree, so a fresh run of the same commit proceeds. The holder execs
# so the tracked pid IS the lock-holding process — spawned children (e.g. a
# sleep loop) would deliberately retain FD 9 past the parent's death, which
# is the crash-safety property, not the one under test here.
bash -c '
  set -euo pipefail
  . "$1"
  acquire_commit_review_lock "$2"
  touch "$3/killed-held"
  exec sleep 300
' bash "$repo_root/scripts/lib/review-commit-lock.sh" "$sha_a" "$tmp" &
holder_pid=$!
wait_for_file "$tmp/killed-held" "kill-test lock holder"
kill -9 "$holder_pid"
wait "$holder_pid" 2>/dev/null || true
holder_pid=""
bash -c '
  set -euo pipefail
  . "$1"
  acquire_commit_review_lock "$2"
' bash "$repo_root/scripts/lib/review-commit-lock.sh" "$sha_a" ||
  fail "same commit not acquirable after the owner was SIGKILLed"

echo "review commit lock tests passed"
