/**
 * Managed-auth onboarding must be self-describing and usable by a brand-new
 * Lobu user. The user starts in their own workspace, discovers a public org's
 * managed OAuth offer, joins it, and creates their own consent-only grant.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuthProfile } from '../../utils/auth-profiles';
import { initWorkspaceProvider } from '../../workspace';
import { TestApiClient } from '../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../setup/test-fixtures';

async function seedManagedGoogleOrg() {
  const org = await createTestOrganization({
    name: 'Managed Connectors',
    slug: 'managed-connectors',
    visibility: 'public',
  });

  for (const [key, name] of [
    ['google.gmail', 'Gmail'],
    ['google.calendar', 'Google Calendar'],
  ] as const) {
    await createTestConnectorDefinition({
      key,
      name,
      organization_id: org.id,
      auth_schema: {
        methods: [
          {
            type: 'oauth',
            provider: 'google',
            requiredScopes: ['openid'],
            authorizationUrl: 'https://accounts.example/authorize',
            tokenUrl: 'https://accounts.example/token',
            clientIdKey: 'GOOGLE_CLIENT_ID',
            clientSecretKey: 'GOOGLE_CLIENT_SECRET',
          },
        ],
      },
      feeds_schema: { items: {} },
    });
  }

  // A connector-bound Google app is provider-wide, so it can serve both Gmail
  // and Calendar. Discovery must mirror the runtime profile resolver.
  await createAuthProfile({
    organizationId: org.id,
    connectorKey: 'google.gmail',
    displayName: 'Managed Google App',
    profileKind: 'oauth_app',
    provider: 'google',
    authData: {
      GOOGLE_CLIENT_ID: 'managed-client-id',
      GOOGLE_CLIENT_SECRET: 'managed-client-secret',
    },
  });

  return org;
}

describe('managed-auth onboarding', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('discovers live managed OAuth offers before login without knowing the org slug', async () => {
    const managed = await seedManagedGoogleOrg();

    const client = await TestApiClient.for({
      organizationId: managed.id,
      userId: null,
      memberRole: null,
      scopedToOrg: false,
    });
    const organizations = await client.organizations.list();
    const offer = organizations.find((organization) => organization.slug === managed.slug);

    expect(offer).toMatchObject({
      slug: 'managed-connectors',
      is_member: false,
      managed_auth: {
        credential_mode: 'managed',
        requires_user_login: true,
        requires_user_consent: true,
        join_required: true,
        connect_method: 'connections.connectManaged',
        local_bootstrap_command: 'lobu init --from-org managed-connectors',
        connectors: [
          {
            connector_key: 'google.calendar',
            provider: 'google',
            managed_by_org: 'managed-connectors',
          },
          {
            connector_key: 'google.gmail',
            provider: 'google',
            managed_by_org: 'managed-connectors',
          },
        ],
      },
    });
    expect(JSON.stringify(offer)).not.toContain('managed-client-secret');
    await expect(
      client.connections.connectManaged({
        managed_by_org: managed.slug,
        connector_key: 'google.gmail',
      })
    ).rejects.toThrow(/requires workspace membership with write access/i);
  });

  it('auto-joins the signed-in user when managed connect starts', async () => {
    const home = await createTestOrganization({ name: 'Fresh User Home' });
    const user = await createTestUser({ email: 'fresh-user@example.com' });
    await addUserToOrganization(user.id, home.id, 'owner');
    const managed = await seedManagedGoogleOrg();

    const client = await TestApiClient.for({
      organizationId: home.id,
      userId: user.id,
      memberRole: 'owner',
      scopedToOrg: false,
    });

    const first = (await client.connections.connectManaged({
      managed_by_org: managed.slug,
      connector_key: 'google.gmail',
    })) as { connection_id: number; status: string };
    expect(first).toMatchObject({
      connection_id: expect.any(Number),
      status: 'pending_auth',
    });
    await expect(
      client.connections.connectManaged({
        managed_by_org: managed.slug,
        connector_key: 'google.gmail',
      })
    ).resolves.toMatchObject({
      connection_id: first.connection_id,
      status: 'pending_auth',
    });

    const organizations = await client.organizations.list();
    expect(organizations.find((organization) => organization.slug === managed.slug)).toMatchObject({
      is_member: true,
      managed_auth: { join_required: false },
    });
  });

  it('creates only the caller-owned consent grant and no cloud feeds', async () => {
    const home = await createTestOrganization({ name: 'Fresh User Home' });
    const user = await createTestUser({ email: 'fresh-user@example.com' });
    await addUserToOrganization(user.id, home.id, 'owner');
    const managed = await seedManagedGoogleOrg();

    const homeClient = await TestApiClient.for({
      organizationId: home.id,
      userId: user.id,
      memberRole: 'owner',
      scopedToOrg: false,
    });
    const result = (await homeClient.connections.connectManaged({
      managed_by_org: managed.slug,
      connector_key: 'google.gmail',
    })) as { connection_id?: number; status?: string };

    expect(result).toMatchObject({
      connection_id: expect.any(Number),
      status: 'pending_auth',
    });

    const sql = getTestDb();
    const rows = (await sql`
      SELECT created_by, visibility, config
      FROM connections
      WHERE id = ${result.connection_id}
      LIMIT 1
    `) as unknown as Array<{
      created_by: string;
      visibility: string;
      config: Record<string, unknown> | null;
    }>;
    expect(rows[0]).toMatchObject({
      created_by: user.id,
      visibility: 'private',
      config: { consent_only: true },
    });

    const feeds = await sql`SELECT 1 FROM feeds WHERE connection_id = ${result.connection_id}`;
    expect(feeds).toHaveLength(0);
  });

  it('rejects a connector that the public org does not actively offer without joining', async () => {
    const home = await createTestOrganization({ name: 'Fresh User Home' });
    const user = await createTestUser({ email: 'fresh-user@example.com' });
    await addUserToOrganization(user.id, home.id, 'owner');
    const managed = await seedManagedGoogleOrg();

    const client = await TestApiClient.for({
      organizationId: home.id,
      userId: user.id,
      memberRole: 'owner',
      scopedToOrg: false,
    });
    await expect(
      client.connections.connectManaged({
        managed_by_org: managed.slug,
        connector_key: 'github',
      })
    ).rejects.toThrow(/No active managed OAuth offer/i);

    const sql = getTestDb();
    const memberships = await sql`
      SELECT 1
      FROM "member"
      WHERE "organizationId" = ${managed.id}
        AND "userId" = ${user.id}
    `;
    expect(memberships).toHaveLength(0);
  });
});
