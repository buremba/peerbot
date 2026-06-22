import { AsyncLocalStorage } from 'node:async_hooks';
import type { getDb } from '../../db/client';

interface OrgContext {
  organizationId: string;
}

export const orgContext = new AsyncLocalStorage<OrgContext>();

export function getOrgId(): string {
  const ctx = orgContext.getStore();
  if (!ctx)
    throw new Error('Organization context not available — wrap request with orgContext.run()');
  return ctx.organizationId;
}

export function tryGetOrgId(): string | null {
  return orgContext.getStore()?.organizationId ?? null;
}

/**
 * Resolve the org id from an explicit argument, falling back to the ambient
 * request context. Returns null when neither is available.
 *
 * Replaces the `organizationId ?? tryGetOrgId()` idiom: an explicit org always
 * wins (callers with their own scope, e.g. a worker token), otherwise the
 * AsyncLocalStorage context set by request middleware applies.
 */
export function resolveOrgId(explicit?: string | null): string | null {
  return explicit ?? tryGetOrgId();
}

/**
 * Like {@link resolveOrgId} but throws when no org can be resolved — for store
 * methods that cannot run unscoped. `caller` names the method in the error so a
 * missing-context bug points at its source (e.g. "GrantStore.grant requires
 * organizationId (explicit or via orgContext)").
 */
export function requireOrgId(explicit: string | null | undefined, caller: string): string {
  const orgId = resolveOrgId(explicit);
  if (!orgId) {
    throw new Error(`${caller} requires organizationId (explicit or via orgContext)`);
  }
  return orgId;
}

/**
 * Optional `organization_id` filter as a composable SQL fragment, so the
 * org-scoped and legacy (org-less) query variants share a single statement.
 * Returns an empty fragment when `orgId` is null/undefined.
 */
export function orgScope(sql: ReturnType<typeof getDb>, orgId: string | null | undefined) {
  return orgId ? sql`AND organization_id = ${orgId}` : sql``;
}
