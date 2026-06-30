/**
 * Integration tests for the native conversation-tools authorization layer.
 *
 * The governing invariant: an agent addresses a Lobu BINDING (via an opaque
 * handle), never a raw platform id, and the server re-resolves every handle
 * against the agent's CURRENT bindings — so a forged handle, another tenant's
 * channel, or a revoked binding all fail closed. These tests exercise that
 * against a real DB, including the hosted-preview cross-org path.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, cleanupTestDatabase } from '../../setup/test-db';
import {
  createTestAgent,
  createTestOrganization,
  insertChatConnectionRow,
} from '../../setup/test-fixtures';
import {
  resolveAddressableTargets,
  resolveAuthorizedTarget,
  resolveAuthorizedThread,
  threadHandleForMessage,
} from '../../../gateway/conversations/authorization';

async function seedSlackConnection(opts: {
  organizationId: string;
  agentId: string;
  connectionId: string;
  status?: 'active' | 'stopped' | 'error' | 'paused';
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await insertChatConnectionRow({
    id: opts.connectionId,
    organizationId: opts.organizationId,
    agentId: opts.agentId,
    platform: 'slack',
    status: opts.status,
    settings: opts.settings,
    metadata: opts.metadata,
  });
}

async function seedBinding(opts: {
  organizationId: string;
  agentId: string;
  channelId: string;
  teamId?: string;
}): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO agent_channel_bindings
      (organization_id, agent_id, platform, channel_id, team_id, created_at)
    VALUES (
      ${opts.organizationId}, ${opts.agentId}, 'slack', ${opts.channelId}, ${opts.teamId ?? 'T_TEST'}, NOW()
    )
  `;
}

describe('conversation authorization', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('lists an agent own-org bound channel with a resolvable handle', async () => {
    const org = await createTestOrganization();
    const agent = await createTestAgent({ organizationId: org.id, agentId: 'crm' });
    await seedSlackConnection({ organizationId: org.id, agentId: agent.agentId, connectionId: 'conn-1' });
    await seedBinding({ organizationId: org.id, agentId: agent.agentId, channelId: 'slack:C0LEADS' });

    const targets = await resolveAddressableTargets(agent.agentId, org.id);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      kind: 'channel',
      platform: 'slack',
      connectionId: 'conn-1',
      channelId: 'C0LEADS',
      channelKey: 'slack:C0LEADS',
    });

    // The handle round-trips: list → resolve.
    const resolved = await resolveAuthorizedTarget(agent.agentId, org.id, targets[0]!.handle);
    expect(resolved?.connectionId).toBe('conn-1');
  });

  it('strips a bare (unprefixed) binding channel id', async () => {
    const org = await createTestOrganization();
    const agent = await createTestAgent({ organizationId: org.id, agentId: 'crm' });
    await seedSlackConnection({ organizationId: org.id, agentId: agent.agentId, connectionId: 'conn-1' });
    await seedBinding({ organizationId: org.id, agentId: agent.agentId, channelId: 'C0BARE' });

    const [t] = await resolveAddressableTargets(agent.agentId, org.id);
    expect(t).toMatchObject({ channelId: 'C0BARE', channelKey: 'slack:C0BARE' });
  });

  it('omits inactive connections', async () => {
    const org = await createTestOrganization();
    const agent = await createTestAgent({ organizationId: org.id, agentId: 'crm' });
    await seedSlackConnection({ organizationId: org.id, agentId: agent.agentId, connectionId: 'conn-1', status: 'stopped' });
    await seedBinding({ organizationId: org.id, agentId: agent.agentId, channelId: 'slack:C0LEADS' });

    expect(await resolveAddressableTargets(agent.agentId, org.id)).toEqual([]);
  });

  // --- Hosted-preview cross-org ---

  it('cross-org: resolves a tenant binding through the shared previewMode connection', async () => {
    const hostOrg = await createTestOrganization();
    const tenantOrg = await createTestOrganization();
    await createTestAgent({ organizationId: hostOrg.id, agentId: 'concierge' });
    await createTestAgent({ organizationId: tenantOrg.id, agentId: 'food-ordering' });

    await seedSlackConnection({
      organizationId: hostOrg.id,
      agentId: 'concierge',
      connectionId: 'preview-conn',
      settings: { previewMode: true },
      metadata: {}, // hosted-preview invariant: no teamId
    });
    await seedBinding({ organizationId: tenantOrg.id, agentId: 'food-ordering', channelId: 'slack:C0LUNCH' });

    const targets = await resolveAddressableTargets('food-ordering', tenantOrg.id);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ connectionId: 'preview-conn', channelId: 'C0LUNCH' });
  });

  it('cross-org guardrail: a NORMAL (non-preview) connection in another org is never borrowed', async () => {
    const otherOrg = await createTestOrganization();
    const tenantOrg = await createTestOrganization();
    await createTestAgent({ organizationId: otherOrg.id, agentId: 'crm' });
    await createTestAgent({ organizationId: tenantOrg.id, agentId: 'food-ordering' });

    await seedSlackConnection({ organizationId: otherOrg.id, agentId: 'crm', connectionId: 'normal-conn', settings: {} });
    await seedBinding({ organizationId: tenantOrg.id, agentId: 'food-ordering', channelId: 'slack:C0LUNCH' });

    expect(await resolveAddressableTargets('food-ordering', tenantOrg.id)).toEqual([]);
  });

  it('invariant: a SECOND preview connection per platform is rejected (single hosted bot owns the slot)', async () => {
    const hostOrg = await createTestOrganization();
    const tenantOrg = await createTestOrganization();
    await createTestAgent({ organizationId: hostOrg.id, agentId: 'concierge' });
    await createTestAgent({ organizationId: tenantOrg.id, agentId: 'sneaky' });
    await seedSlackConnection({
      organizationId: hostOrg.id,
      agentId: 'concierge',
      connectionId: 'preview-1',
      settings: { previewMode: true },
      metadata: {},
    });
    // A tenant trying to stand up a competing team-less preview connection (the
    // cross-org hijack vector) must hit the partial unique index and fail.
    await expect(
      seedSlackConnection({
        organizationId: tenantOrg.id,
        agentId: 'sneaky',
        connectionId: 'preview-2',
        settings: { previewMode: true },
        metadata: {},
      })
    ).rejects.toThrow();
  });

  it('cross-org guardrail: a previewMode connection WITH a teamId is never borrowed', async () => {
    const hostOrg = await createTestOrganization();
    const tenantOrg = await createTestOrganization();
    await createTestAgent({ organizationId: hostOrg.id, agentId: 'concierge' });
    await createTestAgent({ organizationId: tenantOrg.id, agentId: 'food-ordering' });

    await seedSlackConnection({
      organizationId: hostOrg.id,
      agentId: 'concierge',
      connectionId: 'preview-conn',
      settings: { previewMode: true },
      metadata: { teamId: 'T_REAL' }, // not a hosted preview bot
    });
    await seedBinding({ organizationId: tenantOrg.id, agentId: 'food-ordering', channelId: 'slack:C0LUNCH' });

    expect(await resolveAddressableTargets('food-ordering', tenantOrg.id)).toEqual([]);
  });

  // --- Tenant-escape + revocation ---

  it('tenant escape: agent B cannot resolve agent A\'s channel handle', async () => {
    const org = await createTestOrganization();
    await createTestAgent({ organizationId: org.id, agentId: 'agent-a' });
    await createTestAgent({ organizationId: org.id, agentId: 'agent-b' });
    await seedSlackConnection({ organizationId: org.id, agentId: 'agent-a', connectionId: 'conn-a' });
    await seedBinding({ organizationId: org.id, agentId: 'agent-a', channelId: 'slack:C0PRIVATE' });

    const [aTarget] = await resolveAddressableTargets('agent-a', org.id);
    expect(aTarget).toBeTruthy();

    // Agent B replays agent A's handle — must fail closed.
    const escaped = await resolveAuthorizedTarget('agent-b', org.id, aTarget!.handle);
    expect(escaped).toBeNull();
  });

  it('forged / malformed handles fail closed', async () => {
    const org = await createTestOrganization();
    const agent = await createTestAgent({ organizationId: org.id, agentId: 'crm' });
    await seedSlackConnection({ organizationId: org.id, agentId: agent.agentId, connectionId: 'conn-1' });
    await seedBinding({ organizationId: org.id, agentId: agent.agentId, channelId: 'slack:C0LEADS' });

    expect(await resolveAuthorizedTarget(agent.agentId, org.id, 'c_not-base64!!')).toBeNull();
    expect(await resolveAuthorizedTarget(agent.agentId, org.id, 'garbage')).toBeNull();
    // A well-formed handle for a channel the agent is NOT bound to.
    const forged = 'c_' + Buffer.from('slack:C0OTHER', 'utf8').toString('base64url');
    expect(await resolveAuthorizedTarget(agent.agentId, org.id, forged)).toBeNull();
  });

  it('revocation: a handle stops resolving once the binding is removed', async () => {
    const org = await createTestOrganization();
    const agent = await createTestAgent({ organizationId: org.id, agentId: 'crm' });
    await seedSlackConnection({ organizationId: org.id, agentId: agent.agentId, connectionId: 'conn-1' });
    await seedBinding({ organizationId: org.id, agentId: agent.agentId, channelId: 'slack:C0LEADS' });

    const [t] = await resolveAddressableTargets(agent.agentId, org.id);
    expect(await resolveAuthorizedTarget(agent.agentId, org.id, t!.handle)).toBeTruthy();

    await getTestDb()`DELETE FROM agent_channel_bindings WHERE organization_id = ${org.id} AND agent_id = ${agent.agentId}`;

    expect(await resolveAuthorizedTarget(agent.agentId, org.id, t!.handle)).toBeNull();
  });

  // --- Thread handles ---

  it('thread handle re-authorizes its channel and yields the platform thread id', async () => {
    const org = await createTestOrganization();
    const agent = await createTestAgent({ organizationId: org.id, agentId: 'crm' });
    await seedSlackConnection({ organizationId: org.id, agentId: agent.agentId, connectionId: 'conn-1' });
    await seedBinding({ organizationId: org.id, agentId: agent.agentId, channelId: 'slack:C0LEADS' });

    const [t] = await resolveAddressableTargets(agent.agentId, org.id);
    const threadHandle = threadHandleForMessage(t!, '1718000000.0001');

    const thread = await resolveAuthorizedThread(agent.agentId, org.id, threadHandle);
    expect(thread?.target.connectionId).toBe('conn-1');
    expect(thread?.threadId).toBe('slack:C0LEADS:1718000000.0001');

    // Another agent cannot use that thread handle.
    await createTestAgent({ organizationId: org.id, agentId: 'agent-b' });
    expect(await resolveAuthorizedThread('agent-b', org.id, threadHandle)).toBeNull();
  });
});
