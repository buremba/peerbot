/**
 * Visibility and org-scope WHERE clause helpers:
 * buildOrgScopeWhere, buildConnectionVisibilityClause, buildExcludeWatcherClause,
 * buildProducedByBehaviorClause.
 */

import { compileConnectionFkVisibility } from '../../authz/connection-visibility';
import { compileResourceVisibility } from '../../authz/resource-visibility';
import type { AuthzScope } from '../../authz/scope';
import { useLinkedOrgScope } from '../linked-org-ids';
import { validateNumericId } from '../sql-validation';

/**
 * Exclude content already in any window for a given watcher. The id is bound as
 * a query parameter; `validateNumericId` is the belt to that suspenders.
 *
 * Returns empty strings/arrays when no filter is applied.
 */
export function buildExcludeWatcherClause(
  excludeWatcherId: number | undefined,
  baseParamIndex: number
): { sql: string; params: unknown[] } {
  if (excludeWatcherId === undefined) return { sql: '', params: [] };
  const validated = validateNumericId(excludeWatcherId, 'exclude_watcher_id');
  return {
    sql: ` AND NOT EXISTS (
    SELECT 1 FROM watcher_window_events exc_iwe
    WHERE exc_iwe.event_id = f.id AND exc_iwe.watcher_id = $${baseParamIndex}::bigint
  )`,
    params: [validated],
  };
}

/**
 * Restrict to events a Behavior PRODUCED (`events.behavior_id`).
 *
 * All four `read_knowledge` builders must call it: a filter added to only some
 * is worse than one added to none, since the same scope would then return
 * different rows depending on whether a search term was typed.
 *
 * A column equality, NOT an EXISTS over `watcher_window_events` — that table
 * records what a Behavior READ. Backed by idx_events_behavior_produced.
 */
export function buildProducedByBehaviorClause(
  producedByBehaviorId: number | undefined,
  baseParamIndex: number
): { sql: string; params: unknown[] } {
  if (producedByBehaviorId === undefined) return { sql: '', params: [] };
  const validated = validateNumericId(producedByBehaviorId, 'produced_by_behavior_id');
  return {
    sql: ` AND f.behavior_id = $${baseParamIndex}::bigint`,
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
  // Denormalized bridge (events.linked_org_ids, write-once at INSERT): folds
  // the entity + connection branches into one GIN-indexed condition instead
  // of per-row OR/EXISTS subplans. Gated until the one-time backfill is done.
  if (useLinkedOrgScope()) {
    return {
      sql: `AND (f.organization_id = ${p} OR f.linked_org_ids @> ARRAY[${p}]::text[])`,
      params: [options.organization_id],
    };
  }
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
 * behavior-mode path that already select by other constraints).
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
