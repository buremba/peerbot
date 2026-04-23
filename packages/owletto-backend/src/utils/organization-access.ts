/**
 * Organization Access Utilities
 *
 * Provides helpers for organization-scoped database queries with
 * public/private organization support.
 *
 * Access Rules:
 * - Public orgs: Anyone can READ, only members can WRITE
 * - Private orgs: Members only for READ and WRITE
 */

import { type DbClient, getDb } from '../db/client';
import type { ToolContext } from '../tools/registry';

/**
 * Get the user's role in a workspace (organization).
 * Returns null if the user is not a member.
 */
export async function getWorkspaceRole(
  sql: DbClient,
  orgId: string,
  userId: string
): Promise<string | null> {
  const result = await sql`
    SELECT role FROM "member"
    WHERE "organizationId" = ${orgId} AND "userId" = ${userId}
    LIMIT 1
  `;
  return result.length > 0 ? (result[0].role as string) : null;
}

/**
 * Check if user can read an entity
 * Allowed if entity belongs to the user's organization and user is a member.
 */
async function canReadEntity(sql: DbClient, entityId: number, ctx: ToolContext): Promise<boolean> {
  const entityResult = await getDb()`
    SELECT e.organization_id
    FROM entities e
    WHERE e.id = ${entityId}
    LIMIT 1
  `;
  if (entityResult.length === 0) return false;

  const entityOrgId = String(entityResult[0].organization_id);
  if (entityOrgId !== ctx.organizationId) return false;
  if (!ctx.userId) return true;

  const orgRole = await getWorkspaceRole(sql, entityOrgId, ctx.userId);
  return orgRole !== null;
}

/**
 * Check if user can write to an entity (must own it)
 * Only allowed if entity is in user's own organization
 */
async function canWriteEntity(sql: DbClient, entityId: number, ctx: ToolContext): Promise<boolean> {
  const entityRows = await getDb()`
    SELECT organization_id
    FROM entities
    WHERE id = ${entityId}
    LIMIT 1
  `;
  if (entityRows.length === 0) return false;

  const entityOrgId = String(entityRows[0].organization_id);
  if (entityOrgId !== ctx.organizationId) return false;

  // System/internal calls (e.g. reaction scripts) — org match is sufficient
  if (!ctx.userId && ctx.isAuthenticated) return true;
  if (!ctx.userId) return false;

  const membership = await sql`
    SELECT 1
    FROM "member"
    WHERE "organizationId" = ${ctx.organizationId}
      AND "userId" = ${ctx.userId}
      AND role IN ('owner', 'admin')
    LIMIT 1
  `;
  return membership.length > 0;
}

/**
 * Require read access or throw
 */
export async function requireReadAccess(
  sql: DbClient,
  entityId: number,
  ctx: ToolContext
): Promise<void> {
  const canRead = await canReadEntity(sql, entityId, ctx);
  if (!canRead) {
    throw new Error(`Access denied: entity ${entityId} is not accessible to your organization`);
  }
}

/**
 * Require write access or throw
 */
export async function requireWriteAccess(
  sql: DbClient,
  entityId: number,
  ctx: ToolContext
): Promise<void> {
  const canWrite = await canWriteEntity(sql, entityId, ctx);
  if (!canWrite) {
    throw new Error(`Access denied: entity ${entityId} does not belong to your organization`);
  }
}
