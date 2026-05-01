import { getDb, pgTextArray } from '../db/client';
import { isLobuGatewayRunning } from '../lobu/gateway';
import { getLobuServiceToken } from '../lobu/service-token';
import logger from '../utils/logger';

interface CreateNotificationParams {
  organizationId: string;
  userId: string;
  type:
    | 'action_approval_needed'
    | 'connection_permission_request'
    | 'invitation_received'
    | 'browser_auth_expired'
    | 'generic'
    | 'agent_message';
  title: string;
  body?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  resourceUrl?: string | null;
  /** When set, deliver only through this specific bot connection */
  connectionId?: string | null;
}

interface NotificationRow {
  id: number;
  organization_id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  resource_type: string | null;
  resource_id: string | null;
  resource_url: string | null;
  is_read: boolean;
  created_at: string;
}

/**
 * Forward a notification to active bot connections via Lobu's messaging API.
 *
 * Fetches active connections and their default targets from Lobu's internal API,
 * then sends via /api/v1/messaging/send with platform-specific routing.
 */
async function deliverToBotConnections(params: CreateNotificationParams): Promise<void> {
  if (!isLobuGatewayRunning()) return;

  const port = process.env.PORT || '8787';
  const lobuBaseUrl = `http://127.0.0.1:${port}/lobu`;

  const text = params.body ? `${params.title}\n\n${params.body}` : params.title;

  try {
    // Fetch connections and targets in parallel
    const [connRes, targetsRes] = await Promise.all([
      fetch(`${lobuBaseUrl}/api/internal/connections`),
      fetch(`${lobuBaseUrl}/api/internal/connections/test-targets`),
    ]);
    if (!connRes.ok) return;

    const connBody = (await connRes.json()) as {
      connections: Array<{
        id: string;
        platform: string;
        templateAgentId: string;
        status: string;
      }>;
    };
    const targets = targetsRes.ok
      ? ((await targetsRes.json()) as Array<{ platform: string; defaultTarget: string }>)
      : [];

    const targetMap = new Map(targets.map((t) => [t.platform, t.defaultTarget]));

    let connections = connBody.connections.filter((c) => c.status === 'active');
    if (params.connectionId) {
      connections = connections.filter((c) => c.id === params.connectionId);
    }

    for (const conn of connections) {
      const target = targetMap.get(conn.platform);
      // Platform-specific routing
      const routing: Record<string, unknown> = {};
      if (conn.platform === 'telegram' && target) {
        routing.telegram = { chatId: target };
      } else if (conn.platform === 'slack' && target) {
        routing.slack = { channel: target };
      }

      const token = await getLobuServiceToken(params.organizationId);
      await fetch(`${lobuBaseUrl}/api/v1/messaging/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          agentId: conn.templateAgentId,
          message: text,
          platform: conn.platform,
          ...routing,
        }),
      }).catch((err) =>
        logger.warn(
          { err, connectionId: conn.id },
          '[Notifications] Failed to send via Lobu connection'
        )
      );
    }
  } catch (err) {
    logger.warn({ err }, '[Notifications] Failed to deliver to embedded Lobu');
  }
}

export async function createNotificationForUsers(
  userIds: string[],
  params: Omit<CreateNotificationParams, 'userId'>
): Promise<void> {
  if (userIds.length === 0) return;
  const sql = getDb();

  const values = userIds.map((uid) => ({
    organization_id: params.organizationId,
    user_id: uid,
    type: params.type,
    title: params.title,
    body: params.body ?? null,
    resource_type: params.resourceType ?? null,
    resource_id: params.resourceId ?? null,
    resource_url: params.resourceUrl ?? null,
  }));

  // Batch insert using unnest for efficiency
  const orgIds = values.map((v) => v.organization_id);
  const uids = values.map((v) => v.user_id);
  const types = values.map((v) => v.type);
  const titles = values.map((v) => v.title);
  const bodies = values.map((v) => v.body);
  const resourceTypes = values.map((v) => v.resource_type);
  const resourceIds = values.map((v) => v.resource_id);
  const resourceUrls = values.map((v) => v.resource_url);

  await sql`
    INSERT INTO notifications (organization_id, user_id, type, title, body, resource_type, resource_id, resource_url)
    SELECT * FROM unnest(
      ${pgTextArray(orgIds)}::text[],
      ${pgTextArray(uids)}::text[],
      ${pgTextArray(types)}::text[],
      ${pgTextArray(titles)}::text[],
      ${pgTextArray(bodies)}::text[],
      ${pgTextArray(resourceTypes)}::text[],
      ${pgTextArray(resourceIds)}::text[],
      ${pgTextArray(resourceUrls)}::text[]
    )
  `;

  // Deliver to bot connections (fire-and-forget) for each user
  for (const uid of userIds) {
    deliverToBotConnections({ ...params, userId: uid }).catch((err) =>
      logger.warn({ err }, '[Notifications] Failed to deliver to bot connections')
    );
  }
}

export async function listNotifications(opts: {
  organizationId: string;
  userId: string;
  cursor?: number | null;
  limit?: number;
  unreadOnly?: boolean;
}): Promise<{ notifications: NotificationRow[]; nextCursor: number | null }> {
  const sql = getDb();
  const limit = Math.min(opts.limit ?? 20, 50);
  const cursor = opts.cursor ?? null;
  const unreadOnly = opts.unreadOnly ?? false;

  const rows = await sql<NotificationRow>`
    SELECT *
    FROM notifications
    WHERE organization_id = ${opts.organizationId}
      AND user_id = ${opts.userId}
      AND (${cursor}::bigint IS NULL OR id < ${cursor})
      AND (${!unreadOnly} OR is_read = false)
    ORDER BY id DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const notifications = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? notifications[notifications.length - 1].id : null;

  return { notifications, nextCursor };
}

export async function getUnreadCount(organizationId: string, userId: string): Promise<number> {
  const sql = getDb();
  const rows = await sql<{ count: number }>`
    SELECT COUNT(*)::int AS count
    FROM notifications
    WHERE organization_id = ${organizationId}
      AND user_id = ${userId}
      AND is_read = false
  `;
  return rows[0].count;
}

export async function markAsRead(
  organizationId: string,
  userId: string,
  notificationId: number
): Promise<boolean> {
  const sql = getDb();
  const rows = await sql`
    UPDATE notifications
    SET is_read = true
    WHERE id = ${notificationId}
      AND organization_id = ${organizationId}
      AND user_id = ${userId}
      AND is_read = false
    RETURNING id
  `;
  return rows.length > 0;
}

export async function markAllAsRead(organizationId: string, userId: string): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    UPDATE notifications
    SET is_read = true
    WHERE organization_id = ${organizationId}
      AND user_id = ${userId}
      AND is_read = false
    RETURNING id
  `;
  return rows.length;
}

export async function deleteNotification(
  organizationId: string,
  userId: string,
  notificationId: number
): Promise<boolean> {
  const sql = getDb();
  const rows = await sql`
    DELETE FROM notifications
    WHERE id = ${notificationId}
      AND organization_id = ${organizationId}
      AND user_id = ${userId}
    RETURNING id
  `;
  return rows.length > 0;
}
