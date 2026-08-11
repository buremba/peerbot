/**
 * Social-login connection auto-provisioning must dedupe by the STABLE account
 * identity, not by the auth-profile row.
 *
 * Regression context (prod, buremba org): the same Google account surfaced as
 * TWO oauth_account auth profiles (46 `personal` + 87 `gmail-account`, both
 * `account_id = 7xF6MgFl…`), and connection auto-provisioning keyed its
 * existing-connection lookup only on `auth_profile_id`. The second profile's
 * login event therefore saw "no connection for profile 87" and minted a
 * duplicate `gmail-buremba-2` row — repeated for every subsequent re-auth.
 *
 * This test calls the real `provisionConnectorFromSocialLogin` against the
 * real DB with the two profiles + one live connection on the OLDER profile,
 * and asserts the run reuses it (no new connection, no `createProvisionedConnection`
 * call) instead of minting a duplicate for the newer profile.
 *
 * Red→green: with the lookup keyed only on `auth_profile_id` the run creates a
 * second connection (provisionCalls === 1) and this fails.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../index';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('social-login connection provisioning dedupes by account', () => {
  let provisionCalls: number;

  beforeEach(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    vi.resetModules();
    provisionCalls = 0;
    vi.doMock('../../../connect/oauth-providers', () => ({
      fetchUserInfoWithRaw: async () => ({
        raw: { sub: 'google-sub-1', name: 'Burak', email: 'burak@gmail.com' },
        normalized: { name: 'Burak', email: 'burak@gmail.com' },
      }),
    }));
    vi.doMock('../../../utils/provisioned-connection', () => ({
      createProvisionedConnection: async () => {
        provisionCalls += 1;
        return { connectionId: null, error: null };
      },
    }));
  });

  it('reuses the live connection for the same Google account instead of creating a duplicate', async () => {
    const org = await createTestOrganization({ slug: 'acme' });
    const user = await createTestUser();
    const sql = getTestDb();

    // The better-auth account row the auth profiles link to (prod: the Google
    // account row id IS the provider account id).
    await sql`
      INSERT INTO "account" (id, "accountId", "providerId", "userId", scope, "createdAt", "updatedAt")
      VALUES ('google-sub-1', 'google-sub-1', 'google', ${user.id}, 'openid email', NOW(), NOW())
    `;

    await createTestConnectorDefinition({
      key: 'google.gmail',
      name: 'Gmail',
      organization_id: org.id,
      auth_schema: {
        methods: [
          {
            type: 'oauth',
            provider: 'google',
            requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            loginProvisioning: { autoCreateConnection: true },
            clientIdKey: 'GOOGLE_CLIENT_ID',
            clientSecretKey: 'GOOGLE_CLIENT_SECRET',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
          },
        ],
      },
      feeds_schema: { threads: {} },
    });

    // OAuth app profile — required for the auto-provision path.
    await createAuthProfile({
      organizationId: org.id,
      connectorKey: 'google.gmail',
      displayName: 'Google App',
      profileKind: 'oauth_app',
      provider: 'google',
      authData: { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' },
    });

    // The historical duplication: two oauth_account profiles for the SAME
    // Google account (mirrors prod profiles 46 + 87).
    const older = await createAuthProfile({
      organizationId: org.id,
      connectorKey: 'google.gmail',
      displayName: 'personal',
      slug: 'personal',
      profileKind: 'oauth_account',
      accountId: 'google-sub-1',
      provider: 'google',
      status: 'active',
    });
    await createAuthProfile({
      organizationId: org.id,
      connectorKey: 'google.gmail',
      displayName: 'gmail-account',
      slug: 'gmail-account',
      profileKind: 'oauth_account',
      accountId: 'google-sub-1',
      provider: 'google',
      status: 'active',
    });

    // One live connection, linked to the OLDER profile. A personal-credential
    // (oauth_account) connection must be private, matching prod.
    await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_at, updated_at
      ) VALUES (
        ${org.id}, 'google.gmail', 'gmail-buremba', 'Gmail', 'active', ${older.id}, 'private', NOW(), NOW()
      )
    `;

    // Provisioning resolves the org from the request URL's first path segment
    // (the `api`/`auth` top-level routes are reserved, so the slug must lead).
    const { provisionConnectorFromSocialLogin } = await import(
      '../../../auth/social-login-provisioning'
    );
    await provisionConnectorFromSocialLogin({
      env: {} as Env,
      request: new Request('https://example.test/acme/oauth2/callback/google'),
      account: {
        id: 'google-sub-1',
        userId: 'user-1',
        providerId: 'google',
        accessToken: 'tok',
        scope: 'openid email',
      },
    });

    // The account-linked connection is reused: no new connection is minted.
    expect(provisionCalls).toBe(0);
    const [count] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM connections
      WHERE organization_id = ${org.id}
        AND connector_key = 'google.gmail'
        AND deleted_at IS NULL
    `;
    expect(count.n).toBe(1);
  });
});
