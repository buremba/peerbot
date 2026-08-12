import type { DbClient } from '../db/client';

interface BehaviorConnectionVisibilityContext {
  organizationId: string;
  userId: string | null;
  actingWatcherId?: number | null;
}

/**
 * Resolve the user identity used only for connection row visibility.
 *
 * Behavior reactions are headless, so their execution context intentionally has
 * no user principal. They may still use private connections owned by their
 * durable creator. Policy, provenance, and approval checks continue to use the
 * autonomous Behavior principal; this resolver only supplies the principal for
 * connection visibility predicates.
 */
export async function resolveBehaviorConnectionVisibilityUserId(
  ctx: BehaviorConnectionVisibilityContext,
  sql: DbClient
): Promise<string | null> {
  if (ctx.userId !== null || ctx.actingWatcherId == null) {
    return ctx.userId;
  }

  const rows = await sql<{ created_by: string }>`
    SELECT created_by
    FROM watchers
    WHERE id = ${ctx.actingWatcherId}
      AND organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
  return rows[0]?.created_by ?? null;
}
