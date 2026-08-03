import type { Context } from 'hono';
import type { Env } from '../index';
import { requireOrgUser } from '../utils/require-org-user';
import {
  deleteNotification,
  getUnreadCount,
  listNotifications,
  markAllAsRead,
  markAsRead,
} from './service';

export async function restListNotifications(c: Context<{ Bindings: Env }>) {
  const auth = requireOrgUser(c);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const cursorRaw = c.req.query('cursor') ? Number(c.req.query('cursor')) : null;
  const cursor = cursorRaw !== null && Number.isFinite(cursorRaw) ? cursorRaw : null;
  const limitRaw = c.req.query('limit') ? Number(c.req.query('limit')) : 20;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20;
  const unreadOnly = c.req.query('unread_only') === 'true';
  const clientIds = (c.req.query('client_ids') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const mcpActivityId = c.req.query('mcp_activity_id')?.trim() || null;
  if (clientIds.some((clientId) => clientId.length > 512)) {
    return c.json({ error: 'Invalid client ID' }, 400);
  }
  if (mcpActivityId && mcpActivityId.length > 512) {
    return c.json({ error: 'Invalid MCP activity ID' }, 400);
  }
  if (mcpActivityId && clientIds.length === 0) {
    return c.json({ error: 'mcp_activity_id requires client_ids' }, 400);
  }

  const result = await listNotifications({
    organizationId: auth.organizationId,
    userId: auth.userId,
    cursor,
    limit,
    unreadOnly,
    clientIds,
    mcpActivityId,
  });

  return c.json(result);
}

export async function restGetUnreadCount(c: Context<{ Bindings: Env }>) {
  const auth = requireOrgUser(c);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const count = await getUnreadCount(auth.organizationId, auth.userId);
  return c.json({ count });
}

export async function restMarkAsRead(c: Context<{ Bindings: Env }>) {
  const auth = requireOrgUser(c);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) {
    return c.json({ error: 'Invalid notification ID' }, 400);
  }
  const updated = await markAsRead(auth.organizationId, auth.userId, id);
  if (!updated) {
    return c.json({ error: 'Not found or already read' }, 404);
  }
  return c.json({ success: true });
}

export async function restMarkAllAsRead(c: Context<{ Bindings: Env }>) {
  const auth = requireOrgUser(c);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const count = await markAllAsRead(auth.organizationId, auth.userId);
  return c.json({ success: true, count });
}

export async function restDeleteNotification(c: Context<{ Bindings: Env }>) {
  const auth = requireOrgUser(c);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) {
    return c.json({ error: 'Invalid notification ID' }, 400);
  }
  const deleted = await deleteNotification(auth.organizationId, auth.userId, id);
  if (!deleted) {
    return c.json({ error: 'Not found' }, 404);
  }
  return c.json({ success: true });
}
