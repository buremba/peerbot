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

  it("a stored derived backing_sql is queryable + org-scoped via query_sql", async () => {
    // Author a derived view over REAL event columns (an illustrative
    // `SUM(amount)` would be rejected — `amount` isn't an allowlisted column).
    await owner.entity_schema.createType({
      slug: 'events-by-type',
      name: 'Events by type',
      backing: {
        sql: 'SELECT semantic_type, COUNT(*) AS event_count FROM events GROUP BY semantic_type',
      },
    });

    // 2 events in org A + 1 in org B, same semantic_type. Org B must be excluded.
    await createTestEvent({ organization_id: orgAId, semantic_type: 'purchase', content: 'a1' });
    await createTestEvent({ organization_id: orgAId, semantic_type: 'purchase', content: 'a2' });
    await createTestEvent({ organization_id: orgBId, semantic_type: 'purchase', content: 'b1' });

    // Reuse path: read the STORED view SQL, then run it through query_sql.
    const got = (await owner.entity_schema.getType('events-by-type')) as {
      entity_type?: { backing_sql?: string | null };
    };
    const backingSql = got.entity_type?.backing_sql;
    expect(backingSql).toContain('COUNT(*)');

    const ctxA: ToolContext = {
      organizationId: orgAId,
      userId: 'u',
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: false,
    };
    const res = await querySql({ sql: backingSql as string, sort_by: 'semantic_type' }, {}, ctxA);

    expect(res.error).toBeUndefined();
    const purchase = res.rows.find((r) => r.semantic_type === 'purchase');
    // Org-scoped: only org A's 2 events are counted, never org B's.
    expect(Number(purchase?.event_count)).toBe(2);
  });
});
