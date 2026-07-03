/**
 * Default `connections.visibility` must depend on the CREDENTIAL kind, not just
 * the creator's role.
 *
 * A connection reads through ONE org-level credential (its auth profile's token),
 * so an `org`-visible connection lets every org member read live through the
 * owner's token. For a personal login (`profile_kind='oauth_account'` — a user's
 * own Gmail etc.) that means org-visible = the owner's private inbox exposed to
 * the whole org. So a personal-credential connection must default to `private`
 * EVEN when an admin/owner creates it — the credential being personal outranks
 * the role. Every other credential kind (env/oauth_app/service account) backs a
 * genuinely shared source and keeps the role-based default (owner → `org`).
 *
 * Red→green: before the fix, resolveConnectionVisibility branched on role alone,
 * so an OWNER's oauth_account connection defaulted `org` — the exposure bug.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { manageAuthProfiles } from '../../../tools/admin/manage_auth_profiles';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { getTestDb, cleanupTestDatabase } from '../../setup/test-db';
import { initWorkspaceProvider } from '../../../workspace';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {} as Env;

function ownerCtx(organizationId: string, userId: string): ToolContext {
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

async function makeConnectors(orgId: string) {
  // A personal-login (oauth_account) connector.
  await createTestConnectorDefinition({
    key: 'vis.oauth',
    name: 'Vis OAuth',
    organization_id: orgId,
    auth_schema: {
      methods: [
        {
          type: 'oauth',
          provider: 'visoauth',
          requiredScopes: ['read'],
          clientIdKey: 'VISOAUTH_CLIENT_ID',
          clientSecretKey: 'VISOAUTH_CLIENT_SECRET',
        },
      ],
    },
    feeds_schema: { items: {} },
  });
  // A no-auth connector (a genuinely shared source: no personal credential).
  await createTestConnectorDefinition({
    key: 'vis.noauth',
    name: 'Vis NoAuth',
    organization_id: orgId,
    feeds_schema: { items: {} },
  });
}

describe('connection visibility default depends on credential kind', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it("an OWNER's oauth_account (personal-login) connection defaults to PRIVATE", async () => {
    process.env.VISOAUTH_CLIENT_ID = 'env-id';
    process.env.VISOAUTH_CLIENT_SECRET = 'env-secret';
    const org = await createTestOrganization({ name: 'Vis Org A' });
    const user = await createTestUser({ name: 'Owner A' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ownerCtx(org.id, user.id);
    await makeConnectors(org.id);

    await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'vis.oauth',
        profile_kind: 'oauth_account',
        display_name: 'Vis Account',
        slug: 'vis-account',
      },
      TEST_ENV,
      ctx
    );

    const res = await manageConnections(
      {
        action: 'create',
        connector_key: 'vis.oauth',
        slug: 'vis-oauth-conn',
        display_name: 'Vis OAuth Connection',
        auth_profile_slug: 'vis-account',
      },
      TEST_ENV,
      ctx
    );
    expect('error' in res).toBe(false);
    const connectionId = 'connection' in res ? (res.connection as { id: number }).id : 0;
    expect(connectionId).toBeGreaterThan(0);

    const sql = getTestDb();
    const [row] = (await sql`
      SELECT visibility FROM connections WHERE id = ${connectionId}
    `) as Array<{ visibility: string }>;
    // The fix: personal creds → private even for an owner.
    expect(row.visibility).toBe('private');

    delete process.env.VISOAUTH_CLIENT_ID;
    delete process.env.VISOAUTH_CLIENT_SECRET;
  });

  it("an OWNER's non-personal (no auth_profile) connection still defaults to ORG", async () => {
    const org = await createTestOrganization({ name: 'Vis Org B' });
    const user = await createTestUser({ name: 'Owner B' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ownerCtx(org.id, user.id);
    await makeConnectors(org.id);

    const res = await manageConnections(
      {
        action: 'create',
        connector_key: 'vis.noauth',
        slug: 'vis-noauth-conn',
        display_name: 'Vis NoAuth Connection',
      },
      TEST_ENV,
      ctx
    );
    expect('error' in res).toBe(false);
    const connectionId = 'connection' in res ? (res.connection as { id: number }).id : 0;
    expect(connectionId).toBeGreaterThan(0);

    const sql = getTestDb();
    const [row] = (await sql`
      SELECT visibility FROM connections WHERE id = ${connectionId}
    `) as Array<{ visibility: string }>;
    // No personal credential → role default preserved (owner → org).
    expect(row.visibility).toBe('org');
  });
});
