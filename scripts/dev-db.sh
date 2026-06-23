#!/usr/bin/env bash
# Local dev against the local (brew) Postgres — one DATABASE per worktree/branch,
# so a single name keys the worktree, its database, and (with portless) its URL.
# No embedded cluster, so none of the shm-slot / data-dir-lock gotchas; and
# `FROM=<db>` forks an existing dataset for a safe, disposable preview.
#
#   make dev-db                                    # DB = current branch
#   make dev-db NAME=sidebar
#   make dev-db NAME=preview FROM=owletto_local    # fork real dev data
#   make dev-db NAME=sidebar PORT=8931 WORKER_PROXY_PORT=8131
#
# This is what `make dev` runs by default. The embedded per-worktree cluster is
# opt-in via `LOBU_EMBEDDED=1 make dev` (a.k.a. `make dev-embedded`) — it stays the
# `lobu run` / CI runtime, but is no longer the dev default (its per-worktree
# clusters + kill-9 churn leak SysV shm anchors into macOS's shmmni=32 cap).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/lib/db-name.sh
. "$REPO_ROOT/scripts/lib/db-name.sh"

# Name defaults to the current git branch (the worktree's branch) so the
# database tracks the worktree. `lobu_db_name` derives `lobu_feat_sidebar` from
# `feat/sidebar` — and `task-clean.sh` uses the same helper to drop it.
RAW_NAME="${NAME:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo dev)}"
DB="$(lobu_db_name "$RAW_NAME")"

PGHOST="${PGHOST:-localhost}"
# Default to brew postgresql@18 on 5418 — same MAJOR as the product's embedded
# runtime (embedded-postgres@18). 5432 stays @17 (lobu_test / the integration
# suite). Override with PGPORT=5432 to target @17.
PGPORT="${PGPORT:-5418}"
PGUSER="${PGUSER:-$USER}"
export PGHOST PGPORT PGUSER

# Each worktree's unique app ports live in .env.local (task-setup writes them).
# When `make dev` routes here, PORT/WORKER_PROXY_PORT arrive empty, and dev-native.sh
# only sources .env.local AFTER we set PORT below — so seed them here first, else
# every worktree collides on the 8930 default.
if [ -z "${PORT:-}" ] && [ -f "$REPO_ROOT/.env.local" ]; then
  PORT="$(awk -F= '/^PORT=/{print $2; exit}' "$REPO_ROOT/.env.local" | tr -d '[:space:]')"
fi
if [ -z "${WORKER_PROXY_PORT:-}" ] && [ -f "$REPO_ROOT/.env.local" ]; then
  WORKER_PROXY_PORT="$(awk -F= '/^WORKER_PROXY_PORT=/{print $2; exit}' "$REPO_ROOT/.env.local" | tr -d '[:space:]')"
fi

# Fail fast with a clear message if the brew cluster isn't up — so the default
# `make dev` doesn't dump a cryptic createdb error on a machine without Postgres.
if ! pg_isready -h "$PGHOST" -p "$PGPORT" -q 2>/dev/null; then
  echo "✗ No Postgres reachable at $PGHOST:$PGPORT (brew postgresql@18)." >&2
  echo "  First-time setup: make setup   (provisions + starts postgresql@18 on 5418)" >&2
  echo "  Or the zero-dependency embedded loop: LOBU_EMBEDDED=1 make dev" >&2
  exit 1
fi

db_exists() {
  psql -tAc "select 1 from pg_database where datname='$1'" postgres 2>/dev/null | grep -q 1
}

if db_exists "$DB"; then
  echo "→ using existing database $DB"
elif [ -n "${FROM:-}" ]; then
  # Fork via dump/restore so it works even when $FROM has live connections
  # (CREATE DATABASE ... TEMPLATE refuses to copy an in-use database — and a live
  # dev DB is exactly when you want to fork). The source must still be at the
  # current schema; an old/drifted DB won't migrate forward.
  echo "→ forking $FROM → $DB (pg_dump)"
  createdb "$DB"
  if ! pg_dump --no-owner --no-privileges "$FROM" | psql -q -v ON_ERROR_STOP=1 -d "$DB" >/dev/null; then
    echo "✗ fork failed while copying '$FROM' → '$DB'." >&2
    dropdb --if-exists "$DB" 2>/dev/null
    exit 1
  fi
else
  echo "→ creating database $DB (the app migrates the schema on first boot)"
  createdb "$DB"
fi

export DATABASE_URL="postgres://${PGUSER}@${PGHOST}:${PGPORT}/${DB}"
export PORT="${PORT:-8930}"
# portless owns the front-door PORT, but it can't see Lobu's internal worker
# egress proxy — so auto-pick a free port for it (unless one was given) and
# parallel previews never collide on it.
if [ -z "${WORKER_PROXY_PORT:-}" ]; then
  WORKER_PROXY_PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')"
fi
export WORKER_PROXY_PORT
# Single-operator local install: own the database lifecycle — apply migrations
# to the target DB (so a fresh DB gets the schema and a fork is upgraded to the
# current version; runMigrations is idempotent) and seed the first user/org so
# /api/local-init works. Same flag `lobu run` uses; prod never sets it.
export LOBU_RUN_OWNS_DB=1
# Single-user mode: makes /api/auth-config report singleUserMode=true, so the SPA
# signs you in automatically via the loopback /api/local-init handshake instead
# of showing the cloud login form. The embedded runtime defaults this on; the
# external-Postgres path (this script) doesn't, so set it here for the walk-in
# local UX. Override with LOBU_SINGLE_USER=0 to test the multi-user login form.
export LOBU_SINGLE_USER="${LOBU_SINGLE_USER:-1}"
echo "→ DATABASE_URL=$DATABASE_URL"
echo "→ server on :$PORT   (worker proxy :$WORKER_PROXY_PORT)"
echo ""
# dev-native.sh routes the postgres:// URL to the external path and, for a
# localhost host, defaults PGSSLMODE=disable — so brew Postgres just works.
exec "$REPO_ROOT/scripts/dev-native.sh"
