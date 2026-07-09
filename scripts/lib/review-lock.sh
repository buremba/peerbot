# review-lock.sh — host-wide ownership for the destructive full review suite.
# shellcheck shell=bash

REVIEW_LOCK_PATH=""

release_review_lock() {
  [ -n "$REVIEW_LOCK_PATH" ] || return 0
  if [ "$(readlink "$REVIEW_LOCK_PATH" 2>/dev/null || true)" = "$$" ]; then
    rm -f "$REVIEW_LOCK_PATH"
  fi
  REVIEW_LOCK_PATH=""
}

acquire_review_lock() {
  local lock_root candidate owner_pid waited=0
  lock_root="${TMPDIR:-/tmp}/lobu-review-locks"
  candidate="$lock_root/full-review"
  mkdir -p "$lock_root"

  # Database isolation is necessary but not sufficient: the full suite also
  # owns machine-global ports, embedded Postgres processes, and constrained
  # macOS shared-memory slots. Serialize the whole gate even when callers use
  # different REVIEW_DATABASE_URL values.
  while ! ln -s "$$" "$candidate" 2>/dev/null; do
    owner_pid="$(readlink "$candidate" 2>/dev/null || true)"
    if [ -z "$owner_pid" ] || ! kill -0 "$owner_pid" 2>/dev/null; then
      rm -f "$candidate"
      continue
    fi
    if [ "$waited" -eq 0 ]; then
      echo ">> another full review owns this host (pid $owner_pid); waiting"
    fi
    if [ "$waited" -ge "${REVIEW_LOCK_TIMEOUT_SECONDS:-1800}" ]; then
      echo "timed out waiting for full review lock held by pid $owner_pid" >&2
      return 2
    fi
    sleep 2
    waited=$((waited + 2))
  done
  REVIEW_LOCK_PATH="$candidate"
}
