import type { Context } from 'hono';
import type { Env } from '../index';
import {
  deleteNotification,
  getUnreadCount,
  listNotifications,
  markAllAsRead,
  markAsRead,
} from './service';

function requireOrgUser(c: Context<{ Bindings: Env }>): {
  organizationId: string;
  userId: string;
} | null {
  const organizationId = c.var.organizationId;
  const userId = c.var.session?.userId ?? c.var.user?.id;
  if (!organizationId || !userId) return null;
  return { organizationId, userId };
}

export async function restListNotifications(c: Context<{ Bindings: Env }>) {
  const auth = requireOrgUser(c);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const cursorRaw = c.req.query('cursor') ? Number(c.req.query('cursor')) : null;
  const cursor = cursorRaw !== null && Number.isFinite(cursorRaw) ? cursorRaw : null;
  const limitRaw = c.req.query('limit') ? Number(c.req.query('limit')) : 20;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20;
  const unreadOnly = c.req.query('unread_only') === 'true';

  const result = await listNotifications({
    organizationId: auth.organizationId,
    userId: auth.userId,
    cursor,
    limit,
    unreadOnly,
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
