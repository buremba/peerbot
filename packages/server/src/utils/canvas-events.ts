/**
 * Canvas-on-events helpers.
 *
 * A watcher "window" (canvas) is a supersede chain of `semantic_type='canvas_state'`
 * events. The chain ROOT (supersedes_event_id IS NULL) is the window identity —
 * its event id is the `window_id` everywhere. Human edits and materialized
 * corrections supersede the current head, copying the root's period metadata so
 * period queries hit any chain member consistently.
 *
 * Identity: a lazy per-watcher "canvas" entity claimed via `entity_identities`
 * (namespace `watcher_canvas`, identifier = `<watcherId>`), anchoring the chain
 * via `entity_ids`. The partial unique index `idx_entity_identities_live_unique`
 * (org, namespace, identifier WHERE deleted_at IS NULL) is the multi-replica lock.
 *
 * Invariants (enforced by DB indexes, not in-memory state):
 *   - One root per period: `idx_canvas_chain_root` (unique, partial) → 23505 on
 *     a concurrent second root, which callers map to a 409.
 *   - One superseder per event: `idx_events_superseded_by` (unique, partial) →
 *     23505 on a concurrent supersede of the same head, mapped to a 409.
 *   - Head = chain member with no superseder (NOT EXISTS anti-join; derived).
 *
 * `fetch_types: false`: never bind a raw JS array — the only array here is
 * entity_ids, formatted as a `{n}` literal cast to bigint[] exactly like
 * insert-event.ts does.
 */

import type { DbClient } from '../db/client';

/** Namespace for the per-watcher canvas identity claim in `entity_identities`. */
export const WATCHER_CANVAS_NAMESPACE = 'watcher_canvas';

/** Metadata keys copied onto every chain member so period queries are consistent. */
export interface CanvasPeriodMeta {
  watcher_id: number;
  granularity: string;
  window_start: string;
  window_end: string;
}

/**
 * Resolve a live `user(id)` to attribute the canvas entity to. Prefers the
 * caller-supplied id (the watcher's creator — already a live user); otherwise
 * falls back to an org owner/admin. Returns null when the org has no member.
 * Mirrors promote-keyed-entities' resolveCreator.
 */
async function resolveCanvasCreator(
  tx: DbClient,
  organizationId: string,
  createdBy: string | null | undefined
): Promise<string | null> {
  if (createdBy && createdBy.trim().length > 0) return createdBy;
  const rows = await tx<{ userId: string }>`
    SELECT "userId"
    FROM "member"
    WHERE "organizationId" = ${organizationId}
    ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
             "createdAt" ASC
    LIMIT 1
  `;
  return rows.length > 0 ? rows[0].userId : null;
}

/**
 * Ensure the lazy per-watcher canvas entity exists and return its id. Idempotent
 * and multi-replica-safe via the `watcher_canvas` live-unique identity claim:
 * the reuse fast-path resolves an existing claim; the create path tolerates a
 * concurrent claim (ON CONFLICT DO NOTHING) and resolves the winner.
 *
 * The canvas entity is a child of the watcher's bound entity (`parentEntityId`)
 * when present, else a root entity. It uses the same `canvas` entity type as
 * other lazily-created system entities would; it falls back to no type binding
 * only if no `canvas` type is registered (entity_type_id is NOT NULL, so we pick
 * a sensible default). Runs on the caller's transaction handle so the entity +
 * identity writes commit atomically with the canvas event.
 */
