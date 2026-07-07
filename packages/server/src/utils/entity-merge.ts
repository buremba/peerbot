/**
 * Entity merge — fold a duplicate `loser` entity into the `winner` it really is.
 *
 * The world-model keystone: when a bridge event (or a reviewer/watcher) reveals
 * two entities are the same real thing, this fuses them WITHOUT rewriting the
 * append-only `events` table. It runs off the ingest hot path — a user-configured
 * watcher's agent, or an admin, calls it via the `manage_entity_merge` tool; the
 * resolver only ever LOGS a "merge candidate", never fuses inline.
 *
 * Two disjoint event populations recall the winner afterward:
 *   1. Identity/metadata-attributed events (connector-ingested): repaired HERE —
 *      the loser's identities move to the winner, so the existing identity-graph
 *      recall (entity_identities → events.metadata) finds them for free.
 *   2. Raw `events.entity_ids`-stamped events (save_content memories, feed-pinned,
 *      webhooks): can't be rewritten (append-only), so the loser stays as a
 *      tombstone carrying `merged_into = winner`, and the recall redirect in
 *      content-search/entity-link.ts gathers `{winner} ∪ {losers}` for the
 *      `entity_ids @>` branch.
 *
 * Reversible from live data, no audit table: every identity moved loser→winner is
 * stamped `merged_from_entity_id = loser`, so an un-merge is "move back everything
 * marked with this loser, clear the pointer, un-tombstone".
 */

import { type DbClient, getDb } from '../db/client';
import logger from './logger';

export interface ApplyMergeParams {
  orgId: string;
  /** The duplicate that gets tombstoned + forwarded. */
  loserId: number;
  /** The surviving entity that absorbs the loser. */
  winnerId: number;
  /** Who triggered the merge (agent id / user id) — for the tombstone audit. */
  mergedBy: string;
}

export interface ApplyMergeResult {
  movedIdentities: number;
  tombstonedIdentities: number;
  repointedEdges: number;
}

/**
 * Fuse `loser` into `winner` in one transaction. Idempotent-safe on re-run: a
 * loser already merged into this winner returns a zero result rather than
 * throwing. Throws on a cross-entity-type or already-merged-elsewhere conflict so
 * the caller (tool) surfaces it rather than silently corrupting the graph.
 */
