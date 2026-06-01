/**
 * query_entity_type read path — the trusted derived-entity reader that dispatches
 * internal (org-scoped query_sql) vs. external (live, no-copy, against a bound
 * connection's database). The "external" connection here points right back at the
 * test DB URL, so the executor opens a fresh pool and reads it as an external DB —
 * exercising resolveExternalConnection → getPool → executeExternalSource end-to-end.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryEntityType } from '../../../tools/admin/query_entity_type';
import type { ToolContext } from '../../../tools/registry';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { __closeAllExternalPools } from '../../../utils/execute-external-source';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

describe('query_entity_type', () => {
  let owner: TestApiClient;
  let orgAId: string;
  let ctxA: ToolContext;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const orgA = await createTestOrganization({ name: 'QET A' });
    orgAId = orgA.id;
    const user = await createTestUser({ email: 'qet@test.com' });
    await addUserToOrganization(user.id, orgA.id, 'owner');
    owner = await TestApiClient.for({
      organizationId: orgA.id,
      userId: user.id,
      memberRole: 'owner',
    });
    ctxA = ownerToolContext(orgAId, user.id);
  });

  afterAll(async () => {
    await __closeAllExternalPools();
  });

  it('reads an INTERNAL derived entity (org-scoped)', async () => {
    await owner.entity_schema.createType({
      slug: 'spend-by-vendor-qet',
      name: 'Spend by vendor',
      backing: {
        sql: "SELECT (metadata->>'vendor') AS vendor, COUNT(*)::int AS purchases FROM events GROUP BY 1",
      },
    });
    await createTestEvent({ organization_id: orgAId, content: 'a1', metadata: { vendor: 'acme' } });
    await createTestEvent({ organization_id: orgAId, content: 'a2', metadata: { vendor: 'acme' } });

    const res = await queryEntityType({ slug: 'spend-by-vendor-qet', sort_by: 'vendor' }, {}, ctxA);
    expect(res.error).toBeUndefined();
    expect(res.source).toBe('internal');
    expect(Number(res.rows.find((r) => r.vendor === 'acme')?.purchases)).toBe(2);
  });

  it('errors on a stored (non-derived) type', async () => {
    await owner.entity_schema.createType({ slug: 'people-qet', name: 'People' });
    const res = await queryEntityType({ slug: 'people-qet' }, {}, ctxA);
    expect(res.rows).toHaveLength(0);
    expect(res.error).toMatch(/not derived|no backing view/i);
  });

  it('errors on an unknown slug', async () => {
    const res = await queryEntityType({ slug: 'nope-nope' }, {}, ctxA);
    expect(res.error).toMatch(/not found/i);
  });

  it('reads an EXTERNAL-backed derived entity LIVE against the connection DB', async () => {
    const db = getTestDb();
    await db`DROP TABLE IF EXISTS qet_ext_signups`;
    await db`CREATE TABLE qet_ext_signups (id bigserial primary key, org text, amount numeric)`;
    await db`INSERT INTO qet_ext_signups (org, amount) VALUES ('a', 10), ('a', 5), ('b', 7)`;

    const profile = await createAuthProfile({
      organizationId: orgAId,
      connectorKey: 'postgres',
      displayName: 'ext db',
      profileKind: 'env',
      authData: { DATABASE_URL: process.env.DATABASE_URL as string },
    });
    await db`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_at, updated_at)
      VALUES
        (${orgAId}, 'postgres', 'qet-ext-db', 'Ext DB', 'active', ${profile.id}, 'org', NOW(), NOW())
    `;

    await owner.entity_schema.createType({
      slug: 'ext-spend',
      name: 'External spend',
      backing: {
        connection: 'qet-ext-db',
        // trailing ';' must be stripped before the subquery wrap.
        sql: 'SELECT org, sum(amount)::numeric AS total, count(*)::int AS n FROM qet_ext_signups GROUP BY org;',
      },
    });

    const res = await queryEntityType({ slug: 'ext-spend', sort_by: 'org' }, {}, ctxA);
    expect(res.error).toBeUndefined();
    expect(res.source).toBe('external');
    const a = res.rows.find((r) => r.org === 'a');
    expect(Number(a?.total)).toBe(15);
    expect(Number(a?.n)).toBe(2);

    await db`DROP TABLE IF EXISTS qet_ext_signups`;
  });

  it('errors when an external backing references a missing connection', async () => {
    await owner.entity_schema.createType({
      slug: 'ext-missing',
      name: 'Ext missing',
      backing: { connection: 'does-not-exist', sql: 'SELECT 1 AS x' },
    });
    const res = await queryEntityType({ slug: 'ext-missing' }, {}, ctxA);
    expect(res.source).toBe('external');
    expect(res.error).toMatch(/no longer exists|not found/i);
  });
});
