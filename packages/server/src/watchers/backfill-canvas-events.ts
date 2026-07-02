/**
 * One-off backfill: fold historical `watcher_windows` rows into canvas-on-events.
 *
 * For each existing window this:
 *   1. Ensures the per-watcher canvas entity (entity_identities ns='watcher_canvas').
 *   2. Inserts the `canvas_state` ROOT event (created_at = window.created_at,
 *      occurred_at = window.window_end, payload_data = window.extracted_data,
 *      metadata = { watcher_id, granularity, window_start, window_end,
 *      content_analyzed, version_id }). Idempotent: the partial unique index
 *      idx_canvas_chain_root makes a replay a no-op (ON CONFLICT DO NOTHING).
 *   3. Fills the denormalized watcher_window_events.watcher_id for the window's
 *      link rows.
 *
 * Re-keying window_id references (watcher_reactions/runs/watcher_window_events/
 * event_classifications) onto the root event id is DEFERRED to Phase 3: those
 * columns carry a FK to watcher_windows(id) which is still live during this
 * dual-write release, so pointing them at an events id would violate the FK. The
 * read flip keys on period metadata (not on window_id = event id), so historical
 * windows read correctly from their canvas roots without the re-key. The re-key
 * runs once the FKs + watcher_windows are dropped in Phase 3.
 *
 * Scoping: EVERY query is scoped by watcher_windows / semantic_type='canvas_state'.
 * We NEVER pattern-match bare metadata.window_id — 19k+ tab_event/tab_snapshot
 * events use it for BROWSER windows and must not be touched.
 *
 * Prod has dozens of windows, so this is intentionally simple. It is idempotent
 * (re-running skips windows whose canvas root already exists and whose references
 * already point at the root id), so it is safe to replay.
 *
 * `fetch_types:false`: all binds here are scalar params; no raw JS array binds.
 */

import type { DbClient } from '../db/client';
import { ensureCanvasEntity } from '../utils/canvas-events';

export interface CanvasBackfillReport {
  windows: number;
  rootsCreated: number;
  rootsExisting: number;
  /** watcher_window_events rows whose denormalized watcher_id was filled. */
  windowEventsWatcherIdFilled: number;
  skipped: number;
  /** Windows whose per-window transaction failed (logged and skipped; re-run to retry). */
  failed: number;
}

interface WindowRow {
  id: number | string;
  watcher_id: number | string;
  organization_id: string;
  created_by: string | null;
  entity_ids: unknown;
  granularity: string;
  window_start: Date | string;
  window_end: Date | string;
  content_analyzed: number | string;
  extracted_data: unknown;
  version_id: number | string | null;
  created_at: Date | string | null;
}

function parseEntityIds(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === 'string') return raw.replace(/[{}]/g, '').split(',').filter(Boolean).map(Number);
  return [];
}

/**
 * Backfill canvas-on-events from watcher_windows. With `execute: false` it only
 * reports what WOULD change (dry-run: no writes).
 */
