import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { BEHAVIOR_RUN_SOURCE } from '../../../gateway/behavior-run-session';
import type { Env } from '../../../index';
import {
  fingerprintBehaviorSources,
  handleBehaviorMode,
} from '../../../tools/get_content/behavior-mode';
import { getContent } from '../../../tools/get_content/handler';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestAgent,
  createTestConnection,
  createTestEntity,
  createTestEvent,
  ownerToolContext,
} from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

const env = { JWT_SECRET: 'test-jwt-secret-for-testing-only' } as Env;
const since = '2026-07-30';
const until = '2026-07-30';
const occurredAt = new Date('2026-07-30T12:00:00.000Z');

function contentIds(result: unknown): number[] {
  return ((result as { content: Array<{ id: number }> }).content ?? [])
    .map((item) => Number(item.id))
    .sort((a, b) => a - b);
}

describe('Behavior private-connection visibility', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('uses the caller for interactive reads and the Behavior author for headless reads and fingerprints', async () => {
    const sql = getTestDb();
    const dbClient = sql as unknown as DbClient;
    const workspace = await TestWorkspace.create({
      name: 'Behavior Visibility Principal Org',
    });
    const entity = await createTestEntity({
      name: 'Behavior Visibility Entity',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId: workspace.users.admin.id,
      name: 'Behavior Visibility Agent',
    });
    const created = (await workspace.owner.behaviors.create({
      entity_id: entity.id,
      slug: 'behavior-visibility-principal',
      name: 'Behavior Visibility Principal',
      prompt: 'Summarize the visible content.',
      agent_id: agent.agentId,
      sources: [{ name: 'content', query: 'SELECT * FROM events' }],
    })) as { behavior_id: string };
    const behaviorId = Number(created.behavior_id);

    const ownerConnection = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: 'slack',
      created_by: workspace.users.owner.id,
      visibility: 'private',
    });
    const adminConnection = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: 'slack',
      created_by: workspace.users.admin.id,
      visibility: 'private',
    });
    const ownerPrivate = await createTestEvent({
      entity_id: entity.id,
      organization_id: workspace.org.id,
      connection_id: ownerConnection.id,
      connector_key: 'slack',
      content: 'Owner private content',
      occurred_at: occurredAt,
    });
    // Fingerprint before the admin's private event exists, so the baseline can
    // only come from the Behavior author's own private connection.
    const fingerprint = await fingerprintBehaviorSources({
      sql: dbClient,
      behaviorId: behaviorId,
      windowStart: '2026-07-30T00:00:00.000Z',
      windowEnd: '2026-07-31T00:00:00.000Z',
    });
    expect(fingerprint.empty).toBe(false);

    const adminPrivate = await createTestEvent({
      entity_id: entity.id,
      organization_id: workspace.org.id,
      connection_id: adminConnection.id,
      connector_key: 'slack',
      content: 'Admin private content',
      occurred_at: occurredAt,
    });
    // An admin-private event must be invisible to the author-principal
    // fingerprint, so the digest has to stay byte-identical.
    expect(
      await fingerprintBehaviorSources({
        sql: dbClient,
        behaviorId: behaviorId,
        windowStart: '2026-07-30T00:00:00.000Z',
        windowEnd: '2026-07-31T00:00:00.000Z',
      })
    ).toEqual(fingerprint);

    const orgConnection = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: 'slack',
      visibility: 'org',
    });
    const orgVisible = await createTestEvent({
      entity_id: entity.id,
      organization_id: workspace.org.id,
      connection_id: orgConnection.id,
      connector_key: 'slack',
      content: 'Organization-visible content',
      occurred_at: occurredAt,
    });

    const ownerRead = await workspace.owner.knowledge.read({
      behavior_id: behaviorId,
      since,
      until,
    });
    expect(contentIds(ownerRead)).toEqual([ownerPrivate.id, orgVisible.id].sort((a, b) => a - b));

    const adminRead = await workspace.admin.knowledge.read({
      behavior_id: behaviorId,
      since,
      until,
    });
    expect(contentIds(adminRead)).toEqual([adminPrivate.id, orgVisible.id].sort((a, b) => a - b));

    const behaviorRunRead = await getContent(
      { behavior_id: behaviorId, since, until },
      env,
      {
        ...ownerToolContext(workspace.org.id, workspace.users.admin.id),
        agentId: agent.agentId,
        // Verified run identity must match the requested Behavior.
        actingBehaviorId: behaviorId,
        sourceContext: {
          source: BEHAVIOR_RUN_SOURCE,
          conversationId: `${agent.agentId}_behavior_${behaviorId}_run_99`,
        },
      }
    );
    expect(contentIds(behaviorRunRead)).toEqual(
      [ownerPrivate.id, orgVisible.id].sort((a, b) => a - b)
    );

    const otherCreated = (await workspace.admin.behaviors.create({
      entity_id: entity.id,
      slug: 'behavior-visibility-other',
      name: 'Other Behavior',
      prompt: 'Other',
      agent_id: agent.agentId,
      sources: [{ name: 'content', query: 'SELECT * FROM events' }],
    })) as { behavior_id: string };
    const otherBehaviorId = Number(otherCreated.behavior_id);

    await expect(
      getContent(
        { behavior_id: otherBehaviorId, since, until },
        env,
        {
          ...ownerToolContext(workspace.org.id, workspace.users.admin.id),
          agentId: agent.agentId,
          actingBehaviorId: behaviorId,
          sourceContext: {
            source: BEHAVIOR_RUN_SOURCE,
            conversationId: `${agent.agentId}_behavior_${behaviorId}_run_99`,
          },
        }
      )
    ).rejects.toThrow(/own behavior_id/);

    const headlessRead = await handleBehaviorMode(
      { behavior_id: behaviorId, since, until },
      env,
      dbClient,
      {
        organizationId: workspace.org.id,
        userId: null,
      }
    );
    expect(contentIds(headlessRead)).toEqual(
      [ownerPrivate.id, orgVisible.id].sort((a, b) => a - b)
    );
  });
});
