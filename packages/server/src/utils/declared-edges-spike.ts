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
import { assertEdgeClaim, retractEdgeClaim } from './edge-claims-spike';
import { normalizeIdentityValue } from './entity-link-upsert';
import { canonicalizeSymmetricEdge, validateTypeRule } from './relationship-validation';

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
  /**
   * Stable name for this rule within its connector manifest. Together with the
   * connection it forms the edge's OWNER identity — the thing reconcile is
   * scoped to. Deliberately independent of `ruleVersion`: an author bumping the
   * version must keep owning the edges the previous version wrote, or they
   * strand.
   */
  name: string;
  from: DeclaredEdgeEndpoint;
  to: DeclaredEdgeEndpoint;
};

/** `connectionId:ruleName` — stable across rule-version bumps. */
function ownerIdOf(connectionId: number, ruleName: string): string {
  return `${connectionId}:${ruleName}`;
}

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
    const raw = valueAtPath(item, spec.eventPath);
    if (!raw) continue;
    // The SAME function the attribution path used to store this identity.
    // Re-implementing it (a bare trim) silently misses every normalized
    // namespace — an email stored lowercase is never found by its raw form.
    const identifier = normalizeIdentityValue(spec.namespace, raw);
    if (!identifier) continue;
    // Joined to the entity's TYPE, because `endpoint.entityType` is part of the
    // declaration and must constrain what resolves. Matching on the identity
    // alone would let a manifest that says `from: invoice` quietly attach the
    // edge to whatever entity happens to hold that identifier.
    const rows = await sql<{ entity_id: number }>`
      SELECT ei.entity_id
      FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE ei.organization_id = ${orgId}
        AND ei.namespace = ${spec.namespace}
        AND ei.identifier = ${identifier}
        AND ei.deleted_at IS NULL
        AND e.deleted_at IS NULL
        AND et.slug = ${endpoint.entityType}
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
async function resolveRelationshipType(
  sql: DbClient,
  orgId: string,
  slug: string
): Promise<{ id: number; isSymmetric: boolean } | null> {
  const rows = await sql<{ id: number; is_symmetric: boolean }>`
    SELECT id, is_symmetric FROM entity_relationship_types
    WHERE organization_id = ${orgId} AND slug = ${slug}
      AND status = 'active' AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows.length > 0
    ? { id: Number(rows[0].id), isSymmetric: Boolean(rows[0].is_symmetric) }
    : null;
}

export type MaterializeResult = {
  created: number;
  duplicate: number;
  unresolved: number;
  unknownType: number;
  /** Live edges withdrawn because the batch no longer asserts them. */
  retracted: number;
  /**
   * Resolved to a real pair, but the org's `entity_relationship_type_rules`
   * forbid that type pairing. Counted rather than thrown: one bad item in a
   * 10k-item sync must not abort the batch.
   */
  rejected: number;
};

/**
 * Honour a feed's declared edge rules for a batch of synced items.
 *
 * Runs AFTER the attribution pass, so both endpoints already exist.
 *
 * Writes its provenance as a CLAIM under `metadata.claims[ownerId]` rather than
 * as a single `metadata.derivedFrom` owner. The single-owner shape could not
 * represent one edge that two sources both assert, so a connector's reconcile
 * destroyed edges a human or a second connector still stood behind. The claim
 * set is bounded by the number of owners, never by history length, so it stays
 * an indexed read.
 */
