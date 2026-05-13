/**
 * Multi-tenant auth TTL caches, isolated in a leaf module.
 *
 * Hoisted out of `multi-tenant.ts` so test cleanup (`cleanupTestDatabase`)
 * can clear them without statically importing `multi-tenant.ts` — that file
 * loads the entire auth stack (better-auth, OAuth provider, tool-access
 * registry, etc.) and transitively pulls in `@lobu/connector-sdk`. Tests
 * that don't have the workspace `dist/` built (gateway-only `bun:test`
 * suites) need to clear caches without paying that import cost.
 */

import { TtlCache } from '../utils/ttl-cache';
import type { ResolvedOwner } from './types';

// Caches – module-level singletons (survive across requests).
export const orgSlugCache = new TtlCache<{ id: string; visibility: string }>(60_000); // 60s
export const memberRoleCache = new TtlCache<string | null>(60_000); // 60s
export const ownerCache = new TtlCache<ResolvedOwner | null>(300_000); // 5min
export const sessionCache = new TtlCache<{ user: any; session: any } | null>(30_000); // 30s

/**
 * Test-only: clear all multi-tenant auth caches so a freshly-reset database
 * (new org/user/token IDs) is not shadowed by TTL'd entries from the previous
 * run. Referenced from cleanupTestDatabase().
 */
export function clearMultiTenantCachesForTests(): void {
  orgSlugCache.clear();
  memberRoleCache.clear();
  ownerCache.clear();
  sessionCache.clear();
}
