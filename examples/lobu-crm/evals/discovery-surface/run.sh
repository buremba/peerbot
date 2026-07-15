#!/usr/bin/env bash
# Discovery-surface eval launcher.
#
# The eval runs the REAL isolated-vm sandbox (run_sdk / query_sdk), whose native
# addon only loads under Node 22–24 — NOT under Bun. So this harness runs under
# node@22 + tsx. The repo-root tsconfig `paths` map `@lobu/*` to `src`, which
# lets tsx resolve the workspace transitively (the built `dist` is CJS and its
# `export *` re-exports don't bind cleanly through node's ESM loader).
#
# GEMINI_API_KEY is sourced from the repo .env. DATABASE_URL must point at a
# throwaway *test* Postgres (name containing "test"); the harness runs migrations
# (DROP SCHEMA public CASCADE) against it, guarded by assertSafeTestDatabaseUrl.
#
# Usage:
#   ./run.sh [--trials N] [--tasks id,id]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# repo root = five levels up from examples/lobu-crm/evals/discovery-surface
ROOT="$(cd "$HERE/../../../.." && pwd)"

# Node 22 (isolated-vm prebuilt ABI). Override with NODE22_BIN if elsewhere.
NODE22_BIN="${NODE22_BIN:-/opt/homebrew/opt/node@22/bin/node}"
if [ ! -x "$NODE22_BIN" ]; then
  echo "node@22 not found at $NODE22_BIN — set NODE22_BIN to a Node 22–24 binary (isolated-vm needs it)." >&2
  exit 1
fi

# Source GEMINI_API_KEY (+ optional GEMINI_API_BASE_URL / GEMINI_MODEL_ID) from .env.
if [ -z "${GEMINI_API_KEY:-}" ] && [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi
if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "GEMINI_API_KEY not set and not found in $ROOT/.env — cannot run the real eval." >&2
  exit 2
fi

# Default to a local throwaway test DB if the caller didn't set one.
export DATABASE_URL="${DATABASE_URL:-postgresql://localhost:5432/lobu_mcp_discovery_test}"
case "$DATABASE_URL" in
  *test*|*_ci) : ;;
  *) echo "Refusing to run: DATABASE_URL ($DATABASE_URL) is not an obvious test DB (name must contain 'test')." >&2; exit 1 ;;
esac

exec "$NODE22_BIN" --import "$ROOT/node_modules/tsx/dist/loader.mjs" "$HERE/run.ts" "$@"
