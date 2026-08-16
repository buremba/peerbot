/**
 * SPIKE — edges as a claim set plus an append-only change log.
 *
 * The design: every assertion and retraction is recorded in the log (what
 * changed and how); `entity_relationships` stays the projection holding current
 * state (what is true now, at index speed).
 *
 * This is NOT a new architecture. Entity *field* changes already work this way —
 * `recordChangeEvent` writes a field-level diff into `events` with
 * `semantic_type='change'` while the entity row holds current state. Edges are
 * the hole in that pattern: on origin/main `recordChangeEvent` has exactly one
 * call site (`manage_entity.ts:574`, inside `handleUpdate`), and `handleLink`,
 * `handleUnlink` and `handleUpdateLink` record nothing at all.
 *
 * The one novel piece is WHERE current claim state lives. Folding the whole log
 * to answer "is this edge live" would be an aggregate over history, which the
 * read path forbids and which grows without bound. So the projection row carries
 * its own claim set in `metadata.claims`, keyed by owner — bounded by the number
 * of owners, never by history length. The log is written for audit and replay
 * and is never read to decide current state.
 */
import type { DbClient } from '../db/client';
import { getDb } from '../db/client';
import { insertConnectionlessAuditEvent, stableJson } from './insert-event';

/**
 * Edge changes ride the existing `semantic_type='change'` bucket, discriminated
 * by `metadata.category`, exactly as deployment and lifecycle audits already do.
 * This matches what shipped in #2807 for the MCP link handlers, so a reader sees
 * one contract whether a human or a connector moved the edge.
 */
export const EDGE_CHANGE_SEMANTIC_TYPE = 'change';
export const EDGE_CHANGE_CATEGORY = 'relationship';

export type EdgeClaimRef = {
  orgId: string;
  fromEntityId: number;
  toEntityId: number;
  relationshipTypeId: number;
  /** Stable owner identity — a connector rule, a user, an agent. */
  ownerId: string;
};

export type ClaimOutcome = {
  /** Live after this operation. */
  live: boolean;
  /** Owners currently asserting this edge. */
  owners: string[];
  /** The projection changed state (created or tombstoned), rather than only its claim set. */
  flipped: boolean;
};

function claimsOf(metadata: unknown): string[] {
  const claims = (metadata as { claims?: Record<string, unknown> } | null)?.claims;
  return claims ? Object.keys(claims).sort() : [];
}

/**
 * Append the change to the log — but ONLY when the claim set actually moved.
 *
 * This guard is what makes the log affordable at connector scale. A sync
 * re-asserts every edge it still believes in, so without it a 10k-edge feed
 * would append 10k audit rows per run to an append-only table, for a graph that
 * did not change. Re-asserting an existing claim is a no-op and records
 * nothing; a new row, a new co-owner, or a withdrawal all move the set and are
 * all recorded.
 *
 * A dropped row costs history, never state: current ownership lives in the
 * projection row's claim set, which is the same reason the shipped edge audit
 * tolerates a drop.
 */
async function logEdgeChange(params: {
  ref: EdgeClaimRef;
  op: 'assert' | 'retract';
  before: string[];
  after: string[];
  ruleVersion?: string;
  seq: string;
}): Promise<void> {
  const { ref } = params;
  if (stableJson(params.before) === stableJson(params.after)) return;
  await insertConnectionlessAuditEvent({
    organizationId: ref.orgId,
    entityIds: [ref.fromEntityId, ref.toEntityId],
    // Idempotency is keyed on the caller-supplied sequence token, so a retried
    // batch does not append a second identical history row.
    originId: `edge:${ref.fromEntityId}:${ref.toEntityId}:${ref.relationshipTypeId}:${ref.ownerId}:${params.seq}`,
    semanticType: EDGE_CHANGE_SEMANTIC_TYPE,
    title: `Relationship ${params.op === 'assert' ? 'claimed' : 'released'}: ${ref.fromEntityId}->${ref.toEntityId}`,
    metadata: {
      _lobu_relationship_change: true,
      category: EDGE_CHANGE_CATEGORY,
      op: params.op,
      ownerId: ref.ownerId,
      fromEntityId: String(ref.fromEntityId),
      toEntityId: String(ref.toEntityId),
      relationshipTypeId: String(ref.relationshipTypeId),
      ruleVersion: params.ruleVersion ?? null,
      // The diff, in the same `changes = [{field, old, new}]` shape the MCP
      // handlers write, so one reader parses both.
      changes: [{ field: 'claims', old: params.before, new: params.after }],
    },
  });
}

