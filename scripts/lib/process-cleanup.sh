#!/usr/bin/env bash
# Shared process cleanup helpers for local/E2E scripts.

# Gracefully stop a child job, then force and reap it if it does not exit. The
# optional poll limit is primarily for focused tests; production callers use
# the default ten-second grace period.
lobu_child_job_is_live() {
  local child_pid="${1:?child pid is required}"
  local active_pids

  # `jobs` is stronger than kill -0/ps here: it identifies this shell's exact
  # child job, so a reaped PID cannot alias an unrelated replacement process.
  # Command-substitution shells inherit EXIT traps; clear it before reading the
  # copied job table so a caller's cleanup cannot recursively run there.
  active_pids="$(trap - EXIT; jobs -pr; jobs -ps)"
  case $'\n'"$active_pids"$'\n' in
    *$'\n'"$child_pid"$'\n'*) return 0 ;;
    *) return 1 ;;
  esac
}

lobu_terminate_child() {
  local child_pid="${1:?child pid is required}"
  local max_polls="${2:-100}"
  local poll

  kill "$child_pid" 2>/dev/null || true
  for ((poll = 0; poll < max_polls; poll++)); do
    lobu_child_job_is_live "$child_pid" || break
    sleep 0.1
  done
  if lobu_child_job_is_live "$child_pid"; then
    kill -9 "$child_pid" 2>/dev/null || true
  fi
  wait "$child_pid" 2>/dev/null || true
}

# Kill every process listening on a TCP port. Use a shell read loop instead of
# `xargs -r`: `-r` is a GNU extension rejected by the BSD xargs shipped on
# macOS, which made cleanup report success while leaving the gateway alive.
lobu_kill_listening_port() {
  local port="${1:?port is required}"
  local pid

  if command -v lsof >/dev/null 2>&1; then
    while IFS= read -r pid; do
      case "$pid" in
        "" | *[!0-9]*) continue ;;
      esac
      kill -9 "$pid" 2>/dev/null || true
    done < <(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
    return
  fi

  # Minimal published-artifact containers install psmisc (fuser), not lsof.
  # Linux fuser supplies the same cleanup guarantee; macOS takes the lsof path.
  if command -v fuser >/dev/null 2>&1; then
    fuser -k -9 "$port/tcp" >/dev/null 2>&1 || true
  fi
}
