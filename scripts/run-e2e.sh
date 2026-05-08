#!/usr/bin/env bash
# Run the openclaw-plugin e2e suite against a freshly-booted dev server.
#
# What this does:
#   1. Sanity-check Postgres (DATABASE_URL must point at a DB with pgvector)
#   2. Build workspace packages if needed
#   3. (Optional) Boot the fake OpenAI-compatible LLM server, configure the
#      dev server to use it via FAKE_LLM_BASE_URL + a fixture provider registry
#   4. Boot scripts/dev-native.sh in the background
#   5. Wait until /health responds
#   6. Run vitest (test/e2e/) inside packages/openclaw-plugin
#   7. Tear the fake + server down on any exit path
#
# Env knobs:
#   ZAI_API_KEY=...                 → run the live memory-loop tests too;
#                                     without it those skip cleanly.
#   LOBU_E2E_FAKE_LLM=0             → disable the fake-LLM harness (for
#                                     debugging real-provider e2e setups).
#   LOBU_E2E_FAKE_LLM_PORT=9876     → fixed port for the fake; default is
#                                     the same so tests have a stable URL.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

: "${DATABASE_URL:?Set DATABASE_URL=postgres://... (with pgvector) before running}"

PORT="${PORT:-8787}"
APP_URL="${APP_URL:-http://127.0.0.1:${PORT}}"
LOG="$(mktemp -t lobu-e2e-server.XXXXXX.log)"
PIDFILE="$(mktemp -t lobu-e2e-server.XXXXXX.pid)"
FAKE_LLM_PIDFILE="$(mktemp -t lobu-e2e-fake-llm.XXXXXX.pid)"
FAKE_LLM_LOG="$(mktemp -t lobu-e2e-fake-llm.XXXXXX.log)"

USE_FAKE_LLM="${LOBU_E2E_FAKE_LLM:-1}"
FAKE_LLM_PORT="${LOBU_E2E_FAKE_LLM_PORT:-9876}"
FAKE_LLM_BASE_URL="http://127.0.0.1:${FAKE_LLM_PORT}"

process_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

