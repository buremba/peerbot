# review-lock.sh — host-wide ownership for the destructive full review suite.
# shellcheck shell=bash

# FD 9 is intentionally inherited by review children. Kernel flock ownership
# then survives an abrupt parent exit until every child is gone, so another
# review cannot overlap an orphaned test process.
REVIEW_LOCK_HELD=0

review_lock_root() {
  if [ -n "${REVIEW_LOCK_ROOT_FOR_TESTS:-}" ]; then
    printf '%s\n' "$REVIEW_LOCK_ROOT_FOR_TESTS"
  else
    printf '/tmp/lobu-review-locks-%s\n' "$(id -u)"
  fi
}

release_review_lock() {
  [ "$REVIEW_LOCK_HELD" = "1" ] || return 0
  exec 9>&-
  REVIEW_LOCK_HELD=0
}

acquire_review_lock() {
  local lock_root candidate owner_pid timeout poll_seconds started now announced
  lock_root="$(review_lock_root)"
  candidate="$lock_root/full-review.lock"
  timeout="${REVIEW_LOCK_TIMEOUT_SECONDS:-1800}"
  poll_seconds="${REVIEW_LOCK_POLL_SECONDS:-2}"

  case "$timeout" in
    ''|*[!0-9]*)
      echo "REVIEW_LOCK_TIMEOUT_SECONDS must be a non-negative integer" >&2
      return 2
      ;;
  esac

  mkdir -p "$lock_root"
  chmod 700 "$lock_root"
  touch "$candidate"
  chmod 600 "$candidate"
  exec 9>>"$candidate"
  started="$(date +%s)"
  announced=0

  while ! perl -MFcntl=:flock -e \
    'exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <&9; do
    owner_pid="$(sed -n '1p' "$candidate" 2>/dev/null || true)"
    if [ -z "$owner_pid" ]; then
      owner_pid="unknown"
    fi
    now="$(date +%s)"
    if [ $((now - started)) -ge "$timeout" ]; then
      exec 9>&-
      echo "timed out waiting for full review lock held by pid $owner_pid" >&2
      return 2
    fi
    if [ "$announced" = "0" ]; then
      echo ">> another full review owns this host (pid $owner_pid); waiting"
      announced=1
    fi
    sleep "$poll_seconds"
  done

  # The file may contain a PID from a dead process, but the kernel lock is the
  # source of truth. Rewrite diagnostics only after atomic ownership succeeds.
  : > "$candidate"
  printf '%s\n' "$$" >&9
  REVIEW_LOCK_HELD=1
}
