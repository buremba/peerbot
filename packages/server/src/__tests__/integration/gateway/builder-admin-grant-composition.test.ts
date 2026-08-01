/**
 * The metadata→tenant→grant COMPOSITION for the Builder admin-tool grant.
 *
 * `builder-admin-tools-platform-identity.test.ts` covers the grant itself, and
 * `stores/active-chat-connection-tenant.test.ts` covers the tenant lookup — but
 * both are fed `alternateTeamId` (resp. a slug) directly. Nothing proved that
 * the dispatch path DERIVES those keys correctly from a message payload, and
 * that seam is exactly where the bug lived: `platformMetadata.connectionId` is
 * a RUNTIME connection id, while `connections.slug` namespaces BYO rows as
 * `agentconn-<id>`. Passing the runtime id straight through as a slug made the
 * lookup miss for every BYO connection, silently dropping the Grid fallback —
 * a fail-closed miss no unit test would notice.
 *
 * These tests drive `resolveGrantTeamKeys` (the extracted derivation) against a
 * real `connections` row and then feed its output into
 * `resolveBuilderAdminGrant`, so the two halves are exercised as they compose
 * at dispatch time.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUILDER_ADMIN_TOOLS,
  resolveBuilderAdminGrant,
  resolveGrantTeamKeys,
} from '../../../gateway/orchestration/message-consumer';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
  insertChatConnectionRow,
  linkSlackIdentityInGraph,
} from '../../setup/test-fixtures';

const WORKSPACE_TEAM = 'T_WORKSPACE';
const ENTERPRISE_TEAM = 'E_ENTERPRISE';
const SLACK_USER = 'U_COMPOSE';
/** A BYO runtime connection id — stored under slug `agentconn-<id>`. */
const BYO_CONNECTION_ID = 'conn-compose-1';

async function linkSlackIdentity(
  organizationId: string,
  teamId: string,
  lobuUserId: string
): Promise<void> {
  await linkSlackIdentityInGraph({
    organizationId,
    userId: lobuUserId,
    teamId,
    slackUserId: SLACK_USER,
  });
}

async function seedOwnerBuilder(): Promise<{
  orgId: string;
  userId: string;
  systemAgentId: string;
}> {
  const org = await createTestOrganization();
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  const agent = await createTestAgent({ organizationId: org.id });
  await getTestDb()`
    UPDATE organization SET system_agent_id = ${agent.agentId} WHERE id = ${org.id}
  `;
  return { orgId: org.id, userId: user.id, systemAgentId: agent.agentId };
}

/** Seed an active Slack connection whose tenant is the Grid enterprise id. */
async function seedGridConnection(orgId: string, status: 'active' | 'paused' = 'active') {
  await insertChatConnectionRow({
    id: BYO_CONNECTION_ID,
    organizationId: orgId,
    platform: 'slack',
    status,
    metadata: { teamId: ENTERPRISE_TEAM, teamName: 'Acme Grid' },
  });
}

