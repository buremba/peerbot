#!/usr/bin/env bash
# =============================================================================
# Seed the geo_countries / geo_admin1 / geo_places tables from GeoNames.
#
# Run once after the 20260515150000_geo_enrichment.sql migration applies.
# Idempotent: TRUNCATEs each target table before re-importing, so re-running
# pulls fresh GeoNames data without surfacing duplicates.
#
# Requires:
#   - DATABASE_URL env var or the script reads from ../.env
#   - psql, curl, unzip, awk on PATH
#   - PostGIS already installed (the migration does this)
#
# Defaults to GeoNames cities1000.txt (~150k rows, ~7MB compressed, ~20MB
# uncompressed) — the v1 sweet spot. To use a different dataset:
#   GEO_PLACES_SOURCE=cities500   ./scripts/seed-geo-data.sh
#   GEO_PLACES_SOURCE=cities5000  ./scripts/seed-geo-data.sh
#   GEO_PLACES_SOURCE=cities15000 ./scripts/seed-geo-data.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# DATABASE_URL: env wins, otherwise pull from repo .env.
if [[ -z "${DATABASE_URL:-}" && -f "${REPO_ROOT}/.env" ]]; then
    DATABASE_URL="$(grep -E '^DATABASE_URL=' "${REPO_ROOT}/.env" | head -1 | cut -d= -f2-)"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "error: DATABASE_URL not set and no .env in ${REPO_ROOT}" >&2
    exit 1
fi

# Dataset choice. cities1000 is the v1 default — best balance of size and
# coverage. cities500 (200k rows) gets neighbourhoods + hamlets. cities5000
# (50k) is too coarse for "where was this photo".
GEO_PLACES_SOURCE="${GEO_PLACES_SOURCE:-cities1000}"

case "${GEO_PLACES_SOURCE}" in
    cities500|cities1000|cities5000|cities15000) ;;
    *)
        echo "error: GEO_PLACES_SOURCE='${GEO_PLACES_SOURCE}' — expected one of cities500|cities1000|cities5000|cities15000" >&2
        exit 1
        ;;
esac

WORKDIR="$(mktemp -d -t lobu-geo-seed)"
trap 'rm -rf "${WORKDIR}"' EXIT

echo "==> seed-geo-data: working in ${WORKDIR}"
echo "==> dataset: ${GEO_PLACES_SOURCE}"

# -----------------------------------------------------------------------------
# 1) geo_countries  (GeoNames countryInfo.txt)
# -----------------------------------------------------------------------------
echo "==> downloading countryInfo.txt"
curl -sSfL --retry 3 "https://download.geonames.org/export/dump/countryInfo.txt" \
    -o "${WORKDIR}/countryInfo.txt"

# countryInfo.txt is tab-separated with a # comment header — strip comments.
# Column order (1-indexed): ISO ISO3 ISO-Numeric fips Country Capital Area
# Population Continent tld CurrencyCode CurrencyName Phone Postal-Code-Format
# Postal-Code-Regex Languages geonameid neighbours EquivalentFipsCode
grep -v '^#' "${WORKDIR}/countryInfo.txt" \
    | awk -F'\t' 'NF >= 18 { print $1"\t"$2"\t"$3"\t"$4"\t"$5"\t"$6"\t"$7"\t"$8"\t"$9"\t"$10"\t"$11"\t"$12"\t"$13"\t"$14"\t"$15"\t"$16"\t"$17"\t"$18 }' \
    > "${WORKDIR}/geo_countries.tsv"

echo "==> importing geo_countries ($(wc -l < "${WORKDIR}/geo_countries.tsv") rows)"
psql "${DATABASE_URL}" <<SQL
BEGIN;
TRUNCATE geo_countries;
\\copy geo_countries (code, code3, numeric_code, fips, name, capital, area_sq_km, population, continent, tld, currency_code, currency_name, phone, postal_code_fmt, postal_code_re, languages, geonameid, neighbours) FROM '${WORKDIR}/geo_countries.tsv' WITH (FORMAT csv, DELIMITER E'\t', NULL '', QUOTE E'\b');
COMMIT;
SQL