/**
 * Record that `ownerId` asserts this edge. Idempotent per owner: asserting twice
 * leaves one claim.
 *
 * The claim-set mutation is ONE statement, so concurrent owners serialize on the
 * projection row's lock rather than racing a read-modify-write.
 */
export async function assertEdgeClaim(params: {
  ref: EdgeClaimRef;
  ruleVersion?: string;
  createdBy: string;
  seq: string;
  sql?: DbClient;
}): Promise<ClaimOutcome> {
  const run = async (sql: DbClient): Promise<ClaimOutcome> => {
    const { ref } = params;
    const claimValue = { ruleVersion: params.ruleVersion ?? null };

    const before = await sql<{ metadata: unknown }>`
      SELECT metadata FROM entity_relationships
      WHERE organization_id = ${ref.orgId}
        AND from_entity_id = ${ref.fromEntityId}
        AND to_entity_id = ${ref.toEntityId}
        AND relationship_type_id = ${ref.relationshipTypeId}
        AND deleted_at IS NULL
      FOR UPDATE
    `;
    const beforeOwners = before.length > 0 ? claimsOf(before[0].metadata) : [];

    const rows = await sql<{ metadata: unknown; inserted: number }>`
      INSERT INTO entity_relationships (
        organization_id, from_entity_id, to_entity_id, relationship_type_id,
        metadata, confidence, source, created_by, updated_by, created_at, updated_at
      ) VALUES (
        ${ref.orgId}, ${ref.fromEntityId}, ${ref.toEntityId}, ${ref.relationshipTypeId},
        ${sql.json({ claims: { [ref.ownerId]: claimValue } })},
        1.0, 'feed', ${params.createdBy}, ${params.createdBy},
        current_timestamp, current_timestamp
      )
      ON CONFLICT (from_entity_id, to_entity_id, relationship_type_id)
        WHERE deleted_at IS NULL
      DO UPDATE SET
        metadata = jsonb_set(
          coalesce(entity_relationships.metadata, '{}'::jsonb),
          ARRAY['claims', ${ref.ownerId}],
          ${sql.json(claimValue)},
          true
        ),
        updated_by = ${params.createdBy},
        updated_at = current_timestamp
      RETURNING metadata,
                -- Did THIS statement insert the row, or update an existing one?
                -- The pre-read cannot answer that: under a race both callers
                -- read "no row" and both would claim the create. xmax is zero
                -- only on a genuinely new tuple.
                (xmax = 0)::int AS inserted
    `;
    const afterOwners = claimsOf(rows[0]?.metadata);
    await logEdgeChange({
      ref,
      op: 'assert',
      before: beforeOwners,
      after: afterOwners,
      ruleVersion: params.ruleVersion,
      seq: params.seq,
    });
    return { live: true, owners: afterOwners, flipped: Number(rows[0]?.inserted) === 1 };
  };
  return params.sql ? run(params.sql) : (getDb().begin(run) as Promise<ClaimOutcome>);
}

/**
 * Withdraw `ownerId`'s claim. The edge is tombstoned only when the LAST claim
 * goes — which is the whole point: one owner withdrawing must not destroy an
 * edge another owner still asserts.
 */
