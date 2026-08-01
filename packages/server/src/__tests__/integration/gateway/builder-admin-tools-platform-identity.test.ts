/**
 * WI-0.2: resolveBuilderAdminTools must resolve a PLATFORM user id (e.g. Slack
 * `U…`) to its linked Lobu member before the member-role lookup.
 *
 * On a chat-platform run the worker's `userId` is the platform id, NOT a Lobu
 * user id. Before the fix the `member.userId = ${userId}` join never matched, so
 * an org owner driving the builder/system agent from Slack silently lost the
 * admin-tool grant. The fix maps platform id → lobu user via
 * the workspace-scoped Slack identity first (collision-safe: an ambiguous link grants
 * nothing).
 *
 * Red→green: with `platform:'slack'` the grant only lands once the resolver maps
 * the Slack id to the member. Web/session runs (`platform:'api'` or absent) use
 * `userId` directly, unchanged.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUILDER_ADMIN_TOOLS,
  resolveBuilderAdminTools,
} from '../../../gateway/orchestration/message-consumer';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  linkSlackIdentityInGraph,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const SLACK_TEAM = 'T_WI02';
const SLACK_USER = 'U_WI02';

async function linkSlackIdentity(opts: {
  organizationId: string;
  teamId: string;
  platformUserId: string;
  lobuUserId: string;
}): Promise<void> {
  await linkSlackIdentityInGraph({
    organizationId: opts.organizationId,
    userId: opts.lobuUserId,
    teamId: opts.teamId,
    slackUserId: opts.platformUserId,
  });
}

/** Point org.system_agent_id at an agent (the builder gate requires the match). */
async function setSystemAgent(orgId: string, agentId: string): Promise<void> {
  await getTestDb()`
    UPDATE organization SET system_agent_id = ${agentId} WHERE id = ${orgId}
  `;
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
  await setSystemAgent(org.id, agent.agentId);
  return { orgId: org.id, userId: user.id, systemAgentId: agent.agentId };
}

describe('resolveBuilderAdminTools — platform identity resolution (WI-0.2)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('grants builder tools for a Slack run once the platform id maps to the owner', async () => {
    const { orgId, userId, systemAgentId } = await seedOwnerBuilder();
    await linkSlackIdentity({
      organizationId: orgId,
      teamId: SLACK_TEAM,
      platformUserId: SLACK_USER,
      lobuUserId: userId,
    });

    const granted = await resolveBuilderAdminTools({
      agentId: systemAgentId,
      organizationId: orgId,
      // A Slack run carries the raw platform id, NOT the Lobu user id.
      userId: SLACK_USER,
      platform: 'slack',
      teamId: SLACK_TEAM,
    });

    expect(granted).toEqual([...BUILDER_ADMIN_TOOLS]);
  });

  it('withholds the grant for a Slack run whose platform id is not linked to any member', async () => {
    const { orgId, systemAgentId } = await seedOwnerBuilder();
    // No linkSlackIdentity → the platform id resolves to no Lobu user.

    const granted = await resolveBuilderAdminTools({
      agentId: systemAgentId,
      organizationId: orgId,
      userId: SLACK_USER,
      platform: 'slack',
      teamId: SLACK_TEAM,
    });

    expect(granted).toBeUndefined();
  });

  it('scopes the identity by team: a Slack id linked in a DIFFERENT workspace grants nothing here', async () => {
    const { orgId, systemAgentId } = await seedOwnerBuilder();
    const other = await createTestUser();
    // The same Slack platform_user_id is linked, but only in a DIFFERENT team.
    // The resolver is team-scoped, so resolving for SLACK_TEAM finds no link and
    // the owner of the OTHER workspace can't ride this org's builder grant.
    await linkSlackIdentity({
      organizationId: orgId,
      teamId: 'T_OTHER',
      platformUserId: SLACK_USER,
      lobuUserId: other.id,
    });

    const granted = await resolveBuilderAdminTools({
      agentId: systemAgentId,
      organizationId: orgId,
      userId: SLACK_USER,
      platform: 'slack',
      teamId: SLACK_TEAM,
    });

    expect(granted).toBeUndefined();
  });

  it('grants builder tools for a web/session run using userId directly (no identity lookup)', async () => {
    const { orgId, userId, systemAgentId } = await seedOwnerBuilder();
    // platform 'api' → userId is already the Lobu user id, used directly.
    const granted = await resolveBuilderAdminTools({
      agentId: systemAgentId,
      organizationId: orgId,
      userId,
      platform: 'api',
    });

    expect(granted).toEqual([...BUILDER_ADMIN_TOOLS]);
  });

  it('withholds the grant for a member who is not owner/admin', async () => {
    const org = await createTestOrganization();
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'member');
    const agent = await createTestAgent({ organizationId: org.id });
    await setSystemAgent(org.id, agent.agentId);
    await linkSlackIdentity({
      organizationId: org.id,
      teamId: SLACK_TEAM,
      platformUserId: SLACK_USER,
      lobuUserId: user.id,
    });

    const granted = await resolveBuilderAdminTools({
      agentId: agent.agentId,
      organizationId: org.id,
      userId: SLACK_USER,
      platform: 'slack',
      teamId: SLACK_TEAM,
    });

    expect(granted).toBeUndefined();
  });

  it('grants via alternateTeamId when the link is under the enterprise key (Grid E… vs T…)', async () => {
    // Managed enterprise installs key the identity on E…; inbound
    // events carry the workspace T…. Callers pass connection external_tenant_id
    // as alternateTeamId — exact team-scoped, not a global U… collapse.
    const { orgId, userId, systemAgentId } = await seedOwnerBuilder();
    await linkSlackIdentity({
      organizationId: orgId,
      teamId: 'E_ENTERPRISE',
      platformUserId: SLACK_USER,
      lobuUserId: userId,
    });

    const granted = await resolveBuilderAdminTools({
      agentId: systemAgentId,
      organizationId: orgId,
      userId: SLACK_USER,
      platform: 'slack',
      teamId: 'T_WORKSPACE',
      alternateTeamId: 'E_ENTERPRISE',
    });

    expect(granted).toEqual([...BUILDER_ADMIN_TOOLS]);
  });

  it('does not grant when only an unrelated team has the link (no alternate)', async () => {
    const { orgId, userId, systemAgentId } = await seedOwnerBuilder();
    await linkSlackIdentity({
      organizationId: orgId,
      teamId: 'E_ENTERPRISE',
      platformUserId: SLACK_USER,
      lobuUserId: userId,
    });

    const granted = await resolveBuilderAdminTools({
      agentId: systemAgentId,
      organizationId: orgId,
      userId: SLACK_USER,
      platform: 'slack',
      teamId: 'T_WORKSPACE',
      // no alternateTeamId → fail closed
    });

    expect(granted).toBeUndefined();
  });
});
