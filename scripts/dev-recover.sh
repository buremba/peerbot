#!/usr/bin/env bash
# dev-recover.sh — recover wedged local dev for this checkout.
#
# Frees only this worktree's PORT and WORKER_PROXY_PORT (from .env.local), runs
# make clean-workers, and optionally restarts `make dev` with a health probe.
#
# Usage:
#   make dev-recover                 # inspect + free ports + clean workers
#   make dev-recover RESTART=1       # also start make dev and probe /api/health
#
# Log (when RESTART=1): .lobu-dev-recover.log (gitignored)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DEV_PORT="${PORT:-8930}"
WORKER_PROXY_PORT="${WORKER_PROXY_PORT:-8119}"

if [[ -f .env.local ]]; then
  parsed_port="$(awk -F= '/^PORT=/{print $2; exit}' .env.local | tr -d '[:space:]')"
  if [[ -n "$parsed_port" && "$parsed_port" =~ ^[0-9]+$ ]]; then
    DEV_PORT="$parsed_port"
  fi
  parsed_proxy="$(awk -F= '/^WORKER_PROXY_PORT=/{print $2; exit}' .env.local | tr -d '[:space:]')"
  if [[ -n "$parsed_proxy" && "$parsed_proxy" =~ ^[0-9]+$ ]]; then
    WORKER_PROXY_PORT="$parsed_proxy"
  fi
fi

PORTS=("$DEV_PORT" "$WORKER_PROXY_PORT")
RESTART="${RESTART:-0}"

echo "=== Dev recovery ($(basename "$REPO_ROOT")) ==="
echo "→ PORT=$DEV_PORT WORKER_PROXY_PORT=$WORKER_PROXY_PORT"

echo ""
echo "=== Port listeners ==="
for p in "${PORTS[@]}"; do
  echo "--- :$p ---"
  lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null || echo "(none)"
done

echo ""
echo "=== make clean-workers ==="
make clean-workers

echo ""
echo "=== Freeing listeners on :$DEV_PORT and :$WORKER_PROXY_PORT ==="
killed=0
for p in "${PORTS[@]}"; do
  pids="$(lsof -t -iTCP:"$p" -sTCP:LISTEN 2>/dev/null || true)"
  for pid in $pids; do
    [[ -z "$pid" ]] && continue
    echo "kill -9 $pid (was listening on :$p)"
    kill -9 "$pid" 2>/dev/null || true
    killed=$((killed + 1))
  done
done
echo "→ killed $killed listener(s)"

if [[ "$RESTART" != "1" ]]; then
  echo ""
  echo "✓ Ports freed. Run 'make dev' or 'make dev-recover RESTART=1' to start the server."
  exit 0
fi

echo ""
echo "=== Starting make dev (background) ==="
LOG="$REPO_ROOT/.lobu-dev-recover.log"
rm -f "$LOG"
nohup make dev >"$LOG" 2>&1 &
DEV_PID=$!
echo "→ dev pid $DEV_PID, log: $LOG"

echo ""
echo "=== Waiting for 'Lobu running at' (up to 120s) ==="
deadline=$((SECONDS + 120))
ready=0
while (( SECONDS < deadline )); do
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    echo "✗ make dev exited early (pid $DEV_PID gone)"
    echo "--- tail of $LOG ---"
    tail -80 "$LOG" || true
    exit 1
  fi
  if grep -q 'Lobu running at' "$LOG" 2>/dev/null; then
    ready=1
    break
  fi
  if grep -qiE 'EADDRINUSE|Unsupported Node|No Postgres reachable' "$LOG" 2>/dev/null; then
    echo "✗ startup error detected in log"
    echo "--- tail of $LOG ---"
    tail -80 "$LOG" || true
    exit 1
  fi
  sleep 2
done

if [[ "$ready" -eq 0 ]]; then
  echo "✗ timed out waiting for 'Lobu running at'"
  echo "--- tail of $LOG ---"
  tail -80 "$LOG" || true
  exit 1
fi

grep 'Lobu running at' "$LOG" | tail -1

echo ""
echo "=== curl http://127.0.0.1:$DEV_PORT/api/health ==="
curl -sf "http://127.0.0.1:$DEV_PORT/api/health" && echo "" || {
  echo "✗ health check failed"
  exit 1
}

echo ""
echo "✅ Dev server recovered on :$DEV_PORT (pid $DEV_PID)"