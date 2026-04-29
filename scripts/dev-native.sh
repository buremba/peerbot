#!/usr/bin/env bash
# Run the embedded Lobu stack natively.
#
# What runs:
#   - owletto-backend (Hono + tsx watch) on :8787
#   - embedded @lobu/gateway (in-process) with HTTP egress proxy on :8118
#   - embedded workers (spawned as Bun subprocesses on demand)
#   - Vite dev middleware for owletto-web on the same :8787 (HMR via WS)
#
# Requires, managed outside this script:
#   - redis-server on localhost:6379 (e.g. `brew services start redis`)
#   - remote Postgres reachable via DATABASE_URL in .env
#
# Skipped vs production: external managed services and cloud backfill workers.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- Preflight -------------------------------------------------------------

command -v bun >/dev/null || { echo "bun is required: curl -fsSL https://bun.sh/install | bash"; exit 1; }

if [ ! -f .env ]; then
  echo "❌ .env not found at $REPO_ROOT/.env"
  echo "   Copy from .env.example or run: npx @lobu/cli@latest"
  exit 1
fi

if [ ! -d packages/core/dist ] || [ ! -d packages/owletto-sdk/dist ] || [ ! -d packages/gateway/dist ]; then
  echo "📦 Building workspace packages (one-time)…"
  make build-packages
fi

if ! (exec 3<>/dev/tcp/127.0.0.1/6379) 2>/dev/null; then
  echo "❌ redis not reachable on localhost:6379"
  echo "   Start it with: brew services start redis"
  exit 1
fi
exec 3<&- 2>/dev/null || true
exec 3>&- 2>/dev/null || true

# --- Env -------------------------------------------------------------------

set -a
# shellcheck disable=SC1091
source .env
set +a

export NODE_ENV="${NODE_ENV:-development}"
export ENVIRONMENT="${ENVIRONMENT:-development}"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8787}"
export PUBLIC_WEB_URL="${PUBLIC_WEB_URL:-http://localhost:${PORT}}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export PGSSLMODE="${PGSSLMODE:-require}"
export LOBU_PROVIDER_REGISTRY_PATH="${LOBU_PROVIDER_REGISTRY_PATH:-$REPO_ROOT/config/providers.json}"
export LOBU_DEV_PROJECT_PATH="${LOBU_DEV_PROJECT_PATH:-$REPO_ROOT}"
export LOBU_WORKSPACE_ROOT="${LOBU_WORKSPACE_ROOT:-$REPO_ROOT/workspaces}"

mkdir -p "$LOBU_WORKSPACE_ROOT"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "❌ DATABASE_URL not set in .env"
  exit 1
fi

# --- Run -------------------------------------------------------------------

echo "→ owletto-backend on http://${HOST}:${PORT}"
echo "→ embedded gateway proxy on :8118"
echo "→ Vite HMR in-process (same port)"
echo ""

exec bun run --filter '@lobu/owletto-backend' dev
