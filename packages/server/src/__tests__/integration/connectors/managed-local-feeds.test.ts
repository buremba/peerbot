/**
 * Stage 5 — the LOCAL managedBy connection gets its feeds so it syncs.
 *
 * The CLOUD grant-holder is consent-only (no feeds, never syncs — Stage 3).
 * The LOCAL `managedBy` connection is the OPPOSITE: it is NOT consent-only, so
 * it CAN have feeds, and those feeds run locally — events land in local
 * Postgres. This is what makes "cloud auth, local data" actually sync.
 *
 * Proven here by creating a local `config.managedBy` connection (the shape
 * `lobu connect` / `defineConnection({ managedBy, feeds })` / `lobu apply`
 * produce) and adding a feed via the same admin path apply uses.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { manageFeeds } from '../../../tools/admin/manage_feeds';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
} as unknown as Env;

function ctxFor(organizationId: string, userId: string): ToolContext {
  return {
    organizationId,
    userId,
    memberRole: 'owner',
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
  } as ToolContext;
}

describe('Stage 5 — local managed connection has feeds', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('a local managedBy connection (not consent_only) can create a feed that syncs locally', async () => {
    const org = await createTestOrganization({ name: 'Local Managed Org' });
    const user = await createTestUser({ name: 'Local Managed User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ctxFor(org.id, user.id);

    await createTestConnectorDefinition({
      key: 'demo.oauth',
      name: 'Demo OAuth',
      organization_id: org.id,
      auth_schema: {
        methods: [{ type: 'oauth', provider: 'demo', requiredScopes: ['read'] }],
      },
      feeds_schema: { items: {} },
    });

    const sql = getTestDb();
    // The local managedBy connection — the shape `lobu connect` /
    // `defineConnection({ managedBy })` produce. NOTE: managedBy, NOT
    // consent_only — the cloud holds the grant; the local copy syncs.
    const connRows = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status, config, created_by,
        created_at, updated_at
      ) VALUES (
        ${org.id}, 'demo.oauth', 'demo-managed-local', 'Managed Local', 'active',
        ${sql.json({ managedBy: { org: 'cloud-public-org' } })}, ${user.id}, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const connectionId = Number(connRows[0].id);

    const result = (await manageFeeds(
      { action: 'create_feed', connection_id: connectionId, feed_key: 'items' },
      TEST_ENV,
      ctx
    )) as { feed?: { id?: number }; error?: string };

    // Feed creation succeeds — a managedBy (non-consent_only) connection is NOT
    // blocked by the consent-only guard.
    expect(result.error).toBeUndefined();
    expect(result.feed?.id).toBeDefined();

    // The feed is persisted against the connection and active → the local
    // worker will sync it.
    const feedRows = (await sql`
      SELECT feed_key, status FROM feeds WHERE connection_id = ${connectionId}
    `) as unknown as Array<{ feed_key: string; status: string }>;
    expect(feedRows.length).toBe(1);
    expect(feedRows[0].feed_key).toBe('items');
    expect(feedRows[0].status).toBe('active');
  });

  it('a consent_only connection (cloud grant-holder) still cannot have feeds', async () => {
    // Contrast: the CLOUD-side consent-only connection is still blocked, so the
    // managed-vs-consent_only distinction is the thing that gates syncing.
    const org = await createTestOrganization({ name: 'Consent Cloud Org' });
    const user = await createTestUser({ name: 'Consent Cloud User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ctxFor(org.id, user.id);

    await createTestConnectorDefinition({
      key: 'demo.oauth',
      name: 'Demo OAuth',
      organization_id: org.id,
      auth_schema: {
        methods: [{ type: 'oauth', provider: 'demo', requiredScopes: ['read'] }],
      },
      feeds_schema: { items: {} },
    });

    const sql = getTestDb();
    const connRows = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status, config, created_by,
        created_at, updated_at
      ) VALUES (
        ${org.id}, 'demo.oauth', 'demo-consent-only', 'Consent Only', 'active',
        ${sql.json({ consent_only: true })}, ${user.id}, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    const result = (await manageFeeds(
      { action: 'create_feed', connection_id: Number(connRows[0].id), feed_key: 'items' },
      TEST_ENV,
      ctx
    )) as { error?: string };
    expect(result.error).toMatch(/consent-only/i);
  });
});
