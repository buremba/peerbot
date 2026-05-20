#!/usr/bin/env bash
# Build the pgvector artifact for the current platform and stage it under
# prebuilt/<platform>/.
#
# embedded-postgres ships PostgreSQL 18.x with NO pg_config and NO server
# headers, so pgvector cannot be compiled against it directly. Instead we build
# against a separately-installed PostgreSQL of the SAME MAJOR version (18.x) and
# rely on the extension ABI being stable within a major — a library built
# against any 18.x loads into embedded-postgres's 18.x. (Validated locally:
# Homebrew PG 18.1's vector.dylib loaded into embedded-postgres PG 18.3.)
#
# Requirements (provided per CI matrix cell):
#   - pg_config for PostgreSQL 18 on PATH, or PG_CONFIG pointing at it
#   - a C toolchain (make + cc)
#
# Usage:
#   PGVECTOR_VERSION=v0.8.1 packages/pgvector-embedded/scripts/build.sh
set -euo pipefail

PGVECTOR_VERSION="${PGVECTOR_VERSION:-v0.8.1}"
PG_CONFIG="${PG_CONFIG:-pg_config}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Platform key must match embedded-postgres's package suffix and Node's
# process.platform-process.arch (darwin-arm64, darwin-x64, linux-x64, linux-arm64).
node_platform() { node -e 'process.stdout.write(`${process.platform}-${process.arch}`)'; }
PLATFORM="${PLATFORM:-$(node_platform)}"
OUT_DIR="${PKG_ROOT}/prebuilt/${PLATFORM}"

PG_MAJOR="$("${PG_CONFIG}" --version | sed -E 's/^PostgreSQL ([0-9]+).*/\1/')"
if [[ "${PG_MAJOR}" != "18" ]]; then
  echo "ERROR: pg_config reports PostgreSQL ${PG_MAJOR}, expected 18 (embedded-postgres major). Set PG_CONFIG." >&2
  exit 1
fi

echo "==> pgvector ${PGVECTOR_VERSION} for ${PLATFORM} against $(${PG_CONFIG} --version)"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
git clone --depth 1 --branch "${PGVECTOR_VERSION}" https://github.com/pgvector/pgvector.git "${WORK}/pgvector"

# OPTFLAGS="" strips pgvector's default `-march=native`. These artifacts are
# redistributed and loaded on arbitrary user CPUs, so a binary tuned to the CI
# runner's microarchitecture would SIGILL on older hardware. Build for the
# baseline target instead; the perf delta is negligible next to portability.
make -C "${WORK}/pgvector" PG_CONFIG="${PG_CONFIG}" OPTFLAGS=""

PKGLIBDIR="$(${PG_CONFIG} --pkglibdir)"
SHARED_DIR="${PKG_ROOT}/prebuilt"

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}" "${SHARED_DIR}"

# Stage straight from the build dir — we run `make` but not `make install`, so
# nothing lands in the OS Postgres's pkglibdir/sharedir. The library, control
# file, and generated SQL all sit under the cloned/built pgvector tree.
#
# Compiled extension library is the only PLATFORM-SPECIFIC artifact → goes in
# prebuilt/<platform>/ (name differs per platform via $(DLSUFFIX)).
cp "${WORK}/pgvector/vector"*.so "${OUT_DIR}/" 2>/dev/null || true
cp "${WORK}/pgvector/vector"*.dylib "${OUT_DIR}/" 2>/dev/null || true
# Fall back to an installed copy only if the build dir somehow lacks the lib.
if ! ls "${OUT_DIR}"/vector.* >/dev/null 2>&1; then
  cp "${PKGLIBDIR}/vector".* "${OUT_DIR}/"
fi

# Control + the full-install SQL for the pinned version are byte-identical
# across platforms, so they're vendored ONCE at the prebuilt root (not per
# platform). CREATE EXTENSION at default_version reads vector--<version>.sql
# directly; the vector--A--B.sql upgrade scripts only run on ALTER EXTENSION
# UPDATE, never on a fresh embedded DB, so we don't ship them.
PGVECTOR_SQL_VERSION="${PGVECTOR_VERSION#v}"
cp "${WORK}/pgvector/vector.control" "${SHARED_DIR}/"
cp "${WORK}/pgvector/sql/vector--${PGVECTOR_SQL_VERSION}.sql" "${SHARED_DIR}/"

echo "==> staged $(ls "${OUT_DIR}" | wc -l | tr -d ' ') platform file(s) in ${OUT_DIR}"
ls -1 "${OUT_DIR}" | sed 's/^/    /'
echo "==> staged shared control + SQL in ${SHARED_DIR}"
ls -1 "${SHARED_DIR}"/vector.control "${SHARED_DIR}"/vector--*.sql | sed 's/^/    /'
