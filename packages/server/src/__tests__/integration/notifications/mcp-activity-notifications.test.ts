import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import {
  currentMcpActivityAttribution,
  recordMcpConversationActivity,
} from '../../../lobu/stores/mcp-client-conversations';
import {
  createNotificationForUsers,
  deleteNotification,
  listNotifications,
  markAllAsRead,
  markAsRead,
} from '../../../notifications/service';
import { listOrgActivity } from '../../../tools/admin/manage_operations/activity-feed';
import { notify } from '../../../tools/admin/notify';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { get } from '../../setup/test-helpers';

describe('MCP activity notification attribution', () => {
  let organizationId: string;
  let organizationSlug: string;
  let ownerId: string;
  let otherOwnerId: string;
  let ownerToken: string;
  let otherOwnerToken: string;
  let clientId: string;

  const conversationId = 'host-conversation';
  const transportSessionId = 'transport-session';

  function conversationContext(
    userId: string,
    overrides: Partial<ToolContext> = {}
  ): ToolContext {
    return {
      organizationId,
      userId,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      clientId,
      mcpConversationId: conversationId,
      mcpSessionId: transportSessionId,
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      ...overrides,
    } as ToolContext;
  }

  async function activityFor(token: string) {
    const response = await get(
      `/api/${organizationSlug}/clients/activity-scopes?client_ids=${clientId}`,
      { token }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      scopes: Array<{ activityId: string; unreadNotificationCount: number }>;
    };
    return body.scopes.find((scope) => scope.activityId === conversationId)!;
  }

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const organization = await createTestOrganization({
      name: 'MCP Activity Notification Org',
      slug: 'mcp-activity-notifications',
    });
    organizationId = organization.id;
    organizationSlug = organization.slug;

    const owner = await createTestUser({ email: 'mcp-count-owner@example.com' });
    const otherOwner = await createTestUser({ email: 'mcp-count-other@example.com' });
    ownerId = owner.id;
    otherOwnerId = otherOwner.id;
    await addUserToOrganization(ownerId, organizationId, 'owner');
    await addUserToOrganization(otherOwnerId, organizationId, 'owner');

    clientId = (
      await createTestOAuthClient({
        client_name: 'ChatGPT',
        owner_user_id: ownerId,
      })
    ).client_id;
    ownerToken = (
      await createTestAccessToken(ownerId, organizationId, clientId, {
        scope: 'mcp:read mcp:write mcp:admin',
      })
    ).token;
    otherOwnerToken = (
      await createTestAccessToken(otherOwnerId, organizationId, clientId, {
        scope: 'mcp:read mcp:write mcp:admin',
      })
    ).token;

    await recordMcpConversationActivity({
      ctx: conversationContext(ownerId),
      toolName: 'manage_operations',
      failed: false,
    });
    await recordMcpConversationActivity({
      ctx: conversationContext(ownerId, {
        mcpConversationId: 'other-chatgpt-conversation',
        mcpSessionId: 'other-chatgpt-transport',
      }),
      toolName: 'manage_operations',
      failed: false,
    });
  });

  it('derives per-user unread counts from existing notification target state', async () => {
    const mcpActivity = currentMcpActivityAttribution(conversationContext(ownerId));
    expect(mcpActivity).not.toBeNull();

    expect(
      await createNotificationForUsers([ownerId, otherOwnerId], {
        organizationId,
        type: 'generic',
        title: 'Shared activity notification',
        idempotencyKey: 'mcp-activity-shared',
        mcpActivity,
      })
    ).toMatchObject({ created: true });
    expect(
      await createNotificationForUsers([ownerId, otherOwnerId], {
        organizationId,
        type: 'generic',
        title: 'Shared activity notification retry',
        idempotencyKey: 'mcp-activity-shared',
        mcpActivity,
      })
    ).toMatchObject({ created: false });
    await notify(
      {
        action: 'send',
        recipients: [ownerId],
        title: 'Owner-only activity notification',
      },
      {} as never,
      conversationContext(ownerId)
    );
    await createNotificationForUsers([ownerId], {
      organizationId,
      type: 'generic',
      title: 'Unattributed notification',
    });

    expect((await activityFor(ownerToken)).unreadNotificationCount).toBe(2);
    expect((await activityFor(otherOwnerToken)).unreadNotificationCount).toBe(1);

    const notifications = await getDb()<Array<{ id: number; title: string }>>`
      SELECT id, title
      FROM events
      WHERE organization_id = ${organizationId}
        AND semantic_type = 'notification'
    `;
    const sharedId = Number(
      notifications.find((item) => item.title === 'Shared activity notification')!.id
    );
    const ownerOnlyId = Number(
      notifications.find((item) => item.title === 'Owner-only activity notification')!.id
    );

    expect(await markAsRead(organizationId, ownerId, sharedId)).toBe(true);
    expect((await activityFor(ownerToken)).unreadNotificationCount).toBe(1);
    expect((await activityFor(otherOwnerToken)).unreadNotificationCount).toBe(1);

    expect(await deleteNotification(organizationId, ownerId, ownerOnlyId)).toBe(true);
    expect((await activityFor(ownerToken)).unreadNotificationCount).toBe(0);
    expect((await activityFor(otherOwnerToken)).unreadNotificationCount).toBe(1);

    expect(await deleteNotification(organizationId, ownerId, sharedId)).toBe(true);
    expect(await markAllAsRead(organizationId, otherOwnerId)).toBe(1);
    expect((await activityFor(otherOwnerToken)).unreadNotificationCount).toBe(0);
  });

  it('stores provenance on the event and keeps notification targets recipient-only', async () => {
    const [event] = await getDb()<Array<{
      client_id: string | null;
      metadata: Record<string, unknown>;
    }>>`
      SELECT client_id, metadata
      FROM events
      WHERE organization_id = ${organizationId}
        AND title = 'Shared activity notification'
    `;
    expect(event).toMatchObject({
      client_id: clientId,
      metadata: {
        mcp_conversation_id: conversationId,
        mcp_session_id: transportSessionId,
      },
    });

    const targetAttributionColumns = await getDb()<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'notification_targets'
        AND column_name LIKE 'mcp_%'
    `;
    expect(targetAttributionColumns).toEqual([]);
  });

  it('filters notifications and events to exactly one activity id', async () => {
    await createNotificationForUsers([ownerId], {
      organizationId,
      type: 'generic',
      title: 'Exact activity notification',
      mcpActivity: currentMcpActivityAttribution(conversationContext(ownerId)),
    });
    await createNotificationForUsers([ownerId], {
      organizationId,
      type: 'generic',
      title: 'Other ChatGPT conversation notification',
      mcpActivity: currentMcpActivityAttribution(
        conversationContext(ownerId, {
          mcpConversationId: 'other-chatgpt-conversation',
          mcpSessionId: 'other-chatgpt-transport',
        })
      ),
    });
    const notificationsResponse = await get(
      `/api/${organizationSlug}/notifications?client_ids=${clientId}&mcp_activity_id=${conversationId}`,
      { token: ownerToken }
    );
    expect(notificationsResponse.status).toBe(200);
    const notificationsBody = (await notificationsResponse.json()) as {
      notifications: Array<{ title: string }>;
    };
    expect(notificationsBody.notifications.map((item) => item.title)).toContain(
      'Exact activity notification'
    );
    expect(notificationsBody.notifications.map((item) => item.title)).not.toContain(
      'Unattributed notification'
    );
    expect(notificationsBody.notifications.map((item) => item.title)).not.toContain(
      'Other ChatGPT conversation notification'
    );

    const result = await getContent(
      {
        client_ids: [clientId],
        mcp_activity_id: conversationId,
        limit: 100,
      } as never,
      {} as never,
      conversationContext(ownerId)
    );
    expect(result.content.map((item) => item.title)).toContain('Exact activity notification');
    expect(result.content.map((item) => item.title)).not.toContain('Unattributed notification');
    expect(result.content.map((item) => item.title)).not.toContain(
      'Other ChatGPT conversation notification'
    );
  });

  it('does not guess legacy notification provenance from a linked proposal', async () => {
    const unreadBefore = (await activityFor(ownerToken)).unreadNotificationCount;
    const sql = getDb();
    const [proposal] = await sql<Array<{ id: number }>>`
      INSERT INTO events (
        organization_id, origin_id, payload_type, semantic_type,
        interaction_type, interaction_status, client_id, metadata
      ) VALUES (
        ${organizationId}, 'legacy-proposal', 'text', 'operation',
        'approval', 'pending', ${clientId},
        ${sql.json({ mcp_session_id: transportSessionId })}
      )
      RETURNING id
    `;
    const [notification] = await sql<Array<{ id: number }>>`
      INSERT INTO events (
        organization_id, title, payload_type, semantic_type, metadata
      ) VALUES (
        ${organizationId}, 'Legacy approval notification', 'text', 'notification',
        ${sql.json({
          notification_type: 'action_approval_needed',
          resource_type: 'event',
          resource_id: String(proposal.id),
        })}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO notification_targets (event_id, user_id)
      VALUES (${notification.id}, ${ownerId})
    `;

    expect((await activityFor(ownerToken)).unreadNotificationCount).toBe(unreadBefore);
    const filtered = await get(
      `/api/${organizationSlug}/notifications?client_ids=${clientId}&mcp_activity_id=${conversationId}`,
      { token: ownerToken }
    );
    const filteredBody = (await filtered.json()) as {
      notifications: Array<{ title: string }>;
    };
    expect(filteredBody.notifications.map((item) => item.title)).not.toContain(
      'Legacy approval notification'
    );

    const global = await get(`/api/${organizationSlug}/notifications`, { token: ownerToken });
    const globalBody = (await global.json()) as {
      notifications: Array<{ title: string }>;
    };
    expect(globalBody.notifications.map((item) => item.title)).toContain(
      'Legacy approval notification'
    );
  });
});

describe('notification list > source attribution', () => {
  it('carries feed/behavior attribution from the producing version', async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const sql = getDb();
    const org = await createTestOrganization({ name: 'Attr Notification Org' });
    const user = await createTestUser({ email: 'attr-notif@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    await createTestConnectorDefinition({
      key: 'attr-notif-connector',
      name: 'Attr Notif',
      organization_id: org.id,
    });
    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'attr-notif-connector',
      visibility: 'org',
      created_by: user.id,
    });

    const [feed] = await sql`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, kind, display_name, created_at)
      VALUES (${org.id}, ${conn.id}, 'home_feed', 'active', 'collected', 'Attr Notif Feed', NOW())
      RETURNING id
    `;

    const watcherId = 910001;
    await sql`
      INSERT INTO watchers (
        id, name, slug, organization_id, entity_ids, schedule, timezone,
        next_run_at, agent_id, model_config, sources, version, tags, status,
        created_by, created_at, updated_at, watcher_group_id, triggers
      ) VALUES (
        ${watcherId}, 'Attr Notif Behavior', 'attr-notif-behavior',
        ${org.id}, '{}'::bigint[], '0 9 * * *', 'Europe/London', NOW(),
        'attr-notif-agent', '{}'::jsonb, '[]'::jsonb, 1, '{}'::text[],
        'active', ${user.id}, NOW(), NOW(), ${watcherId}, '[]'::jsonb
      )
    `;
    const [v1] = await sql`
      INSERT INTO watcher_versions (watcher_id, version, name, created_by, prompt, created_at)
      VALUES (${watcherId}, 1, 'Attr Notif Behavior', ${user.id}, 'prompt', NOW())
      RETURNING id
    `;
    await sql`
      UPDATE watchers SET current_version_id = ${v1.id} WHERE id = ${watcherId}
    `;

    const [ev] = await sql`
      INSERT INTO events (
        organization_id, title, payload_type, payload_text, occurred_at,
        semantic_type, connector_key, connection_id, feed_id, feed_key,
        behavior_id, behavior_version_id, metadata, created_at
      ) VALUES (
        ${org.id}, 'Attr notification', 'text', 'notification body', NOW(),
        'notification', 'attr-notif-connector', ${conn.id}, ${feed.id}, 'home_feed',
        ${watcherId}, ${v1.id}, '{}'::jsonb, NOW()
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO notification_targets (event_id, user_id, delivered_at)
      VALUES (${ev.id}, ${user.id}, NOW())
    `;

    // Bump the behavior's current version after the notification was produced.
    const [v2] = await sql`
      INSERT INTO watcher_versions (watcher_id, version, name, created_by, prompt, created_at)
      VALUES (${watcherId}, 2, 'Renamed Notif Behavior', ${user.id}, 'prompt', NOW())
      RETURNING id
    `;
    await sql`
      UPDATE watchers SET current_version_id = ${v2.id} WHERE id = ${watcherId}
    `;

    const { notifications } = await listNotifications({
      organizationId: org.id,
      userId: user.id,
    });
    const item = notifications.find((n) => n.id === ev.id);
    expect(item).toBeTruthy();
    // The producing version (v1) name, not the renamed current version.
    expect(item!.behavior_name).toBe('Attr Notif Behavior');
    expect(item!.behavior_id).toBe(watcherId);
    expect(item!.feed_name).toBe('Attr Notif Feed');
    expect(item!.feed_id).toBe(feed.id);
    expect(item!.feed_key).toBe('home_feed');
    expect(item!.platform).toBe('attr-notif-connector');
    expect(item!.connection_id).toBe(conn.id);

    const activity = await listOrgActivity({
      organizationId: org.id,
      userId: user.id,
      ownerSlug: org.slug,
      includeRuns: false,
    });
    const card = activity.items.find((entry) => entry.notification_id === ev.id);
    expect(card).toMatchObject({
      platform: 'attr-notif-connector',
      connection_id: conn.id,
      feed_id: feed.id,
      feed_key: 'home_feed',
      feed_name: 'Attr Notif Feed',
      behavior_id: watcherId,
      behavior_name: 'Attr Notif Behavior',
    });
  });
});
