/**
 * Derived-entity READ path.
 *
 * A derived entity type stores a `backing_sql` view but no rows of its own.
 * The read path reuses the existing `query_sql` tool: fetch the view SQL via
 * `get_type`, run it through `query_sql`, which org-scopes every referenced
 * table (here `events`) via `validateAndScopeQuery`. This test proves that
 * round-trip works AND that the scoping isolates orgs — a sibling org's events
 * never leak into the aggregate.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

describe('derived entity read path (reuse query_sql)', () => {
  let owner: TestApiClient;
  let orgAId: string;
  let orgBId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const orgA = await createTestOrganization({ name: 'Derived Query A' });
    const orgB = await createTestOrganization({ name: 'Derived Query B' });
    orgAId = orgA.id;
    orgBId = orgB.id;
    const user = await createTestUser({ email: 'derived-query@test.com' });
    await addUserToOrganization(user.id, orgA.id, 'owner');
    owner = await TestApiClient.for({
      organizationId: orgA.id,
      userId: user.id,
      memberRole: 'owner',
    });
  });

  it('a stored derived backing_sql (metadata jsonb) is queryable + org-scoped via query_sql', async () => {
    // Realistic derived view: business data lives in events.metadata (jsonb),
    // not in fixed columns. Extraction + cast + aggregate must survive the
    // parse → validate → org-scope path (now powered by @polyglot-sql/sdk).
    const sql =
      "SELECT (metadata->>'vendor') AS vendor, SUM((metadata->>'amount')::numeric) AS total_spend, COUNT(*) AS purchases FROM events GROUP BY 1";
    await owner.entity_schema.createType({
      slug: 'spend-by-vendor',
      name: 'Spend by vendor',
      backing: { sql },
    });

    // Inference classifies the jsonb columns: vendor → dimension, the SUM →
    // additive measure, COUNT(*) → additive measure.
    const got = (await owner.entity_schema.getType('spend-by-vendor')) as {
      entity_type?: {
        backing_sql?: string | null;
        metadata_schema?: { properties?: Record<string, Record<string, unknown>> };
      };
    };
    const props = got.entity_type?.metadata_schema?.properties ?? {};
    expect(props.vendor?.['x-dimension']).toBeDefined();
    expect((props.total_spend?.['x-measure'] as { reagg?: string })?.reagg).toBe('additive');
    expect((props.purchases?.['x-measure'] as { reagg?: string })?.reagg).toBe('additive');

    // 2 purchases in org A + 1 in org B (same vendor). Org B must be excluded.
    await createTestEvent({ organization_id: orgAId, content: 'a1', metadata: { vendor: 'acme', amount: '10' } });
    await createTestEvent({ organization_id: orgAId, content: 'a2', metadata: { vendor: 'acme', amount: '5' } });
    await createTestEvent({ organization_id: orgBId, content: 'b1', metadata: { vendor: 'acme', amount: '99' } });

    const ctxA: ToolContext = {
      organizationId: orgAId,
      userId: 'u',
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: false,
    };
    const res = await querySql(
      { sql: got.entity_type?.backing_sql as string, sort_by: 'vendor' },
      {},
      ctxA
    );

    expect(res.error).toBeUndefined();
    const acme = res.rows.find((r) => r.vendor === 'acme');
    // Org-scoped: only org A's 2 events aggregate — org B's $99 never leaks in.
    expect(Number(acme?.purchases)).toBe(2);
    expect(Number(acme?.total_spend)).toBe(15);
  });

  it('rejects creating a stored row on a derived (view) entity type', async () => {
    await owner.entity_schema.createType({
      slug: 'orders-view',
      name: 'Orders view',
      backing: { sql: 'SELECT semantic_type, COUNT(*) AS n FROM events GROUP BY 1' },
    });
    // The view has no stored rows; inserting one would be silently ignored.
    await expect(
      owner.entities.create({ type: 'orders-view', name: 'nope' })
    ).rejects.toThrow(/derived|view|no stored rows/i);
  });
});
