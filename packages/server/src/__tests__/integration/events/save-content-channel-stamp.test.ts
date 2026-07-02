/**
 * Integration test: save_content (save_memory) stamps the source CHANNEL entity
 * into events.entity_ids when the call originates from a chat session.
 *
 * This is the ACL-isolation guarantee for the Slack federated-distillation flow:
 * when an agent reads a channel and saves its distilled knowhow, that memory
 * must inherit the channel's per-member visibility gate (resource-visibility) —
 * so a member of the channel recalls it, but it never leaks into other channels.
 * The stamp is what links the derived event to the channel resource entity.
 *
 * DB-backed (save_content resolves the channel entity via entity_identities and
 * writes an events row), so this runs against the pgvector DB via DATABASE_URL.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { slackChannelKey } from '../../../authz/slack-channel-graph';
import type { ToolContext } from '../../../tools/registry';
import { saveContent } from '../../../tools/save_content';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('saveContent > channel entity stamp', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let channelEntityId: number;
  const TEAM_ID = 'T0TEAM';
  const CHANNEL_ID = 'C0ENG';

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Channel Stamp Org' });
    user = await createTestUser({ email: 'channel-stamp@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    // A `channel` resource entity keyed on its team-scoped slack_channel_id,
    // exactly as slack-channel-graph materializes it.
    const channel = await createTestEntity({
      name: 'eng',
      entity_type: 'channel',
      organization_id: org.id,
    });
    channelEntityId = channel.id;
    const sql = getTestDb();
    await sql`
      INSERT INTO entity_identities
        (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES
        (${org.id}, ${channelEntityId}, 'slack_channel_id',
         ${slackChannelKey(TEAM_ID, CHANNEL_ID)}, 'slack')
    `;
  });

  function ctxWithSource(source?: {
    teamId?: string;
    channelId?: string;
  }): ToolContext {
    return {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:write'],
      sourceContext: source
        ? { platform: 'slack', teamId: source.teamId, channelId: source.channelId }
        : null,
    } as ToolContext;
  }

  it('stamps the channel entity when sourceContext carries the team+channel', async () => {
    const result = await saveContent(
      {
        content: 'The team decided to ship the migration next sprint.',
        semantic_type: 'summary',
        title: 'eng channel knowhow',
        metadata: {},
      } as never,
      {} as never,
      // Bare channel id (belt-and-suspenders — the resolver strips anyway).
      ctxWithSource({ teamId: TEAM_ID, channelId: CHANNEL_ID })
    );

    expect(result.entity_ids).toContain(channelEntityId);
  });

  it('stamps even when sourceContext.channelId is platform-PREFIXED (the live worker-token form)', async () => {
    // The Chat SDK / worker token carries `slack:C0ENG`, but the graphed
    // identity is the bare `T…:C…`. Regression guard: without prefix stripping
    // in resolveChannelEntityId this misses and the stamp silently never fires.
    const result = await saveContent(
      {
        content: 'Prefixed-channel knowhow should still be channel-scoped.',
        semantic_type: 'summary',
        title: 'eng channel knowhow (prefixed)',
        metadata: {},
      } as never,
      {} as never,
      ctxWithSource({ teamId: TEAM_ID, channelId: `slack:${CHANNEL_ID}` })
    );

    expect(result.entity_ids).toContain(channelEntityId);
  });

  it('does NOT stamp a channel when there is no chat sourceContext', async () => {
    const result = await saveContent(
      {
        content: 'A note saved from a plain web session.',
        semantic_type: 'note',
        title: 'no-channel note',
        metadata: {},
      } as never,
      {} as never,
      ctxWithSource()
    );

    expect(result.entity_ids).not.toContain(channelEntityId);
  });

  it('does NOT stamp when the channel has no graphed entity (unknown channel)', async () => {
    const result = await saveContent(
      {
        content: 'Saved from a channel that was never synced.',
        semantic_type: 'note',
        title: 'ungraphed channel note',
        metadata: {},
      } as never,
      {} as never,
      ctxWithSource({ teamId: TEAM_ID, channelId: 'C0UNKNOWN' })
    );

    expect(result.entity_ids).not.toContain(channelEntityId);
  });
});
