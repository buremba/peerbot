/**
 * SPIKE — the connector-facing half of connector-declared entity->entity edges.
 *
 * NOT production placement. This exists to answer one question with running
 * code rather than a design document: what does a connector actually write in
 * its manifest, and how much new machinery does honouring it require?
 *
 * The answer is that it requires almost none. Both endpoints of an
 * entity->entity edge resolve through the SAME identity machinery that
 * `attributions` already uses today. So the materializer is a thin layer over
 * resolution that already happens on every sync — resolve twice instead of
 * once, then write one row.
 *
 * The declaration below deliberately mirrors `EventAttributionRule`: same
 * target spec, same `autoCreate`, same identity selectors. A connector author
 * who can write `attributions` can already write this.
 */
import type { EntityIdentitySpec } from '@lobu/connector-sdk';
import type { DbClient } from '../db/client';
import { getDb, pgBigintArray } from '../db/client';

/**
 * Proposed manifest shape, additive on `feeds_schema[feed].eventKinds[kind]`:
 *
 * ```ts
 * eventKinds: {
 *   invoice: {
 *     attributions: [ ... ],            // event -> entity, unchanged
 *     relationships: [                  // entity -> entity, new
 *       {
 *         type: 'invoice_customer',
 *         from: { entityType: 'invoice',  identities: [{ namespace: 'erp_invoice',  eventPath: 'metadata.origin_id' }] },
 *         to:   { entityType: 'customer', identities: [{ namespace: 'erp_customer', eventPath: 'metadata.customer_origin_id' }] },
 *       },
 *     ],
 *   },
 * }
 * ```
 */
export type DeclaredEdgeEndpoint = {
  entityType: string;
  identities: EntityIdentitySpec[];
};

export type DeclaredEdgeRule = {
  /** Relationship type slug. Resolved against the DB, never trusted from the caller. */
  type: string;
  from: DeclaredEdgeEndpoint;
  to: DeclaredEdgeEndpoint;
};

function valueAtPath(item: Record<string, unknown>, path: string): string | null {
  let cur: unknown = item;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur == null) return null;
  const s = String(cur).trim();
  return s === '' ? null : s;
}

/**
 * Resolve one endpoint to an entity id through `entity_identities` — the same
 * table `attributions` writes. Returns null when nothing resolves, which is the
 * caller's signal to skip rather than to park state: the attribution pass with
 * `autoCreate` is what guarantees the row exists by the time this runs.
 */
