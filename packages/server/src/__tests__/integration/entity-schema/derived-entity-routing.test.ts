/**
 * Derived-entity ROUTING path.
 *
 * Derived ("view") entity types have no rows in `entities` — their rows come
 * from `backing_sql`. This proves the backend abstracts that away so the
 * frontend treats derived rows like stored entities:
 *   - `manage_entity` list returns derived rows in the standard entity shape
 *     (flagged `is_derived`), org-scoped.
 *   - `resolve_path` resolves a single derived row by slug into a read-only
 *     entity (with inferred `measure_columns`), and 404s an unknown slug.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestEvent,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';
import { TestApiClient } from '../../setup/test-mcp-client';

// A derived view over events that emits id/slug/name (so its rows can be routed
// like stored entities) plus two aggregate measures.
const SPEND_VIEW_SQL = `
  SELECT
    'vendor:' || (metadata->>'vendor') AS id,
    (metadata->>'vendor') AS name,
    'vendor-' || (metadata->>'vendor') AS slug,
    SUM((metadata->>'amount')::numeric) AS total_spend,
    COUNT(*) AS purchases
  FROM events
  WHERE metadata->>'vendor' IS NOT NULL
  GROUP BY 1, 2, 3
`;

describe('derived entity routing (list + resolve_path)', () => {
  let api: TestApiClient;
  let orgAId: string;
  let orgBId: string;
  let orgSlug: string;
  let token: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const orgA = await createTestOrganization({ name: 'Derived Routing A' });
    const orgB = await createTestOrganization({ name: 'Derived Routing B' });
    orgAId = orgA.id;
    orgBId = orgB.id;
    orgSlug = orgA.slug;
    const user = await createTestUser({ email: 'derived-routing@test.com' });
    await addUserToOrganization(user.id, orgA.id, 'owner');
    api = await TestApiClient.for({
      organizationId: orgA.id,
      userId: user.id,
      memberRole: 'owner',
    });

    await api.entity_schema.createType({
      slug: 'spend-vendor',
      name: 'Spend by vendor',
      backing: { sql: SPEND_VIEW_SQL },
    });

    // Org A: acme x2 (=15), globex x1 (=20). Org B: acme x1 (=99) — must not leak.
    await createTestEvent({ organization_id: orgAId, content: 'a1', metadata: { vendor: 'acme', amount: '10' } });
    await createTestEvent({ organization_id: orgAId, content: 'a2', metadata: { vendor: 'acme', amount: '5' } });
    await createTestEvent({ organization_id: orgAId, content: 'a3', metadata: { vendor: 'globex', amount: '20' } });
    await createTestEvent({ organization_id: orgBId, content: 'b1', metadata: { vendor: 'acme', amount: '99' } });

    const oauthClient = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, orgA.id, oauthClient.client_id)).token;
  });

  async function resolvePath(args: Record<string, unknown>) {
    const response = await post(`/api/${orgSlug}/resolve_path`, { body: args, token });
    if (response.status >= 400) {
      const body = (await response.json()) as { error?: string };
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    return response.json();
  }

  it('lists derived rows in the standard entity shape (org-scoped)', async () => {
    const res = (await api.entities.list({ entity_type: 'spend-vendor' })) as {
      entities: Array<{
        name: string;
        slug: string;
        metadata: Record<string, unknown>;
      }>;
    };
    const byName = Object.fromEntries(res.entities.map((e) => [e.name, e]));
    expect(Object.keys(byName).sort()).toEqual(['acme', 'globex']);
    expect(byName.acme.slug).toBe('vendor-acme');
    // Org B's $99 acme event must NOT leak into org A's aggregate.
    expect(Number(byName.acme.metadata.total_spend)).toBe(15);
    expect(Number(byName.acme.metadata.purchases)).toBe(2);
  });

  it('resolve_path resolves a derived row by slug into a read-only entity', async () => {
    const result = (await resolvePath({ path: `/${orgSlug}/spend-vendor/vendor-acme` })) as {
      entity?: {
        name: string;
        slug: string;
        is_derived?: boolean;
        measure_columns?: string[];
        metadata: Record<string, unknown>;
      };
    };
    expect(result.entity?.name).toBe('acme');
    expect(result.entity?.slug).toBe('vendor-acme');
    expect(result.entity?.is_derived).toBe(true);
    expect(Number(result.entity?.metadata.total_spend)).toBe(15);
    // measure_columns is inferred from the backing SQL (same as get_type).
    expect((result.entity?.measure_columns ?? []).sort()).toEqual(['purchases', 'total_spend']);
  });

  it('resolve_path 404s an unknown derived slug (no silent fallback)', async () => {
    await expect(
      resolvePath({ path: `/${orgSlug}/spend-vendor/vendor-missing` })
    ).rejects.toThrow();
  });

  it('falls back to the id column for routing when the view projects no slug', async () => {
    // A view that emits `id`/`name` but no `slug`. The row must still be
    // routable: the slug falls back to the id, in both list and resolve.
    await api.entity_schema.createType({
      slug: 'vendor-noslug',
      name: 'Vendor (no slug)',
      backing: {
        sql: `SELECT (metadata->>'vendor') AS id, (metadata->>'vendor') AS name,
                COUNT(*) AS purchases
              FROM events WHERE metadata->>'vendor' IS NOT NULL GROUP BY 1, 2`,
      },
    });

    const list = (await api.entities.list({ entity_type: 'vendor-noslug' })) as {
      entities: Array<{ slug: string; name: string }>;
    };
    const acme = list.entities.find((e) => e.name === 'acme');
    expect(acme?.slug).toBe('acme'); // slug fell back to the id column

    const resolved = (await resolvePath({
      path: `/${orgSlug}/vendor-noslug/acme`,
    })) as { entity?: { name: string; is_derived?: boolean } };
    expect(resolved.entity?.name).toBe('acme');
    expect(resolved.entity?.is_derived).toBe(true);
  });
});
