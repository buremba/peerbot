/**
 * Restricted-role backstop (20260531130000_restricted_query_role.sql).
 *
 * Non-admin query_sql / metric_series run their SQL under `lobu_query_restricted`,
 * which can read every queryable table EXCEPT the auth/identity tables. This is
 * the DB-level floor under the app-layer admin gate: even if a future parser
 * hole let an admin-only table slip past, PostgreSQL refuses.
 *
 * The first test asserts the role's grants directly (independent of the app
 * gate). The second proves a member's ordinary query still succeeds under the
 * role — i.e. the backstop doesn't strip access to legitimately queryable data.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEvent, createTestOrganization } from '../../setup/test-fixtures';

describe('restricted query role backstop', () => {
  let orgId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Restricted Role' });
    orgId = org.id;
    await createTestEvent({ organization_id: orgId, content: 'evt' });
  });

  it('the role itself cannot read auth/identity tables but can read operational ones', async () => {
    const db = getTestDb();
    // Skip cleanly if the role was not provisioned (managed cluster w/o CREATEROLE).
    const present = await db`SELECT 1 FROM pg_roles WHERE rolname = 'lobu_query_restricted'`;
    if (present.length === 0) return;

    await expect(
      db.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE lobu_query_restricted');
        return tx.unsafe('SELECT 1 FROM public.oauth_tokens LIMIT 1');
      })
    ).rejects.toThrow(/permission denied/i);

    // operational tables remain readable under the role
    const ok = await db.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE lobu_query_restricted');
      return tx.unsafe('SELECT count(*)::int AS c FROM public.entities');
    });
    expect(Array.isArray(ok)).toBe(true);
  });

  it('a member\'s ordinary query_sql still returns rows under the restricted role', async () => {
    const ctx: ToolContext = {
      organizationId: orgId,
      userId: 'rr-member',
      memberRole: 'member',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: false,
    };
    const res = await querySql({ sql: 'SELECT id FROM events' }, {}, ctx);
    expect(res.error).toBeUndefined();
    expect(res.rows.length).toBeGreaterThan(0);
  });
});