# -----------------------------------------------------------------------------
# 2) geo_admin1  (GeoNames admin1CodesASCII.txt)
# -----------------------------------------------------------------------------
echo "==> downloading admin1CodesASCII.txt"
curl -sSfL --retry 3 "https://download.geonames.org/export/dump/admin1CodesASCII.txt" \
    -o "${WORKDIR}/admin1CodesASCII.txt"

# Column order: code(IT.07)  name  asciiname  geonameid
# Derive country_code = code prefix before the first dot.
awk -F'\t' 'NF >= 4 {
    split($1, parts, ".");
    printf "%s\t%s\t%s\t%s\t%s\n", $1, parts[1], $2, $3, $4
}' "${WORKDIR}/admin1CodesASCII.txt" > "${WORKDIR}/geo_admin1.tsv"

echo "==> importing geo_admin1 ($(wc -l < "${WORKDIR}/geo_admin1.tsv") rows)"
psql "${DATABASE_URL}" <<SQL
BEGIN;
TRUNCATE geo_admin1;
\\copy geo_admin1 (code, country_code, name, ascii_name, geonameid) FROM '${WORKDIR}/geo_admin1.tsv' WITH (FORMAT csv, DELIMITER E'\t', NULL '', QUOTE E'\b');
COMMIT;
SQL

# -----------------------------------------------------------------------------
# 3) geo_places  (GeoNames cities*.zip)
# -----------------------------------------------------------------------------
echo "==> downloading ${GEO_PLACES_SOURCE}.zip"
curl -sSfL --retry 3 "https://download.geonames.org/export/dump/${GEO_PLACES_SOURCE}.zip" \
    -o "${WORKDIR}/${GEO_PLACES_SOURCE}.zip"

echo "==> unzipping"
unzip -q -o "${WORKDIR}/${GEO_PLACES_SOURCE}.zip" -d "${WORKDIR}/"

PLACES_TXT="${WORKDIR}/${GEO_PLACES_SOURCE}.txt"

# Column order (1-indexed): geonameid name asciiname alternatenames latitude
# longitude feature_class feature_code country_code cc2 admin1_code admin2_code
# admin3_code admin4_code population elevation dem timezone modification_date
#
# We project to: geonameid, name, ascii_name, alt_names, latitude, longitude,
# feature_class, feature_code, country_code, admin1_code, admin2_code,
# population, elevation, timezone. (elevation may be empty in the source.)
awk -F'\t' 'NF >= 18 {
    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $11, $12, $15, $16, $18
}' "${PLACES_TXT}" > "${WORKDIR}/geo_places.tsv"

echo "==> importing geo_places ($(wc -l < "${WORKDIR}/geo_places.tsv") rows)"
# `location` is a GENERATED column — don't COPY it, postgres computes from
# latitude+longitude on insert.
psql "${DATABASE_URL}" <<SQL
BEGIN;
TRUNCATE geo_places;
\\copy geo_places (geonameid, name, ascii_name, alt_names, latitude, longitude, feature_class, feature_code, country_code, admin1_code, admin2_code, population, elevation_m, timezone) FROM '${WORKDIR}/geo_places.tsv' WITH (FORMAT csv, DELIMITER E'\t', NULL '', QUOTE E'\b');
ANALYZE geo_places;
COMMIT;
SQL

# -----------------------------------------------------------------------------
# Smoke test — pick a famous coordinate, verify geo_lookup returns the right
# city. Failure = data is loaded but PostGIS / indexes / function are wrong.
# -----------------------------------------------------------------------------
echo "==> smoke test"
psql "${DATABASE_URL}" -c "SELECT place_name, country_name, admin1_name, ROUND(distance_km::numeric, 2) AS km FROM geo_lookup(41.8902, 12.4922);"

echo "==> done. Geo enrichment ready."
