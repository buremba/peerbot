#!/usr/bin/env bash
# Run the embedded Lobu stack natively.
#
# What runs:
#   - server (Hono + tsx watch) on :$PORT (default 8787)
#   - embedded gateway (in-process) with HTTP egress proxy on :$WORKER_PROXY_PORT (default 8118)
#   - embedded workers (spawned as Bun subprocesses on demand)
#   - Vite dev middleware for web on the same :$PORT (HMR via WS)
#
# Requires, managed outside this script:
#   - Postgres reachable via DATABASE_URL in .env
#
# Per-worktree port overrides: drop a gitignored `.env.local` in the repo root
# with `PORT=8788` and `WORKER_PROXY_PORT=8119` (or similar) to run multiple
# worktrees side-by-side without colliding on :8787 / :8118. .env.local takes
# precedence over .env.
#
# Skipped vs production: external managed services and cloud backfill workers.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- Preflight -------------------------------------------------------------

command -v bun >/dev/null || { echo "bun is required: curl -fsSL https://bun.sh/install | bash"; exit 1; }

# Lobu's SDK sandbox (query_sdk / run_sdk) depends on isolated-vm@6, which has
# not shipped Node 25+ support yet (upstream: laverdet/isolated-vm#553). The
# call-site gate in packages/server/src/sandbox/run-script.ts only surfaces
# this when an agent invokes the sandbox; we fail fast here so `make dev`
# itself refuses to boot under an unsupported Node major.
node_supported() {
  local bin=$1
  [ -x "$bin" ] || return 1
  local major
  major=$("$bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo "")
  [ -n "$major" ] && [ "$major" -ge 22 ] && [ "$major" -lt 25 ]
}

if ! node_supported "$(command -v node || true)"; then
  for candidate in /opt/homebrew/opt/node@22/bin /opt/homebrew/opt/node@23/bin /opt/homebrew/opt/node@24/bin /usr/local/opt/node@22/bin /usr/local/opt/node@23/bin /usr/local/opt/node@24/bin; do
    if node_supported "$candidate/node"; then
      echo "↪︎  Using $($candidate/node -v) from $candidate (system node is unsupported)"
      export PATH="$candidate:$PATH"
      break
    fi
  done
fi

if ! node_supported "$(command -v node || true)"; then
  current=$(node -v 2>/dev/null || echo 'unknown')
  echo "❌ Unsupported Node.js runtime: $current (required: 22.x–24.x)"
  echo "   isolated-vm has no Node 25+ build yet — see https://github.com/laverdet/isolated-vm/issues/553"
  echo "   Quick fix on macOS: brew install node@22 (this script auto-detects Homebrew node@22-24)"
  echo "   Or use a version manager (nvm, fnm, mise, asdf, volta) that honours .nvmrc / .node-version."
  exit 1
fi

if [ ! -f .env ]; then
  echo "❌ .env not found at $REPO_ROOT/.env"
  echo "   Copy from .env.example or run: npx @lobu/cli@latest"
  exit 1
fi

if [ ! -d packages/core/dist ] || [ ! -d packages/connector-sdk/dist ] || [ ! -d packages/agent-worker/dist ]; then
  echo "📦 Building workspace packages (one-time)…"
  make build-packages
fi

# --- Env -------------------------------------------------------------------

# Preserve explicit environment overrides from the caller while still loading
# local defaults/secrets from .env. This matters for scripts/run-e2e.sh, which
# points DATABASE_URL at an isolated test database; sourcing .env must not send
# the app server to a different DB than the test helpers use.
_PRESET_DATABASE_URL_SET="${DATABASE_URL+x}"
_PRESET_DATABASE_URL="${DATABASE_URL-}"
_PRESET_PGSSLMODE_SET="${PGSSLMODE+x}"
_PRESET_PGSSLMODE="${PGSSLMODE-}"
_PRESET_HOST_SET="${HOST+x}"
_PRESET_HOST="${HOST-}"
_PRESET_PORT_SET="${PORT+x}"
_PRESET_PORT="${PORT-}"
_PRESET_WORKER_PROXY_PORT_SET="${WORKER_PROXY_PORT+x}"
_PRESET_WORKER_PROXY_PORT="${WORKER_PROXY_PORT-}"
_PRESET_PUBLIC_WEB_URL_SET="${PUBLIC_WEB_URL+x}"
_PRESET_PUBLIC_WEB_URL="${PUBLIC_WEB_URL-}"
_PRESET_LOBU_PROVIDER_REGISTRY_PATH_SET="${LOBU_PROVIDER_REGISTRY_PATH+x}"
_PRESET_LOBU_PROVIDER_REGISTRY_PATH="${LOBU_PROVIDER_REGISTRY_PATH-}"
_PRESET_FAKE_LLM_API_KEY_SET="${FAKE_LLM_API_KEY+x}"
_PRESET_FAKE_LLM_API_KEY="${FAKE_LLM_API_KEY-}"
_PRESET_FAKE_LLM_BASE_URL_SET="${FAKE_LLM_BASE_URL+x}"
_PRESET_FAKE_LLM_BASE_URL="${FAKE_LLM_BASE_URL-}"

set -a
# shellcheck disable=SC1091
source .env
# .env.local is gitignored and intended for per-worktree overrides
# (e.g. PORT/WORKER_PROXY_PORT so two worktrees can run side-by-side).
if [ -f .env.local ]; then
  # shellcheck disable=SC1091
  source .env.local
fi
set +a

if [[ -n "$_PRESET_DATABASE_URL_SET" ]]; then export DATABASE_URL="$_PRESET_DATABASE_URL"; fi
if [[ -n "$_PRESET_PGSSLMODE_SET" ]]; then export PGSSLMODE="$_PRESET_PGSSLMODE"; fi
if [[ -n "$_PRESET_HOST_SET" ]]; then export HOST="$_PRESET_HOST"; fi
if [[ -n "$_PRESET_PORT_SET" ]]; then export PORT="$_PRESET_PORT"; fi
if [[ -n "$_PRESET_WORKER_PROXY_PORT_SET" ]]; then export WORKER_PROXY_PORT="$_PRESET_WORKER_PROXY_PORT"; fi
if [[ -n "$_PRESET_PUBLIC_WEB_URL_SET" ]]; then export PUBLIC_WEB_URL="$_PRESET_PUBLIC_WEB_URL"; fi
if [[ -n "$_PRESET_LOBU_PROVIDER_REGISTRY_PATH_SET" ]]; then export LOBU_PROVIDER_REGISTRY_PATH="$_PRESET_LOBU_PROVIDER_REGISTRY_PATH"; fi
if [[ -n "$_PRESET_FAKE_LLM_API_KEY_SET" ]]; then export FAKE_LLM_API_KEY="$_PRESET_FAKE_LLM_API_KEY"; fi
if [[ -n "$_PRESET_FAKE_LLM_BASE_URL_SET" ]]; then export FAKE_LLM_BASE_URL="$_PRESET_FAKE_LLM_BASE_URL"; fi

export NODE_ENV="${NODE_ENV:-development}"
export ENVIRONMENT="${ENVIRONMENT:-development}"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8787}"
export WORKER_PROXY_PORT="${WORKER_PROXY_PORT:-8118}"
export PUBLIC_WEB_URL="${PUBLIC_WEB_URL:-http://localhost:${PORT}}"
export LOBU_PROVIDER_REGISTRY_PATH="${LOBU_PROVIDER_REGISTRY_PATH:-$REPO_ROOT/config/providers.json}"
export LOBU_DEV_PROJECT_PATH="${LOBU_DEV_PROJECT_PATH:-$REPO_ROOT}"
export LOBU_WORKSPACE_ROOT="${LOBU_WORKSPACE_ROOT:-$REPO_ROOT/workspaces}"

