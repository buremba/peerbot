/**
 * Conflict-safe batch edge writes for first-party materializers.
 *
 * Four call sites had hand-rolled the same statement one round trip per edge.
 * Three agreed; `auto-linker` had copied it WITHOUT the conflict clause and put
 * a `SELECT` in front instead, so two concurrent linkers could both pass the
 * check and the second raise `23505`.
 *
 * Not a replacement for `relationship-validation.ts`, which guards the
 * caller-facing `manage_entity` surface: its `validateSource` accepts only
 * `ui|llm|feed|api` and would reject the `config`/`manual` sources reconcilers
 * own, and its `checkDuplicateEdge` raises a 409 where a materializer wants an
 * idempotent no-op.
 *
 * Not a general edge kernel either: `entity-merge`'s repoint/tombstone and
 * `force_delete_tree`'s hard delete stay where they are, because their SQL is
 * ordering-dependent and set-based.
 */

import { type DbClient, getDb, pgBigintArray } from '../db/client';
import type { RelationshipTypePurpose } from './relationship-validation';

interface EdgePair {
  fromEntityId: number;
  toEntityId: number;
}

interface UpsertEdgesParams {
  db: DbClient;
  organizationId: string;
  relationshipTypeId: number;
  pairs: EdgePair[];
  source: string;
  confidence?: number | null;
  createdBy?: string | null;
  metadata?: object | null;
  onConflict: 'ignore' | 'update';
}

/**
 * Find-or-create an org-scoped relationship type.
 *
 * `description` only lands on first create; an existing type keeps its current
 * description.
 *
 * `purpose` classifies the type for the ACL readers. Passing it also REPAIRS an
 * existing row, which matters because this statement adopts rather than
 * create-or-fails: without the repair, a row that predates the classification
 * (or that an older pod created mid-rollout) would stay unclassified forever and
 * its members would lose access once reads require it. Omitting `purpose` never
 * clears an existing one — `mentions` and `member_of` share this function, and a
 * mentions upsert must not strip an authorization stamp.
 */
export async function ensureRelationshipType(params: {
  organizationId: string;
  slug: string;
  name: string;
  description: string;
  purpose?: RelationshipTypePurpose;
}): Promise<number> {
  const sql = getDb();
  const rows = await sql<{ id: number }>`
    INSERT INTO entity_relationship_types
      (slug, name, description, organization_id, is_symmetric, created_by, purpose, created_at, updated_at)
    VALUES
      (${params.slug}, ${params.name}, ${params.description}, ${params.organizationId},
       false, NULL, ${params.purpose ?? null}, current_timestamp, current_timestamp)
    ON CONFLICT (organization_id, slug) WHERE status = 'active'
    DO UPDATE SET
      updated_at = EXCLUDED.updated_at,
      purpose = COALESCE(EXCLUDED.purpose, entity_relationship_types.purpose)
    RETURNING id
  `;
  return Number(rows[0].id);
}

/**
 * Write directed edges of one type in a single statement. In `ignore` mode the
 * returned ids are newly created rows; in `update` mode they are created or
 * refreshed rows.
 */
export async function upsertEdges(params: UpsertEdgesParams): Promise<number[]> {
  const { db, organizationId, relationshipTypeId, source, onConflict } = params;

  // `ON CONFLICT DO UPDATE` cannot affect the same row twice in one statement.
  // Self-edges are dropped rather than written: identity resolution can collapse
  // two source keys onto one entity, and a self-loop is meaningless for every
  // type written here.
  const seen = new Set<string>();
  const pairs: EdgePair[] = [];
  for (const pair of params.pairs) {
    if (pair.fromEntityId === pair.toEntityId) continue;
    const key = `${pair.fromEntityId}:${pair.toEntityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(pair);
  }
  if (pairs.length === 0) return [];

  const froms = pairs.map((p) => p.fromEntityId);
  const tos = pairs.map((p) => p.toEntityId);

  const conflictAction =
    onConflict === 'update'
      ? db`DO UPDATE SET
            metadata = EXCLUDED.metadata,
            source = EXCLUDED.source,
            updated_by = EXCLUDED.updated_by,
            updated_at = current_timestamp`
      : db`DO NOTHING`;

  const written = await db<{ id: number }>`
    INSERT INTO entity_relationships (
      organization_id, from_entity_id, to_entity_id, relationship_type_id,
      metadata, confidence, source, created_by, updated_by, created_at, updated_at
    )
    SELECT
      ${organizationId}, v.f, v.t, ${relationshipTypeId},
      ${params.metadata == null ? null : db.json(params.metadata)},
      ${params.confidence ?? null}, ${source},
      ${params.createdBy ?? null}, ${params.createdBy ?? null},
      current_timestamp, current_timestamp
    FROM unnest(${pgBigintArray(froms)}::bigint[], ${pgBigintArray(tos)}::bigint[]) AS v(f, t)
    ON CONFLICT (from_entity_id, to_entity_id, relationship_type_id)
      WHERE deleted_at IS NULL
    ${conflictAction}
    RETURNING id
  `;

  return written.map((row) => Number(row.id));
}
