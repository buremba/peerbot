/**
 * Shared types, utilities, and helpers used across manage_behaviors sub-handlers.
 */

import type { DbClient } from '../../../db/client';
import { getDb } from '../../../db/client';
import { ToolUserError } from '../../../utils/errors';
import {
  requireOrgReadAccess,
  requireOrgWriteAccess,
  requireReadAccess,
  requireWriteAccess,
} from '../../../utils/organization-access';
import { queryProjectsIdColumn } from '../../../utils/execute-data-sources';
import {
  validateWatcherSourceRef,
  resolveWatcherSourcesForSave,
} from '../../../watchers/source-refs';
import type { ToolContext } from '../../registry';
import { normalizeBehaviorTags } from '@lobu/core/contracts/tools/manage-behaviors';

// ============================================
// Types
// ============================================

export interface WatcherOperationResult {
  behavior_id: string;
  success: boolean;
  message: string;
  version?: number;
}

type WatcherAccessMode = 'read' | 'write';

interface WatcherAccessRow {
  id: string | number;
  organization_id: string | null;
  entity_ids: unknown;
}

// ============================================
// JSON coercion helpers
// ============================================

/**
 * Coerce a maybe-stringified JSON value into a parsed value. One helper, three
 * failure policies:
 *  - `keep`        — non-string passes through; bad string returns the raw string.
 *  - `throw`       — `null`/`undefined` → `undefined`; bad string throws `${label} must be valid JSON: …`.
 *  - `{ fallback }` — `null`/`undefined` or bad string → the supplied fallback.
 * `requireObject` (with `parseError`/`shapeError` messages) additionally rejects
 * non-object / array results — used for `extracted_data`.
 */
function coerceJson(value: unknown, opts: { onError: 'keep' }): unknown;
function coerceJson<T>(value: unknown, opts: { onError: 'throw'; label: string }): T | undefined;
function coerceJson<T>(value: unknown, opts: { onError: { fallback: T } }): T;
function coerceJson(
  value: unknown,
  opts: { requireObject: { parseError: string; shapeError: string } }
): Record<string, unknown>;
function coerceJson(
  value: unknown,
  opts: {
    onError?: 'keep' | 'throw' | { fallback: unknown };
    label?: string;
    requireObject?: { parseError: string; shapeError: string };
  }
): unknown {
  let parsed: unknown;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      if (opts.requireObject) throw new Error(opts.requireObject.parseError);
      if (opts.onError === 'keep') return value;
      if (opts.onError === 'throw') {
        throw new Error(`${opts.label} must be valid JSON: ${getErrorMessage(error)}`);
      }
      if (opts.onError) return opts.onError.fallback;
      throw error;
    }
  } else if (value === undefined || value === null) {
    if (opts.requireObject) {
      // fall through to the shape check below
    } else if (opts.onError === 'throw') {
      return undefined;
    } else if (opts.onError && opts.onError !== 'keep') {
      return opts.onError.fallback;
    }
    parsed = value;
  } else {
    parsed = value;
  }

  if (opts.requireObject) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(opts.requireObject.shapeError);
    }
  }
  return parsed;
}

export function parseJson(value: unknown): any {
  return coerceJson(value, { onError: 'keep' });
}

export function normalizeExtractedData(value: unknown): Record<string, unknown> {
  return coerceJson(value, {
    requireObject: {
      parseError: 'extracted_data must be a valid JSON object. Received an invalid JSON string.',
      shapeError:
        "extracted_data must be a JSON object matching the Behavior's extraction contract.",
    },
  });
}

export function parseJsonInput<T>(value: unknown, label: string): T | undefined {
  return coerceJson<T>(value, { onError: 'throw', label });
}

export function normalizeStoredJsonField<T>(value: unknown, fallback: T): T {
  return coerceJson<T>(value, { onError: { fallback } });
}

export function toJsonParam(sql: DbClient, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  return sql.json(value);
}