mkdir -p "$LOBU_WORKSPACE_ROOT"

# --- Run -------------------------------------------------------------------

if [ -z "${DATABASE_URL:-}" ]; then
  # No external Postgres → boot the embedded PGlite backend (src/start-local.ts).
  # First run mints a web login (dev@lobu.local / lobudev123, org "dev") and a
  # bootstrap PAT under LOBU_DATA_DIR. Vite HMR still runs in-process.
  export LOBU_DATA_DIR="${LOBU_DATA_DIR:-$REPO_ROOT/.lobu-dev}"
  export PGSSLMODE=disable
  mkdir -p "$LOBU_DATA_DIR"
  echo "→ no DATABASE_URL set — booting embedded PGlite"
  echo "→ server on http://${HOST}:${PORT}   (Vite HMR in-process)"
  echo "→ data dir: $LOBU_DATA_DIR"
  echo "→ first run seeds a web login: dev@lobu.local / lobudev123   (org 'dev')"
  echo "→ then run \`lobu apply\` from a project dir to sync its lobu.toml"
  echo ""
  exec bun run --filter '@lobu/server' dev:local
fi

export PGSSLMODE="${PGSSLMODE:-require}"

echo "→ server on http://${HOST}:${PORT}"
echo "→ embedded gateway proxy on :${WORKER_PROXY_PORT}"
echo "→ Vite HMR in-process (same port)"
echo ""

exec bun run --filter '@lobu/server' dev
