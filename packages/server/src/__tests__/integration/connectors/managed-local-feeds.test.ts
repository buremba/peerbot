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
import { manageConnections } from '../../../tools/admin/manage_connections';
import { manageFeeds } from '../../../tools/admin/manage_feeds';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  seedOwnerContext,
} from '../../setup/test-fixtures';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
} as unknown as Env;

describe('Stage 5 — local managed connection has feeds', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('creates a managedBy OAuth connection via `create` with NO local auth profile, then a feed', async () => {
    // The path `lobu connect` and `lobu apply` actually use: manage_connections
    // create with config.managedBy for an OAuth connector that has NO local
    // auth profile (the grant lives in the cloud). It must be created active —
    // not rejected with "Select or create an OAuth account profile".
    const { org, ctx } = await seedOwnerContext({
      orgName: 'Create Managed Org',
      userName: 'Create Managed User',
    });

    await createTestConnectorDefinition({
      key: 'demo.oauth',
      name: 'Demo OAuth',
      organization_id: org.id,
      auth_schema: {
        methods: [{ type: 'oauth', provider: 'demo', requiredScopes: ['read'] }],
      },
      feeds_schema: { items: {} },
    });

    const created = (await manageConnections(
      {
        action: 'create',
        connector_key: 'demo.oauth',
        slug: 'gcal-managed',
        config: { managedBy: { org: 'cloud-public-org' } },
      },
      TEST_ENV,
      ctx
    )) as { connection?: { id?: number; status?: string }; error?: string };

    // Created active (not rejected for a missing local OAuth account profile).
    expect(created.error).toBeUndefined();
    expect(created.connection?.id).toBeDefined();
    expect(created.connection?.status).toBe('active');

    const connectionId = Number(created.connection?.id);
    const sql = getTestDb();
    const row = (await sql`
      SELECT config, auth_profile_id, app_auth_profile_id, status
      FROM connections WHERE id = ${connectionId} LIMIT 1
    `) as unknown as Array<{
      config: Record<string, unknown> | null;
      auth_profile_id: number | null;
      app_auth_profile_id: number | null;
      status: string;
    }>;
    expect((row[0].config?.managedBy as { org?: string })?.org).toBe('cloud-public-org');
    expect(row[0].auth_profile_id).toBeNull();
    expect(row[0].app_auth_profile_id).toBeNull();

    // And it can sync — a feed is allowed (not consent_only).
    const feedResult = (await manageFeeds(
      { action: 'create_feed', connection_id: connectionId, feed_key: 'items' },
      TEST_ENV,
      ctx
    )) as { feed?: { id?: number }; error?: string };
    expect(feedResult.error).toBeUndefined();
    expect(feedResult.feed?.id).toBeDefined();
  });

  it('a managedBy create ignores an existing local OAuth profile (null binding)', async () => {
    // Managed connections never select/bind a local auth profile — even when an
    // active oauth_account + oauth_app exist for this connector. Without the fix,
    // the auto-selector would bind the managed connection to the local grant.
    const { org, user, ctx } = await seedOwnerContext({
      orgName: 'Existing Profile Org',
      userName: 'Existing Profile User',
    });

    await createTestConnectorDefinition({
      key: 'demo.oauth',
      name: 'Demo OAuth',
      organization_id: org.id,
      auth_schema: {
        methods: [
          {
            type: 'oauth',
            provider: 'demo',
            requiredScopes: ['read'],
            clientIdKey: 'DEMO_CLIENT_ID',
            clientSecretKey: 'DEMO_CLIENT_SECRET',
          },
        ],
      },
      feeds_schema: { items: {} },
    });
    // Active local profiles the auto-selector would otherwise bind.
    const sql = getTestDb();
    const accountId = `local-acct-${org.id}`;
    await sql`
      INSERT INTO "account" (
        id, "accountId", "providerId", "userId",
        "accessToken", "refreshToken", "accessTokenExpiresAt", scope, "createdAt", "updatedAt"
      ) VALUES (
        ${accountId}, ${accountId}, 'demo', ${user.id},
        'local-grant', 'local-refresh', ${new Date(Date.now() + 3600_000).toISOString()},
        'read', NOW(), NOW()
      )
    `;
    await createAuthProfile({
      organizationId: org.id,
      connectorKey: 'demo.oauth',
      displayName: 'Local App',
      profileKind: 'oauth_app',
      provider: 'demo',
      status: 'active',
      authData: { DEMO_CLIENT_ID: 'cid', DEMO_CLIENT_SECRET: 'secret' },
    });
    await createAuthProfile({
      organizationId: org.id,
      connectorKey: 'demo.oauth',
      displayName: 'Local Account',
      profileKind: 'oauth_account',
      provider: 'demo',
      status: 'active',
      accountId,
      createdBy: user.id,
    });

    const created = (await manageConnections(
      {
        action: 'create',
        connector_key: 'demo.oauth',
        slug: 'managed-despite-local',
        config: { managedBy: { org: 'cloud-public-org' } },
      },
      TEST_ENV,
      ctx
    )) as { connection?: { id?: number; status?: string }; error?: string };

    expect(created.error).toBeUndefined();
    expect(created.connection?.status).toBe('active');

    const row = (await sql`
      SELECT auth_profile_id, app_auth_profile_id
      FROM connections WHERE id = ${Number(created.connection?.id)} LIMIT 1
    `) as unknown as Array<{
      auth_profile_id: number | null;
      app_auth_profile_id: number | null;
    }>;
    // Null despite the existing local profiles — not bound to the local grant.
    expect(row[0].auth_profile_id).toBeNull();
    expect(row[0].app_auth_profile_id).toBeNull();
  });

  it('rejects a create with an EMPTY managedBy.org (not treated as managed)', async () => {
    // An empty/whitespace `org` is not a valid managed connection — it must NOT
    // skip the auth-profile requirement and create an active unauthenticated
    // connection. It falls through to the normal OAuth requirement and is
    // rejected.
    const { org, ctx } = await seedOwnerContext({
      orgName: 'Empty Org Managed',
      userName: 'Empty Org User',
    });

    await createTestConnectorDefinition({
      key: 'demo.oauth',
      name: 'Demo OAuth',
      organization_id: org.id,
      auth_schema: {
        methods: [{ type: 'oauth', provider: 'demo', requiredScopes: ['read'] }],
      },
      feeds_schema: { items: {} },
    });

    const result = (await manageConnections(
      {
        action: 'create',
        connector_key: 'demo.oauth',
        slug: 'empty-managed',
        config: { managedBy: { org: '   ' } },
      },
      TEST_ENV,
      ctx
    )) as { connection?: { id?: number }; error?: string };

    expect(result.error).toBeTruthy();
    expect(result.connection?.id).toBeUndefined();
  });

  it('rejects managedBy on a NON-OAuth connector', async () => {
    // managedBy delegates to a cloud OAuth grant — it makes no sense on a
    // no-auth/browser/env connector and must not bypass their auth path.
    const { org, ctx } = await seedOwnerContext({
      orgName: 'NonOAuth Managed Org',
      userName: 'NonOAuth Managed User',
    });

    await createTestConnectorDefinition({
      key: 'demo.noauth',
      name: 'Demo NoAuth',
      organization_id: org.id,
      auth_schema: { methods: [{ type: 'none' }] },
      feeds_schema: { items: {} },
    });

    const result = (await manageConnections(
      {
        action: 'create',
        connector_key: 'demo.noauth',
        slug: 'noauth-managed',
        config: { managedBy: { org: 'cloud-public-org' } },
      },
      TEST_ENV,
      ctx
    )) as { connection?: { id?: number }; error?: string };

    expect(result.error).toMatch(/only valid for OAuth/i);
    expect(result.connection?.id).toBeUndefined();
  });

  it('a consent_only connection cannot have its consent_only flag removed', async () => {
    // Reverse of the feed guard: a consent-only grant-holder must STAY
    // consent-only — stripping it would let feeds be added so the cloud syncs
    // the grant-holder's data.
    const { org, user, ctx } = await seedOwnerContext({
      orgName: 'Consent Lock Org',
      userName: 'Consent Lock User',
    });

    await createTestConnectorDefinition({
      key: 'demo.oauth',
      name: 'Demo OAuth',
      organization_id: org.id,
      auth_schema: {
        methods: [{ type: 'oauth', provider: 'demo', requiredScopes: ['read'] }],
      },
      feeds_schema: { items: {} },
    });
    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'demo.oauth',
      slug: 'consent-lock',
      display_name: 'Consent Lock',
      created_by: user.id,
      config: { consent_only: true },
      createDefaultFeed: false,
    });

    // Replace the config with one that drops consent_only.
    const result = (await manageConnections(
      { action: 'update', connection_id: conn.id, config: {}, replace_config: true },
      TEST_ENV,
      ctx
    )) as { error?: string };
    expect(result.error).toMatch(/cannot be removed/i);
  });

  it('a local managedBy connection (not consent_only) can create a feed that syncs locally', async () => {
    const { org, user, ctx } = await seedOwnerContext({
      orgName: 'Local Managed Org',
      userName: 'Local Managed User',
    });

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
    // The local managedBy connection — the shape `defineConnection({ managedBy })`
    // produces. NOTE: managedBy, NOT consent_only — the cloud holds the grant;
    // the local copy syncs. No default feed (the test creates its own below).
    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'demo.oauth',
      slug: 'demo-managed-local',
      display_name: 'Managed Local',
      created_by: user.id,
      config: { managedBy: { org: 'cloud-public-org' } },
      createDefaultFeed: false,
    });
    const connectionId = conn.id;

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
    const { org, user, ctx } = await seedOwnerContext({
      orgName: 'Consent Cloud Org',
      userName: 'Consent Cloud User',
    });

    await createTestConnectorDefinition({
      key: 'demo.oauth',
      name: 'Demo OAuth',
      organization_id: org.id,
      auth_schema: {
        methods: [{ type: 'oauth', provider: 'demo', requiredScopes: ['read'] }],
      },
      feeds_schema: { items: {} },
    });

    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'demo.oauth',
      slug: 'demo-consent-only',
      display_name: 'Consent Only',
      created_by: user.id,
      config: { consent_only: true },
      createDefaultFeed: false,
    });

    const result = (await manageFeeds(
      { action: 'create_feed', connection_id: conn.id, feed_key: 'items' },
      TEST_ENV,
      ctx
    )) as { error?: string };
    expect(result.error).toMatch(/consent-only/i);
  });
});
