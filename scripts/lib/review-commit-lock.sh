# review-commit-lock.sh — one pi-review status owner per commit.
# shellcheck shell=bash
#
# Reviews of DIFFERENT commits run concurrently — nothing here serializes
# them. But every invocation posts the same pi-review commit status for its
# HEAD sha, so two runs of the SAME commit would race: an older interrupted
# run's error post could overwrite the owner's success (or vice versa),
# making the required merge gate depend on completion order. A duplicate
# same-commit review has no value anyway, so it is refused, not queued.
#
# FD 9 is intentionally inherited by review children: kernel flock ownership
# survives an abrupt parent exit until every child is gone, so a crashed
# run's reviewer subprocess cannot overlap a fresh run of the same commit.

review_commit_lock_root() {
  if [ -n "${REVIEW_LOCK_ROOT_FOR_TESTS:-}" ]; then
    printf '%s\n' "$REVIEW_LOCK_ROOT_FOR_TESTS"
  else
    printf '/tmp/lobu-review-locks-%s\n' "$(id -u)"
  fi
}

acquire_commit_review_lock() {
  local sha="$1" lock_root candidate owner_pid
  lock_root="$(review_commit_lock_root)"
  candidate="$lock_root/commit-$sha.lock"
  mkdir -p "$lock_root"
  chmod 700 "$lock_root"
  # Never delete lock files, even old ones: unlinking a path whose flock is
  # still held would let a fresh run recreate the name on a new inode and
  # become a second owner of the same sha. They are ~6 bytes each and /tmp
  # clears on reboot — litter is the safe choice.
  touch "$candidate"
  chmod 600 "$candidate"
  exec 9>>"$candidate"
  if ! perl -MFcntl=:flock -e \
    'exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <&9; then
    owner_pid="$(sed -n '1p' "$candidate" 2>/dev/null || true)"
    echo "another review of commit $sha is already running (pid ${owner_pid:-unknown}); duplicate refused" >&2
    exec 9>&-
    return 2
  fi
  # The file may contain a PID from a dead process; the kernel lock is the
  # source of truth. Rewrite diagnostics only after ownership succeeds.
  : > "$candidate"
  printf '%s\n' "$$" >&9
}