export function toTextArrayParam(values: string[]): string {
  // Same trim/drop-empty/dedupe as the review's proposedAfter (one core helper),
  // so displayed tags == stored tags.
  const arr = normalizeBehaviorTags(values);
  if (arr.length === 0) return '{}';
  return (
    '{' + arr.map((v) => '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}'
  );
}

export function summarizeResults(results: WatcherOperationResult[]) {
  const successful = results.filter((r) => r.success).length;
  return {
    total: results.length,
    successful,
    failed: results.length - successful,
  };
}

// ============================================
// Watcher config validation
// ============================================

function validateWatcherConfig(input: {
  prompt?: string;
  classifiers?: unknown[];
  sources?: Array<{ name: string; query: string }>;
}): string | null {
  // Instruction PRESENCE is trigger-shape-dependent (event-turn Behaviors may
  // run with no instruction text) and is enforced by assertBehaviorInstructions
  // when either instructions or triggers change — here an absent or empty
  // prompt is structurally valid.
  //
  // Prompts are literal instruction text — no templating layer — so `{{` is
  // legal prose and there is nothing else to validate about the shape.
  if (input.prompt !== undefined && typeof input.prompt !== 'string') {
    return 'prompt must be a string';
  }

  // The output contract is no longer authored on the watcher. An entity-typed
  // watcher (keying_config.entity_type) derives it from that entity type's
  // metadata_schema at runtime; an untyped watcher runs the worker's free-form
  // summary fallback. There is no inline watcher schema input.

  if (input.classifiers !== undefined) {
    if (!Array.isArray(input.classifiers)) {
      return 'classifiers must be an array';
    }
    // Guard the write hole behind the classifier corruption bug (#2033 item 4):
    // a classifier's `attribute_values` MUST be a keyed object-MAP, never an
    // array. An array shape read back through Object.entries becomes numeric
    // keys `{"0":…}` and, after embedding-stripping, the corrupted
    // `{"0":{},"1":{}}`. Reject the array shape at save time so it can never be
    // persisted into a behavior version's `classifiers` blob.
    for (let i = 0; i < input.classifiers.length; i++) {
      const def = input.classifiers[i];
      if (def === null || typeof def !== 'object' || Array.isArray(def)) {
        return `classifiers[${i}]: each classifier definition must be an object`;
      }
      const attributeValues = (def as Record<string, unknown>).attribute_values;
      if (attributeValues !== undefined && attributeValues !== null) {
        if (typeof attributeValues !== 'object' || Array.isArray(attributeValues)) {
          return `classifiers[${i}].attribute_values: must be an object map keyed by value (got ${
            Array.isArray(attributeValues) ? 'array' : typeof attributeValues
          }). An array shape corrupts on read.`;
        }
      }
    }
  }

  if (input.sources) {
    for (const source of input.sources) {
      let refKind: ReturnType<typeof validateWatcherSourceRef>;
      try {
        refKind = validateWatcherSourceRef(source.name, source.query);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      if (refKind) continue;

      const trimmed = source.query.trim().toUpperCase();
      if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
        return `source "${source.name}": query must be a SELECT statement (read-only)`;
      }
      // Watcher-mode content aggregation keys every row by `id` and the signed
      // window_token only carries those ids; a source that omits `id` yields
      // content_linked: 0 at complete_window and SILENTLY skips the reaction.
      // Reject it at save time so the failure is loud, not invisible.
      if (!queryProjectsIdColumn(source.query)) {
        return `source "${source.name}": query must project an "id" column (e.g. SELECT id, ... FROM events). Without it the reaction is silently skipped because no content can be linked to the window.`;
      }
    }
  }

  return null;
}

/**
 * Run the shared watcher-version validation (config shape + classifier/schema
 * source-path compatibility) and throw a `ToolUserError` (422) on the first
 * failure. Schedule validation is intentionally left to the caller because
 * `create` and `create_version` surface schedule errors with different error
 * types.
 */
export function assertWatcherVersionConfigValid(parsed: {
  prompt?: string;
  classifiers?: unknown[];
  sources?: Array<{ name: string; query: string }>;
}): void {
  const validation = validateWatcherConfig({
    prompt: parsed.prompt,
    classifiers: parsed.classifiers,
    sources: parsed.sources,
  });
  if (validation) {
    throw new ToolUserError(`Behavior validation failed: ${validation}`, 422);
  }
}

/**
 * Resolve every @ref source against the org at save time so a typo fails here
 * (loud 422) rather than silently producing empty context at read_knowledge.
 * Custom-SQL sources are skipped (id projection is already enforced by
 * {@link assertWatcherVersionConfigValid}). Call after the organization id is
 * known and before the watcher/version row is persisted.
 */
export async function assertWatcherSourcesResolve(
  sql: DbClient,
  organizationId: string,
  sources: Array<{ name: string; query: string }>,
  // The Behavior's entity_ids (empty/omitted for an org-scoped Behavior), so
  // {{entityId}} in a custom-SQL source validates exactly as it runs.
  entityIds: number[] = []
): Promise<void> {
  try {
    await resolveWatcherSourcesForSave(sql, organizationId, sources, entityIds);
  } catch (err) {
    throw new ToolUserError(
      `Behavior validation failed: ${err instanceof Error ? err.message : String(err)}`,
      422
    );
  }
}

// ============================================
// Foreign-key-shaped reference validation
// ============================================

/**
 * Resolve `agent_id` against the caller's org before it is persisted.
 *
 * `watchers.agent_id` is NOT NULL but carries NO foreign key to `agents`, so a
 * typo'd or cross-org id is accepted by the database and only surfaces as a
 * Behavior that reports status 'active' / health 'healthy' and never runs — the
 * scheduler joins watchers to agents on `agent_id` (see watchers/automation.ts),
 * so an unresolvable owner silently drops the row out of every scheduling pass.
 * `behaviors.create` already documents `throws: ["EntityNotFound"]` for this
 * case in src/sandbox/method-metadata.ts; this honours that contract.
 *
 * Org-scoped by design: `agents` ids are unique only WITHIN an org, so resolving
 * without the org fence would let one tenant name another tenant's agent.
 * Matches the 404 shape manage_agents' own get/update handlers emit.
 */
export async function assertAgentExists(
  sql: DbClient,
  organizationId: string,
  agentId: string | null | undefined
): Promise<void> {
  if (agentId == null) return;
  const rows = await sql<{ id: string }>`
    SELECT id FROM agents
    WHERE organization_id = ${organizationId} AND id = ${agentId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    throw new ToolUserError(`Agent "${agentId}" not found`, 404);
  }
}

/**
 * Resolve `keying_config.entity_type` against the org before it is persisted.
 *
 * An entity-typed Behavior derives its whole output contract from the named
 * type's `metadata_schema`. When the type does not exist,
 * `deriveWatcherExtractionSchema()` returns null and complete_window SKIPS
 * extraction validation entirely — so a typo does not fail loudly, it silently
 * VOIDS the contract the Behavior was created to enforce. Its sibling
 * `entity_id` is already existence-checked at create, so validating here makes
 * the pair consistent.
 *
 * Uses the same tenant-first-then-public-catalog visibility rule as
 * `resolveEntityTypeMetadataSchema()` (watcher-extraction-schema.ts) so a type
 * that derivation CAN see is never rejected here — checking existence only, as
 * a type legitimately may carry no metadata_schema yet.
 */
export async function assertKeyingConfigEntityTypeExists(
  sql: DbClient,
  organizationId: string,
  keyingConfig: Record<string, unknown> | null | undefined
): Promise<void> {
  const rawType = keyingConfig?.entity_type;
  if (typeof rawType !== 'string') return;
  const entityType = rawType.trim();
  if (!entityType) return;

  const rows = await sql<{ id: number }>`
    SELECT et.id
    FROM entity_types et
    LEFT JOIN organization o ON o.id = et.organization_id
    WHERE et.slug = ${entityType}
      AND et.deleted_at IS NULL
      AND (et.organization_id = ${organizationId} OR o.visibility = 'public')
    LIMIT 1
  `;
  if (rows.length === 0) {
    throw new ToolUserError(
      `Unknown entity type '${entityType}' in keying_config. Use manage_entity_schema(schema_type="entity_type", action="list") to list available types or create a custom type first.`,
      422
    );
  }
}

// ============================================
// Watcher access control
// ============================================

function parseWatcherEntityIds(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number).filter((id) => Number.isFinite(id));
  if (typeof raw === 'string') {
    return raw
      .replace(/[{}]/g, '')
      .split(',')
      .filter(Boolean)
      .map(Number)
      .filter((id) => Number.isFinite(id));
  }
  return [];
}

async function getWatcherAccessRows(
  watcherIds: string[],
  organizationId: string | null | undefined,
): Promise<WatcherAccessRow[]> {
  if (watcherIds.length === 0) return [];
  const sql = getDb();
  // Always scope the read to the caller's org so a TOCTOU swap of watcher_id
  // to another tenant's row cannot surface foreign organization_id/entity_ids
  // into the access check (and so mutating paths that reuse these ids stay
  // org-bound at the first load).
  if (!organizationId) return [];
  const placeholders = watcherIds.map((_, idx) => `$${idx + 2}`).join(',');
  return sql.unsafe<WatcherAccessRow>(
    `SELECT id, organization_id, entity_ids FROM watchers
     WHERE organization_id = $1 AND id IN (${placeholders})`,
    [organizationId, ...watcherIds],
  );
}

/**
 * Existence probe across all orgs for the given watcher ids, reading ONLY the
 * id column — never organization_id/entity_ids. The org-scoped
 * {@link getWatcherAccessRows} load stays the single source of truth for every
 * actual access decision (TOCTOU-safe); this probe exists purely to tell a
 * cross-org id (exists under another tenant — a 403 access fault) apart from an
 * id that exists nowhere (which a mutation handler must be allowed to report
 * per-id, e.g. delete's all-failed "not found or already archived" aggregate).
 */
async function findExistingWatcherIds(watcherIds: string[]): Promise<Set<string>> {
  if (watcherIds.length === 0) return new Set();
  const sql = getDb();
  const placeholders = watcherIds.map((_, idx) => `$${idx + 1}`).join(',');
  const rows = await sql.unsafe<{ id: string | number }>(
    `SELECT id FROM watchers WHERE id IN (${placeholders})`,
    watcherIds,
  );
  return new Set(rows.map((row) => String(row.id)));
}

export async function requireWatcherAccess(
  sql: DbClient,
  watcherIds: string[],
  ctx: ToolContext,
  mode: WatcherAccessMode,
  opts?: { allowMissing?: boolean }
): Promise<void> {
  const uniqueWatcherIds = [...new Set(watcherIds)];
  const rows = await getWatcherAccessRows(uniqueWatcherIds, ctx.organizationId);
  if (rows.length !== uniqueWatcherIds.length) {
    // Some requested ids are absent from the caller's org. By default this is a
    // hard 403 — the strict gate every action but delete relies on, so no
    // action reaches a handler with an id it did not prove in-org.
    //
    // `allowMissing` (delete only) relaxes this ONE case: an id that exists
    // nowhere may fall through so the handler reports it per-id (delete's
    // all-failed "not found or already archived" aggregate). A cross-org id
    // (exists under another tenant) is STILL a 403 — never fall through for it,
    // or a caller could probe/hit foreign rows on the sequential id space.
    const foundIds = new Set(rows.map((row) => String(row.id)));
    const missingIds = uniqueWatcherIds.filter((id) => !foundIds.has(String(id)));
    if (opts?.allowMissing) {
      const existElsewhere = await findExistingWatcherIds(missingIds);
      if (existElsewhere.size > 0) {
        throw new ToolUserError(
          'Access denied: one or more Behaviors were not found in your organization',
          403,
        );
      }
    } else {
      throw new ToolUserError(
        'Access denied: one or more Behaviors were not found in your organization',
        403,
      );
    }
  }

  for (const row of rows) {
    const watcherOrgId = row.organization_id ? String(row.organization_id) : null;
    if (!watcherOrgId || watcherOrgId !== ctx.organizationId) {
      // Cross-org access attempt is a client/permission fault, not a server
      // error — surface it as a 403 ToolUserError so the REST layer returns the
      // right status and it stays out of the operational alert feed.
      throw new ToolUserError(
        `Access denied: Behavior ${row.id} does not belong to your organization`,
        403
      );
    }

    const entityIds = parseWatcherEntityIds(row.entity_ids);
    if (entityIds.length > 0) {
      for (const entityId of entityIds) {
        if (mode === 'write') {
          await requireWriteAccess(sql, entityId, ctx);
        } else {
          await requireReadAccess(sql, entityId, ctx);
        }
      }
      continue;
    }

    if (mode === 'write') {
      await requireOrgWriteAccess(sql, ctx);
    } else {
      await requireOrgReadAccess(sql, ctx);
    }
  }
}

// ============================================
// Batch content counting
// ============================================

import { entityLinkMatchSql } from '../../../utils/content-search';
import { getErrorMessage } from '@lobu/core';

/**
 * Batch count unanalyzed content for multiple watchers in a single query.
 * Returns a map of watcher_id -> count of content not yet in any window for that watcher.
 */
export async function batchCountUnanalyzedContent(
  watcherIds: number[]
): Promise<Map<number, { pending: number; historical: number }>> {
  if (watcherIds.length === 0) {
    return new Map();
  }

  const sql = getDb();

  const placeholders = watcherIds.map((_, i) => `$${i + 1}`).join(', ');

  // The "total content" count joins current_event_records on the entity link
  // for every watcher in the result. On high-volume entities this scans
  // 100K+ rows per Behavior and dominates list latency (8-12s on
  // prod for orgs with even a single Reddit-Digest-class watcher).
  //
  // Cap the per-watcher total at TOTAL_CAP rows. The badge derived from
  // `pending_count = total - analyzed` becomes "TOTAL_CAP+ - analyzed"
  // semantics above the cap; the only consumer is a list-row badge that
  // doesn't need exact counts above a threshold.
  const TOTAL_CAP = 1000;
  const result = await sql.unsafe(
    `
    WITH watcher_entities AS (
      SELECT i.id as watcher_id, unnest(i.entity_ids) as entity_id
      FROM watchers i
      WHERE i.id IN (${placeholders})
        AND array_length(i.entity_ids, 1) > 0
    ),
    analyzed_counts AS (
      -- Canvas-on-events: window_id link rows carry a denormalized watcher_id, so
      -- count analyzed events directly off watcher_window_events without a join
      -- through the retired watcher_windows table.
      SELECT
        ie.watcher_id,
        COUNT(DISTINCT iwc.event_id) as analyzed_count
      FROM (SELECT DISTINCT watcher_id FROM watcher_entities) ie
      LEFT JOIN watcher_window_events iwc ON iwc.watcher_id = ie.watcher_id
      GROUP BY ie.watcher_id
    ),
    total_counts AS (
      SELECT
        wid AS watcher_id,
        (SELECT COUNT(*) FROM (
          SELECT 1 FROM watcher_entities ie
          JOIN current_event_records f ON ${entityLinkMatchSql('ie.entity_id::bigint', 'f')}
          WHERE ie.watcher_id = wid
          LIMIT ${TOTAL_CAP}
        ) capped) AS total_count
      FROM (SELECT DISTINCT watcher_id AS wid FROM watcher_entities) per_watcher
    )
    SELECT
      ac.watcher_id,
      CAST(GREATEST(COALESCE(tc.total_count, 0) - COALESCE(ac.analyzed_count, 0), 0) AS INTEGER) as pending_count,
      0 as historical_count
    FROM analyzed_counts ac
    LEFT JOIN total_counts tc ON tc.watcher_id = ac.watcher_id
    `,
    watcherIds
  );

  const counts = new Map<number, { pending: number; historical: number }>();
  for (const row of result) {
    counts.set(Number(row.watcher_id), {
      pending: (row.pending_count as number) ?? 0,
      historical: (row.historical_count as number) ?? 0,
    });
  }

  for (const id of watcherIds) {
    if (!counts.has(id)) {
      counts.set(id, { pending: 0, historical: 0 });
    }
  }

  return counts;
}
