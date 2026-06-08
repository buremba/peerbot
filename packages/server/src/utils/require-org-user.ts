import type { Context } from 'hono';
import type { Env } from '../index';

/**
 * Extract `(organizationId, userId)` from a context that has already passed
 * `mcpAuth`. Returns null when either is absent, causing the caller to respond
 * 401.
 */
export function requireOrgUser(
  c: Context<{ Bindings: Env }>
): { organizationId: string; userId: string } | null {
  const organizationId = c.var.organizationId;
  const userId = c.var.session?.userId ?? c.var.user?.id;
  if (!organizationId || !userId) return null;
  return { organizationId, userId };
}
