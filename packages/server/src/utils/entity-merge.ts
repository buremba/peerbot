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
 * stamped `merged_from_entity_id = loser` — but only if it doesn't ALREADY carry a
 * marker (COALESCE), so the INNERMOST origin survives an outer merge. So an
 * un-merge is "move back everything still marked with this loser, clear the marker,
 * un-tombstone". Chains ARE flattened (L→W→V stored as L→V, W→V) to keep the read
 * redirect a single indexed hop; COALESCE'd identity markers keep each loser
 * independently reversible even so.
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
      return { movedIdentities: 0, repointedEdges: 0 };
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

    // 1. Move the loser's LIVE identities to the winner. A live loser↔live winner
    //    collision on the SAME (org, namespace, identifier) is impossible — the
    //    global unique index `idx_entity_identities_live_unique` forbids two live
    //    rows for one value org-wide — so the move can never hit the index. Stamp
    //    origin with COALESCE so an identity that already carries a marker (moved
    //    here by an EARLIER merge, e.g. L→W then W→V) keeps its INNERMOST origin —
    //    that's what makes `unmerge(L)` restore L's own identities post-flatten.
    const moved = (await tx<{ id: number }>`
      UPDATE entity_identities
      SET entity_id = ${winnerId},
          merged_from_entity_id = COALESCE(merged_from_entity_id, ${loserId}),
          updated_at = current_timestamp
      WHERE organization_id = ${orgId}
        AND entity_id = ${loserId}
        AND deleted_at IS NULL
      RETURNING id
    `) as Array<{ id: number }>;

    // 2. Union the loser's metadata.aliases into the winner's, so the metric
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

    // 3. Re-point relationship edges loser→winner, then drop self-loops and any
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

    // 4. Flatten: anything that already pointed at the loser now points at the
    //    winner, so every redirect stays exactly one hop (no chain walk at read).
    //    The read redirect (`entity_ids && ARRAY(… merged_into = X …)`) is a
    //    one-time indexed lookup even when X is an outer column, which a recursive
    //    chain walk would NOT be on list/count/order call sites. The identities'
    //    COALESCE'd `merged_from` markers (step 1) preserve reversibility that
    //    the flattened `merged_into` pointer alone would lose.
    await tx`
      UPDATE entities
      SET merged_into = ${winnerId}, updated_at = current_timestamp
      WHERE organization_id = ${orgId} AND merged_into = ${loserId}
    `;

    // 5. Tombstone the loser and point it at the winner.
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
        repointedEdges: repointed.length,
      },
      'entity merge applied',
    );

    return {
      movedIdentities: moved.length,
      repointedEdges: repointed.length,
    };
  });
}

export interface ApplyUnmergeParams {
  orgId: string;
  /** The tombstoned loser to split back out. */
  loserId: number;
  /** Who triggered the un-merge — for the audit log. */
  unmergedBy: string;
}

export interface ApplyUnmergeResult {
  winnerId: number;
  /** Identities moved back from the winner to the loser. */
  restoredIdentities: number;
}

/**
 * Reverse a merge: split `loser` back out of the winner, using ONLY the live-data
 * marker `applyMerge` stamped — no audit table. Every identity still carrying
 * `merged_from_entity_id = loser` is one this loser contributed (COALESCE in
 * applyMerge preserved the innermost origin through outer merges); move them back
 * and clear the marker.
 *
 * Chains: `applyMerge` FLATTENS, so every tombstoned loser points at the TERMINAL
 * winner, and COALESCE kept each identity marked with its innermost origin. So
 * un-merging any single loser is self-consistent regardless of chain depth: in
 * `L→W→V`, `unmerge(L)` restores L's own identities (still marked `merged_from=L`
 * on V) back to a revived L, leaving W→V untouched. Aliases and edges the merge
 * folded in are NOT reversed (they carry no per-merge origin) — the tool contract
 * says so; a caller that needs those back re-derives them.
 */
export async function applyUnmerge(
  params: ApplyUnmergeParams,
  db: DbClient = getDb(),
): Promise<ApplyUnmergeResult> {
  const { orgId, loserId, unmergedBy } = params;

  return db.begin(async (tx) => {
    const [loserRow] = (await tx<{ id: number; merged_into: number | null; deleted_at: string | null }>`
      SELECT id, merged_into, deleted_at
      FROM entities
      WHERE organization_id = ${orgId} AND id = ${loserId}
      FOR UPDATE
    `) as Array<{ id: number; merged_into: number | null; deleted_at: string | null }>;
    if (!loserRow) {
      throw new Error(`applyUnmerge: entity ${loserId} not found in org`);
    }
    if (loserRow.merged_into === null) {
      throw new Error(`applyUnmerge: entity ${loserId} is not merged into anything`);
    }
    const winnerId = Number(loserRow.merged_into);

    // Lock the winner too, in stable id order (matches applyMerge's discipline).
    const [lo, hi] = loserId < winnerId ? [loserId, winnerId] : [winnerId, loserId];
    await tx`
      SELECT id FROM entities
      WHERE organization_id = ${orgId} AND id IN (${lo}, ${hi})
      FOR UPDATE
    `;

    // 1. Move the loser's contributed identities back off the winner. These are
    //    the live winner-owned rows still marked `merged_from = loser` (applyMerge
    //    step 1, COALESCE-preserved). Clear the marker as we return them. A live
    //    loser↔winner value collision can't exist — the global unique index
    //    forbids it — so applyMerge never tombstones on collision, and there is
    //    nothing to revive here; the move is always safe against the index.
    const restored = (await tx<{ id: number }>`
      UPDATE entity_identities
      SET entity_id = ${loserId},
          merged_from_entity_id = NULL,
          updated_at = current_timestamp
      WHERE organization_id = ${orgId}
        AND entity_id = ${winnerId}
        AND merged_from_entity_id = ${loserId}
        AND deleted_at IS NULL
      RETURNING id
    `) as Array<{ id: number }>;

    // 2. Un-forward and un-tombstone the loser: it stands on its own again. Any
    //    OTHER entity flattened onto the winner via THIS loser stays pointing at
    //    the winner — an inherent limit of flatten, documented in the tool contract.
    await tx`
      UPDATE entities
      SET merged_into = NULL, deleted_at = NULL, updated_at = current_timestamp
      WHERE organization_id = ${orgId} AND id = ${loserId}
    `;

    logger.info(
      {
        orgId,
        loserId,
        winnerId,
        unmergedBy,
        restoredIdentities: restored.length,
      },
      'entity merge reversed',
    );

    return {
      winnerId,
      restoredIdentities: restored.length,
    };
  });
}
