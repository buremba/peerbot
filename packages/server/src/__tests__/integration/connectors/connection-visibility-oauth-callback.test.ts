/**
 * END-TO-END proof of the PRIMARY exposure fix: a user connecting their own
 * Gmail via the fresh OAuth flow must end up `private`.
 *
 * The fresh connect inserts the connection with visibility='org' (no
 * oauth_account profile exists yet). The OAuth callback then CREATES the
 * oauth_account profile, attaches it, and DOWNGRADES the connection to 'private'.
 * This drives the REAL callback route (connectRoutes GET /oauth/callback) against
 * a LOCAL fake OAuth provider (real HTTP round-trip for /token + /userinfo) — no
 * module mocking, so it is safe under this suite's shared module graph
 * (vitest `isolate: false`). It covers the route wiring the SQL-invariant test in
 * connection-visibility-default.test.ts could not.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectRoutes } from '../../../connect/routes';
import type { Env } from '../../../index';
import { createConnectToken } from '../../../utils/connect-tokens';
import { getTestDb, cleanupTestDatabase } from '../../setup/test-db';
import { initWorkspaceProvider } from '../../../workspace';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {} as Env;

// biome-ignore lint/suspicious/noExplicitAny: node-server handle
let providerServer: any;
let providerTokenUrl = '';
let providerUserinfoUrl = '';

describe('OAuth callback downgrades a fresh personal connection to private (e2e)', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
    // Local fake OAuth provider: real HTTP endpoints the callback exchanges
    // against (no module mocking — safe under isolate:false).
    const provider = new Hono();
    provider.post('/token', (c) =>
      c.json({
        access_token: 'fake-access-token',
        refresh_token: 'fake-refresh-token',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      })
    );
    provider.get('/userinfo', (c) =>
      c.json({ email: 'owner@example.com', name: 'Owner D', id: 'acct-123' })
    );
    providerServer = await new Promise((resolve) => {
      const s = serve({ fetch: provider.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
        providerTokenUrl = `http://127.0.0.1:${info.port}/token`;
        providerUserinfoUrl = `http://127.0.0.1:${info.port}/userinfo`;
        resolve(s);
      });
    });
  });

  afterAll(() => {
    providerServer?.close?.();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('a fresh Gmail-style OAuth connect ends up private after the callback', async () => {
    process.env.CBOAUTH_CLIENT_ID = 'env-id';
    process.env.CBOAUTH_CLIENT_SECRET = 'env-secret';
    const org = await createTestOrganization({ name: 'CB Org' });
    const user = await createTestUser({ name: 'Owner D' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const sql = getTestDb();

    await createTestConnectorDefinition({
      key: 'cb.oauth',
      name: 'CB OAuth',
      organization_id: org.id,
      auth_schema: {
        methods: [
          {
            type: 'oauth',
            provider: 'cboauth',
            requiredScopes: ['read'],
            clientIdKey: 'CBOAUTH_CLIENT_ID',
            clientSecretKey: 'CBOAUTH_CLIENT_SECRET',
            tokenUrl: providerTokenUrl,
            userinfoUrl: providerUserinfoUrl,
          },
        ],
      },
      feeds_schema: { items: {} },
    });

    // The fresh connect: connection inserted pending_auth + visibility='org',
    // no auth_profile yet (the exposure precondition the callback must fix).
    const [conn] = (await sql`
      INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_by)
      VALUES (${org.id}, 'cb.oauth', 'cb-conn', 'CB Connection', 'pending_auth', 'org', ${user.id})
      RETURNING id
    `) as Array<{ id: number }>;

    // Connect token carrying pendingProfileMeta → the callback creates the
    // oauth_account profile and attaches it. tokenUrl/userinfoUrl point at the
    // local fake so the real exchange succeeds.
    const tokenRow = await createConnectToken({
      connectionId: conn.id,
      organizationId: org.id,
      connectorKey: 'cb.oauth',
      authType: 'oauth',
      createdBy: user.id,
      authConfig: {
        provider: 'cboauth',
        clientIdKey: 'CBOAUTH_CLIENT_ID',
        clientSecretKey: 'CBOAUTH_CLIENT_SECRET',
        tokenUrl: providerTokenUrl,
        userinfoUrl: providerUserinfoUrl,
        requestedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        pendingProfileMeta: {
          displayName: 'CB Account',
          slug: 'cb-account',
          connectorKey: 'cb.oauth',
          provider: 'cboauth',
        },
      },
    });

    // Drive the REAL callback route.
    const res = await connectRoutes.request(
      `/oauth/callback?state=${encodeURIComponent(tokenRow.token)}&code=fake-auth-code`
    );
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(400);

    const [after] = (await sql`
      SELECT c.visibility, c.status, ap.profile_kind
      FROM connections c
      LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
      WHERE c.id = ${conn.id}
    `) as Array<{ visibility: string; status: string; profile_kind: string | null }>;

    // The oauth_account profile was created + attached, and the connection was
    // downgraded to private — the primary exposure is closed end-to-end.
    expect(after.profile_kind).toBe('oauth_account');
    expect(after.status).toBe('active');
    expect(after.visibility).toBe('private');

    delete process.env.CBOAUTH_CLIENT_ID;
    delete process.env.CBOAUTH_CLIENT_SECRET;
  });
});
