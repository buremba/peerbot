#!/usr/bin/env bash
# Build + push Lobu's CNPG-compatible PostGIS-enabled Postgres image.
#
# Inputs (env, all optional):
#   CNPG_VERSION    Postgres version + minor, must match a published CNPG
#                   tag (e.g. 18.1, 17.4). Default: 18.1
#   CNPG_BASE       CNPG base flavour. Default: system-trixie
#   POSTGIS_TAG     Tag suffix indicating the PostGIS major. Default: 3
#   REGISTRY        Image registry root. Default: ghcr.io/lobu-ai
#   IMAGE_NAME      Image name under REGISTRY. Default: postgres-postgis
#   PUSH            "1" to docker push after build; "0" to build only. Default: 1
#   PLATFORM        Buildx platform. Default: linux/amd64,linux/arm64
#                   (CNPG pods can run on either; multi-arch keeps the cluster
#                   flexible. Set to a single platform for faster local builds.)
#
# Output:
#   ${REGISTRY}/${IMAGE_NAME}:${CNPG_VERSION}-postgis-${POSTGIS_TAG}
#
# After this script succeeds:
#   kubectl -n <ns> patch cluster.postgresql.cnpg.io <name> \
#     --type=merge -p '{"spec":{"imageName":"<that tag>"}}'

set -euo pipefail

CNPG_VERSION="${CNPG_VERSION:-18.1}"
CNPG_BASE="${CNPG_BASE:-system-trixie}"
POSTGIS_TAG="${POSTGIS_TAG:-3}"
REGISTRY="${REGISTRY:-ghcr.io/lobu-ai}"
IMAGE_NAME="${IMAGE_NAME:-postgres-postgis}"
PUSH="${PUSH:-1}"
PLATFORM="${PLATFORM:-linux/amd64,linux/arm64}"

TAG="${CNPG_VERSION}-postgis-${POSTGIS_TAG}"
IMAGE="${REGISTRY}/${IMAGE_NAME}:${TAG}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "==> Building ${IMAGE}"
echo "    CNPG base: ghcr.io/cloudnative-pg/postgresql:${CNPG_VERSION}-${CNPG_BASE}"
echo "    Platform:  ${PLATFORM}"
echo "    Push:      ${PUSH}"

cd "${REPO_ROOT}/db/postgis"

# Always go through buildx so the requested PLATFORM is honoured. Plain
# `docker build` ignores --platform from env on macOS (arm64 host) and
# silently produces an arm64 image; the CNPG pod on an amd64 node then
# loops with "exec format error" — easy to miss until rollout.
BUILDER_NAME="lobu-postgis"
if ! docker buildx inspect "${BUILDER_NAME}" >/dev/null 2>&1; then
    docker buildx create --name "${BUILDER_NAME}" --use >/dev/null
else
    docker buildx use "${BUILDER_NAME}" >/dev/null
fi

BUILD_ACTION="--platform=${PLATFORM}"
if [[ "${PUSH}" == "1" ]]; then
    BUILD_ACTION="${BUILD_ACTION} --push"
elif [[ "${PLATFORM}" == *","* ]]; then
    # Multi-arch + no-push isn't useful — buildx can't load multi-arch
    # manifests into the local engine. Fall back to single-arch local load.
    echo "warning: PUSH=0 with multi-arch PLATFORM — falling back to local load (host arch only)"
    BUILD_ACTION="--load"
else
    BUILD_ACTION="${BUILD_ACTION} --load"
fi

# --provenance=false + --sbom=false: buildx defaults to attaching SLSA
# provenance to multi-arch pushes, which adds "unknown/unknown" platform
# entries to the OCI index. Some containerd versions (incl. the one CNPG
# pods on Hetzner ride on) pick the attestation manifest instead of the
# real amd64/arm64 image and the pod then dies with `exec format error`.
# We don't consume provenance, so strip it.
docker buildx build \
    --build-arg "CNPG_VERSION=${CNPG_VERSION}" \
    --build-arg "CNPG_BASE=${CNPG_BASE}" \
    --provenance=false \
    --sbom=false \
    -t "${IMAGE}" \
    ${BUILD_ACTION} \
    .

echo
echo "==> Done. Image: ${IMAGE}"
echo
echo "Apply to a CNPG cluster:"
echo "  kubectl -n <ns> patch cluster.postgresql.cnpg.io <name> \\"
echo "    --type=merge -p '{\"spec\":{\"imageName\":\"${IMAGE}\"}}'"
echo
echo "Then once the cluster pods finish rolling:"
echo "  psql \"\$DATABASE_URL\" -c 'CREATE EXTENSION postgis;'"
echo "  scripts/seed-geo-data.sh"