export async function backfillCanvasEvents(opts: {
  db: DbClient;
  org?: string | null;
  execute: boolean;
  log?: (msg: string) => void;
}): Promise<CanvasBackfillReport> {
  const { db: sql, execute } = opts;
  const log = opts.log ?? (() => {});
  const report: CanvasBackfillReport = {
    windows: 0,
    rootsCreated: 0,
    rootsExisting: 0,
    windowEventsWatcherIdFilled: 0,
    skipped: 0,
    failed: 0,
  };

  const windows = (await sql`
    SELECT
      ww.id, ww.watcher_id, w.organization_id, w.created_by, w.entity_ids,
      ww.granularity, ww.window_start, ww.window_end, ww.content_analyzed,
      ww.extracted_data, ww.version_id, ww.created_at
    FROM watcher_windows ww
    JOIN watchers w ON w.id = ww.watcher_id
    ${opts.org ? sql`WHERE w.organization_id = ${opts.org}` : sql``}
    ORDER BY ww.id ASC
  `) as unknown as WindowRow[];

  log(`Found ${windows.length} watcher_windows row(s) to backfill.`);

  for (const ww of windows) {
    report.windows += 1;
    const oldWindowId = Number(ww.id);
    const watcherId = Number(ww.watcher_id);
    const windowStartIso = new Date(ww.window_start as string).toISOString();
    const windowEndIso = new Date(ww.window_end as string).toISOString();

    if (!execute) {
      // Dry-run: report whether a root already exists.
      const existing = (await sql`
        SELECT 1 FROM events
        WHERE semantic_type = 'canvas_state'
          AND supersedes_event_id IS NULL
          AND (metadata->>'watcher_id')::bigint = ${watcherId}
          AND (metadata->>'granularity') = ${ww.granularity}
          AND (metadata->>'window_start')::timestamptz = ${windowStartIso}
        LIMIT 1
      `) as unknown as unknown[];
      if (existing.length > 0) report.rootsExisting += 1;
      else report.rootsCreated += 1;
      continue;
    }

    await sql.begin(async (tx) => {
      const parentEntityId = parseEntityIds(ww.entity_ids)[0] ?? null;
      const canvasEntityId = await ensureCanvasEntity({
        tx,
        watcherId,
        organizationId: ww.organization_id,
        parentEntityId,
        createdBy: ww.created_by,
      });
      const entityIdsValue = canvasEntityId != null ? `{${canvasEntityId}}` : null;

      // Insert the ROOT canvas_state event with the window's original created_at.
      // ON CONFLICT on the partial unique index makes a replay a no-op. We must
      // use a raw INSERT (not insertEvent) to control created_at.
      const inserted = (await tx`
        INSERT INTO events (
          entity_ids, organization_id, origin_id, payload_type, payload_data,
          semantic_type, metadata, occurred_at, created_by, created_at
        ) VALUES (
          ${entityIdsValue}::bigint[],
          ${ww.organization_id},
          ${`canvas_backfill_${oldWindowId}`},
          'json_template',
          ${tx.json((ww.extracted_data as Record<string, unknown>) ?? {})},
          'canvas_state',
          ${tx.json({
            watcher_id: watcherId,
            granularity: ww.granularity,
            window_start: windowStartIso,
            window_end: windowEndIso,
            content_analyzed: Number(ww.content_analyzed) || 0,
            version_id: ww.version_id != null ? Number(ww.version_id) : null,
          })},
          ${windowEndIso},
          ${ww.created_by},
          ${ww.created_at ? new Date(ww.created_at as string) : new Date(ww.window_end as string)}
        )
        ON CONFLICT (
          ((metadata->>'watcher_id')::bigint),
          (metadata->>'granularity'),
          (metadata->>'window_start')
        ) WHERE (semantic_type = 'canvas_state' AND supersedes_event_id IS NULL)
        DO NOTHING
        RETURNING id
      `) as unknown as Array<{ id: number | string }>;

      let rootEventId: number;
      if (inserted.length > 0) {
        rootEventId = Number(inserted[0].id);
        report.rootsCreated += 1;
      } else {
        // Root already exists (idempotent replay) — resolve it.
        const existing = (await tx`
          SELECT id FROM events
          WHERE semantic_type = 'canvas_state'
            AND supersedes_event_id IS NULL
            AND (metadata->>'watcher_id')::bigint = ${watcherId}
            AND (metadata->>'granularity') = ${ww.granularity}
            AND (metadata->>'window_start')::timestamptz = ${windowStartIso}
          LIMIT 1
        `) as unknown as Array<{ id: number | string }>;
        if (existing.length === 0) {
          // No root landed and none exists — odd state (e.g. mismatched metadata).
          // Skip so we don't leave a half-done window.
          report.skipped += 1;
          return;
        }
        rootEventId = Number(existing[0].id);
        report.rootsExisting += 1;
      }
      void rootEventId; // root created/resolved; window_id re-key deferred (Phase 3).

      // Fill the denormalized watcher_window_events.watcher_id for this window's
      // link rows. This has no FK constraint (unlike window_id → watcher_windows),
      // so it is safe during dual-write. Scoped to the exact old window id.
      const wwe = (await tx`
        UPDATE watcher_window_events
        SET watcher_id = ${watcherId}
        WHERE window_id = ${oldWindowId} AND watcher_id IS NULL
        RETURNING id
      `) as unknown as unknown[];
      report.windowEventsWatcherIdFilled += wwe.length;
    }).catch((err: unknown) => {
      // One bad window (corrupt data, transient DB error) must not abort the
      // whole run — the per-window tx already rolled back, so log it, count it,
      // and continue. The backfill is idempotent: a re-run retries only the
      // failed windows (everything else no-ops on the unique root index).
      report.failed += 1;
      log(
        `window ${oldWindowId} (watcher ${watcherId}) FAILED, continuing: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
  }

  if (report.failed > 0) {
    log(`${report.failed} window(s) failed — re-run the backfill to retry them.`);
  }
  return report;
}
