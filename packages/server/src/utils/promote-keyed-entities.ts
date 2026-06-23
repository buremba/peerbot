/**
 * Promote keyed watcher-window rows into real child entities (P2 phase 1).
 *
 * `computeStableKeys()` stamps a deterministic stable-key string onto each
 * extracted entity (at `keyingConfig.key_output_field`). That key dead-ended:
 * nothing turned the keyed rows into rows in the `entities` table. This module
 * closes that gap. For each keyed row it:
 *
 *   1. Upserts a child entity, idempotent by stable key. The stable key is
 *      persisted as an `entity_identities` row in a dedicated `watcher_key`
 *      namespace (identifier = `<watcherId>::<stableKey>`), so a re-run — or a
 *      second replica racing the same window — resolves to the existing entity
 *      instead of creating a duplicate. The partial unique index
 *      `idx_entity_identities_live_unique (organization_id, namespace,
 *      identifier) WHERE deleted_at IS NULL` is the lock.
 *   2. Emits an append-only `observation` event linking the child entity to the
 *      window (`metadata.window_id` / `stable_key` / `watcher_id`). Idempotent:
 *      a prior observation for the same `(window_id, stable_key)` short-circuits
 *      the insert. Events are append-only — we never DELETE.
 *
 * Both steps run on the caller's transaction handle so the entity, identity, and
 * observation writes commit atomically with the window itself.
 *
 * Multi-replica notes:
 *   - `entities.id` / `entity_identities.id` are `nextval()` sequence columns,
 *     so concurrent inserts never collide on the PK (no advisory-lock allocator
 *     needed here — that's only for the MAX(id)+1 tables).
 *   - The window itself is guarded by `idx_watcher_windows_unique_period`, so at
 *     most one completion creates a given window; idempotent replays reuse it and
 *     re-enter this function, where the per-(window, key) guards make repeats
 *     no-ops.
 *   - `fetch_types: false`: never bind a raw JS array — identifiers are scalar
 *     params and ANY-array lookups go through `pgTextArray()`.
 */

import { slugify } from '@lobu/core';
import type { DbClient } from '../db/client';
import type { KeyingConfig } from '../types/watchers';
import { getValueAtPath } from './object-path';
import logger from './logger';

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
  /** The finalized watcher_windows.id this completion produced/reused. */
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
  /** Number of observation events newly inserted (excludes idempotent skips). */
  observationsInserted: number;
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
 * Upsert a child entity by stable key. Returns its id and whether it was newly
 * created. Idempotent across re-runs / concurrent replicas via the
 * `entity_identities` live-unique index on (org, namespace, identifier).
 */
async function upsertKeyedEntity(params: {
  tx: DbClient;
  organizationId: string;
  entityTypeId: number;
  parentEntityId: number | null;
  identifier: string;
  name: string;
  slug: string;
  metadata: Record<string, unknown>;
  createdBy: string;
}): Promise<{ entityId: number; created: boolean }> {
  const { tx, organizationId, identifier } = params;

  // 1. Existing identity → reuse its entity (the idempotent fast path).
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
    return { entityId: Number(existing[0].entity_id), created: false };
  }

  // 2. Create the entity (sequence-allocated id — multi-replica safe).
  const inserted = await tx<{ id: number | string }>`
    INSERT INTO entities (
      organization_id, entity_type_id, name, slug, parent_id, metadata,
      created_by, created_at, updated_at
    ) VALUES (
      ${organizationId}, ${params.entityTypeId}, ${params.name}, ${params.slug},
      ${params.parentEntityId}, ${tx.json(params.metadata)}, ${params.createdBy},
      current_timestamp, current_timestamp
    )
    RETURNING id
  `;
  const entityId = Number(inserted[0].id);

  // 3. Claim the stable key. ON CONFLICT DO NOTHING against the live-unique
  //    index: if a concurrent completion already claimed it, our insert is a
  //    no-op and we re-read the winner (and drop the entity row we just made —
  //    it is orphaned but harmless; the winner's entity is canonical).
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
    return { entityId, created: true };
  }

  // Lost the race: another transaction claimed this key. Resolve the winner.
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
    return { entityId: Number(winner[0].entity_id), created: false };
  }
  // Extremely unlikely: the conflicting row was tombstoned between INSERT and
  // re-read. Fall back to the entity we created.
  return { entityId, created: true };
}

/**
 * Emit an append-only `observation` event linking the child entity to the
 * window. Idempotent per (window_id, stable_key): a prior observation
 * short-circuits the insert. Runs on `tx` so it commits atomically with the
 * entity + window writes.
 */
async function insertObservationEvent(params: {
  tx: DbClient;
  organizationId: string;
  entityId: number;
  watcherId: number;
  windowId: number;
  stableKey: string;
  createdBy: string;
}): Promise<boolean> {
  const { tx, organizationId, entityId, watcherId, windowId, stableKey } = params;

  // Idempotency guard: was this (window, key) already observed? Scoped by
  // semantic_type so it never collides with other event kinds.
  const existing = await tx<{ id: number }>`
    SELECT id
    FROM events
    WHERE organization_id = ${organizationId}
      AND semantic_type = 'observation'
      AND metadata->>'window_id' = ${String(windowId)}
      AND metadata->>'stable_key' = ${stableKey}
      AND metadata->>'watcher_id' = ${String(watcherId)}
    LIMIT 1
  `;
  if (existing.length > 0) return false;

  const originId = `watcher-observation:${watcherId}:${windowId}:${stableKey}`;
  const metadata = {
    category: 'watcher_promotion',
    window_id: windowId,
    stable_key: stableKey,
    watcher_id: watcherId,
  };

  await tx`
    INSERT INTO events (
      entity_ids, organization_id, origin_id, semantic_type, metadata,
      created_by, created_at
    ) VALUES (
      ${`{${entityId}}`}::bigint[], ${organizationId}, ${originId}, 'observation',
      ${tx.json(metadata)}, ${params.createdBy}, NOW()
    )
  `;
  return true;
}

/**
 * Promote every keyed row at `keyingConfig.entity_path` into a child entity +
 * observation event. Skips rows whose stable key is empty. NEVER throws on a
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
    observationsInserted: 0,
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
    const metadata: Record<string, unknown> = {
      watcher_id: watcherId,
      stable_key: stableKey,
      source: 'watcher_promotion',
    };

    try {
      const { entityId, created } = await upsertKeyedEntity({
        tx,
        organizationId,
        entityTypeId,
        parentEntityId,
        identifier,
        name,
        slug,
        metadata,
        createdBy,
      });
      result.promoted += 1;
      if (created) result.created += 1;

      const inserted = await insertObservationEvent({
        tx,
        organizationId,
        entityId,
        watcherId,
        windowId,
        stableKey,
        createdBy,
      });
      if (inserted) result.observationsInserted += 1;
    } catch (err) {
      logger.error(
        { err, watcherId, windowId, stableKey, organizationId },
        '[promote-keyed-entities] failed to promote keyed row'
      );
      // Re-throw: this runs inside the window transaction, so a partial write
      // here would otherwise commit a half-promoted state. Surfacing the error
      // rolls the whole completion back — the agent retries idempotently.
      throw err;
    }
  }

  logger.info(
    {
      watcherId,
      windowId,
      entityTypeSlug,
      promoted: result.promoted,
      created: result.created,
      observationsInserted: result.observationsInserted,
    },
    '[promote-keyed-entities] promoted keyed window rows into entities'
  );

  return result;
}
