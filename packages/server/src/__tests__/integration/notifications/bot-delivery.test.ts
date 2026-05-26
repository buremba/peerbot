/**
 * Integration test for the notification → bot-connection delivery path.
 *
 * Exercises `resolveBotDeliveryTargets` against a real DB: it JOINs the org's
 * active chat connections to their channel bindings and returns the channel(s)
 * each notification should post to. This is the path that was a silent no-op
 * after #846 removed the HTTP endpoints the old implementation called.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, cleanupTestDatabase } from '../../setup/test-db';
import { createTestAgent, createTestOrganization } from '../../setup/test-fixtures';
import { resolveBotDeliveryTargets } from '../../../notifications/service';

async function seedSlackConnection(opts: {
  organizationId: string;
  agentId: string;
  connectionId: string;
  status?: string;
}): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO agent_connections
      (id, organization_id, agent_id, platform, config, settings, metadata, status, created_at, updated_at)
    VALUES (
      ${opts.connectionId}, ${opts.organizationId}, ${opts.agentId}, 'slack',
      ${sql.json({})}, ${sql.json({})}, ${sql.json({})}, ${opts.status ?? 'active'}, NOW(), NOW()
    )
  `;
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

describe('resolveBotDeliveryTargets', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('resolves an active connection to its bound channel', async () => {
    const org = await createTestOrganization();
    const agent = await createTestAgent({ organizationId: org.id, agentId: 'crm' });
    await seedSlackConnection({
      organizationId: org.id,
      agentId: agent.agentId,
      connectionId: 'conn-1',
    });
    await seedBinding({
      organizationId: org.id,
      agentId: agent.agentId,
      channelId: 'slack:C0LEADS',
    });

    const targets = await resolveBotDeliveryTargets(org.id);

    expect(targets).toEqual([
      { connectionId: 'conn-1', platform: 'slack', channelKey: 'slack:C0LEADS' },
    ]);
  });

  it('returns nothing for a connection with no binding', async () => {
    const org = await createTestOrganization();
    const agent = await createTestAgent({ organizationId: org.id, agentId: 'crm' });
    await seedSlackConnection({
      organizationId: org.id,
      agentId: agent.agentId,
      connectionId: 'conn-1',
    });
    // No binding seeded.

    expect(await resolveBotDeliveryTargets(org.id)).toEqual([]);
  });

  it('omits inactive connections', async () => {
    const org = await createTestOrganization();
    const agent = await createTestAgent({ organizationId: org.id, agentId: 'crm' });
    await seedSlackConnection({
      organizationId: org.id,
      agentId: agent.agentId,
      connectionId: 'conn-1',
      status: 'stopped',
    });
    await seedBinding({
      organizationId: org.id,
      agentId: agent.agentId,
      channelId: 'slack:C0LEADS',
    });

    expect(await resolveBotDeliveryTargets(org.id)).toEqual([]);
  });

  it('prefixes a bare channel id with the platform', async () => {
    const org = await createTestOrganization();
    const agent = await createTestAgent({ organizationId: org.id, agentId: 'crm' });
    await seedSlackConnection({
      organizationId: org.id,
      agentId: agent.agentId,
      connectionId: 'conn-1',
    });
    await seedBinding({
      organizationId: org.id,
      agentId: agent.agentId,
      channelId: 'C0BARE',
    });

    const targets = await resolveBotDeliveryTargets(org.id);
    expect(targets).toEqual([
      { connectionId: 'conn-1', platform: 'slack', channelKey: 'slack:C0BARE' },
    ]);
  });

  it('honors the connectionId filter', async () => {
    const org = await createTestOrganization();
    const agent = await createTestAgent({ organizationId: org.id, agentId: 'crm' });
    for (const id of ['conn-1', 'conn-2']) {
      await seedSlackConnection({ organizationId: org.id, agentId: agent.agentId, connectionId: id });
    }
    await seedBinding({ organizationId: org.id, agentId: agent.agentId, channelId: 'slack:C1' });

    const targets = await resolveBotDeliveryTargets(org.id, 'conn-2');
    expect(targets.map((t) => t.connectionId)).toEqual(['conn-2']);
  });
});
