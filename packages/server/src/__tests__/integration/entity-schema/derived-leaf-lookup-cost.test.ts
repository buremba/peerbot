/**
 * Derived-leaf slug lookup — SQL-side exact match.
 *
 * `resolve_path` resolves one row of a derived ("view") entity type by slug.
 * Derived rows aren't stored in `entities`, so the row has to come from
 * `backing_sql` — and the work must not scale with how many rows the view
 * produces. A MISS is the worst case: it has no early exit, so paging for it
 * re-ran the backing SQL once per page, and derived views are typically
 * aggregates over `events` — history aggregation on a request path, once per
 * page. Rows past `MAX_PAGES * PAGE` were also simply unreachable.
 *
 * The internal path now pushes the match into SQL as a bound parameter. The
 * predicate reads candidate columns via `to_jsonb(...)->>` so a column the view
 * doesn't project yields NULL and falls through, mirroring `derivedRowSlug`'s
 * `slug ?? id` without needing to know the projection. That fallthrough is the
 * risky part of the change, so it is covered explicitly here for views that
 * project both columns, only `id`, a slug that collides with another row's
 * `id`, and a slug column whose value carries whitespace padding (JS trims it,
 * so the predicate has to strip the same characters).
 *
 * Cost itself is structural — the resolver makes one call with no loop — and is
 * asserted here as "SQL returned at most the one matching row" rather than by
 * counting executions: `vitest.config.ts` sets `isolate: false`, so a per-file
 * module spy is not reliable once another file has loaded the module.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { queryDerivedEntityView } from '../../../utils/entity-management';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestEvent,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';
import { TestApiClient } from '../../setup/test-mcp-client';

/** Rows in the paged view — comfortably more than one 500-row page. */
const PAGED_ROWS = 600;

/** Projects both `slug` and `id`; `slug` must win. */
const BOTH_COLUMNS_SQL = `
  SELECT
    'id-' || (metadata->>'ordinal') AS id,
    'slug-' || (metadata->>'ordinal') AS slug,
    'Row ' || (metadata->>'ordinal') AS name
  FROM events
  WHERE metadata->>'ordinal' IS NOT NULL
`;

/**
 * Projects a tab-padded `slug`. `derivedRowSlug` trims in JS, so the SQL
 * predicate has to strip the same characters or a padded row 404s where the
 * in-memory match resolved it.
 */
const PADDED_SLUG_SQL = `
  SELECT
    'id-' || (metadata->>'ordinal') AS id,
    E'\\t' || 'slug-' || (metadata->>'ordinal') || E'\\t' AS slug,
    'Row ' || (metadata->>'ordinal') AS name
  FROM events
  WHERE metadata->>'ordinal' IS NOT NULL
`;

/** Projects NO `slug` column at all — the predicate must fall through to `id`. */
const ID_ONLY_SQL = `
  SELECT
    'id-' || (metadata->>'ordinal') AS id,
    'Row ' || (metadata->>'ordinal') AS name
  FROM events
  WHERE metadata->>'ordinal' IS NOT NULL
`;

describe('derived leaf slug lookup', () => {
  let api: TestApiClient;
  let orgId: string;
  let orgSlug: string;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Derived Leaf Lookup' });
    orgId = org.id;
    orgSlug = org.slug;
    const user = await createTestUser({ email: 'derived-leaf-lookup@test.example.com' });
    userId = user.id;
    await addUserToOrganization(user.id, org.id, 'owner');
    api = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });

    // Chunked so one wide Promise.all doesn't exhaust the shared pool.
    const CHUNK = 100;
    for (let start = 0; start < PAGED_ROWS; start += CHUNK) {
      await Promise.all(
        Array.from({ length: Math.min(CHUNK, PAGED_ROWS - start) }, (_, index) =>
          createTestEvent({
            organization_id: org.id,
            content: `lookup row ${start + index + 1}`,
            metadata: { ordinal: String(start + index + 1) },
          })
        )
      );
    }

    await api.entity_schema.createType({
      slug: 'leaf-both',
      name: 'Leaf both columns',
      backing: { sql: BOTH_COLUMNS_SQL },
    });
    await api.entity_schema.createType({
      slug: 'leaf-id-only',
      name: 'Leaf id only',
      backing: { sql: ID_ONLY_SQL },
    });

    const oauthClient = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, org.id, oauthClient.client_id)).token;
  }, 120_000);

  function lookup(sql: string, slug: string) {
    return queryDerivedEntityView(sql, undefined, { limit: 1, offset: 0 }, ownerToolContext(orgId, userId), {
      preservePageRows: true,
      exactSlug: slug,
    });
  }

  it('narrows to the single matching row in SQL, not in memory', async () => {
    // The target sits on the LAST page of a multi-page view: under the old
    // in-memory scan this row cost every preceding page.
    const result = await lookup(BOTH_COLUMNS_SQL, `slug-${PAGED_ROWS}`);
    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe(`Row ${PAGED_ROWS}`);
  });

  it('prefers slug over id when the view projects both', async () => {
    const bySlug = await lookup(BOTH_COLUMNS_SQL, 'slug-7');
    expect(bySlug.rows).toHaveLength(1);
    expect(bySlug.rows[0].name).toBe('Row 7');

    // `id-7` is a real value in the `id` column, but `slug` is non-null on every
    // row, so COALESCE never reaches `id` — matching `slug ?? id` in JS.
    const byId = await lookup(BOTH_COLUMNS_SQL, 'id-7');
    expect(byId.rows).toHaveLength(0);
  });

  it('falls through to id when the view projects no slug column', async () => {
    // The `to_jsonb(...)->>'slug'` read yields NULL for a column that does not
    // exist rather than raising `undefined column`. This is the case a plain
    // `COALESCE(slug, id)` predicate would have failed on.
    const result = await lookup(ID_ONLY_SQL, 'id-42');
    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Row 42');
  });

  it('matches a slug whose column value is whitespace-padded', async () => {
    // `btrim` with no character set strips spaces only; JS `.trim()` also strips
    // tabs and newlines, so the predicate trims that same set.
    const result = await lookup(PADDED_SLUG_SQL, 'slug-13');
    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Row 13');
  });

  it('returns nothing for a slug that no row carries', async () => {
    const result = await lookup(BOTH_COLUMNS_SQL, 'slug-does-not-exist');
    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(0);
  });

  it('resolve_path resolves a deep row and 404s a miss', async () => {
    const hit = await post(`/api/${orgSlug}/resolve_path`, {
      body: { path: `/${orgSlug}/leaf-both/slug-${PAGED_ROWS}` },
      token,
    });
    expect(hit.status).toBe(200);
    const hitBody = (await hit.json()) as {
      entity?: { name: string; slug: string; is_derived?: boolean };
    };
    expect(hitBody.entity?.slug).toBe(`slug-${PAGED_ROWS}`);
    expect(hitBody.entity?.name).toBe(`Row ${PAGED_ROWS}`);
    expect(hitBody.entity?.is_derived).toBe(true);

    const miss = await post(`/api/${orgSlug}/resolve_path`, {
      body: { path: `/${orgSlug}/leaf-both/slug-does-not-exist` },
      token,
    });
    expect(miss.status).toBeGreaterThanOrEqual(400);
  });

  it('resolves an id-only view through resolve_path', async () => {
    const response = await post(`/api/${orgSlug}/resolve_path`, {
      body: { path: `/${orgSlug}/leaf-id-only/id-99` },
      token,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { entity?: { slug: string; name: string } };
    expect(body.entity?.slug).toBe('id-99');
    expect(body.entity?.name).toBe('Row 99');
  });
});
