#!/bin/bash
set -euo pipefail

# Check dependencies
command -v bun >/dev/null || { echo "Install bun: curl -fsSL https://bun.sh/install | bash"; exit 1; }

# Provision the shared dev Postgres: brew postgresql@18 on :5418 — the default
# `make dev` / dev-db.sh backend, same MAJOR as the product's embedded PG18.
# Coexists with @17 on 5432 (lobu_test / the integration suite). Idempotent, and
# skipped gracefully if brew/@18 are absent — `make dev-embedded` still needs none.
if command -v brew >/dev/null 2>&1 && brew list postgresql@18 >/dev/null 2>&1; then
  PGDATA18="$(brew --prefix)/var/postgresql@18"
  if ! grep -qE '^port = 5418' "$PGDATA18/postgresql.conf" 2>/dev/null; then
    echo "port = 5418" >> "$PGDATA18/postgresql.conf"
  fi
  brew services start postgresql@18 >/dev/null 2>&1 || true
  PGBIN18="$(brew --prefix postgresql@18)/bin"
  for _ in $(seq 1 15); do "$PGBIN18/pg_isready" -h localhost -p 5418 -q 2>/dev/null && break; sleep 1; done
  # Role DB so `psql`/dev-db.sh connect as $USER (pgvector is installed per-DB on
  # first boot via LOBU_RUN_OWNS_DB; the extension bottle is already present).
  "$PGBIN18/createdb" -h localhost -p 5418 "$USER" 2>/dev/null || true
  echo "✓ brew postgresql@18 running on :5418 (the default 'make dev' backend)"
else
  echo "ℹ brew postgresql@18 not found — install it (brew install postgresql@18) for 'make dev',"
  echo "  or use the zero-dependency embedded loop: make dev-embedded"
fi

make build-packages

echo "Setup complete!"
echo ""
echo "If you haven't configured .env yet, run:"
echo "  npx @lobu/cli@latest"
echo ""
echo "To start development:"
echo "  make dev             # local dev against shared brew Postgres@18 + Vite HMR"
echo "  make dev-embedded    # zero-dependency embedded per-worktree Postgres (lobu run / CI runtime)"
