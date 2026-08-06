import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import {
  currentMcpActivityAttribution,
  recordMcpConversationActivity,
} from '../../../lobu/stores/mcp-client-conversations';
import {
  createNotificationForUsers,
  deleteNotification,
  markAllAsRead,
  markAsRead,
} from '../../../notifications/service';
import { notify } from '../../../tools/admin/notify';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
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