export async function retractEdgeClaim(params: {
  ref: EdgeClaimRef;
  seq: string;
  sql?: DbClient;
}): Promise<ClaimOutcome> {
  const run = async (sql: DbClient): Promise<ClaimOutcome> => {
    const { ref } = params;
    const before = await sql<{ metadata: unknown }>`
      SELECT metadata FROM entity_relationships
      WHERE organization_id = ${ref.orgId}
        AND from_entity_id = ${ref.fromEntityId}
        AND to_entity_id = ${ref.toEntityId}
        AND relationship_type_id = ${ref.relationshipTypeId}
        AND deleted_at IS NULL
      FOR UPDATE
    `;
    if (before.length === 0) return { live: false, owners: [], flipped: false };
    const beforeOwners = claimsOf(before[0].metadata);

    // Remove this owner's key, and tombstone in the SAME statement iff nothing
    // remains. Column references on the right-hand side see the pre-update row,
    // so the emptiness test is evaluated against the old claim set.
    const rows = await sql<{ metadata: unknown; deleted_at: string | null }>`
      UPDATE entity_relationships
      SET metadata = jsonb_set(
            coalesce(metadata, '{}'::jsonb),
            ARRAY['claims'],
            coalesce(metadata -> 'claims', '{}'::jsonb) - ${ref.ownerId},
            true
          ),
          deleted_at = CASE
            WHEN (coalesce(metadata -> 'claims', '{}'::jsonb) - ${ref.ownerId}) = '{}'::jsonb
            THEN current_timestamp ELSE NULL END,
          updated_at = current_timestamp
      WHERE organization_id = ${ref.orgId}
        AND from_entity_id = ${ref.fromEntityId}
        AND to_entity_id = ${ref.toEntityId}
        AND relationship_type_id = ${ref.relationshipTypeId}
        AND deleted_at IS NULL
      RETURNING metadata, deleted_at
    `;
    const afterOwners = claimsOf(rows[0]?.metadata);
    const live = rows[0]?.deleted_at == null;
    await logEdgeChange({
      ref,
      op: 'retract',
      before: beforeOwners,
      after: afterOwners,
      seq: params.seq,
    });
    return { live, owners: afterOwners, flipped: live === false };
  };
  return params.sql ? run(params.sql) : (getDb().begin(run) as Promise<ClaimOutcome>);
}

export type EdgeHistoryEntry = {
  op: string;
  ownerId: string;
  before: string[];
  after: string[];
  occurredAt: string;
};

/**
 * Read the change history for one edge. AUDIT ONLY — never a read path. Current
 * state comes from the projection row's claim set, which is why this can be a
 * full history scan without violating the no-aggregate-on-read rule.
 */
export async function readEdgeHistory(params: {
  orgId: string;
  fromEntityId: number;
  toEntityId: number;
  relationshipTypeId: number;
  sql?: DbClient;
}): Promise<EdgeHistoryEntry[]> {
  const sql = params.sql ?? getDb();
  const rows = await sql<
    {
      op: string;
      owner_id: string;
      changes: Array<{ old: string[]; new: string[] }>;
      occurred_at: string;
    }
  >`
    SELECT metadata ->> 'op' AS op,
           metadata ->> 'ownerId' AS owner_id,
           metadata -> 'changes' AS changes,
           occurred_at
    FROM events
    WHERE organization_id = ${params.orgId}
      AND semantic_type = ${EDGE_CHANGE_SEMANTIC_TYPE}
      AND metadata ? '_lobu_relationship_change'
      AND metadata ->> 'category' = ${EDGE_CHANGE_CATEGORY}
      AND metadata ->> 'fromEntityId' = ${String(params.fromEntityId)}
      AND metadata ->> 'toEntityId' = ${String(params.toEntityId)}
      AND metadata ->> 'relationshipTypeId' = ${String(params.relationshipTypeId)}
    ORDER BY id ASC
  `;
  return rows.map((r) => ({
    op: r.op,
    ownerId: r.owner_id,
    before: r.changes?.[0]?.old ?? [],
    after: r.changes?.[0]?.new ?? [],
    occurredAt: r.occurred_at,
  }));
}
