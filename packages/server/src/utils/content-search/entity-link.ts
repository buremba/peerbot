/**
 * Entity-link SQL helpers: STANDARD_IDENTITY_NAMESPACES, entityLinkMatchSql,
 * EntityIdentityScope, fetchEntityIdentityScopes, buildEntityLinkUnion.
 */

import { type DbClient, pgTextArray } from '../../db/client';

/**
 * Standard identity namespaces (mirror of IDENTITY in @lobu/connector-sdk).
 * Kept local so content-search.ts doesn't take a build-time dep on the SDK.
 *
 * Adding a namespace here is a three-step change:
 *   1. Add the key to `IDENTITY` in @lobu/connector-sdk so connectors can reference it.
 *   2. Add a partial BTREE index `idx_events_metadata_<ns>` in a migration
 *      (see db/migrations/20260419120000_add_event_identity_indexes.sql).
 *   3. Add the string to this list — `entityLinkMatchSql` will emit a UNION
 *      branch that uses the new index.
 *
 * Non-standard namespaces are intentionally unsupported at read time: without
 * a matching index the identity branch seq-scans `events`, which blows up the
 * entire content query. If a connector needs a new namespace, add the index.
 */
export const STANDARD_IDENTITY_NAMESPACES = [
  'email',
  'phone',
  'wa_jid',
  'slack_user_id',
  'github_login',
  // Immutable id — read-time github attribution rides this so a reused login
  // (freed by a rename, reclaimed by another account) can't JOIN to the old
  // person. Backed by idx_events_metadata_github_user_id.
  'github_user_id',
  'auth_user_id',
  'google_contact_id',
] as const;

/**
 * SQL predicate: "event `<alias>` is linked to entity `<paramRef>`".
 *
 * Matches two ways:
 *   1. Legacy / feed-pinned attribution: entity id appears in `events.entity_ids`.
 *   2. Identity-graph attribution: a live `entity_identities` row claims an
 *      identifier that the event carries in `metadata->>namespace` (stamped
 *      there by `applyEntityLinks` at ingestion; see src/utils/entity-link-upsert.ts).
 *
 * Events are append-only, so (2) is how connector-driven auto-linking is
 * surfaced at read time — `entity_ids` is never mutated post-insert.
 *
 * Shape: `alias.id IN (UNION …)`. Each standard namespace gets its own UNION
 * branch with a literal `ei.namespace = '<ns>'` so Postgres can evaluate the
 * join against `entity_identities` first, then probe `events` via the
 * per-namespace partial BTREE index `idx_events_metadata_<ns>`. Writing this
 * as a top-level OR of EXISTS branches — or as a single identity branch with
 * `OR` across namespaces — forces Parallel Seq Scan on `events` because the
 * namespace becomes a join filter instead of a restrictable predicate.
 */
export function entityLinkMatchSql(paramRef: string, alias = 'f'): string {
  const directBranch = `SELECT e2.id FROM events e2 WHERE e2.entity_ids @> ARRAY[${paramRef}]`;

  const standardBranches = STANDARD_IDENTITY_NAMESPACES.map(
    (ns) => `SELECT e2.id FROM events e2
      JOIN entity_identities ei
        ON ei.entity_id = ${paramRef}
       AND ei.namespace = '${ns}'
       AND ei.deleted_at IS NULL
      WHERE e2.metadata ? '${ns}' AND e2.metadata->>'${ns}' = ei.identifier`
  );

  const branches = [directBranch, ...standardBranches].join('\n    UNION\n    ');
  return `${alias}.id IN (\n    ${branches}\n  )`;
}

/**
 * One identity claim for an entity — `(namespace, identifier)`.
 *
 * Used by `fetchEntityIdentityScopes` + `buildEntityLinkUnion` to skip the
 * UNION branches that would never match for this entity. On a 4.7GB events
 * table the empty-branches-still-cost-real-time issue is the difference
 * between 200ms and 1.2s on the candidate_set scan alone.
 */
export interface EntityIdentityScope {
  namespace: string;
  identifier: string;
}

/**
 * Pre-fetch the live `entity_identities` rows for one entity, restricted to
 * the namespaces we have backing indexes for (`STANDARD_IDENTITY_NAMESPACES`).
 *
 * Cheap: indexed scan via `idx_entity_identities_by_entity`. Typical entity
 * has 0-3 rows. Run once per request, not per query.
 */
export async function fetchEntityIdentityScopes(
  sql: DbClient,
  entityId: number
): Promise<EntityIdentityScope[]> {
  const rows = (await sql`
    SELECT namespace, identifier
    FROM entity_identities
    WHERE entity_id = ${entityId}
      AND deleted_at IS NULL
      AND namespace = ANY(${pgTextArray([...STANDARD_IDENTITY_NAMESPACES])}::text[])
  `) as Array<{ namespace: unknown; identifier: unknown }>;
  return rows.map((r) => ({
    namespace: String(r.namespace),
    identifier: String(r.identifier),
  }));
}

/**
 * Build the same `<alias>.id IN (UNION …)` predicate as `entityLinkMatchSql`,
 * but emit only the branches an entity actually needs.
 *
 * Differences from the legacy helper:
 *  - The direct `entity_ids @> ARRAY[N]` branch is always included.
 *  - One `metadata->>'<ns>' = $N` branch per pre-fetched scope (no JOIN to
 *    `entity_identities`; the identifier is bound as a parameter). For an
 *    entity with no identities, that's zero extra branches — Postgres only
 *    plans the direct scan.
 *  - Uses an inline `entityIdLiteral` (already validated as a numeric id) so
 *    the planner sees the actual id and picks the entity-specific GIN scan
 *    instead of building a generic plan.
 *
 * Identifier values are bound params (caller appends them to its params
 * array), defending against tampering even though `entity_identities` is
 * write-controlled.
 */
export function buildEntityLinkUnion(opts: {
  /** Already-validated entity id, will be inlined as `<id>::bigint`. */
  entityIdLiteral: number;
  scopes: EntityIdentityScope[];
  alias?: string;
  baseParamIndex: number;
}): { sql: string; params: string[] } {
  const alias = opts.alias ?? 'f';
  const direct = `SELECT e2.id FROM events e2 WHERE e2.entity_ids @> ARRAY[${opts.entityIdLiteral}::bigint]`;
  const params: string[] = [];
  let paramIndex = opts.baseParamIndex;

  // Skip namespaces we have no backing index for (e.g. anything outside
  // STANDARD_IDENTITY_NAMESPACES) — they'd seq-scan events. The fetch helper
  // already filters to the standard list, but we double-check here so a
  // future caller that builds scopes manually can't blow up the scan.
  const indexed = new Set<string>(STANDARD_IDENTITY_NAMESPACES);
  const scopeBranches: string[] = [];
  for (const scope of opts.scopes) {
    if (!indexed.has(scope.namespace)) continue;
    params.push(scope.identifier);
    scopeBranches.push(
      `SELECT e2.id FROM events e2 WHERE e2.metadata->>'${scope.namespace}' = $${paramIndex}`
    );
    paramIndex += 1;
  }

  const branches = [direct, ...scopeBranches].join('\n    UNION\n    ');
  return {
    sql: `${alias}.id IN (\n    ${branches}\n  )`,
    params,
  };
}