async function resolveEndpoint(
  sql: DbClient,
  orgId: string,
  endpoint: DeclaredEdgeEndpoint,
  item: Record<string, unknown>
): Promise<number | null> {
  for (const spec of endpoint.identities) {
    const identifier = valueAtPath(item, spec.eventPath);
    if (!identifier) continue;
    const rows = await sql<{ entity_id: number }[]>`
      SELECT entity_id FROM entity_identities
      WHERE organization_id = ${orgId}
        AND namespace = ${spec.namespace}
        AND identifier = ${identifier}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (rows.length > 0) return Number(rows[0].entity_id);
  }
  return null;
}

/**
 * Resolve the relationship type FROM THE DB, never from the manifest string
 * alone — the `$links` gate decision requires exactly this, so that a connector
 * cannot name an authz-bearing type into existence.
 */
async function resolveRelationshipTypeId(
  sql: DbClient,
  orgId: string,
  slug: string
): Promise<number | null> {
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM entity_relationship_types
    WHERE organization_id = ${orgId} AND slug = ${slug} AND status = 'active'
    LIMIT 1
  `;
  return rows.length > 0 ? Number(rows[0].id) : null;
}

export type MaterializeResult = {
  created: number;
  duplicate: number;
  unresolved: number;
  unknownType: number;
  /** Live edges withdrawn because the batch no longer asserts them. */
  retracted: number;
};

/**
 * Honour a feed's declared edge rules for a batch of synced items.
 *
 * Runs AFTER the attribution pass, so both endpoints already exist. Writes
 * provenance into `metadata.derivedFrom`, which the baseline already indexes
 * (`idx_entity_relationships_derived_from_rule`) and which nothing else in the
 * repo writes.
 */
export async function materializeDeclaredEdges(params: {
  orgId: string;
  connectionId: number;
  ruleVersion: string;
  rules: DeclaredEdgeRule[];
  items: Array<Record<string, unknown>>;
  createdBy: string;
  /**
   * Withdraw edges this rule previously asserted from a from-entity that the
   * CURRENT batch also touches, but no longer points at the same target — the
   * "the invoice moved to a different customer" case. Scoped to the batch's own
   * from-entities, so a partial sync never retracts what it did not observe.
   */
  reconcile?: boolean;
  sql?: DbClient;
}): Promise<MaterializeResult> {
  const sql = params.sql ?? getDb();
  const out: MaterializeResult = {
    created: 0,
    duplicate: 0,
    unresolved: 0,
    unknownType: 0,
    retracted: 0,
  };

  for (const rule of params.rules) {
    const typeId = await resolveRelationshipTypeId(sql, params.orgId, rule.type);
    if (typeId == null) {
      out.unknownType += params.items.length;
      continue;
    }
    /** from_entity_id -> the to_entity_ids THIS batch asserts for it. */
    const asserted = new Map<number, Set<number>>();
    for (const item of params.items) {
      const fromId = await resolveEndpoint(sql, params.orgId, rule.from, item);
      const toId = await resolveEndpoint(sql, params.orgId, rule.to, item);
      if (fromId == null || toId == null || fromId === toId) {
        out.unresolved += 1;
        continue;
      }
      const derivedFrom = {
        derivedFrom: {
          relationshipTypeId: String(typeId),
          ruleVersion: params.ruleVersion,
          connectionId: String(params.connectionId),
        },
      };
      const inserted = await sql<{ id: number }[]>`
        INSERT INTO entity_relationships (
          organization_id, from_entity_id, to_entity_id, relationship_type_id,
          metadata, confidence, source, created_by, updated_by, created_at, updated_at
        ) VALUES (
          ${params.orgId}, ${fromId}, ${toId}, ${typeId},
          ${sql.json(derivedFrom)}, 1.0, 'feed', ${params.createdBy}, ${params.createdBy},
          current_timestamp, current_timestamp
        )
        ON CONFLICT (from_entity_id, to_entity_id, relationship_type_id)
          WHERE deleted_at IS NULL
        DO NOTHING
        RETURNING id
      `;
      if (inserted.length > 0) out.created += 1;
      else out.duplicate += 1;
      const set = asserted.get(fromId);
      if (set) set.add(toId);
      else asserted.set(fromId, new Set([toId]));
    }

    if (!params.reconcile || asserted.size === 0) continue;
    // Every DERIVED edge of this type, from a from-entity the batch observed,
    // whose target the batch no longer asserts. No separate state table is
    // consulted — the batch IS the snapshot, exactly as access-graph reconciles
    // departures.
    //
    // Deliberately NOT filtered on ruleVersion: reconcile owns the whole
    // derived slice for (from_entity, type). Scoping it to the current version
    // would strand every edge the previous version wrote the moment a connector
    // author bumps the rule — the stale edge stays live forever because no
    // later sync ever claims it. Provenance stays on the row for retraction and
    // audit; it is not an ownership boundary.
    //
    // A hand-authored (`source='ui'`) edge carries no `derivedFrom` and is
    // therefore never touched, which is the point of keying on it at all.
    for (const [fromId, targets] of asserted) {
      const stale = await sql<{ id: number }[]>`
        UPDATE entity_relationships
        SET deleted_at = current_timestamp, updated_at = current_timestamp
        WHERE organization_id = ${params.orgId}
          AND from_entity_id = ${fromId}
          AND relationship_type_id = ${typeId}
          AND deleted_at IS NULL
          AND metadata ? 'derivedFrom'
          AND NOT (to_entity_id = ANY (${pgBigintArray([...targets])}::bigint[]))
        RETURNING id
      `;
      out.retracted += stale.length;
    }
  }
  return out;
}

/**
 * Withdraw every edge a rule version asserted. Uses only
 * `idx_entity_relationships_derived_from_rule`; no separate state table is
 * consulted, because none is needed to know what a rule wrote.
 */
export async function retractDeclaredEdges(params: {
  orgId: string;
  relationshipTypeId: number;
  ruleVersion: string;
  sql?: DbClient;
}): Promise<number> {
  const sql = params.sql ?? getDb();
  const rows = await sql<{ id: number }[]>`
    UPDATE entity_relationships
    SET deleted_at = current_timestamp, updated_at = current_timestamp
    WHERE organization_id = ${params.orgId}
      AND deleted_at IS NULL
      AND metadata ? 'derivedFrom'
      AND metadata -> 'derivedFrom' ->> 'relationshipTypeId' = ${String(params.relationshipTypeId)}
      AND metadata -> 'derivedFrom' ->> 'ruleVersion' = ${params.ruleVersion}
    RETURNING id
  `;
  return rows.length;
}
