/**
 * `listConversationFeeds` projects `channel_messages` into one FeedSpec per
 * channel under a chat connection. Invariants:
 *  - one feed per distinct channel, with message count + latest activity;
 *  - ordered most-recent-active first;
 *  - decorated with the routed agent from `agent_channel_bindings`, matching
 *    either the bare or the canonical prefixed (`slack:C…`) binding id;
 *  - fenced to (organizationId, connectionId) — another connection's channels
 *    never bleed in.
 *
 * The projection reads only `channel_messages` + `agent_channel_bindings`
 * (neither has a connection/agent FK), so the seed needs no agent_connections
 * row.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import {
  createTestAgent,
  createTestOrganization,
} from '../../__tests__/setup/test-fixtures';
import { initWorkspaceProvider } from '../../workspace';
import { listConversationFeeds } from '../conversation-feeds';

async function seedChannel(opts: {
  organizationId: string;
  connectionId: string;
  channelId: string;
  /** When set, also writes a binding (any agent_id; no FK) for decoration. */
  bindAgentId?: string;
  /** Binding id as stored — defaults to the bare channel id. */
  bindingChannelId?: string;
  messages: string[];
  /** Age of the channel's NEWEST message in seconds; lower = more recent. */
  newestSecondsAgo: number;
}): Promise<void> {
  const sql = getTestDb();
  if (opts.bindAgentId) {
    await sql`
      INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id)
      VALUES (${opts.organizationId}, ${opts.bindAgentId}, 'slack', ${opts.bindingChannelId ?? opts.channelId})
    `;
  }
  const n = opts.messages.length;
  for (let i = 0; i < n; i++) {
    // Oldest message first; the last one sits at `newestSecondsAgo`.
    const secondsAgo = opts.newestSecondsAgo + (n - 1 - i);
    await sql`
      INSERT INTO channel_messages (
        organization_id, connection_id, platform, channel_id,
        platform_message_id, author_name, is_bot, text, occurred_at
      ) VALUES (
        ${opts.organizationId}, ${opts.connectionId}, 'slack', ${opts.channelId},
        ${`${opts.connectionId}-${opts.channelId}-${i}`}, 'Alice', false, ${opts.messages[i]},
        NOW() - (${secondsAgo} * interval '1 second')
      )
    `;
  }
}

describe('listConversationFeeds', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('projects one feed per channel with count, activity, routed agent, and recency order', async () => {
    const org = await createTestOrganization({ name: 'Feeds Org' });
    const agent = await createTestAgent({ organizationId: org.id });

    await seedChannel({
      organizationId: org.id,
      connectionId: 'conn-a',
      channelId: 'C-GENERAL',
      bindAgentId: agent.agentId,
      // Binding stored in canonical prefixed form — projection must still match.
      bindingChannelId: 'slack:C-GENERAL',
      messages: ['hello', 'world', 'again'],
      newestSecondsAgo: 100,
    });
    await seedChannel({
      organizationId: org.id,
      connectionId: 'conn-a',
      channelId: 'C-RANDOM',
      messages: ['just one'],
      newestSecondsAgo: 1, // most recent → must sort first
    });

    const feeds = await listConversationFeeds(org.id, 'conn-a');

    expect(feeds).toHaveLength(2);

    const general = feeds.find((f) => f.id === 'C-GENERAL');
    expect(general).toMatchObject({
      sourceKind: 'chat-channel',
      connectionId: 'conn-a',
      status: 'active',
      itemCount: 3,
      targetAgentId: agent.agentId,
    });
    expect(general?.lastActivityAt).toBeTruthy();

    const random = feeds.find((f) => f.id === 'C-RANDOM');
    expect(random?.itemCount).toBe(1);
    expect(random?.targetAgentId).toBeNull(); // no binding → unrouted

    // Most-recently-active channel first.
    expect(feeds[0].id).toBe('C-RANDOM');
  });

  it('is fenced to the connection — another connection\'s channels do not bleed in', async () => {
    const org = await createTestOrganization({ name: 'Fence Org' });

    await seedChannel({
      organizationId: org.id,
      connectionId: 'conn-mine',
      channelId: 'C-MINE',
      messages: ['mine'],
      newestSecondsAgo: 1,
    });
    await seedChannel({
      organizationId: org.id,
      connectionId: 'conn-other',
      channelId: 'C-OTHER',
      messages: ['theirs'],
      newestSecondsAgo: 1,
    });

    const feeds = await listConversationFeeds(org.id, 'conn-mine');
    const ids = feeds.map((f) => f.id);
    expect(ids).toContain('C-MINE');
    expect(ids).not.toContain('C-OTHER');
  });
});
