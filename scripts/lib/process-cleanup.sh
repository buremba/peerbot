#!/usr/bin/env bash
# Shared process cleanup helpers for local/E2E scripts.

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
