#!/bin/bash
set -e

MODE="${1:-server}"

echo "Starting Owletto (Node.js)"
echo "================================"

# Log environment (masked)
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
echo "Starting Node.js server on port 8787..."

# Run pending migrations before starting the server
run_migrations

# Patch ESM-only packages for CJS compat (catches lazy-installed deps like lobu/node_modules/*)
node /app/patch-esm-exports.cjs 2>/dev/null || true

# Start the Node.js server using tsx
exec pnpm exec tsx /app/src/server.ts