is_repo_process() {
  local cwd
  cwd="$(process_cwd "$1")"
  [[ "$cwd" == "$REPO_ROOT" || "$cwd" == "$REPO_ROOT"/* ]]
}

kill_repo_pid() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && is_repo_process "$pid"; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || return 0
      sleep 1
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
}

kill_repo_dev_processes() {
  local pattern pid
  for pattern in 'tsx watch.*src/server.ts' 'node.*src/server.ts'; do
    while IFS= read -r pid; do
      kill_repo_pid "$pid"
    done < <(pgrep -f "$pattern" 2>/dev/null || true)
  done
}

cleanup() {
  for pidfile in "$PIDFILE" "$FAKE_LLM_PIDFILE"; do
    if [[ -s "$pidfile" ]]; then
      pid=$(cat "$pidfile")
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        for _ in 1 2 3 4 5; do
          kill -0 "$pid" 2>/dev/null || break
          sleep 1
        done
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
  done
  # tsx watch fork-spawns child processes that can hold :8118 / $PORT after
  # the parent exits. Only kill processes whose cwd is this checkout so a
  # sibling dev server in another worktree survives cleanup.
  kill_repo_dev_processes
  ports=(8118 "$PORT")
  if [[ "$USE_FAKE_LLM" != "0" ]]; then
    ports+=("$FAKE_LLM_PORT")
  fi
  for port in "${ports[@]}"; do
    while IFS= read -r holder; do
      kill_repo_pid "$holder"
    done < <(lsof -ti :"$port" 2>/dev/null || true)
  done
  rm -f "$PIDFILE" "$FAKE_LLM_PIDFILE"
  echo "  server log retained at: $LOG"
  if [[ "$USE_FAKE_LLM" != "0" ]]; then
    echo "  fake-llm log retained at: $FAKE_LLM_LOG"
  fi
}
trap cleanup EXIT INT TERM

# 1. Postgres sanity
psql_args=(-d "$DATABASE_URL" -t -A -c "SELECT 1")
if ! psql "${psql_args[@]}" >/dev/null 2>&1; then
  echo "Cannot reach Postgres via DATABASE_URL" >&2
  exit 1
fi
if ! psql -d "$DATABASE_URL" -t -A -c "SELECT 1 FROM pg_extension WHERE extname='vector'" | grep -q 1; then
  echo "pgvector extension not installed in DATABASE_URL target" >&2
  echo "   Run: psql -d \"\$DATABASE_URL\" -c 'CREATE EXTENSION IF NOT EXISTS vector'" >&2
  exit 1
fi

# 2. Build packages if dist trees aren't there yet
if [[ ! -d packages/core/dist || ! -d packages/connector-sdk/dist || ! -d packages/agent-worker/dist ]]; then
  echo "Building workspace packages..."
  make build-packages >/dev/null
fi

# 3. Optionally start the fake LLM server.
#    The dev server will be configured to discover it via:
#      LOBU_PROVIDER_REGISTRY_PATH → fixture pointing at FAKE_LLM_BASE_URL
#      FAKE_LLM_API_KEY            → stub key, marks the provider "system-keyed"
#      FAKE_LLM_BASE_URL           → upstream URL the secret-proxy forwards to
if [[ "$USE_FAKE_LLM" != "0" ]]; then
  echo "Starting fake LLM server on ${FAKE_LLM_BASE_URL}..."
  (
    FAKE_LLM_MODULE="${REPO_ROOT}/packages/server/src/__tests__/fixtures/fake-llm-server.ts" \
    FAKE_LLM_PORT="$FAKE_LLM_PORT" \
    bun -e '
      const modulePath = process.env.FAKE_LLM_MODULE;
      const port = Number(process.env.FAKE_LLM_PORT);
      if (!modulePath || !Number.isInteger(port)) {
        throw new Error("FAKE_LLM_MODULE and numeric FAKE_LLM_PORT are required");
      }
      import(modulePath).then(async ({ startFakeLlmServer }) => {
        const handle = await startFakeLlmServer({ port });
        process.stdout.write("fake-llm listening at " + handle.url + "\n");
        // Keep the process alive
        setInterval(() => {}, 1 << 30);
      }).catch((err) => { console.error(err); process.exit(1); });
    ' >"$FAKE_LLM_LOG" 2>&1 &
    echo $! > "$FAKE_LLM_PIDFILE"
  ) || true
  # Wait for the fake to bind
  for i in $(seq 1 30); do
    if curl -sf -m 1 "${FAKE_LLM_BASE_URL}/v1/models" >/dev/null 2>&1; then
      break
    fi
    if [[ $i -eq 30 ]]; then
      echo "fake-llm did not start within 15s. Last 20 log lines:" >&2
      tail -n 20 "$FAKE_LLM_LOG" >&2 || true
      exit 1
    fi
    sleep 0.5
  done
  echo "fake-llm healthy"

  export LOBU_PROVIDER_REGISTRY_PATH="${REPO_ROOT}/packages/server/src/__tests__/fixtures/fake-providers.json"
  export FAKE_LLM_API_KEY="${FAKE_LLM_API_KEY:-fake-test-key}"
  export FAKE_LLM_BASE_URL
fi

# 4. Boot the dev server (DATABASE_URL etc. are inherited)
echo "Booting dev server on ${APP_URL} (logs: ${LOG})..."
( ./scripts/dev-native.sh >"$LOG" 2>&1 & echo $! > "$PIDFILE" ) || true

# 5. Wait for /health
deadline=$(( $(date +%s) + 60 ))
until curl -sf -m 2 "$APP_URL/health" >/dev/null 2>&1; do
  if [[ $(date +%s) -gt $deadline ]]; then
    echo "Server did not become healthy within 60s. Last 30 log lines:" >&2
    tail -n 30 "$LOG" >&2 || true
    exit 1
  fi
  sleep 1
done
echo "Server healthy"

# 6. Run the e2e suite
echo "Running openclaw-plugin e2e..."
if [[ "$USE_FAKE_LLM" != "0" ]]; then
  APP_URL="$APP_URL" \
  LOBU_E2E_FAKE_LLM_URL="${FAKE_LLM_BASE_URL}" \
    bun run --cwd packages/openclaw-plugin test:e2e
else
  APP_URL="$APP_URL" \
    bun run --cwd packages/openclaw-plugin test:e2e
fi
