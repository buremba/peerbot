/**
 * Promote keyed watcher-window rows into real child entities (P2 phase 1).
 *
 * `computeStableKeys()` stamps a deterministic stable-key string onto each
 * extracted entity (at `keyingConfig.key_output_field`). That key dead-ended:
 * nothing turned the keyed rows into rows in the `entities` table. This module
 * closes that gap. For each keyed row it upserts a child entity, idempotent by
 * stable key. The stable key is persisted as an `entity_identities` row in a
 * dedicated `watcher_key` namespace (identifier = `<watcherId>::<stableKey>`),
 * so a re-run — or a second replica racing the same window — resolves to the
 * existing entity instead of creating a duplicate. The partial unique index
 * `idx_entity_identities_live_unique (organization_id, namespace, identifier)
 * WHERE deleted_at IS NULL` is the lock.
 *
 * Origin provenance (the window that first produced the entity, its stable key,
 * and the watcher) is stamped onto the entity's own `metadata` at creation —
 * `metadata.window_id` / `stable_key` / `watcher_id`. There is NO separate
 * observation event: an entity is promoted once (it's an identity, not a time
 * series), so its origin lives on the row itself.
 *
 * The upsert runs on the caller's transaction handle so the entity and identity
 * writes commit atomically with the window itself.
 *
 * Multi-replica notes:
 *   - `entities.id` / `entity_identities.id` are `nextval()` sequence columns,
 *     so concurrent inserts never collide on the PK (no advisory-lock allocator
 *     needed here — that's only for the MAX(id)+1 tables).
 *   - The window (canvas chain root) is guarded by `idx_canvas_chain_root`, so at
 *     most one completion creates a given window; idempotent replays reuse it and
 *     re-enter this function, where the per-key identity claim makes repeats
 *     no-ops.
 *   - `fetch_types: false`: never bind a raw JS array — all identifiers here are
 *     scalar params.
 */

import { slugify } from '@lobu/core';
import {
  deferEntityCreate,
  deferEntityFieldChange,
  type DeferredMutation,
  runMutationGate,
} from '../authz/entity-mutation-gate';
import type { DbClient } from '../db/client';
import type { KeyingConfig } from '../types/watchers';
import { type BlockedChange, mergeEntityFields } from './entity-field-merge';
import { getValueAtPath } from './object-path';
import logger from './logger';
import { isUniqueViolation } from './pg-errors';

/** Namespace for the stable-key identity claim in `entity_identities`. */
const WATCHER_KEY_NAMESPACE = 'watcher_key';

export interface PromoteKeyedEntitiesParams {
  /** Transaction-bound SQL handle (MUST be the window-write transaction). */
  tx: DbClient;
  /** Extracted data AFTER `computeStableKeys` has stamped the keys. */
  extractedData: Record<string, unknown>;
  keyingConfig: KeyingConfig;
  watcherId: number;
  organizationId: string;
  /** The finalized window identity (canvas ROOT event id) this completion produced/reused. */
  windowId: number;
  /** The watcher's bound parent entity (entity_ids[0]); null when unbound. */
  parentEntityId: number | null;
  /**
   * Attribution for created entities — MUST be a live `user(id)` because
   * `entities.created_by` is NOT NULL with an ON DELETE RESTRICT FK. The
   * watcher's own `created_by` satisfies this. When null, an org owner/admin is
   * resolved as a fallback; if none exists, entity creation is skipped.
   */
  createdBy?: string | null;
}

export interface PromoteKeyedEntitiesResult {
  /** Number of distinct keyed rows that resolved to an entity. */
  promoted: number;
  /** Of those, how many created a brand-new entity (vs. matched an existing). */
  created: number;
  /**
   * Owned-field / policy-gated changes and policy-held creates that were NOT
   * applied — packaged as deferred approvals the caller flushes POST-COMMIT
   * (never writing inline, never on the caller's tx).
   */
  deferred: DeferredMutation[];
}

/**
 * A stable key is "non-empty" when at least one of its `::`-joined segments
 * carries a slug. `computeStableKeys` emits `"stability::"` / `"::app-crashes"`
 * when one field is null — those are still meaningful and DO promote. Only an
 * all-empty key (`""`, `"::"`, `"::::"`) is skipped.
 */
function hasNonEmptyKey(stableKey: unknown): stableKey is string {
  if (typeof stableKey !== 'string') return false;
  return stableKey.split('::').some((segment) => segment.length > 0);
}