export async function ensureCanvasEntity(params: {
  tx: DbClient;
  watcherId: number;
  organizationId: string;
  parentEntityId: number | null;
  createdBy: string | null | undefined;
}): Promise<number | null> {
  const { tx, watcherId, organizationId, parentEntityId } = params;
  const identifier = String(watcherId);

  // 1. Existing claim → reuse (idempotent fast path).
  const existing = await tx<{ entity_id: number | string }>`
    SELECT ei.entity_id
    FROM entity_identities ei
    JOIN entities e ON e.id = ei.entity_id
    WHERE ei.organization_id = ${organizationId}
      AND ei.namespace = ${WATCHER_CANVAS_NAMESPACE}
      AND ei.identifier = ${identifier}
      AND ei.deleted_at IS NULL
      AND e.deleted_at IS NULL
    LIMIT 1
  `;
  if (existing.length > 0) return Number(existing[0].entity_id);

  const createdBy = await resolveCanvasCreator(tx, organizationId, params.createdBy);
  if (!createdBy) {
    // entities.created_by is NOT NULL; without an attributable member we cannot
    // create the canvas entity. The canvas event still gets written (unanchored).
    return null;
  }

  // Resolve an entity type to bind to (entities.entity_type_id is NOT NULL).
  // Prefer a `canvas` type (org-first, then public via organization.visibility,
  // skipping view-backed derived types — same precedence as createEntity);
  // otherwise fall back to any stored type in the org so the canvas entity can
  // still be created and anchor the chain.
  const typeRows = await tx<{ id: number | string; backing_sql: string | null }>`
    SELECT et.id, et.backing_sql
    FROM entity_types et
    LEFT JOIN organization o ON o.id = et.organization_id
    WHERE et.slug = 'canvas'
      AND et.deleted_at IS NULL
      AND (et.organization_id = ${organizationId} OR o.visibility = 'public')
    ORDER BY (et.organization_id = ${organizationId}) DESC, et.id ASC
    LIMIT 1
  `;
  let entityTypeId: number | null =
    typeRows.length > 0 && !typeRows[0].backing_sql ? Number(typeRows[0].id) : null;
  if (entityTypeId == null) {
    const anyType = await tx<{ id: number | string }>`
      SELECT et.id
      FROM entity_types et
      WHERE et.organization_id = ${organizationId}
        AND et.deleted_at IS NULL
        AND et.backing_sql IS NULL
      ORDER BY et.id ASC
      LIMIT 1
    `;
    if (anyType.length === 0) return null;
    entityTypeId = Number(anyType[0].id);
  }

  // 2. Create the entity (sequence-allocated id — multi-replica safe). Slug is
  //    unique per (org, parent); a collision here is astronomically unlikely
  //    (one canvas per watcher) but tolerate it by suffixing the watcher id.
  const baseSlug = `watcher-canvas-${watcherId}`;
  const inserted = await tx<{ id: number | string }>`
    INSERT INTO entities (
      organization_id, entity_type_id, name, slug, parent_id, metadata,
      created_by, created_at, updated_at
    ) VALUES (
      ${organizationId}, ${entityTypeId}, ${`Canvas · watcher ${watcherId}`}, ${baseSlug},
      ${parentEntityId}, ${tx.json({ watcher_id: watcherId, source: 'watcher_canvas' })},
      ${createdBy}, current_timestamp, current_timestamp
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;

  let entityId: number | null = inserted.length > 0 ? Number(inserted[0].id) : null;
  if (entityId == null) {
    // Slug collision (pre-existing canvas entity for this watcher). Resolve it.
    const bySlug = await tx<{ id: number | string }>`
      SELECT id FROM entities
      WHERE organization_id = ${organizationId}
        AND COALESCE(parent_id, 0) = COALESCE(${parentEntityId}::bigint, 0)
        AND slug = ${baseSlug}
      LIMIT 1
    `;
    if (bySlug.length === 0) return null;
    entityId = Number(bySlug[0].id);
  }

  // 3. Claim the identity. ON CONFLICT DO NOTHING against the live-unique index:
  //    if a concurrent completion already claimed it, resolve the winner and
  //    (if we created a fresh entity) drop ours so it doesn't linger orphaned.
  const claimed = await tx<{ entity_id: number | string }>`
    INSERT INTO entity_identities (
      organization_id, entity_id, namespace, identifier, source_connector
    ) VALUES (
      ${organizationId}, ${entityId}, ${WATCHER_CANVAS_NAMESPACE}, ${identifier}, 'watcher'
    )
    ON CONFLICT (organization_id, namespace, identifier) WHERE deleted_at IS NULL
    DO NOTHING
    RETURNING entity_id
  `;
  if (claimed.length > 0) return entityId;

  const winner = await tx<{ entity_id: number | string }>`
    SELECT entity_id
    FROM entity_identities
    WHERE organization_id = ${organizationId}
      AND namespace = ${WATCHER_CANVAS_NAMESPACE}
      AND identifier = ${identifier}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (winner.length > 0 && inserted.length > 0) {
    // Safe: our entity is brand-new in THIS transaction (no identity, children,
    // events, or relationships) — its only blocking FK is parent_id RESTRICT,
    // which can't fire on a freshly-created leaf.
    await tx`DELETE FROM entities WHERE id = ${entityId}`;
  }
  return winner.length > 0 ? Number(winner[0].entity_id) : entityId;
}

/**
 * Look up the current chain HEAD (event with no superseder) for a canvas period.
 * Uses the NOT-EXISTS anti-join over the listing index; returns null when no
 * chain exists yet (pre-backfill window).
 */
export async function findCanvasHead(
  tx: DbClient,
  period: { watcherId: number; granularity: string; windowStart: string }
): Promise<{ id: number; rootEventId: number; payloadData: Record<string, unknown> } | null> {
  const rows = await tx<{ id: number | string; root_event_id: number | string | null; payload_data: unknown }>`
    SELECT e.id, (e.metadata->>'root_event_id')::bigint AS root_event_id, e.payload_data
    FROM events e
    WHERE e.semantic_type = 'canvas_state'
      AND (e.metadata->>'watcher_id')::bigint = ${period.watcherId}
      AND (e.metadata->>'granularity') = ${period.granularity}
      AND (e.metadata->>'window_start')::timestamptz = ${period.windowStart}
      AND NOT EXISTS (SELECT 1 FROM events n WHERE n.supersedes_event_id = e.id)
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const id = Number(rows[0].id);
  const rootEventId = rows[0].root_event_id != null ? Number(rows[0].root_event_id) : id;
  const payloadData =
    rows[0].payload_data && typeof rows[0].payload_data === 'object'
      ? (rows[0].payload_data as Record<string, unknown>)
      : {};
  return { id, rootEventId, payloadData };
}
