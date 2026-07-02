/**
 * One-off backfill: populate `events.superseded_by` from the existing
 * `supersedes_event_id` edges.
 *
 * Context: migration 20260702200000_events_superseded_by adds the column but
 * does NOT fill it (a prior inline 1.5M-row UPDATE inside a migration caused an
 * outage). New superseding writes dual-write the column in the same tx as the
 * superseding INSERT (utils/insert-event.ts). This script fills the historical
 * rows out of band, in small batches with short sleeps, so it is safe to run
 * against a live prod database.
 *
 * `superseded_by` is the inverse edge of `supersedes_event_id`: for a row R
 * that was replaced by a newer row N (N.supersedes_event_id = R.id), we set
 * R.superseded_by = N.id. The partial unique index idx_events_superseded_by
 * guarantees at most one N per R, so this is an unambiguous 1:1 fill. This is
 * LINEAGE METADATA ONLY — never payload — so it does not violate the
 * append-only invariant (precedent: search_tsv is maintained post-insert).
 *
 * Idempotent + resumable: every batch only touches rows where
 * `superseded_by IS NULL`, so re-running after an interrupt (or after the
 * dual-write has already stamped some rows) simply skips already-filled rows.
 * Safe under concurrent live writes: the dual-write and this backfill both
 * guard on `superseded_by IS NULL`, and the unique index serializes supersede
 * winners, so neither can clobber the other.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STAGE 2 (view flip + partial index) — deploy ONLY after this backfill has
 * completed on the target DB. It is deliberately NOT committed as a migration
 * file: the migration runner (embedded-runtime.ts / dbmate) auto-applies every
 * unapplied migration in filename order at boot, which would flip the view
 * BEFORE the backfill finished and un-mask every not-yet-stamped superseded
 * row. Run this SQL by hand (or add it as a migration in the follow-up PR once
 * prod is fully backfilled):
 *
 *   -- Partial index backing the flipped predicate. Org-scoped chronological
 *   -- reads (get_content, metrics/compiler.ts rewrites events→
 *   -- current_event_records, utils/execute-data-sources.ts) filter on
 *   -- organization_id then order by created_at, so key the live-row index on
 *   -- (organization_id, created_at) restricted to live rows. CONCURRENTLY so
 *   -- the build never blocks writes.
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_live_org_created
 *       ON public.events (organization_id, created_at)
 *       WHERE superseded_by IS NULL;
 *
 *   -- Flip the view from the per-row anti-join to the cheap partial-index
 *   -- predicate. Column list MUST match the current definition (see migration
 *   -- 20260618140000_event_embeddings_contract.sql, which added the
 *   -- event_embeddings LEFT JOIN). Only the WHERE clause changes.
 *   CREATE OR REPLACE VIEW public.current_event_records AS
 *    SELECT e.id, e.organization_id, e.entity_ids, e.origin_id, e.title,
 *           e.payload_type, e.payload_text, e.payload_data, e.payload_template,
 *           e.attachments, e.metadata, e.score, emb.embedding, e.author_name,
 *           e.source_url, e.occurred_at, e.created_at, e.origin_parent_id,
 *           COALESCE(length(e.payload_text), 0) AS content_length,
 *           e.search_tsv, e.origin_type, e.connector_key, e.connection_id,
 *           e.feed_key, e.feed_id, e.run_id, e.semantic_type, e.client_id,
 *           e.created_by, e.interaction_type, e.interaction_status,
 *           e.interaction_input_schema, e.interaction_input,
 *           e.interaction_output, e.interaction_error, e.supersedes_event_id
 *      FROM (public.events e
 *        LEFT JOIN public.event_embeddings emb ON ((emb.event_id = e.id)))
 *     WHERE e.superseded_by IS NULL;
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { type DbClient, pgBigintArray } from '../db/client';

export interface BackfillSupersededByOptions {
  db: DbClient;
  /** Rows scanned per batch (default 5000). */
  batchSize?: number;
  /** Milliseconds to sleep between batches to avoid hammering a live DB (default 200). */
  sleepMs?: number;
  /** Dry-run: count what WOULD be filled without writing (default false). */
  execute?: boolean;
  log?: (msg: string) => void;
}

export interface BackfillSupersededByReport {
  /** Total rows whose `superseded_by` was (or would be) filled. */
  filled: number;
  /** Number of batches processed. */
  batches: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fill `events.superseded_by` for historical superseded rows. Walks the
 * supersede edges by ascending superseded-row id, so an interrupted run resumes
 * cleanly (every batch re-filters on `superseded_by IS NULL`).
 */
export async function backfillSupersededBy(
  opts: BackfillSupersededByOptions
): Promise<BackfillSupersededByReport> {
  const sql = opts.db;
  const batchSize = opts.batchSize ?? 5000;
  const sleepMs = opts.sleepMs ?? 200;
  // A production backfill must not silently no-op (batchSize 0 makes every
  // batch empty → reports "done" with nothing filled) or die on LIMIT/negative
  // sleep — reject bad knobs up front.
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`batchSize must be a positive integer (got ${String(opts.batchSize)})`);
  }
  if (!Number.isFinite(sleepMs) || sleepMs < 0) {
    throw new Error(`sleepMs must be a non-negative number (got ${String(opts.sleepMs)})`);
  }
  const execute = opts.execute ?? false;
  const log = opts.log ?? (() => {});

  let filled = 0;
  let batches = 0;
  // Cursor over the superseded row's id. Only advances past ids we've inspected;
  // combined with the `superseded_by IS NULL` guard this is resumable and never
  // reprocesses a filled row.
  let cursor = 0;

  for (;;) {
    // A superseded row (e) is one that some newer row (n) points at via
    // supersedes_event_id and whose superseded_by is not yet stamped. Grab a
    // batch of such rows past the cursor. `n.id` is the value we will stamp
    // onto e.superseded_by (the unique index guarantees one n per e).
    const candidates = (await sql`
      SELECT e.id AS superseded_id, n.id AS superseder_id
      FROM events e
      JOIN events n ON n.supersedes_event_id = e.id
      WHERE e.superseded_by IS NULL
        AND e.id > ${cursor}
      ORDER BY e.id ASC
      LIMIT ${batchSize}
    `) as unknown as Array<{ superseded_id: number; superseder_id: number }>;

    if (candidates.length === 0) break;

    batches++;
    cursor = Number(candidates[candidates.length - 1]!.superseded_id);

    if (execute) {
      const batchIds = candidates.map((r) => Number(r.superseded_id));
      // Correlated UPDATE, scoped to this batch's ids. Re-derives the superseder
      // from the live edge (n.supersedes_event_id) rather than trusting the
      // read, so a concurrent supersede that landed between the SELECT and here
      // is reflected. Guarded on `superseded_by IS NULL` so the live dual-write
      // path (insert-event.ts) always wins a race without being overwritten.
      const updated = (await sql`
        UPDATE events e
        SET superseded_by = n.id
        FROM events n
        WHERE n.supersedes_event_id = e.id
          AND e.superseded_by IS NULL
          AND e.id = ANY(${pgBigintArray(batchIds)}::bigint[])
        RETURNING e.id
      `) as unknown as Array<{ id: number }>;
      filled += updated.length;
    } else {
      filled += candidates.length;
    }

    log(
      `batch ${batches}: ${execute ? 'filled' : 'would fill'} ${filled} row(s) ` +
        `(cursor now at superseded id ${cursor})`
    );

    if (candidates.length < batchSize) break;
    if (sleepMs > 0) await sleep(sleepMs);
  }

  return { filled, batches };
}