describe('Builder admin grant — payload metadata → tenant → grant composition', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('derives the enterprise alternate key from a BYO runtime connectionId and grants', async () => {
    const { orgId, userId, systemAgentId } = await seedOwnerBuilder();
    await seedGridConnection(orgId);
    // The identity is linked under the Grid E… key, while the event carries T….
    await linkSlackIdentity(orgId, ENTERPRISE_TEAM, userId);

    const keys = await resolveGrantTeamKeys({
      platform: 'slack',
      organizationId: orgId,
      // Routing key for a DM is the platform name, not a workspace id.
      routingTeamId: 'slack',
      platformMetadata: {
        teamId: WORKSPACE_TEAM,
        connectionId: BYO_CONNECTION_ID,
      },
    });

    // The event's workspace id is primary; the connection's tenant is the
    // alternate. Regression: a runtime-id-as-slug lookup returns undefined here.
    expect(keys).toEqual({
      teamId: WORKSPACE_TEAM,
      alternateTeamId: ENTERPRISE_TEAM,
    });

    const granted = await resolveBuilderAdminGrant({
      agentId: systemAgentId,
      organizationId: orgId,
      userId: SLACK_USER,
      platform: 'slack',
      teamId: keys.teamId,
      alternateTeamId: keys.alternateTeamId,
    });
    expect(granted).toEqual({
      tools: [...BUILDER_ADMIN_TOOLS],
      actorUserId: userId,
    });
  });

  it('prefers platformMetadata.teamId over the routing key', async () => {
    const { orgId, userId, systemAgentId } = await seedOwnerBuilder();
    // Linked under the real workspace id; the routing key is the string 'slack'.
    await linkSlackIdentity(orgId, WORKSPACE_TEAM, userId);

    const keys = await resolveGrantTeamKeys({
      platform: 'slack',
      organizationId: orgId,
      routingTeamId: 'slack',
      platformMetadata: { teamId: WORKSPACE_TEAM },
    });
    expect(keys.teamId).toBe(WORKSPACE_TEAM);

    const granted = await resolveBuilderAdminGrant({
      agentId: systemAgentId,
      organizationId: orgId,
      userId: SLACK_USER,
      platform: 'slack',
      teamId: keys.teamId,
      alternateTeamId: keys.alternateTeamId,
    });
    expect(granted).toEqual({
      tools: [...BUILDER_ADMIN_TOOLS],
      actorUserId: userId,
    });
  });

  it('omits the alternate when the connection tenant equals the event team', async () => {
    const { orgId } = await seedOwnerBuilder();
    await insertChatConnectionRow({
      id: BYO_CONNECTION_ID,
      organizationId: orgId,
      platform: 'slack',
      status: 'active',
      metadata: { teamId: WORKSPACE_TEAM },
    });

    const keys = await resolveGrantTeamKeys({
      platform: 'slack',
      organizationId: orgId,
      platformMetadata: {
        teamId: WORKSPACE_TEAM,
        connectionId: BYO_CONNECTION_ID,
      },
    });

    expect(keys.alternateTeamId).toBeUndefined();
  });

  it('withholds the alternate — and the grant — when the install is paused', async () => {
    const { orgId, userId, systemAgentId } = await seedOwnerBuilder();
    await seedGridConnection(orgId, 'paused');
    await linkSlackIdentity(orgId, ENTERPRISE_TEAM, userId);

    const keys = await resolveGrantTeamKeys({
      platform: 'slack',
      organizationId: orgId,
      platformMetadata: {
        teamId: WORKSPACE_TEAM,
        connectionId: BYO_CONNECTION_ID,
      },
    });
    // Fail closed: a paused install must not supply a privilege key.
    expect(keys.alternateTeamId).toBeUndefined();

    const granted = await resolveBuilderAdminGrant({
      agentId: systemAgentId,
      organizationId: orgId,
      userId: SLACK_USER,
      platform: 'slack',
      teamId: keys.teamId,
      alternateTeamId: keys.alternateTeamId,
    });
    expect(granted).toBeUndefined();
  });

  it('does not consult connections for a non-Slack platform', async () => {
    const { orgId } = await seedOwnerBuilder();
    await seedGridConnection(orgId);

    const keys = await resolveGrantTeamKeys({
      platform: 'telegram',
      organizationId: orgId,
      platformMetadata: {
        teamId: WORKSPACE_TEAM,
        connectionId: BYO_CONNECTION_ID,
      },
    });

    expect(keys).toEqual({ teamId: WORKSPACE_TEAM });
  });

  it("does not borrow another org's connection tenant", async () => {
    const { orgId } = await seedOwnerBuilder();
    const foreign = await createTestOrganization();
    // The connection lives in a DIFFERENT org under the same runtime id.
    await seedGridConnection(foreign.id);

    const keys = await resolveGrantTeamKeys({
      platform: 'slack',
      organizationId: orgId,
      platformMetadata: {
        teamId: WORKSPACE_TEAM,
        connectionId: BYO_CONNECTION_ID,
      },
    });

    expect(keys.alternateTeamId).toBeUndefined();
  });
});
