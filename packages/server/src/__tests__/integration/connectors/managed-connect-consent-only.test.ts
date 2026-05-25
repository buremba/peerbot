/**
 * Stage 3 — connecting a managed connector in a PUBLIC org yields a
 * consent-only connection (grant only, no feeds).
 *
 * A managed connector lives in a `visibility='public'` org with a managed
 * org-level `oauth_app` profile (the client secret stays in the cloud). When a
 * member runs the connect flow against it, the resulting connection must be
 * CONSENT-ONLY: it holds the OAuth grant for delegation but has NO feeds, so
 * the cloud never syncs a copy — the data lives only on the member's local
 * instance.
 *
 * Proven here by driving `manageConnections({ action: 'connect' })`:
 *   1. PUBLIC org + managed oauth_app → the new connection carries
 *      `config.consent_only = true` and has zero feeds.
 *   2. PRIVATE org with the same setup → an ordinary connection (no
 *      consent_only), so the managed-only behavior is scoped to public orgs.
 *   3. The feed guard holds end-to-end: creating a feed on the resulting
 *      consent-only connection is rejected.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { manageFeeds } from '../../../tools/admin/manage_feeds';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnectorDefinition,
  seedOwnerContext,
} from '../../setup/test-fixtures';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
} as unknown as Env;

/**
 * Seed an org (public by default) with an OAuth connector + an active managed
 * `oauth_app` profile (the client secret the cloud holds). Returns the owner's
 * tool context + the connector key.
 */
async function seedManagedConnector(opts: { visibility: 'public' | 'private' }) {
  const { org, ctx } = await seedOwnerContext({
    orgName: `Managed ${opts.visibility} Org`,
    userName: 'Connecting Member',
    visibility: opts.visibility,
  });

  const connectorKey = 'demo.oauth';
  await createTestConnectorDefinition({
    key: connectorKey,
    name: 'Demo OAuth',
    organization_id: org.id,
    auth_schema: {
      methods: [
        {
          type: 'oauth',
          provider: 'demo',
          requiredScopes: ['read'],
          authorizationUrl: 'https://demo.example/authorize',
          tokenUrl: 'https://demo.example/token',
          clientIdKey: 'DEMO_CLIENT_ID',
          clientSecretKey: 'DEMO_CLIENT_SECRET',
        },
      ],
    },
    feeds_schema: { items: {} },
  });

  // The managed oauth_app — the signal that this connector is "managed".
  await createAuthProfile({
    organizationId: org.id,
    connectorKey,
    displayName: 'Managed Demo App',
    profileKind: 'oauth_app',
    provider: 'demo',
    authData: { DEMO_CLIENT_ID: 'managed-cid', DEMO_CLIENT_SECRET: 'managed-secret' },
  });

  return { ctx, connectorKey };
}

describe('Stage 3 — managed-connect creates a consent-only connection', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('a managed connector in a PUBLIC org yields a consent_only connection with no feeds', async () => {
    const { ctx, connectorKey } = await seedManagedConnector({ visibility: 'public' });

    const result = (await manageConnections(
      { action: 'connect', connector_key: connectorKey },
      TEST_ENV,
      ctx
    )) as { connection_id?: number; status?: string; error?: string };

    expect(result.error).toBeUndefined();
    expect(result.connection_id).toBeDefined();
    // The OAuth grant is pending until the user completes consent.
    expect(result.status).toBe('pending_auth');

    const sql = getTestDb();
    const connRows = (await sql`
      SELECT config FROM connections WHERE id = ${result.connection_id} LIMIT 1
    `) as unknown as Array<{ config: Record<string, unknown> | null }>;
    expect(connRows[0]?.config?.consent_only).toBe(true);

    // No feeds were created — the cloud never syncs this connection.
    const feedRows = (await sql`
      SELECT 1 FROM feeds WHERE connection_id = ${result.connection_id}
    `) as unknown as Array<unknown>;
    expect(feedRows.length).toBe(0);

    // And the by-construction guard holds: a feed cannot be added later.
    const feedResult = (await manageFeeds(
      { action: 'create_feed', connection_id: result.connection_id, feed_key: 'items' },
      TEST_ENV,
      ctx
    )) as { error?: string };
    expect(feedResult.error).toMatch(/consent-only/i);
  });

  it('a managed connector in a PRIVATE org is an ordinary connection (no consent_only)', async () => {
    const { ctx, connectorKey } = await seedManagedConnector({ visibility: 'private' });

    const result = (await manageConnections(
      { action: 'connect', connector_key: connectorKey },
      TEST_ENV,
      ctx
    )) as { connection_id?: number; error?: string };

    expect(result.error).toBeUndefined();
    expect(result.connection_id).toBeDefined();

    const sql = getTestDb();
    const connRows = (await sql`
      SELECT config FROM connections WHERE id = ${result.connection_id} LIMIT 1
    `) as unknown as Array<{ config: Record<string, unknown> | null }>;
    // Not a public org → not managed → no consent_only marking.
    expect(connRows[0]?.config?.consent_only).toBeUndefined();
  });
});
