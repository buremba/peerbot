# Lobu's CloudNativePG (CNPG) Postgres image with PostGIS baked in.
#
# Why a custom image: PostGIS is required by Lobu's geo-enrichment migration
# (db/migrations/20260515150000_geo_enrichment.sql). The migration is
# defensive — it cleanly no-ops on hosts where the extension isn't available
# — but the runtime enrichment hook in packages/server only does anything
# when PostGIS is present at boot. For prod we want it present.
#
# Why custom instead of upstream postgis/postgis:
# CloudNativePG ships its own Postgres image with operator-specific init
# scripts, the apicgw extension, recovery hooks, and a hardened layout.
# Plain postgis/postgis lacks all of that and would confuse the operator.
# Extending CNPG's own image with the upstream PostgreSQL APT repo's
# postgresql-<N>-postgis-3 package is the path the CNPG docs recommend.
#
# Build:
#   scripts/build-postgis-image.sh
# (image-tag and target registry can be overridden via env, see script)
#
# After building & pushing, point the cluster at it:
#   kubectl -n <ns> patch cluster.postgresql.cnpg.io <name> \
#     --type=merge -p '{"spec":{"imageName":"<image>:<tag>"}}'
# CNPG rolls the pods; `CREATE EXTENSION postgis;` then succeeds.

ARG CNPG_VERSION=18.1
ARG CNPG_BASE=system-trixie
FROM ghcr.io/cloudnative-pg/postgresql:${CNPG_VERSION}-${CNPG_BASE}

# postgresql-<N>-postgis-3 is in pgdg's repo, which the CNPG base image
# already has registered. Pull the major version out of the base tag so
# the apt package matches.
ARG CNPG_VERSION

USER 0
RUN PG_MAJOR="${CNPG_VERSION%%.*}" \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      "postgresql-${PG_MAJOR}-postgis-3" \
      "postgresql-${PG_MAJOR}-postgis-3-scripts" \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

USER 26
