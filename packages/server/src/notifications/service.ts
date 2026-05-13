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
async function deliverToBotConnections(
  params: Omit<CreateNotificationParams, 'userId'>
): Promise<void> {
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
        agentId: string;
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
    if (connections.length === 0) return;

    // Mint the service token once per org (it's org-scoped, not per-connection).
    const token = await getLobuServiceToken(params.organizationId);

    await Promise.allSettled(
      connections.map((conn) => {
        const target = targetMap.get(conn.platform);
        // Platform-specific routing
        const routing: Record<string, unknown> = {};
        if (conn.platform === 'telegram' && target) {
          routing.telegram = { chatId: target };
        } else if (conn.platform === 'slack' && target) {
          routing.slack = { channel: target };
        }
        return fetch(`${lobuBaseUrl}/api/v1/messaging/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            agentId: conn.agentId,
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
      })
    );
  } catch (err) {
    logger.warn({ err }, '[Notifications] Failed to deliver to embedded Lobu');
  }
}

/**
 * Notifications are events + per-user targets.
 *
 * The `events` table stores the notification's content (org-wide visibility,
 * searchable, addressable from the knowledge view); `notification_targets`
 * scopes inbox / read-state to the addressed users. "Send to admins" inserts
 * ONE event + N targets; "mark read" updates a target row; "unread count"
 * counts target rows without `read_at`.
 *
 * The legacy public.notifications table was migrated by
 * 20260513200000_notifications_as_events.sql and dropped.
 */
export async function createNotificationForUsers(
  userIds: string[],
  params: Omit<CreateNotificationParams, 'userId'>
): Promise<void> {
  if (userIds.length === 0) return;
  const sql = getDb();

  await sql.begin(async (tx) => {
    const inserted = (await tx`
      INSERT INTO events
        (organization_id, title, payload_text, payload_type, semantic_type,
         occurred_at, metadata)
      VALUES (
        ${params.organizationId},
        ${params.title},
        ${params.body ?? null},
        'text',
        'notification',
        now(),
        ${sql.json({
          notification_type: params.type,
          resource_type: params.resourceType ?? null,
          resource_id: params.resourceId ?? null,
          resource_url: params.resourceUrl ?? null,
        })}
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const eventId = inserted[0]?.id;
    if (!eventId) return;

    await tx`
      INSERT INTO notification_targets (event_id, user_id)
      SELECT ${eventId}, uid
      FROM unnest(${pgTextArray(userIds)}::text[]) AS u(uid)
      ON CONFLICT DO NOTHING
    `;
  });

  // Deliver to bot connections (fire-and-forget). The bot delivery targets
  // the org's connection default channels and is identical for every user in
  // this call, so fan it out once — not once per user.
  deliverToBotConnections(params).catch((err) =>
    logger.warn({ err }, '[Notifications] Failed to deliver to bot connections')
  );
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

  const rows = (await sql`
    SELECT
      e.id,
      e.organization_id,
      t.user_id,
      COALESCE(e.metadata->>'notification_type', 'generic') AS type,
      e.title,
      e.payload_text AS body,
      e.metadata->>'resource_type' AS resource_type,
      e.metadata->>'resource_id' AS resource_id,
      e.metadata->>'resource_url' AS resource_url,
      (t.read_at IS NOT NULL) AS is_read,
      t.delivered_at AS created_at
    FROM notification_targets t
    JOIN events e ON e.id = t.event_id
    WHERE e.organization_id = ${opts.organizationId}
      AND t.user_id = ${opts.userId}
      AND (${cursor}::bigint IS NULL OR e.id < ${cursor})
      AND (${!unreadOnly} OR t.read_at IS NULL)
    -- Order strictly by e.id so the (e.id < cursor) keyset pagination is
    -- consistent. delivered_at would tie-break for concurrent inserts but
    -- doesn't match the cursor — using it as the primary key risked
    -- skipping notifications when delivered_at and e.id disagreed.
    ORDER BY e.id DESC
    LIMIT ${limit + 1}
  `) as unknown as NotificationRow[];

  const hasMore = rows.length > limit;
  const notifications = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? notifications[notifications.length - 1].id : null;

  return { notifications, nextCursor };
}

export async function getUnreadCount(organizationId: string, userId: string): Promise<number> {
  const sql = getDb();
  const rows = (await sql`
    SELECT COUNT(*)::int AS count
    FROM notification_targets t
    JOIN events e ON e.id = t.event_id
    WHERE e.organization_id = ${organizationId}
      AND t.user_id = ${userId}
      AND t.read_at IS NULL
  `) as unknown as Array<{ count: number }>;
  return rows[0].count;
}

export async function markAsRead(
  organizationId: string,
  userId: string,
  notificationId: number
): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    UPDATE notification_targets t
    SET read_at = now()
    FROM events e
    WHERE t.event_id = e.id
      AND e.id = ${notificationId}
      AND e.organization_id = ${organizationId}
      AND t.user_id = ${userId}
      AND t.read_at IS NULL
    RETURNING t.event_id
  `) as unknown as Array<{ event_id: number }>;
  return rows.length > 0;
}

export async function markAllAsRead(organizationId: string, userId: string): Promise<number> {
  const sql = getDb();
  const rows = (await sql`
    UPDATE notification_targets t
    SET read_at = now()
    FROM events e
    WHERE t.event_id = e.id
      AND e.organization_id = ${organizationId}
      AND t.user_id = ${userId}
      AND t.read_at IS NULL
    RETURNING t.event_id
  `) as unknown as Array<{ event_id: number }>;
  return rows.length;
}

/**
 * "Deleting" a notification is a per-user concern — the event stays in the
 * org-wide knowledge stream. We just drop the target row so it disappears
 * from this user's inbox.
 */
export async function deleteNotification(
  organizationId: string,
  userId: string,
  notificationId: number
): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    DELETE FROM notification_targets t
    USING events e
    WHERE t.event_id = e.id
      AND e.id = ${notificationId}
      AND e.organization_id = ${organizationId}
      AND t.user_id = ${userId}
    RETURNING t.event_id
  `) as unknown as Array<{ event_id: number }>;
  return rows.length > 0;
}