/**
 * Resolve a live `user(id)` to attribute created entities to. Prefers the
 * caller-supplied `created_by` (the watcher's creator — already a live user);
 * otherwise falls back to an org owner/admin, mirroring entity-link-upsert's
 * `resolveOrgCreator`. Returns null when the org has no member to attribute to.
 */
async function resolveCreator(
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
 * Resolve the target entity-type slug. Prefer the explicit `keying_config`
 * field; otherwise derive a singular-ish slug from the last segment of
 * `entity_path` (`analysis.results.problems` → `problem`).
 */
function resolveEntityTypeSlug(config: KeyingConfig): string {
  if (config.entity_type && config.entity_type.trim().length > 0) {
    return config.entity_type.trim();
  }
  const lastSegment = config.entity_path.split('.').pop() ?? config.entity_path;
  const base = slugify(lastSegment);
  // Light singularization so `problems` → `problem`, `categories` → `category`.
  if (base.endsWith('ies')) return `${base.slice(0, -3)}y`;
  if (base.endsWith('s') && !base.endsWith('ss')) return base.slice(0, -1);
  return base || 'item';
}

/**
 * Build a human-readable entity name from the configured key fields' RAW values
 * (not the slugified key). Falls back to the stable key when no field carries a
 * value.
 */
function buildEntityName(
  entityRecord: Record<string, unknown>,
  config: KeyingConfig,
  stableKey: string
): string {
  const parts = config.key_fields
    .map((field) => entityRecord[field])
    .filter((v): v is string | number => v !== null && v !== undefined && String(v).trim().length > 0)
    .map((v) => String(v).trim());
  const joined = parts.join(' · ');
  return joined.length > 0 ? joined : stableKey;
}

/**
 * Resolve an entity-type slug → entity_types(id), searching the watcher's own
 * org first then any public catalog (same precedence as createEntity). Skips
 * derived (view-backed) types — they have no stored rows to insert into.
 */
async function resolveEntityTypeId(
  tx: DbClient,
  organizationId: string,
  entityTypeSlug: string
): Promise<number | null> {
  const rows = await tx<{ id: number; backing_sql: string | null }>`
    SELECT et.id, et.backing_sql
    FROM entity_types et
    LEFT JOIN organization o ON o.id = et.organization_id
    WHERE et.slug = ${entityTypeSlug}
      AND et.deleted_at IS NULL
      AND (
        et.organization_id = ${organizationId}
        OR o.visibility = 'public'
      )
    ORDER BY (et.organization_id = ${organizationId}) DESC, et.id ASC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  if (rows[0].backing_sql) return null;
  return Number(rows[0].id);
}

/**
 * How many readable numeric suffixes (`-2`, `-3`, …) to try before falling back
 * to a guaranteed-unique identifier-derived slug. Keeps slugs human-friendly
 * while guaranteeing the insert terminates.
 */
const SLUG_DISAMBIGUATION_ATTEMPTS = 5;

/**
 * Insert the child entity, tolerating a slug collision on
 * `entities_slug_parent_unique (organization_id, COALESCE(parent_id,0), slug)`.
 * Two keyed rows can slugify to the same base slug, and the slug can clash with
 * a pre-existing sibling. A raw INSERT would then throw 23505 and — because
 * promotion runs inside the window-completion transaction — roll the whole
 * completion back; since the slug is deterministic, every retry re-hits it and
 * the window is permanently poison-pilled. The entity's real identity is its
 * `watcher_key` claim, so the slug is cosmetic: retry with `-2`, `-3`, … and
 * finally an identifier-derived suffix (unique per watcher+key). Each attempt is
 * savepoint-isolated so a failed INSERT doesn't abort the outer transaction.
 */
async function insertEntityWithUniqueSlug(params: {
  tx: DbClient;
  organizationId: string;
  entityTypeId: number;
  parentEntityId: number | null;
  name: string;
  baseSlug: string;
  identifier: string;
  metadata: Record<string, unknown>;
  createdBy: string;
}): Promise<number> {
  const { tx } = params;
  const insertWithSlug = (slug: string) =>
    tx.savepoint(
      (sp) => sp<{ id: number | string }>`
        INSERT INTO entities (
          organization_id, entity_type_id, name, slug, parent_id, metadata,
          created_by, created_at, updated_at
        ) VALUES (
          ${params.organizationId}, ${params.entityTypeId}, ${params.name}, ${slug},
          ${params.parentEntityId}, ${tx.json(params.metadata)}, ${params.createdBy},
          current_timestamp, current_timestamp
        )
        RETURNING id
      `
    );

  for (let attempt = 1; attempt <= SLUG_DISAMBIGUATION_ATTEMPTS; attempt++) {
    const slug = attempt === 1 ? params.baseSlug : `${params.baseSlug}-${attempt}`;
    try {
      const inserted = await insertWithSlug(slug);
      return Number(inserted[0].id);
    } catch (err) {
      if (isUniqueViolation(err, 'entities_slug_parent_unique')) continue;
      throw err;
    }
  }
  // Readable suffixes exhausted: the identifier is unique per (watcher, key), so
  // this slug is collision-free among promotions (and effectively so against any
  // sibling). A final failure here propagates to the per-row guard in the loop.
  const inserted = await insertWithSlug(`${params.baseSlug}-${slugify(params.identifier)}`);
  return Number(inserted[0].id);
}

/**
 * Upsert a child entity by stable key. Returns its id and whether it was newly
 * created. Idempotent across re-runs / concurrent replicas via the
 * `entity_identities` live-unique index on (org, namespace, identifier). Slug
 * collisions are disambiguated by `insertEntityWithUniqueSlug` (the stable key,
 * not the slug, is the identity).
 */
async function upsertKeyedEntity(params: {
  tx: DbClient;
  organizationId: string;
  entityTypeId: number;
  entityTypeSlug: string;
  parentEntityId: number | null;
  identifier: string;
  name: string;
  baseSlug: string;
  metadata: Record<string, unknown>;
  /** Extracted entity field values to sync into metadata (excludes the stable key). */
  fieldValues: Record<string, unknown>;
  createdBy: string;
  /** Org policy: creates of this type queue an approval instead of inserting. */
  createNeedsApproval: boolean;
}): Promise<{
  entityId: number;
  created: boolean;
  blocked: Record<string, BlockedChange>;
  blockedCreate: boolean;
}> {
  const { tx, organizationId, identifier } = params;

  // 1. Existing identity → reuse its entity (the idempotent fast path), and SYNC the
  //    freshly-extracted field values into it honoring human ownership AND the org's
  //    update policy: un-gated fields are written; human-owned or policy-gated
  //    fields are returned as `blocked` (the caller queues an approval) and never
  //    overwritten inline.
  const existing = await tx<{ entity_id: number | string }>`
    SELECT ei.entity_id
    FROM entity_identities ei
    JOIN entities e ON e.id = ei.entity_id
    WHERE ei.organization_id = ${organizationId}
      AND ei.namespace = ${WATCHER_KEY_NAMESPACE}
      AND ei.identifier = ${identifier}
      AND ei.deleted_at IS NULL
      AND e.deleted_at IS NULL
    LIMIT 1
  `;
  if (existing.length > 0) {
    const entityId = Number(existing[0].entity_id);
    // Owners are 'none' here on purpose: human ownership is enforced inside the
    // merge itself; the gate only adds the org policy's field gates on top.
    const decision = await runMutationGate({
      action: 'update',
      organizationId,
      principalKind: 'watcher',
      sql: tx,
      attribution: 'watcher',
      entityTypeSlug: params.entityTypeSlug,
      entityId,
      fields: Object.fromEntries(
        Object.keys(params.fieldValues).map((field) => [field, 'none' as const])
      ),
    });
    // Fail CLOSED on a deny: apply nothing. The throw is caught by the per-row
    // savepoint in promoteKeyedEntities, so a denied row is skipped without
    // rolling back the window completion.
    if (decision.outcome === 'deny') {
      throw new Error(
        `Mutation gate denied watcher update to entity ${entityId}: ${decision.reason}`
      );
    }
    const requireApproval = [...decision.requireApproval];
    const merge = await mergeEntityFields({
      tx,
      entityId,
      fields: params.fieldValues,
      source: 'watcher',
      actorId: null,
      requireApproval,
    });
    return { entityId, created: false, blocked: merge.blocked, blockedCreate: false };
  }

  // Org policy holds creates of this type for approval — no insert, no identity
  // claim. The caller queues a durable create proposal post-commit; when it is
  // approved and re-promoted, the identity claim above dedupes as usual.
  if (params.createNeedsApproval) {
    return { entityId: 0, created: false, blocked: {}, blockedCreate: true };
  }

  // 2. Create the entity (sequence-allocated id — multi-replica safe),
  //    tolerating a slug collision so promotion can never poison-pill the window.
  const entityId = await insertEntityWithUniqueSlug({
    tx,
    organizationId,
    entityTypeId: params.entityTypeId,
    parentEntityId: params.parentEntityId,
    name: params.name,
    baseSlug: params.baseSlug,
    identifier,
    metadata: params.metadata,
    createdBy: params.createdBy,
  });

  // 3. Claim the stable key. ON CONFLICT DO NOTHING against the live-unique
  //    index: if a concurrent completion already claimed it, our insert is a
  //    no-op and we resolve the winner instead.
  const claimed = await tx<{ entity_id: number | string }>`
    INSERT INTO entity_identities (
      organization_id, entity_id, namespace, identifier, source_connector
    ) VALUES (
      ${organizationId}, ${entityId}, ${WATCHER_KEY_NAMESPACE}, ${identifier}, 'watcher'
    )
    ON CONFLICT (organization_id, namespace, identifier) WHERE deleted_at IS NULL
    DO NOTHING
    RETURNING entity_id
  `;
  if (claimed.length > 0) {
    return { entityId, created: true, blocked: {}, blockedCreate: false };
  }

  // Lost the race: another live transaction already claimed this key. Resolve
  // the winner, then drop the entity we just created so it doesn't linger as an
  // orphaned (identity-less) duplicate child under the parent.
  const winner = await tx<{ entity_id: number | string }>`
    SELECT entity_id
    FROM entity_identities
    WHERE organization_id = ${organizationId}
      AND namespace = ${WATCHER_KEY_NAMESPACE}
      AND identifier = ${identifier}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (winner.length > 0) {
    // Safe hard delete: this entity is brand-new in THIS transaction — nothing
    // references it yet (no identity, children, events, or relationships), and
    // entities' only blocking FK is `parent_id ON DELETE RESTRICT`, which can't
    // fire on a freshly-created leaf.
    await tx`
      DELETE FROM entities
      WHERE id = ${entityId} AND organization_id = ${organizationId}
    `;
    return { entityId: Number(winner[0].entity_id), created: false, blocked: {}, blockedCreate: false };
  }
  // Extremely unlikely: the conflicting claim was tombstoned between our INSERT
  // and this re-read. Keep our entity as the canonical one.
  return { entityId, created: true, blocked: {}, blockedCreate: false };
}

/**
 * Promote every keyed row at `keyingConfig.entity_path` into a child entity.
 * Skips rows whose stable key is empty. NEVER throws on a
 * single-row problem (e.g. unresolved entity type) — promotion must not break
 * window completion; it logs and returns what it managed to promote.
 */
export async function promoteKeyedEntities(
  params: PromoteKeyedEntitiesParams
): Promise<PromoteKeyedEntitiesResult> {
  const {
    tx,
    extractedData,
    keyingConfig,
    watcherId,
    organizationId,
    windowId,
    parentEntityId,
  } = params;
  const result: PromoteKeyedEntitiesResult = {
    promoted: 0,
    created: 0,
    deferred: [],
  };

  const rows = getValueAtPath(extractedData, keyingConfig.entity_path);
  if (!Array.isArray(rows) || rows.length === 0) return result;

  const entityTypeSlug = resolveEntityTypeSlug(keyingConfig);
  const entityTypeId = await resolveEntityTypeId(tx, organizationId, entityTypeSlug);
  if (entityTypeId == null) {
    logger.warn(
      { watcherId, organizationId, entityTypeSlug, entityPath: keyingConfig.entity_path },
      '[promote-keyed-entities] target entity type not found (or derived) — skipping promotion'
    );
    return result;
  }

  const createdBy = await resolveCreator(tx, organizationId, params.createdBy);
  if (createdBy == null) {
    logger.warn(
      { watcherId, organizationId },
      '[promote-keyed-entities] no live user to attribute created entities to — skipping promotion'
    );
    return result;
  }

  // Gate decision for creates of this type (watchers are never human): resolved
  // once per promotion — every row in this window is the same entity type, so
  // one create decision governs them all. We only read the outcome here (the
  // probe's deferral is discarded); each held-back row builds its own deferral
  // below. Fail CLOSED: anything but an explicit 'allow' skips inline creation,
  // and only a 'defer' queues an approval — a 'deny' creates nothing at all.
  const createGate = await runMutationGate({
    action: 'create',
    organizationId,
    principalKind: 'watcher',
    sql: tx,
    attribution: 'watcher',
    watcherId,
    entityTypeSlug,
    entityData: { entity_type: entityTypeSlug, name: '' },
    proposal: {},
  });
  const createNeedsApproval = createGate.outcome !== 'allow';
  if (createGate.outcome === 'deny') {
    logger.warn(
      { watcherId, organizationId, entityTypeSlug, reason: createGate.reason },
      '[promote-keyed-entities] mutation gate denied creates for this type — new rows will be skipped'
    );
  }

  // De-dupe within this window: two extracted rows can collapse to the same
  // stable key. Process each distinct key once.
  const seenKeys = new Set<string>();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const entityRecord = row as Record<string, unknown>;
    const stableKey = entityRecord[keyingConfig.key_output_field];
    if (!hasNonEmptyKey(stableKey)) continue;
    if (seenKeys.has(stableKey)) continue;
    seenKeys.add(stableKey);

    const identifier = `${watcherId}::${stableKey}`;
    const name = buildEntityName(entityRecord, keyingConfig, stableKey);
    const slug = slugify(name) || stableKey;
    // The extracted record's data fields (everything except the computed stable
    // key) are the entity's field values — synced into metadata on create and,
    // for existing entities, merged honoring human ownership.
    const fieldValues = Object.fromEntries(
      Object.entries(entityRecord).filter(([k]) => k !== keyingConfig.key_output_field)
    );
    const metadata: Record<string, unknown> = {
      ...fieldValues,
      watcher_id: watcherId,
      stable_key: stableKey,
      source: 'watcher_promotion',
      // Origin provenance lives on the entity itself — the window that first
      // produced it. (No separate append-only observation event in phase 1;
      // the entity is upserted once, so this is its origin, not a time series.)
      window_id: windowId,
    };

    try {
      const { created, blocked, entityId, blockedCreate } = await tx.savepoint((sp) =>
        upsertKeyedEntity({
          tx: sp,
          organizationId,
          entityTypeId,
          entityTypeSlug,
          parentEntityId,
          identifier,
          name,
          baseSlug: slug,
          metadata,
          fieldValues,
          createdBy,
          createNeedsApproval,
        })
      );
      if (blockedCreate) {
        // Only a 'defer' outcome queues an approval; a 'deny' is fail-closed —
        // the row is skipped entirely (no create, no approval card).
        if (createGate.outcome === 'defer') {
          const createProposal = {
            entity_type: entityTypeSlug,
            name,
            parent_id: parentEntityId,
            metadata,
          };
          result.deferred.push(
            deferEntityCreate({
              entityData: {
                entity_type: entityTypeSlug,
                name,
                parent_id: parentEntityId,
                metadata,
              },
              proposal: createProposal,
              attribution: 'watcher',
              watcherId,
            })
          );
        }
        continue;
      }
      result.promoted += 1;
      if (created) result.created += 1;
      const blockedFields = Object.keys(blocked);
      if (blockedFields.length > 0) {
        result.deferred.push(
          deferEntityFieldChange({
            entityId,
            fields: Object.fromEntries(blockedFields.map((f) => [f, blocked[f].proposed])),
            current: Object.fromEntries(blockedFields.map((f) => [f, blocked[f].current])),
            attribution: 'watcher',
            watcherId,
          })
        );
      }
    } catch (err) {
      // Non-fatal + savepoint-isolated: a single failing row rolls back only its
      // savepoint, never the window-completion transaction. Re-throwing here
      // would roll the whole completion back and — because the row is
      // deterministic — poison-pill the window on every retry. Log and skip; the
      // row is retried idempotently on the next window run (the identity claim
      // dedupes). Slug clashes are already recovered inside upsertKeyedEntity, so
      // reaching here means a genuinely unexpected error for this row.
      logger.error(
        { err, watcherId, windowId, stableKey, organizationId },
        '[promote-keyed-entities] skipped a keyed row after an unrecoverable error — window completion not blocked'
      );
    }
  }

  logger.info(
    {
      watcherId,
      windowId,
      entityTypeSlug,
      promoted: result.promoted,
      created: result.created,
    },
    '[promote-keyed-entities] promoted keyed window rows into entities'
  );

  return result;
}
