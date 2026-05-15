#!/usr/bin/env bash
# =============================================================================
# Optional local-dev setup for the PostGIS-backed geo enrichment path.
#
# Postgis is optional: without it, the geo-enrichment migration is a no-op
# and runtime enrichment skips silently (per AGENTS.md). Run this when you
# want apple.photos / location-bearing events to fill in country / admin1 /
# place_name locally.
#
# What it does, in order:
#   1) Reads DATABASE_URL from the environment, or sources ./.env if unset.
#   2) Checks that the target server has the `postgis` extension available
#      (postgresql-NN-postgis-3 / postgis Homebrew formula installed).
#      If not, prints the OS-specific install command and exits 1.
#   3) Runs `CREATE EXTENSION IF NOT EXISTS postgis;`.
#   4) Calls scripts/seed-geo-data.sh to populate geo_countries /
#      geo_admin1 / geo_places from GeoNames.
#
# Re-running is safe: CREATE EXTENSION is idempotent, the seed TRUNCATEs +
# re-imports each table.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

if [[ -z "${DATABASE_URL:-}" ]]; then
    if [[ -f .env ]]; then
        # shellcheck disable=SC1091
        set -a; . ./.env; set +a
    fi
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "error: DATABASE_URL not set and no .env found at $(pwd)/.env" >&2
    exit 1
fi

command -v psql >/dev/null || {
    echo "error: psql not on PATH. Install postgresql-client first." >&2
    exit 1
}

install_hint() {
    local os
    os="$(uname -s)"
    case "${os}" in
        Darwin)
            cat <<'HINT'

PostGIS is not available on the server. To install on macOS (Homebrew):

  brew install postgis
  brew services restart postgresql@<major>     # e.g. postgresql@16

HINT
            ;;
        Linux)
            cat <<'HINT'

PostGIS is not available on the server. To install on Debian/Ubuntu:

  PG_MAJOR=$(psql "$DATABASE_URL" -tAc 'SHOW server_version_num' | cut -c1-2)
  sudo apt-get update
  sudo apt-get install -y "postgresql-${PG_MAJOR}-postgis-3"

For other distros, install the matching postgresql-NN-postgis-3 package.

HINT
            ;;
        *)
            echo "PostGIS is not available on the server. Install the postgresql-NN-postgis-3 package matching your server version."
            ;;
    esac
    echo "Then rerun: ./scripts/setup-local-postgis.sh"
}

echo "==> checking server for postgis extension"
AVAILABLE=$(psql "${DATABASE_URL}" -tAc "SELECT 1 FROM pg_available_extensions WHERE name='postgis'")
if [[ "${AVAILABLE}" != "1" ]]; then
    install_hint
    exit 1
fi

echo "==> CREATE EXTENSION postgis"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS postgis;'

echo "==> seeding GeoNames reference tables"
bash "${SCRIPT_DIR}/seed-geo-data.sh"

echo
echo "==> done. Geo enrichment is live for this DATABASE_URL."
