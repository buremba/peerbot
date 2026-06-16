-- migrate:up

-- Two more provably-redundant indexes on small / low-write tables, where a plain
-- DROP INDEX (momentary ACCESS EXCLUSIVE) is fine — no CONCURRENTLY needed.
--
--   geo_places_location_idx — gist(location), the postgis geometry index. The
--       live reverse-geocoding path is the geo_lookup() function, which orders
--       by ll_to_earth(lat,lng) KNN and is served entirely by
--       geo_places_earth_idx (see migration 20260520120000). The `location`
--       column + this 11 MB index are the superseded postgis approach — dead,
--       not merely idle. (The vestigial `location` column itself is left for a
--       separate change.)
--   idx_connect_tokens_token — btree(token) that duplicates the UNIQUE
--       connect_tokens_token_key on the same column; the unique index serves
--       every lookup.

DROP INDEX IF EXISTS public.geo_places_location_idx;
DROP INDEX IF EXISTS public.idx_connect_tokens_token;

-- migrate:down

-- geo_places.location is prod-only drift (never in the #908 baseline), so guard
-- the restore: recreate the index only where the column exists (prod), no-op on
-- fresh DBs that never had it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'geo_places' AND column_name = 'location'
  ) THEN
    CREATE INDEX IF NOT EXISTS geo_places_location_idx
        ON public.geo_places USING gist (location);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_connect_tokens_token
    ON public.connect_tokens USING btree (token);