export async function applyMerge(
  params: ApplyMergeParams,
  db: DbClient = getDb(),
): Promise<ApplyMergeResult> {
  const { orgId, loserId, winnerId, mergedBy } = params;
  if (loserId === winnerId) {
    throw new Error('applyMerge: loser and winner are the same entity');
  }

  return db.begin(async (tx) => {
    // Lock both rows in a stable order (lowest id first) to avoid deadlocks when
    // two merges touch the overlapping pair concurrently.
    const [a, b] = loserId < winnerId ? [loserId, winnerId] : [winnerId, loserId];
    const locked = (await tx<{ id: number; merged_into: number | null; deleted_at: string | null }>`
      SELECT id, merged_into, deleted_at
      FROM entities
      WHERE organization_id = ${orgId} AND id IN (${a}, ${b})
      FOR UPDATE
    `) as Array<{ id: number; merged_into: number | null; deleted_at: string | null }>;

    const loser = locked.find((r) => Number(r.id) === loserId);
    const winner = locked.find((r) => Number(r.id) === winnerId);
    if (!loser || !winner) {
      throw new Error(`applyMerge: entity not found in org (loser=${loserId} winner=${winnerId})`);
    }
    // Already fused this exact way — no-op (safe re-run).
    if (Number(loser.merged_into) === winnerId) {
      return { movedIdentities: 0, tombstonedIdentities: 0, repointedEdges: 0 };
    }
    if (loser.merged_into !== null) {
      throw new Error(`applyMerge: loser ${loserId} already merged into ${loser.merged_into}`);
    }
    if (winner.merged_into !== null) {
      throw new Error(`applyMerge: winner ${winnerId} is itself merged into ${winner.merged_into}`);
    }
    if (winner.deleted_at !== null) {
      throw new Error(`applyMerge: winner ${winnerId} is deleted`);
    }

    // 1. Tombstone the loser's identities that COLLIDE with one the winner
    //    already owns (the global unique index forbids two live rows for the
    //    same (org, namespace, identifier)). These stay physically present,
    //    marked, so an un-merge can restore them.
    const tombstoned = (await tx<{ id: number }>`
      UPDATE entity_identities li
      SET deleted_at = current_timestamp,
          merged_from_entity_id = ${loserId},
          updated_at = current_timestamp
      WHERE li.organization_id = ${orgId}
        AND li.entity_id = ${loserId}
        AND li.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM entity_identities wi
          WHERE wi.organization_id = ${orgId}
            AND wi.entity_id = ${winnerId}
            AND wi.namespace = li.namespace
            AND wi.identifier = li.identifier
            AND wi.deleted_at IS NULL
        )
      RETURNING li.id
    `) as Array<{ id: number }>;

    // 2. Move the loser's remaining (non-colliding) live identities to the
    //    winner, marked with their origin for reversibility.
    const moved = (await tx<{ id: number }>`
      UPDATE entity_identities
      SET entity_id = ${winnerId},
          merged_from_entity_id = ${loserId},
          updated_at = current_timestamp
      WHERE organization_id = ${orgId}
        AND entity_id = ${loserId}
        AND deleted_at IS NULL
      RETURNING id
    `) as Array<{ id: number }>;

    // 3. Union the loser's metadata.aliases into the winner's, so the metric
    //    compiler (which resolves against metadata->'aliases') attributes the
    //    loser's contact values to the winner.
    await tx`
      UPDATE entities w
      SET metadata = jsonb_set(
            COALESCE(w.metadata, '{}'::jsonb),
            '{aliases}',
            (
              SELECT to_jsonb(array_agg(DISTINCT a))
              FROM (
                SELECT jsonb_array_elements_text(COALESCE(w.metadata->'aliases', '[]'::jsonb)) AS a
                UNION
                SELECT jsonb_array_elements_text(COALESCE(l.metadata->'aliases', '[]'::jsonb)) AS a
                FROM entities l
                WHERE l.id = ${loserId} AND l.organization_id = ${orgId}
              ) u
              WHERE a IS NOT NULL
            )
          ),
          updated_at = current_timestamp
      FROM entities l
      WHERE w.id = ${winnerId} AND w.organization_id = ${orgId}
        AND l.id = ${loserId}
        AND COALESCE(l.metadata->'aliases', '[]'::jsonb) <> '[]'::jsonb
    `;

    // 4. Re-point relationship edges loser→winner, then drop self-loops and any
    //    duplicate edge the winner already had (same type + other endpoint).
    const repointed = (await tx<{ id: number }>`
      UPDATE entity_relationships
      SET from_entity_id = CASE WHEN from_entity_id = ${loserId} THEN ${winnerId} ELSE from_entity_id END,
          to_entity_id   = CASE WHEN to_entity_id   = ${loserId} THEN ${winnerId} ELSE to_entity_id   END,
          updated_at = current_timestamp
      WHERE organization_id = ${orgId}
        AND deleted_at IS NULL
        AND (from_entity_id = ${loserId} OR to_entity_id = ${loserId})
      RETURNING id
    `) as Array<{ id: number }>;
    // Tombstone self-loops and duplicate edges created by the re-point.
    await tx`
      UPDATE entity_relationships r
      SET deleted_at = current_timestamp, updated_at = current_timestamp
      WHERE r.organization_id = ${orgId}
        AND r.deleted_at IS NULL
        AND (
          r.from_entity_id = r.to_entity_id
          OR EXISTS (
            SELECT 1 FROM entity_relationships o
            WHERE o.organization_id = ${orgId}
              AND o.deleted_at IS NULL
              AND o.id < r.id
              AND o.relationship_type_id = r.relationship_type_id
              AND o.from_entity_id = r.from_entity_id
              AND o.to_entity_id = r.to_entity_id
          )
        )
    `;

    // 5. Flatten: anything that already pointed at the loser now points at the
    //    winner, so every redirect stays exactly one hop (no chain walk at read).
    await tx`
      UPDATE entities
      SET merged_into = ${winnerId}, updated_at = current_timestamp
      WHERE organization_id = ${orgId} AND merged_into = ${loserId}
    `;

    // 6. Tombstone the loser and point it at the winner.
    await tx`
      UPDATE entities
      SET merged_into = ${winnerId}, deleted_at = current_timestamp, updated_at = current_timestamp
      WHERE organization_id = ${orgId} AND id = ${loserId}
    `;

    logger.info(
      {
        orgId,
        loserId,
        winnerId,
        mergedBy,
        movedIdentities: moved.length,
        tombstonedIdentities: tombstoned.length,
        repointedEdges: repointed.length,
      },
      'entity merge applied',
    );

    return {
      movedIdentities: moved.length,
      tombstonedIdentities: tombstoned.length,
      repointedEdges: repointed.length,
    };
  });
}
