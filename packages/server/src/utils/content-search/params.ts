/**
 * Standard parameter-building helpers for the listing path:
 * buildStandardParams, buildStandardWhereSql, WINDOW_JOIN_SQL.
 */

import { pgTextArray } from '../../db/client';
import type { ContentSearchOptions } from './types';

export function buildStandardParams(
  options: ContentSearchOptions & { offset?: number },
  extra: {
    sinceDate: Date | null;
    untilDate: Date | null;
  }
): any[] {
  return [
    options.entity_id ?? null,
    options.platform ?? null,
    extra.sinceDate?.toISOString() ?? null,
    extra.untilDate?.toISOString() ?? null,
    options.window_id ?? null,
    options.engagement_min ?? null,
    options.engagement_max ?? null,
    options.classification_source ?? null,
    // Slot $9 binds a Postgres `text[]` literal (e.g. `'{note,summary}'`); the
    // standard WHERE template uses `= ANY($9::text[])`, covering single- and
    // multi-type callers with one predicate. We hand-format the literal because
    // `sql.unsafe(...)` binding doesn't auto-cast JS arrays.
    options.semantic_type
      ? pgTextArray(
          Array.isArray(options.semantic_type) ? options.semantic_type : [options.semantic_type]
        )
      : null,
    options.interaction_status ?? null,
    // Slot $11 — per-agent memory scope. WHERE template uses
    // `($11::text IS NULL OR f.metadata->>'agent_id' = $11::text)`.
    options.agent_id ?? null,
  ];
}

/**
 * Build the shared `WHERE` skeleton used by `listContentInternal` for both
 * its count and list queries.
 *
 * `entityLinkSql` is the per-request fragment for "which events belong to
 * this entity" — see `buildEntityLinkUnion`. Pre-computing it once and
 * passing it in avoids re-emitting (and re-planning) the 7-branch generic
 * UNION for every query.
 */
export function buildStandardWhereSql(entityLinkSql: string): string {
  return `($1::bigint IS NULL OR ${entityLinkSql})
          AND ($2::text IS NULL OR f.connector_key = $2::text)
          AND ($3::timestamptz IS NULL OR f.occurred_at >= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR f.occurred_at <= $4::timestamptz)
          AND ($5::int IS NULL OR iwf.window_id = $5::int)
          AND ($6::numeric IS NULL OR f.score >= $6::numeric)
          AND ($7::numeric IS NULL OR f.score <= $7::numeric)
          AND ($8::text IS NULL OR EXISTS (
            SELECT 1 FROM latest_event_classifications lc_source
            WHERE lc_source.event_id = f.id
              AND lc_source.source = $8::text
          ))
          AND ($9::text[] IS NULL OR f.semantic_type = ANY($9::text[]))
          AND ($10::text IS NULL OR f.interaction_status = $10::text)
          AND ($11::text IS NULL OR f.metadata->>'agent_id' = $11::text)`;
}

export const WINDOW_JOIN_SQL = `LEFT JOIN watcher_window_events iwf
          ON iwf.event_id = f.id
          AND ($5::int IS NOT NULL)
          AND iwf.window_id = $5::int`;
