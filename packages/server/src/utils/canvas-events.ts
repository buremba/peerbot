/**
 * Canvas-on-events helpers.
 *
 * An automation "window" (canvas) is a supersede chain of `semantic_type='canvas_state'`
 * events. The chain ROOT (supersedes_event_id IS NULL) is the window identity —
 * its event id is the `window_id` everywhere. Human edits and materialized
 * corrections supersede the current head, copying the root's period metadata so
 * period queries hit any chain member consistently.
 *
 * Identity: a lazy per-automation "canvas" entity claimed via `entity_identities`
 * (namespace `automation_canvas`, identifier = `<automationId>`), anchoring the chain
 * via `entity_ids`. The partial unique index `idx_entity_identities_live_unique_scoped`
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
import { CANVAS_ENTITY_TYPE_SLUG } from '../tools/constants';
import { hardDeleteEntityRows, tryInsertEntityRow } from './entity-management';
import { resolveEntityCreator } from './resolve-entity-creator';

/** Namespace for the per-automation canvas identity claim in `entity_identities`. */
export const AUTOMATION_CANVAS_NAMESPACE = 'automation_canvas';

/** Metadata keys copied onto every chain member so period queries are consistent. */
export interface CanvasPeriodMeta {
  automation_id: number;
  granularity: string;
  window_start: string;
  window_end: string;
}

/**
 * Ensure the lazy per-automation canvas entity exists and return its id. Idempotent
 * and multi-replica-safe via the `automation_canvas` live-unique identity claim:
 * the reuse fast-path resolves an existing claim; the create path tolerates a
 * concurrent claim (ON CONFLICT DO NOTHING) and resolves the winner.
 *
 * The canvas entity is a child of the automation's bound entity (`parentEntityId`)
 * when present, else a root entity. It binds to the built-in `$canvas` entity
 * type, created on demand for the org (entity_type_id is NOT NULL). Runs on the
 * caller's transaction handle so the entity + identity writes commit atomically
 * with the canvas event.
 */
