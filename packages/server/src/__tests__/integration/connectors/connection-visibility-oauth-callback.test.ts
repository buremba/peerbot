/**
 * END-TO-END proof of the PRIMARY exposure fix: a user connecting their own
 * Gmail via the fresh OAuth flow must end up `private`.
 *
 * The fresh connect inserts the connection with visibility='org' (no
 * oauth_account profile exists yet, so resolveConnectionVisibility sees no kind).
 * The OAuth callback then CREATES the oauth_account profile, attaches it, and
 * DOWNGRADES the connection to 'private'. This drives the REAL callback route
 * (connectRoutes GET /oauth/callback) with the external provider calls mocked,
 * so it covers the route wiring that the SQL-invariant test in
 * connection-visibility-default.test.ts could not.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY the external OAuth provider round-trips; everything else (token row,
// profile insert, connection UPDATE, the visibility downgrade) runs for real.
vi.mock('../../../connect/oauth-providers', () => ({
  buildAuthorizationUrl: vi.fn(),
  exchangeCodeForTokens: vi.fn(async () => ({
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
  })),
  fetchUserInfoWithRaw: vi.fn(async () => ({
    raw: { email: 'owner@example.com', name: 'Owner D' },
    normalized: { email: 'owner@example.com', name: 'Owner D' },
  })),
}));

import { connectRoutes } from '../../../connect/routes';
import { createConnectToken } from '../../../utils/connect-tokens';
import { getTestDb, cleanupTestDatabase } from '../../setup/test-db';
import { initWorkspaceProvider } from '../../../workspace';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

describe('OAuth callback downgrades a fresh personal connection to private (e2e)', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
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
    // oauth_account profile and attaches it to this connection.
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
    // The route redirects back to the connect page on success (not an error).
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
