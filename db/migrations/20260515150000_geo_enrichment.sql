-- migrate:up

-- =============================================================================
-- Geo enrichment: reverse-geocode lat/lng → country / admin1 / place at the
-- gateway, once, for every event with coordinates. Used by `apple.photos`
-- today; gmaps reviews, github commit metadata, and any future geo-bearing
-- connector benefit automatically.
--
-- Three system-level reference tables (no organization_id — these are
-- read-only geographic facts shared across all tenants) seeded from
-- GeoNames (https://www.geonames.org/, CC-BY 4.0):
--
--   geo_countries — country_code → name/continent/currency/etc. (~250 rows)
--   geo_admin1    — state/province codes per country (~4k rows)
--   geo_places    — populated places (cities/towns/villages/hamlets);
--                   seeded from GeoNames cities1000.txt (~150k rows for v1).
--                   Can be upgraded to the full PPL-class subset of
--                   allCountries (~5M rows) without schema changes —
--                   nearest-neighbor query is the same shape.
--
-- The `geo_lookup(lat, lng)` function returns the enriched row in one
-- call. Nearest-neighbor uses PostGIS `geography(POINT, 4326)` + GiST so
-- distance is true geodesic (not L2-on-degrees), and the index keeps it
-- sub-millisecond at any table size we'd ever load.
--
-- Run `scripts/seed-geo-data.sh` after this migration applies to populate
-- the tables. The TS enrichment hook gracefully no-ops if the tables are
-- empty or the function is missing, so partially-deployed installs keep
-- working — events just don't get the enriched fields until seeding runs.
--
-- ENVIRONMENTS WITHOUT POSTGIS: the entire migration is wrapped in a DO
-- block that probes for the extension. If PostGIS isn't installable
-- (PGlite in tests, restricted hosts), every statement below is skipped
-- with a NOTICE. The runtime enrichment hook also fails open, so
-- partially-supported environments keep functioning — they just don't
-- get geo enrichment.
-- =============================================================================

DO $migration$
BEGIN
    -- Try to install PostGIS. If it's not available on this host (PGlite
    -- without the postgis extension registered, managed Postgres without
    -- the extension, etc.), bail out cleanly.
    BEGIN
        CREATE EXTENSION IF NOT EXISTS postgis;
    EXCEPTION
        WHEN OTHERS THEN
            RAISE NOTICE
                'geo-enrichment: PostGIS unavailable (%), skipping geo schema. Runtime enrichment will no-op.',
                SQLERRM;
            RETURN;
    END;

    -- spatial_ref_sys row for SRID 4326 (WGS-84). Real PostGIS installs
    -- bundle ~8000 standard projections; the pglite-postgis WASM build
    -- ships an empty table to keep the bundle small. Inserting the one
    -- row we use makes nearest-neighbour queries work everywhere; the
    -- ON CONFLICT skips on prod where the row already exists.
    INSERT INTO spatial_ref_sys (srid, auth_name, auth_srid, srtext, proj4text)
    VALUES (
        4326,
        'EPSG',
        4326,
        'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]',
        '+proj=longlat +datum=WGS84 +no_defs'
    )
    ON CONFLICT (srid) DO NOTHING;

    -- Everything below this point assumes PostGIS is loaded. EXECUTE-wrapping
    -- the DDL keeps the SQL parser from choking on `geography(POINT, 4326)`
    -- when this whole DO block is parsed before the extension creates the type.

    -- geo_countries — ISO-2 country code → full record. Source: GeoNames
    -- countryInfo.txt.
    EXECUTE $ddl$
        CREATE TABLE IF NOT EXISTS geo_countries (
            code             text PRIMARY KEY,
            code3            text,
            numeric_code     integer,
            fips             text,
            name             text NOT NULL,
            capital          text,
            area_sq_km       numeric,
            population       bigint,
            continent        text,
            tld              text,
            currency_code    text,
            currency_name    text,
            phone            text,
            postal_code_fmt  text,
            postal_code_re   text,
            languages        text,
            geonameid        bigint,
            neighbours       text
        )
    $ddl$;

    -- geo_admin1 — first-order administrative subdivisions.
    -- Code shape: '<ISO2>.<ADMIN1>' (e.g. 'IT.07' = Lazio).
    EXECUTE $ddl$
        CREATE TABLE IF NOT EXISTS geo_admin1 (
            code         text PRIMARY KEY,
            country_code text NOT NULL,
            name         text NOT NULL,
            ascii_name   text NOT NULL,
            geonameid    bigint
        )
    $ddl$;

    EXECUTE 'CREATE INDEX IF NOT EXISTS geo_admin1_country_idx ON geo_admin1 (country_code)';

    -- geo_places — populated places. `location` is a generated geography
    -- point that the GiST index uses for nearest-neighbour lookup. Stays
    -- sub-ms even at 5M+ rows.
    EXECUTE $ddl$
        CREATE TABLE IF NOT EXISTS geo_places (
            geonameid    bigint PRIMARY KEY,
            name         text NOT NULL,
            ascii_name   text NOT NULL,
            alt_names    text,
            latitude     double precision NOT NULL,
            longitude    double precision NOT NULL,
            feature_class text,
            feature_code  text,
            country_code  text NOT NULL,
            admin1_code   text,
            admin2_code   text,
            population    bigint DEFAULT 0,
            elevation_m   integer,
            timezone      text,
            location      geography(POINT, 4326)
                GENERATED ALWAYS AS (
                    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
                ) STORED
        )
    $ddl$;

    EXECUTE 'CREATE INDEX IF NOT EXISTS geo_places_location_idx ON geo_places USING GIST (location)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS geo_places_country_idx  ON geo_places (country_code)';

    -- geo_lookup(lat, lng) — single-call enrichment.
    -- Returns the nearest populated place plus the country/admin1 join.
    -- distance_km is included so callers can apply their own threshold
    -- (e.g., reject results > 500 km away — ocean/desert coordinates that
    -- would otherwise snap misleadingly to the closest coastal city).
    EXECUTE $fn$
        CREATE OR REPLACE FUNCTION geo_lookup(p_lat double precision, p_lng double precision)
        RETURNS TABLE (
            place_name    text,
            place_id      bigint,
            country_code  text,
            country_name  text,
            admin1_code   text,
            admin1_name   text,
            timezone      text,
            population    bigint,
            distance_km   double precision
        )
        LANGUAGE sql
        STABLE
        PARALLEL SAFE
        AS $body$
            WITH nearest AS (
                SELECT
                    p.geonameid,
                    p.name,
                    p.country_code,
                    p.admin1_code,
                    p.timezone,
                    p.population,
                    ST_Distance(
                        p.location,
                        ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
                    ) / 1000.0 AS distance_km
                FROM geo_places p
                ORDER BY p.location <-> ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
                LIMIT 1
            )
            SELECT
                n.name                                              AS place_name,
                n.geonameid                                         AS place_id,
                n.country_code                                      AS country_code,
                c.name                                              AS country_name,
                CASE
                    WHEN n.admin1_code IS NULL OR n.admin1_code = '' THEN NULL
                    ELSE n.country_code || '.' || n.admin1_code
                END                                                AS admin1_code,
                a.name                                              AS admin1_name,
                n.timezone                                          AS timezone,
                n.population                                        AS population,
                n.distance_km                                       AS distance_km
            FROM nearest n
            LEFT JOIN geo_countries c ON c.code = n.country_code
            LEFT JOIN geo_admin1 a    ON a.code = n.country_code || '.' || n.admin1_code
        $body$
    $fn$;
END
$migration$;

-- migrate:down

DROP FUNCTION IF EXISTS geo_lookup(double precision, double precision);
DROP TABLE IF EXISTS geo_places;
DROP TABLE IF EXISTS geo_admin1;
DROP TABLE IF EXISTS geo_countries;
-- Intentionally do NOT DROP EXTENSION postgis. The extension may be
-- shared by other tables / future migrations on the same Postgres
-- instance; rolling back this migration shouldn't take that down.