export async function ensureCanvasEntity(params: {
  tx: DbClient;
  automationId: number;
  organizationId: string;
  parentEntityId: number | null;
  createdBy: string | null | undefined;
}): Promise<number | null> {
  const { tx, automationId, organizationId, parentEntityId } = params;
  const identifier = String(automationId);

  // 1. Existing claim → reuse (idempotent fast path).
  const existing = await tx<{ entity_id: number | string }>`
    SELECT ei.entity_id
    FROM entity_identities ei
    JOIN entities e ON e.id = ei.entity_id
    WHERE ei.organization_id = ${organizationId}
      AND ei.namespace = ${AUTOMATION_CANVAS_NAMESPACE}
      AND ei.identifier = ${identifier}
      AND ei.deleted_at IS NULL
      AND e.deleted_at IS NULL
    LIMIT 1
  `;
  if (existing.length > 0) return Number(existing[0].entity_id);

  const createdBy = await resolveEntityCreator(tx, organizationId, params.createdBy);
  if (!createdBy) {
    // entities.created_by is NOT NULL; without an attributable member we cannot
    // create the canvas entity. The canvas event still gets written (unanchored).
    return null;
  }

  // Resolve the entity type to bind to (entities.entity_type_id is NOT NULL).
  // The old fallback used any stored org type when no user-authored `canvas`
  // type existed. That was commonly `$member`, exposing canvases through the
  // member roster and its privacy policy. Create a dedicated system type.
  const typeRows = await tx<{ id: number | string }>`
    INSERT INTO entity_types (
      slug, name, description, icon, organization_id, created_at, updated_at
    )
    VALUES (
      ${CANVAS_ENTITY_TYPE_SLUG}, 'Canvas', 'Per-Automation canvas window', 'layout',
      ${organizationId}, current_timestamp, current_timestamp
    )
    ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
    DO UPDATE SET updated_at = entity_types.updated_at
    RETURNING id
  `;
  if (typeRows.length === 0) return null;
  const entityTypeId = Number(typeRows[0].id);

  // 2. Create the entity (sequence-allocated id — multi-replica safe). Slug is
  //    unique per (org, parent); a collision here is astronomically unlikely
  //    (one canvas per automation) but tolerate it by suffixing the automation id.
  const baseSlug = `automation-canvas-${automationId}`;
  const inserted = await tryInsertEntityRow({
    tx,
    row: {
      organizationId,
      entityTypeId,
      name: `Canvas · automation ${automationId}`,
      slug: baseSlug,
      parentId: parentEntityId,
      metadata: { automation_id: automationId, source: 'automation_canvas' },
      createdBy,
    },
  });

  let entityId: number | null = inserted?.id ?? null;
  if (entityId == null) {
    // Slug collision (pre-existing canvas entity for this automation). Resolve it.
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
      ${organizationId}, ${entityId}, ${AUTOMATION_CANVAS_NAMESPACE}, ${identifier}, 'automation'
    )
    ON CONFLICT (organization_id, namespace, identifier, COALESCE(scope_connection_id, 0)) WHERE deleted_at IS NULL
    DO NOTHING
    RETURNING entity_id
  `;
  if (claimed.length > 0) return entityId;

  const winner = await tx<{ entity_id: number | string }>`
    SELECT entity_id
    FROM entity_identities
    WHERE organization_id = ${organizationId}
      AND namespace = ${AUTOMATION_CANVAS_NAMESPACE}
      AND identifier = ${identifier}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (winner.length > 0 && inserted) {
    // Safe: our entity is brand-new in THIS transaction (no identity, children,
    // events, or relationships) — its only blocking FK is parent_id RESTRICT,
    // which can't fire on a freshly-created leaf.
    await hardDeleteEntityRows({ tx, ids: [entityId] });
  }
  return winner.length > 0 ? Number(winner[0].entity_id) : entityId;
}

/**
 * Look up the current chain HEAD (event with no superseder) for a canvas period.
 * Keys on the denormalized `superseded_by IS NULL` stamp (same-tx dual-write
 * since 20260702200000, fully backfilled by 20260702300000); returns null when
 * no chain exists yet (pre-backfill window).
 */
export async function findCanvasHead(
  tx: DbClient,
  period: { automationId: number; granularity: string; windowStart: string }
): Promise<{
  id: number;
  rootEventId: number;
  payloadData: Record<string, unknown>;
  /** Who wrote the current head. Lets a caller tell "I am replaying my own
   * completion" from "another client already answered this window", which are
   * otherwise indistinguishable — both just skip the write. */
  clientId: string | null;
  runId: number | null;
} | null> {
  const rows = await tx<{
    id: number | string;
    root_event_id: number | string | null;
    payload_data: unknown;
    client_id: string | null;
    run_id: number | string | null;
  }>`
    SELECT e.id, (e.metadata->>'root_event_id')::bigint AS root_event_id, e.payload_data,
           e.client_id, e.run_id
    FROM events e
    WHERE e.semantic_type = 'canvas_state'
      AND e.automation_id = ${period.automationId}
      AND (e.metadata->>'granularity') = ${period.granularity}
      AND (e.metadata->>'window_start')::timestamptz = ${period.windowStart}
      AND e.superseded_by IS NULL
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const id = Number(rows[0].id);
  const rootEventId = rows[0].root_event_id != null ? Number(rows[0].root_event_id) : id;
  const payloadData =
    rows[0].payload_data && typeof rows[0].payload_data === 'object'
      ? (rows[0].payload_data as Record<string, unknown>)
      : {};
  return {
    id,
    rootEventId,
    payloadData,
    clientId: rows[0].client_id ?? null,
    runId: rows[0].run_id != null ? Number(rows[0].run_id) : null,
  };
}
