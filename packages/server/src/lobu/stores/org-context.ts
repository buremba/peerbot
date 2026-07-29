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
 * `organization_id` filter as a composable SQL fragment.
 *
 * Fail-closed by construction: `orgId` is required. This used to accept
 * null/undefined and return an EMPTY fragment, which silently dropped the
 * tenant predicate — a cross-tenant read on every SELECT that used it, and a
 * cross-tenant wipe on `GrantStore.revoke`'s DELETE. Nothing signalled it: no
 * error, no log, just a query answering for every org at once.
 *
 * A caller that cannot produce an org must say so explicitly by resolving it
 * with {@link requireOrgId} (which throws and names the caller) rather than
 * passing a nullable through and inheriting an unscoped query.
 */
export function orgScope(sql: ReturnType<typeof getDb>, orgId: string) {
  return sql`AND organization_id = ${orgId}`;
}
