/**
 * Geo enrichment — integration coverage against a real PostGIS-enabled
 * PGlite. The pglite-backend test setup loads `@electric-sql/pglite-postgis`
 * so the migration's DO block falls through to the real path, and the
 * `geo_lookup(lat, lng)` SQL function runs against actual geography data.
 *
 * The fixture is intentionally tiny (3 countries, 3 admin1 regions, 5
 * cities) — just enough to prove:
 *   - nearest-neighbour ordering is correct against geodesic distance
 *   - the country / admin1 join attaches the right joined fields
 *   - the distance gate in `lookupGeoEnrichment` rejects ocean snaps
 *   - the insertEvent hook enriches metadata without overwriting fields
 *     the connector already set
 *
 * Bulk-data coverage (a full GeoNames cities1000 load + the smoke test for
 * Rome) lives in `scripts/seed-geo-data.sh`; not duplicated here.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetGeoEnrichmentProbeForTests,
  lookupGeoEnrichment,
  mergeEnrichedMetadata,
} from '../../utils/geo-enrichment';
import { insertEvent } from '../../utils/insert-event';
import { getTestDb } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';

// PostGIS isn't installable on every test backend — real-Postgres CI
// runners run with a plain Postgres image, so the geo migration's DO
// block bails out and `geo_lookup` never gets created. PGlite is
// configured with @electric-sql/pglite-postgis (see pglite-backend.ts),
// so the function IS available there. Probe once at module load and
// gate the whole suite — unit tests in utils/__tests__/geo-enrichment
// already cover the fail-open behaviour with stubs.
//
// The probe deliberately does NOT swallow query errors: a real DB
// connection / setup failure should fail the run, not silently skip
// the suite. Only the boolean result of the EXISTS query gates the
// suite.
const probeRows = (await getTestDb()`
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'geo_lookup' AND n.nspname = 'public'
  ) AS yes
`) as Array<{ yes: boolean }>;
const hasGeoSchema = !!probeRows[0]?.yes;

const FIXTURES = {
  countries: [
    { code: 'IT', code3: 'ITA', name: 'Italy', continent: 'EU' },
    { code: 'FR', code3: 'FRA', name: 'France', continent: 'EU' },
    { code: 'US', code3: 'USA', name: 'United States', continent: 'NA' },
  ],
  admin1: [
    { code: 'IT.07', country_code: 'IT', name: 'Lazio', ascii_name: 'Lazio' },
    { code: 'FR.11', country_code: 'FR', name: 'Île-de-France', ascii_name: 'Ile-de-France' },
    { code: 'US.NY', country_code: 'US', name: 'New York', ascii_name: 'New York' },
  ],
  places: [
    {
      geonameid: 3169070,
      name: 'Rome',
      ascii_name: 'Rome',
      latitude: 41.8919,
      longitude: 12.5113,
      feature_class: 'P',
      feature_code: 'PPLC',
      country_code: 'IT',
      admin1_code: '07',
      population: 2872800,
      timezone: 'Europe/Rome',
    },
    {
      geonameid: 2988507,
      name: 'Paris',
      ascii_name: 'Paris',
      latitude: 48.8566,
      longitude: 2.3522,
      feature_class: 'P',
      feature_code: 'PPLC',
      country_code: 'FR',
      admin1_code: '11',
      population: 2148000,
      timezone: 'Europe/Paris',
    },
    {
      geonameid: 5128581,
      name: 'New York City',
      ascii_name: 'New York City',
      latitude: 40.7128,
      longitude: -74.006,
      feature_class: 'P',
      feature_code: 'PPL',
      country_code: 'US',
      admin1_code: 'NY',
      population: 8336000,
      timezone: 'America/New_York',
    },
    {
      geonameid: 5391959,
      name: 'San Francisco',
      ascii_name: 'San Francisco',
      latitude: 37.7749,
      longitude: -122.4194,
      feature_class: 'P',
      feature_code: 'PPLA2',
      country_code: 'US',
      admin1_code: 'CA',
      population: 873965,
      timezone: 'America/Los_Angeles',
    },
  ],
};

async function seedFixture(): Promise<void> {
  const sql = getTestDb();
  await sql`TRUNCATE geo_places, geo_admin1, geo_countries`;
  for (const c of FIXTURES.countries) {
    await sql`
      INSERT INTO geo_countries (code, code3, name, continent)
      VALUES (${c.code}, ${c.code3}, ${c.name}, ${c.continent})
    `;
  }
  for (const a of FIXTURES.admin1) {
    await sql`
      INSERT INTO geo_admin1 (code, country_code, name, ascii_name)
      VALUES (${a.code}, ${a.country_code}, ${a.name}, ${a.ascii_name})
    `;
  }
  for (const p of FIXTURES.places) {
    // `location` is a generated column — we never insert into it.
    await sql`
      INSERT INTO geo_places (
        geonameid, name, ascii_name, latitude, longitude,
        feature_class, feature_code, country_code, admin1_code,
        population, timezone
      ) VALUES (
        ${p.geonameid}, ${p.name}, ${p.ascii_name}, ${p.latitude}, ${p.longitude},
        ${p.feature_class}, ${p.feature_code}, ${p.country_code}, ${p.admin1_code},
        ${p.population}, ${p.timezone}
      )
    `;
  }
}

describe.runIf(hasGeoSchema)('geo enrichment (integration)', () => {
  // Deliberately NOT calling cleanupTestDatabase(): that helper TRUNCATEs
  // every table in public schema, including `spatial_ref_sys` — wiping the
  // 8500 SRS rows pglite-postgis populates at CREATE EXTENSION time. Once
  // SRID 4326 disappears, ST_Distance + every geography op throws
  // "Cannot find SRID (4326) in spatial_ref_sys". Vitest gives each test
  // file a fresh PGlite anyway, and seedFixture handles geo-table isolation
  // per-test, so we don't need a broader cleanup.
  beforeEach(async () => {
    _resetGeoEnrichmentProbeForTests();
    await seedFixture();
  });

  describe('geo_lookup SQL function', () => {
    it('returns Rome for a coordinate inside the city centre', async () => {
      const sql = getTestDb();
      const rows = (await sql`
        SELECT place_name, country_code, country_name, admin1_name, timezone, distance_km
        FROM geo_lookup(41.8902, 12.4922)
      `) as Array<{
        place_name: string;
        country_code: string;
        country_name: string;
        admin1_name: string | null;
        timezone: string | null;
        distance_km: number;
      }>;
      const [row] = rows;
      expect(row.place_name).toBe('Rome');
      expect(row.country_code).toBe('IT');
      expect(row.country_name).toBe('Italy');
      expect(row.admin1_name).toBe('Lazio');
      expect(row.timezone).toBe('Europe/Rome');
      expect(row.distance_km).toBeLessThan(5);
    });

    it('picks Paris over Rome for a coordinate inside Paris', async () => {
      const sql = getTestDb();
      const rows = (await sql`
        SELECT place_name, country_code FROM geo_lookup(48.8566, 2.3522)
      `) as Array<{ place_name: string; country_code: string }>;
      expect(rows[0].place_name).toBe('Paris');
      expect(rows[0].country_code).toBe('FR');
    });

    it('picks New York City for a Manhattan coordinate', async () => {
      const sql = getTestDb();
      const rows = (await sql`
        SELECT place_name, country_code, admin1_name
        FROM geo_lookup(40.7580, -73.9855)
      `) as Array<{ place_name: string; country_code: string; admin1_name: string | null }>;
      expect(rows[0].place_name).toBe('New York City');
      expect(rows[0].country_code).toBe('US');
      // CA admin1 not in fixtures, NY admin1 is — proves the join works.
      expect(rows[0].admin1_name).toBe('New York');
    });

    it('returns distance in kilometres, not metres', async () => {
      // Rome → Milan-ish coord (~500 km north). The fixture only has Rome
      // and Trastevere in Italy; the nearest in the fixture is Rome.
      const sql = getTestDb();
      const rows = (await sql`
        SELECT place_name, distance_km FROM geo_lookup(45.4642, 9.1900)
      `) as Array<{ place_name: string; distance_km: number }>;
      expect(rows[0].place_name).toBe('Rome');
      // Real great-circle distance Milan→Rome is ~477 km. Allow generous
      // band — we only care that we're in km units, not m or degrees.
      expect(rows[0].distance_km).toBeGreaterThan(400);
      expect(rows[0].distance_km).toBeLessThan(600);
    });
  });

  describe('lookupGeoEnrichment helper', () => {
    it('returns city + country for a known coordinate', async () => {
      const enrichment = await lookupGeoEnrichment({
        latitude: 41.8919,
        longitude: 12.5113,
      });
      expect(enrichment).not.toBeNull();
      expect(enrichment!.country).toBe('Italy');
      expect(enrichment!.country_code).toBe('IT');
      expect(enrichment!.place_name).toBe('Rome');
      expect(enrichment!.admin1).toBe('Lazio');
      expect(enrichment!.timezone).toBe('Europe/Rome');
    });

    it('rejects ocean coordinates past the 500 km gate (default)', async () => {
      // Middle of the North Atlantic — no city within 500 km in our fixture.
      const enrichment = await lookupGeoEnrichment({
        latitude: 35,
        longitude: -45,
      });
      expect(enrichment).toBeNull();
    });

    it('honours an override maxDistanceKm', async () => {
      // Same ocean coord, generous gate — should snap to the nearest city
      // in the fixture (one of Rome / NYC depending on which is closer).
      const enrichment = await lookupGeoEnrichment(
        { latitude: 35, longitude: -45 },
        { maxDistanceKm: 10_000 }
      );
      expect(enrichment).not.toBeNull();
      expect(['Rome', 'New York City']).toContain(enrichment!.place_name);
    });
  });

  describe('insertEvent integration', () => {
    it('auto-enriches a fresh event with city/country/admin1/timezone', async () => {
      const org = await createTestOrganization();
      const sql = getTestDb();
      await insertEvent({
        entityIds: [],
        organizationId: org.id,
        originId: 'geo-test:rome-1',
        semanticType: 'photo',
        metadata: {
          source: 'apple_photos',
          latitude: 41.8919,
          longitude: 12.5113,
        },
      });
      const rows = (await sql`
        SELECT metadata FROM events
        WHERE organization_id = ${org.id} AND origin_id = 'geo-test:rome-1'
        LIMIT 1
      `) as Array<{ metadata: Record<string, unknown> }>;
      const md = rows[0].metadata;
      expect(md.country).toBe('Italy');
      expect(md.country_code).toBe('IT');
      expect(md.place_name).toBe('Rome');
      expect(md.admin1).toBe('Lazio');
      expect(md.timezone).toBe('Europe/Rome');
      // Original connector-supplied fields preserved.
      expect(md.source).toBe('apple_photos');
      expect(md.latitude).toBe(41.8919);
      expect(md.longitude).toBe(12.5113);
    });

    it('does not overwrite place_name when the connector already set it', async () => {
      const org = await createTestOrganization();
      const sql = getTestDb();
      await insertEvent({
        entityIds: [],
        organizationId: org.id,
        originId: 'geo-test:trastevere-override',
        semanticType: 'photo',
        metadata: {
          source: 'apple_photos',
          latitude: 41.8893,
          longitude: 12.4682,
          // Connector knows better — e.g. a future Photos.sqlite reader
          // pulling Apple's "Trastevere, Rome, Italy" string verbatim.
          place_name: 'Trastevere (custom)',
        },
      });
      const rows = (await sql`
        SELECT metadata FROM events
        WHERE organization_id = ${org.id} AND origin_id = 'geo-test:trastevere-override'
        LIMIT 1
      `) as Array<{ metadata: Record<string, unknown> }>;
      // place_name preserved verbatim; the country/admin1 still get
      // filled by the enricher (nothing to clobber there).
      expect(rows[0].metadata.place_name).toBe('Trastevere (custom)');
      expect(rows[0].metadata.country).toBe('Italy');
      expect(rows[0].metadata.admin1).toBe('Lazio');
    });

    it('leaves metadata untouched when no coords are present', async () => {
      const org = await createTestOrganization();
      const sql = getTestDb();
      await insertEvent({
        entityIds: [],
        organizationId: org.id,
        originId: 'geo-test:no-coords',
        semanticType: 'photo',
        metadata: { source: 'apple_photos', title: 'placeholder' },
      });
      const rows = (await sql`
        SELECT metadata FROM events
        WHERE organization_id = ${org.id} AND origin_id = 'geo-test:no-coords'
        LIMIT 1
      `) as Array<{ metadata: Record<string, unknown> }>;
      expect(rows[0].metadata).not.toHaveProperty('country');
      expect(rows[0].metadata).not.toHaveProperty('place_name');
    });
  });

  describe('mergeEnrichedMetadata', () => {
    it('round-trips through lookup → merge correctly', async () => {
      const md = { latitude: 48.8566, longitude: 2.3522 } as Record<string, unknown>;
      const enrichment = await lookupGeoEnrichment(md);
      const merged = mergeEnrichedMetadata(md, enrichment);
      expect(merged?.place_name).toBe('Paris');
      expect(merged?.country).toBe('France');
    });
  });
});
