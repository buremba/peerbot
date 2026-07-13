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

# FIFO ordering: each waiter registers a ticket file "<epoch>.<pid>" and only
# the oldest live ticket may attempt the flock. Without this, every lock
# release is a poll race that newer waiters win as often as the oldest one —
# under multi-session contention the oldest review starves past its timeout.
# Tickets of dead processes are pruned by any waiter, so a killed review never
# blocks the queue. Reviews from checkouts predating tickets race unordered
# against ticket holders (same flock, so mutual exclusion still holds).
review_lock_prune_dead_tickets() {
  local tickets="$1" t pid stamp now
  now="$(date +%s)"
  for t in "$tickets"/*; do
    [ -e "$t" ] || continue
    pid="${t##*.}"
    stamp="${t##*/}"
    stamp="${stamp%%.*}"
    [ "$pid" = "$$" ] && continue
    case "$pid$stamp" in
      ''|*[!0-9]*) rm -f "$t"; continue ;;
    esac
    # A recycled pid can make a ghost ticket look alive forever; no legitimate
    # waiter outlives a day.
    if [ $((now - stamp)) -gt 86400 ]; then
      rm -f "$t"
      continue
    fi
    kill -0 "$pid" 2>/dev/null || rm -f "$t"
  done
}

review_lock_head_ticket() {
  local tickets="$1"
  # Ticket names are strictly <epoch>.<pid> — no ls-parsing hazard.
  # shellcheck disable=SC2012
  ls "$tickets" 2>/dev/null | sort -t. -k1,1n -k2,2n | head -n 1
}

acquire_review_lock() {
  local lock_root candidate tickets ticket owner_pid timeout poll_seconds started now announced
  lock_root="$(review_lock_root)"
  candidate="$lock_root/full-review.lock"
  tickets="$lock_root/tickets"
  timeout="${REVIEW_LOCK_TIMEOUT_SECONDS:-14400}"
  poll_seconds="${REVIEW_LOCK_POLL_SECONDS:-2}"

  case "$timeout" in
    ''|*[!0-9]*)
      echo "REVIEW_LOCK_TIMEOUT_SECONDS must be a non-negative integer" >&2
      return 2
      ;;
  esac

  mkdir -p "$lock_root" "$tickets"
  chmod 700 "$lock_root"
  touch "$candidate"
  chmod 600 "$candidate"
  exec 9>>"$candidate"
  ticket="$tickets/$(date +%s).$$"
  printf '%s\n' "$$" > "$ticket"
  started="$(date +%s)"
  announced=0

  while :; do
    review_lock_prune_dead_tickets "$tickets"
    if [ "$(review_lock_head_ticket "$tickets")" = "${ticket##*/}" ] &&
      perl -MFcntl=:flock -e \
        'exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)' <&9; then
      break
    fi
    owner_pid="$(sed -n '1p' "$candidate" 2>/dev/null || true)"
    if [ -z "$owner_pid" ]; then
      owner_pid="unknown"
    fi
    now="$(date +%s)"
    if [ $((now - started)) -ge "$timeout" ]; then
      rm -f "$ticket"
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

  rm -f "$ticket"
  # The file may contain a PID from a dead process, but the kernel lock is the
  # source of truth. Rewrite diagnostics only after atomic ownership succeeds.
  : > "$candidate"
  printf '%s\n' "$$" >&9
  REVIEW_LOCK_HELD=1
}
