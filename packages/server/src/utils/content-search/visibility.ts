/**
 * Visibility and org-scope WHERE clause helpers:
 * buildOrgScopeWhere, buildConnectionVisibilityClause, buildExcludeWatcherClause.
 */

import { compileConnectionFkVisibility } from '../../authz/connection-visibility';
import { compileResourceVisibility } from '../../authz/resource-visibility';
import type { AuthzScope } from '../../authz/scope';
import { validateNumericId } from '../sql-validation';

/**
 * Build NOT EXISTS clause to exclude content already in any window for a given
 * watcher. The watcher id is both validated (integer check) and bound as a query
 * parameter — validation guards against obvious injection attempts and the
 * parameter binding is the real defense.
 *
 * @param excludeWatcherId - Watcher ID to exclude content for
 * @param baseParamIndex - Next 1-based `$N` index to allocate for bound params
 * @param tableAlias - Alias for the content table (default: 'f')
 * @returns `{ sql, params }` — empty strings/arrays when no filter is applied
 */
export function buildExcludeWatcherClause(
  excludeWatcherId: number | undefined,
  baseParamIndex: number,
  tableAlias = 'f'
): { sql: string; params: unknown[] } {
  if (excludeWatcherId === undefined) return { sql: '', params: [] };
  const validated = validateNumericId(excludeWatcherId, 'exclude_watcher_id');
  return {
    sql: ` AND NOT EXISTS (
    SELECT 1 FROM watcher_window_events exc_iwe
    JOIN watcher_windows exc_iw ON exc_iw.id = exc_iwe.window_id
    WHERE exc_iwe.event_id = ${tableAlias}.id AND exc_iw.watcher_id = $${baseParamIndex}::bigint
  )`,
    params: [validated],
  };
}

/**
 * Build an org/workspace-scoping WHERE clause using EXISTS (no JOIN needed).
 * Returns an empty string when no scoping is needed (e.g. entity_id is set).
 * Assumes the query has `f` aliasing events and `c` aliasing connections.
 *
 * An event is in scope when ANY of these hold:
 *  - the event itself was stamped to the caller's org (`f.organization_id`),
 *  - one of its `entity_ids` belongs to the caller's org, or
 *  - the connection that produced it belongs to the caller's org.
 *
 * The bridge clauses cover events ingested into another org but cross-linked
 * to entities/connections here. Stand-alone events with no entity links and
 * no connection are still findable via the direct `f.organization_id` match.
 */
export function buildOrgScopeWhere(options: {
  entity_id?: number;
  organization_id?: string;
  baseParamIndex: number;
}): { sql: string; params: Array<string | number | null> } {
  if (options.entity_id || !options.organization_id) return { sql: '', params: [] };

  const p = `$${options.baseParamIndex}::text`;
  const directCond = `f.organization_id = ${p}`;
  const entityCond = `EXISTS (SELECT 1 FROM entities ent_org WHERE ent_org.id = ANY(f.entity_ids) AND ent_org.organization_id = ${p})`;
  const connCond = `c.organization_id = ${p}`;
  return {
    sql: `AND (${directCond} OR ${entityCond} OR ${connCond})`,
    params: [options.organization_id],
  };
}

/**
 * Build a connection-visibility WHERE clause that lives inline alongside the
 * other content filters, so the list and count queries don't need a separate
 * "which connection ids may I see?" round trip.
 *
 * Semantics (must match `getContent`'s legacy two-step flow):
 *  - Authed user: connections with `visibility='org' OR created_by = $userId`.
 *  - Unauthed:    connections with `visibility='org'`.
 *  - Soft-deleted connections (`deleted_at IS NOT NULL`) are excluded.
 *  - Events with `connection_id IS NULL` (system / non-connection events)
 *    are visible in both authed and unauthed cases.
 *
 * Returns an empty fragment when no scope is requested (callers like the
 * watcher-mode path that already select by other constraints).
 *
 * Thin adapter over the one connection-visibility compiler (M1): builds an
 * {@link AuthzScope} from this seam's legacy `{ organizationId, userId }` shape
 * and defers the predicate to {@link compileConnectionFkVisibility}, so the rule
 * lives in exactly one place.
 */
export function buildConnectionVisibilityClause(
  options: {
    organizationId?: string;
    userId?: string | null;
    baseParamIndex: number;
  },
  tableAlias: string = 'f'
): { sql: string; params: Array<string | number | null> } {
  if (!options.organizationId) return { sql: '', params: [] };

  const scope: AuthzScope = {
    organizationId: options.organizationId,
    principal: options.userId ?? null,
  };
  // Compose the two read gates: per-connection visibility AND per-resource
  // membership (the latter only constrains ACL-enforced connections). Resource
  // visibility binds its own params AFTER the connection-visibility params, so a
  // single returned `{ sql, params }` keeps every caller's `$N` indexing intact.
  const conn = compileConnectionFkVisibility(scope, options.baseParamIndex, tableAlias);
  const resource = compileResourceVisibility(
    scope,
    options.baseParamIndex + conn.params.length,
    tableAlias,
  );
  return {
    sql: `${conn.sql} ${resource.sql}`,
    params: [...conn.params, ...resource.params],
  };
}
