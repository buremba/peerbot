/**
 * Visibility and org-scope WHERE clause helpers:
 * buildOrgScopeWhere, buildConnectionVisibilityClause, buildExcludeWatcherClause.
 */

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
/**
 * The flag-gated `exclude_watcher_id` membership NOT EXISTS, returned WITHOUT a leading `AND`
 * so it can be pushed into a conditions array OR spliced after `AND`. The single source of
 * truth for ALL exclude_watcher_id reads (the search/list helper below + the score/superseded
 * inline paths in content-scoring.ts / get_content/query.ts) so the flag governs every
 * read_knowledge() path and phase 3 has ONE place to retire the JOIN.
 *
 * Windows-as-events (P6) phase 2: read membership from the event_edges mirror — a single-table
 * NOT EXISTS via the (child_event_id, watcher_id_hint) partial index — instead of the
 * watcher_window_events -> watcher_windows JOIN. event_edges is an accurate mirror (the trigger
 * syncs INSERT+DELETE; historic rows are backfilled), so the two are equivalent. FLAG-GATED for
 * a staged, A/B-validated cutover of this hot read. DEPLOY GATE: run
 * scripts/backfill-event-edges.sh to completion BEFORE setting the flag, else event_edges
 * misses historic links and wrongly includes them.
 *
 * @param contentIdExpr - SQL expression for the content event id (e.g. `f.id`, `e.id`)
 * @param paramN - the 1-based `$N` index already bound to the (validated) watcher id
 */
export function excludeWatcherNotExists(contentIdExpr: string, paramN: number): string {
  if (
    process.env.WATCHER_EXCLUDE_VIA_EVENT_EDGES === '1' ||
    process.env.WATCHER_EXCLUDE_VIA_EVENT_EDGES === 'true'
  ) {
    return `NOT EXISTS (
    SELECT 1 FROM event_edges exc_ee
    WHERE exc_ee.child_event_id = ${contentIdExpr}
      AND exc_ee.watcher_id_hint = $${paramN}::bigint
      AND exc_ee.edge_type = 'membership'
  )`;
  }
  return `NOT EXISTS (
    SELECT 1 FROM watcher_window_events exc_iwe
    JOIN watcher_windows exc_iw ON exc_iw.id = exc_iwe.window_id
    WHERE exc_iwe.event_id = ${contentIdExpr} AND exc_iw.watcher_id = $${paramN}::bigint
  )`;
}

export function buildExcludeWatcherClause(
  excludeWatcherId: number | undefined,
  baseParamIndex: number,
  tableAlias = 'f'
): { sql: string; params: unknown[] } {
  if (excludeWatcherId === undefined) return { sql: '', params: [] };
  const validated = validateNumericId(excludeWatcherId, 'exclude_watcher_id');
  return {
    sql: ` AND ${excludeWatcherNotExists(`${tableAlias}.id`, baseParamIndex)}`,
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
 * watcher-mode/condensation path that already select by other constraints).
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

  const orgParam = `$${options.baseParamIndex}::text`;
  const userParam = `$${options.baseParamIndex + 1}::text`;
  return {
    sql: `AND (${tableAlias}.connection_id IS NULL OR ${tableAlias}.connection_id IN (
      SELECT vc.id FROM connections vc
      WHERE vc.organization_id = ${orgParam}
        AND vc.deleted_at IS NULL
        AND (vc.visibility = 'org' OR (${userParam} IS NOT NULL AND vc.created_by = ${userParam}))
    ))`,
    params: [options.organizationId, options.userId ?? null],
  };
}
