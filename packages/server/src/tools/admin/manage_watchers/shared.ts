/**
 * Shared types, utilities, and helpers used across manage_watchers sub-handlers.
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
import { validateTemplate } from '../../../watchers/renderer';
import { validateClassifierSourcePaths, validateExtractionSchema } from '../../../watchers/validator';
import { queryProjectsIdColumn } from '../../../utils/execute-data-sources';
import type { ToolContext } from '../../registry';

// ============================================
// Types
// ============================================

export interface WatcherOperationResult {
  watcher_id: string;
  success: boolean;
  message: string;
  version?: number;
}

export type WatcherAccessMode = 'read' | 'write';

export interface WatcherAccessRow {
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
export function coerceJson(value: unknown, opts: { onError: 'keep' }): unknown;
export function coerceJson<T>(value: unknown, opts: { onError: 'throw'; label: string }): T | undefined;
export function coerceJson<T>(value: unknown, opts: { onError: { fallback: T } }): T;
export function coerceJson(
  value: unknown,
  opts: { requireObject: { parseError: string; shapeError: string } }
): Record<string, unknown>;
export function coerceJson(
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
        throw new Error(
          `${opts.label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
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
      shapeError: 'extracted_data must be a JSON object matching the template extraction_schema.',
    },
  });
}

export function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value.length > 0)
    )
  );
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
  const arr = normalizeStringArray(values);
  if (arr.length === 0) return '{}';
  return (
    '{' + arr.map((v) => '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}'
  );
}

export function summarizeResults(results: WatcherOperationResult[]) {
  const successful = results.filter((r) => r.success).length;
  return { total: results.length, successful, failed: results.length - successful };
}

// ============================================
// Watcher config validation
// ============================================

export function validateWatcherConfig(input: {
  prompt?: string;
  extraction_schema?: unknown;
  classifiers?: unknown[];
  sources?: Array<{ name: string; query: string }>;
}): string | null {
  if (!input.prompt || typeof input.prompt !== 'string') {
    return 'prompt is required and must be a string';
  }

  const templateValidation = validateTemplate(input.prompt);
  if (templateValidation) {
    return `prompt: ${templateValidation}`;
  }

  if (!input.extraction_schema || typeof input.extraction_schema !== 'object') {
    return 'extraction_schema is required and must be an object';
  }

  const schemaValidation = validateExtractionSchema(input.extraction_schema);
  if (schemaValidation) {
    return `extraction_schema: ${schemaValidation}`;
  }

  if (input.classifiers !== undefined) {
    if (!Array.isArray(input.classifiers)) {
      return 'classifiers must be an array';
    }
  }

  if (input.sources) {
    for (const source of input.sources) {
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
  extractionSchema?: unknown;
  classifiers?: unknown[];
  sources?: Array<{ name: string; query: string }>;
}): void {
  const validation = validateWatcherConfig({
    prompt: parsed.prompt,
    extraction_schema: parsed.extractionSchema,
    classifiers: parsed.classifiers,
    sources: parsed.sources,
  });
  if (validation) {
    throw new ToolUserError(`Watcher validation failed: ${validation}`, 422);
  }

  if (parsed.classifiers && parsed.extractionSchema) {
    const classifierValidation = validateClassifierSourcePaths(
      parsed.classifiers as Array<{ slug: string; source_path?: string }>,
      parsed.extractionSchema
    );
    if (classifierValidation) {
      throw new ToolUserError(`Classifier-schema compatibility error: ${classifierValidation}`, 422);
    }
  }
}

// ============================================
// Watcher access control
// ============================================

export function parseWatcherEntityIds(raw: unknown): number[] {
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

export async function getWatcherAccessRows(watcherIds: string[]): Promise<WatcherAccessRow[]> {
  if (watcherIds.length === 0) return [];
  const sql = getDb();
  const placeholders = watcherIds.map((_, idx) => `$${idx + 1}`).join(',');
  return sql.unsafe<WatcherAccessRow>(
    `SELECT id, organization_id, entity_ids FROM watchers WHERE id IN (${placeholders})`,
    watcherIds
  );
}

export async function requireWatcherAccess(
  sql: DbClient,
  watcherIds: string[],
  ctx: ToolContext,
  mode: WatcherAccessMode
): Promise<void> {
  const rows = await getWatcherAccessRows(watcherIds);

  for (const row of rows) {
    const watcherOrgId = row.organization_id ? String(row.organization_id) : null;
    if (!watcherOrgId || watcherOrgId !== ctx.organizationId) {
      throw new Error(`Access denied: watcher ${row.id} does not belong to your organization`);
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
  // 100K+ rows per watcher and dominates list_watchers latency (8-12s on
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
      SELECT
        ie.watcher_id,
        COUNT(DISTINCT iwc.event_id) as analyzed_count
      FROM (SELECT DISTINCT watcher_id FROM watcher_entities) ie
      LEFT JOIN watcher_windows iw ON iw.watcher_id = ie.watcher_id
      LEFT JOIN watcher_window_events iwc ON iwc.window_id = iw.id
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