export async function materializeDeclaredEdges(params: {
  orgId: string;
  connectionId: number;
  ruleVersion: string;
  rules: DeclaredEdgeRule[];
  items: Array<Record<string, unknown>>;
  createdBy: string;
  /**
   * Identifies THIS sync attempt. Stable across a retry of the same batch (so a
   * replay appends no duplicate history) and distinct between genuine runs (so
   * a real later change is not mistaken for a replay of the earlier one).
   */
  syncToken: string;
  /**
   * Withdraw edges this rule previously asserted from a from-entity that the
   * CURRENT batch also touches, but no longer points at the same target — the
   * "the invoice moved to a different customer" case. Scoped to the batch's own
   * from-entities, so a partial sync never retracts what it did not observe.
   */
  reconcile?: boolean;
  sql?: DbClient;
}): Promise<MaterializeResult> {
  // Insert and reconcile are ONE logical operation and must be atomic. Run as
  // separate autocommitted statements, two replicas processing conflicting
  // batches for the same from-entity destroy each other's work: A inserts, B
  // inserts, A's reconcile removes B's edge, B's reconcile removes A's, and the
  // invoice is left with NO customer at all. Silent data loss, reproduced in
  // `declared-edges-concurrency.test.ts`. Inside a transaction the two
  // serialize and the later writer simply wins.
  //
  // A caller-supplied handle is assumed to already be a transaction (the sync
  // path threads its own), so we never nest.
  if (!params.sql) {
    return getDb().begin((tx) => materializeDeclaredEdges({ ...params, sql: tx as DbClient })) as
      Promise<MaterializeResult>;
  }
  const sql = params.sql;
  const out: MaterializeResult = {
    created: 0,
    duplicate: 0,
    unresolved: 0,
    unknownType: 0,
    retracted: 0,
    rejected: 0,
  };

  for (const rule of params.rules) {
    const relType = await resolveRelationshipType(sql, params.orgId, rule.type);
    if (relType == null) {
      out.unknownType += params.items.length;
      continue;
    }
    const typeId = relType.id;
    /** from_entity_id -> the to_entity_ids THIS batch asserts for it. */
    const asserted = new Map<number, Set<number>>();
    for (const item of params.items) {
      const resolvedFrom = await resolveEndpoint(sql, params.orgId, rule.from, item);
      const resolvedTo = await resolveEndpoint(sql, params.orgId, rule.to, item);
      if (resolvedFrom == null || resolvedTo == null || resolvedFrom === resolvedTo) {
        out.unresolved += 1;
        continue;
      }
      // A symmetric type must land on ONE canonical ordering, or a connector
      // that happens to emit b->a creates a second edge for the same fact and
      // the claim set is split across two rows that never converge.
      const { from: fromId, to: toId } = relType.isSymmetric
        ? canonicalizeSymmetricEdge(resolvedFrom, resolvedTo)
        : { from: resolvedFrom, to: resolvedTo };

      // The SAME type-pair rules the MCP link path enforces. Without this a
      // connector manifest can assert pairings an operator explicitly forbade.
      try {
        await validateTypeRule(typeId, fromId, toId, sql);
      } catch {
        out.rejected += 1;
        continue;
      }
      // A claim, not a bare insert. Two owners asserting the same triple share
      // ONE projection row and each hold their own key in `metadata.claims`,
      // which is what stops this connector's reconcile from destroying an edge
      // a human or another connector still asserts.
      const outcome = await assertEdgeClaim({
        ref: {
          orgId: params.orgId,
          fromEntityId: fromId,
          toEntityId: toId,
          relationshipTypeId: typeId,
          ownerId: ownerIdOf(params.connectionId, rule.name),
        },
        ruleVersion: params.ruleVersion,
        createdBy: params.createdBy,
        // Stable per sync, so a retried batch re-asserts without appending a
        // second identical history row.
        seq: params.syncToken,
        sql,
      });
      if (outcome.flipped) out.created += 1;
      else out.duplicate += 1;
      const set = asserted.get(fromId);
      if (set) set.add(toId);
      else asserted.set(fromId, new Set([toId]));
    }

    if (!params.reconcile || asserted.size === 0) continue;
    // Every edge THIS OWNER derived, from a from-entity the batch observed,
    // whose target the batch no longer asserts. No separate state table is
    // consulted — the batch IS the snapshot, exactly as access-graph reconciles
    // departures.
    //
    // Scoped to `ownerId`, not `ruleVersion` and not the bare (from, type)
    // slice. Both alternatives are wrong in opposite directions: scoping to the
    // version strands every edge the previous version wrote the moment an
    // author bumps it, while scoping to nothing makes two owners delete each
    // other's edges on alternating syncs. Owner identity is stable across
    // version bumps and distinct between owners, so it is the only scope that
    // is right in both cases.
    //
    // A hand-authored (`source='ui'`) edge carries no `derivedFrom` and is
    // therefore never touched, which is the point of keying on it at all.
    for (const [fromId, targets] of asserted) {
      // Select what this owner still claims but no longer asserts, then release
      // each claim individually. A blanket UPDATE ... SET deleted_at would
      // tombstone the row out from under every co-owner; releasing a claim
      // tombstones only when it was the last one standing.
      const stale = await sql<{ to_entity_id: number }>`
        SELECT to_entity_id
        FROM entity_relationships
        WHERE organization_id = ${params.orgId}
          AND from_entity_id = ${fromId}
          AND relationship_type_id = ${typeId}
          AND deleted_at IS NULL
          AND metadata -> 'claims' ? ${ownerIdOf(params.connectionId, rule.name)}
          AND NOT (to_entity_id = ANY (${pgBigintArray([...targets])}::bigint[]))
      `;
      for (const row of stale) {
        await retractEdgeClaim({
          ref: {
            orgId: params.orgId,
            fromEntityId: fromId,
            toEntityId: Number(row.to_entity_id),
            relationshipTypeId: typeId,
            ownerId: ownerIdOf(params.connectionId, rule.name),
          },
          seq: params.syncToken,
          sql,
        });
        out.retracted += 1;
      }
    }
  }
  return out;
}

/**
 * Withdraw every claim a rule version asserted, for one relationship type.
 *
 * Releases claims rather than tombstoning rows outright: an edge that a human
 * or a second connector also asserts must survive this rule being withdrawn,
 * and only the LAST claim going takes the row with it. The relationship type
 * comes from the column, not from metadata, so the type filter stays indexed.
 *
 * Returns the number of claims released, which is not necessarily the number of
 * edges that disappeared.
 */
export async function retractDeclaredEdges(params: {
  orgId: string;
  relationshipTypeId: number;
  ruleVersion: string;
  /** See `materializeDeclaredEdges` — stable across a retry of this withdrawal. */
  syncToken: string;
  sql?: DbClient;
}): Promise<number> {
  const sql = params.sql ?? getDb();
  const claims = await sql<{
    from_entity_id: number;
    to_entity_id: number;
    owner_id: string;
  }>`
    SELECT r.from_entity_id, r.to_entity_id, c.key AS owner_id
    FROM entity_relationships r,
         LATERAL jsonb_each(r.metadata -> 'claims') AS c
    WHERE r.organization_id = ${params.orgId}
      AND r.deleted_at IS NULL
      AND r.relationship_type_id = ${params.relationshipTypeId}
      AND c.value ->> 'ruleVersion' = ${params.ruleVersion}
  `;
  for (const claim of claims) {
    await retractEdgeClaim({
      ref: {
        orgId: params.orgId,
        fromEntityId: Number(claim.from_entity_id),
        toEntityId: Number(claim.to_entity_id),
        relationshipTypeId: params.relationshipTypeId,
        ownerId: claim.owner_id,
      },
      seq: params.syncToken,
      sql,
    });
  }
  return claims.length;
}
