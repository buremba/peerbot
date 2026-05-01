#!/bin/bash
set -e

MODE="${1:-server}"

echo "Starting Owletto backend (Node)"
echo "================================"

echo "Environment:"
echo "  DATABASE_URL: ${DATABASE_URL:+***set***}"
echo "  GITHUB_TOKEN: ${GITHUB_TOKEN:+***set***}"
echo "  JWT_SECRET: ${JWT_SECRET:+***set***}"

run_migrations() {
  if [ -z "$DATABASE_URL" ]; then
    echo "ERROR: DATABASE_URL not set"
    exit 1
  fi

  echo ""
  echo "Running database migrations..."
  dbmate --url "$DATABASE_URL" --migrations-dir /app/db/migrations --no-dump-schema up
  echo "Migrations complete"
}

if [ "$MODE" = "migrate" ]; then
  run_migrations
  exit 0
fi

echo ""
echo "Starting backend on port 8787..."

# When the Helm chart's pre-upgrade migration Job is enabled, it has
# already applied migrations before this Deployment is rolled. Set
# SKIP_MIGRATIONS=1 in that environment so the per-pod start doesn't
# block on a migration that may take longer than livenessProbe allows.
if [ "${SKIP_MIGRATIONS:-0}" = "1" ]; then
  echo "SKIP_MIGRATIONS=1 — assuming the pre-upgrade Job applied migrations."
else
  run_migrations
fi

# Run under Node so V8 native addons (isolated-vm) load. Bun uses
# JavaScriptCore and cannot link the V8 ABI surface that isolated-vm needs;
# the execute MCP tool silently degrades to RuntimeUnavailable under bun.
#
# We run a pre-bundled artifact (built by scripts/build-server-bundle.mjs
# in the builder stage) instead of TS source via tsx. Bundling at build
# time inlines workspace packages (@lobu/core et al.) so Node never has to
# bind named imports against their CJS dist barrels — that's what crashed
# #430. External npm deps are resolved by Node from node_modules, which
# is hoisted (see Dockerfile `bun install --linker=hoisted`) so the flat
# layout matches what Node expects.
exec node /app/packages/server/dist/server.bundle.mjs
