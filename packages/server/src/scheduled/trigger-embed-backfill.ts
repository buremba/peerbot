/**
 * Scheduled Job: Trigger Embedding Backfill
 *
 * Runs periodically to check for events missing embeddings.
 * Creates a single 'embed_backfill' run per organization batch.
 * The worker claims the run, generates embeddings, and updates the events.
 */

import { getDb } from '../db/client';
import { configuredEmbeddingModelSqlLiteral } from '../utils/embeddings';
import type { Env } from '../index';
import logger from '../utils/logger';
import { isUniqueViolation } from '../utils/pg-errors';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../utils/run-statuses';
import { materializeDueItems } from './due-materializer';

const BATCH_LIMIT = 100;

// Org-discovery scans the most-recent unembedded events rather than the whole
// table. `events` is append-only and rows are embedded inline near insert, so
// the genuine backlog lives at the recent end (measured: >99% of it is in the
// newest id-decile). Scanning the newest N via the partial index makes the
// discovery query ~30ms instead of a ~1s full-table aggregation. N is large
// enough that every org with active backlog surfaces (only a handful ever do);
// the rare event that fails embedding and ages out of this window is still
// reclaimed once an org's recent backlog clears (then it IS the newest
// unembedded row — see the DESC scan in createBackfillRun).
const RECENT_SCAN_LIMIT = 5000;

interface BackfillResult {
  organizations: number;
  runsCreated: number;
  totalEvents: number;
}

interface OrgBatch {
  organization_id: string;
  event_count: number;
}

// A row needs (re)embedding when no embedding row is stamped with the configured
// model — covering "no embedding at all", a stale model, and a NULL stamp
// (legacy row written before stamping). `event_embeddings` is UNIQUE(event_id),
// so this NOT EXISTS is equivalent to the older `emb IS NULL OR embedding_model
// IS DISTINCT FROM <model>` LEFT-JOIN form, but as a correlated anti-join it lets
// the planner drive off `events` (and the idx_events_missing_embedding_backfill
// partial index) instead of hash-joining the whole event_embeddings table. The
// model is server config, inlined as a validated literal. Correlates on `e`.
function needsEmbeddingPredicate(): string {
  const model = configuredEmbeddingModelSqlLiteral();
  return `NOT EXISTS (SELECT 1 FROM event_embeddings emb WHERE emb.event_id = e.id AND emb.embedding_model = ${model})`;
}

// current_event_records masks superseded rows with this anti-join. We query the
// base `events` table directly (so the partial index is usable) and replicate
// the mask here. Correlates on `e`.
const NOT_SUPERSEDED_PREDICATE =
  'NOT EXISTS (SELECT 1 FROM events newer WHERE newer.supersedes_event_id = e.id)';

export async function triggerEmbedBackfill(_env: Env): Promise<BackfillResult> {
  const sql = getDb();
  const needsEmbedding = needsEmbeddingPredicate();

  try {
    let totalEvents = 0;

    const counts = await materializeDueItems<OrgBatch>({
      label: 'EmbedBackfill',
      // Find organizations with events missing/stale embeddings, grouped for
      // batch runs. Scoped to the most-recent RECENT_SCAN_LIMIT unembedded
      // events (the genuine backlog is recent — see RECENT_SCAN_LIMIT), then
      // grouped by org. event_count is the recent-window count, used only to
      // rank/log; createBackfillRun re-collects the exact ids per org.
      fetchDue: () => sql<OrgBatch>`
        SELECT organization_id, COUNT(*)::int AS event_count
        FROM (
          SELECT e.organization_id
          FROM events e
          WHERE e.payload_text IS NOT NULL
            AND e.payload_text != ''
            AND e.organization_id IS NOT NULL
            AND ${sql.unsafe(needsEmbedding)}
            AND ${sql.unsafe(NOT_SUPERSEDED_PREDICATE)}
            AND NOT EXISTS (
              SELECT 1
              FROM runs r
              WHERE r.organization_id = e.organization_id
                AND r.run_type = 'embed_backfill'
                AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
            )
          ORDER BY e.created_at DESC
          LIMIT ${RECENT_SCAN_LIMIT}
        ) sub
        GROUP BY organization_id
        ORDER BY event_count DESC
        LIMIT 10
      `,
      createRun: async (batch) => {
        const created = await createBackfillRun(batch.organization_id);
        if (!created) return 'skipped';
        totalEvents += batch.event_count;
        logger.info(
          { organization_id: batch.organization_id, event_count: batch.event_count },
          '[EmbedBackfill] Created run'
        );
        return 'created';
      },
      onError: (batch, error) => {
        logger.error(
          { error, organization_id: batch.organization_id },
          '[EmbedBackfill] Failed to create run'
        );
      },
      onDone: ({ runsCreated }) => {
        if (runsCreated > 0) {
          logger.info({ runsCreated, totalEvents }, '[EmbedBackfill] Batch complete');
        }
      },
    });

    return { organizations: counts.due, runsCreated: counts.runsCreated, totalEvents };
  } catch (error) {
    logger.error({ error }, '[EmbedBackfill] Error checking for missing embeddings');
    throw error;
  }
}

/**
 * Create a pending embed_backfill run for an organization.
 * Skips if one is already pending/running.
 */
async function createBackfillRun(organizationId: string): Promise<boolean> {
  const sql = getDb();

  const needsEmbedding = needsEmbeddingPredicate();

  try {
    return await sql.begin(async (tx) => {
      // Collect event IDs that need (re)embedding (up to batch limit). Newest
      // first: the backlog is recent (append-only + inline embedding), so the
      // DESC scan walks the partial index backward and short-circuits at the
      // limit instead of scanning the embedded tail. After a model swap every
      // row qualifies, so this still drains the whole history, newest-first.
      const events = await tx`
        SELECT e.id
        FROM events e
        WHERE e.organization_id = ${organizationId}
          AND e.payload_text IS NOT NULL
          AND e.payload_text != ''
          AND ${tx.unsafe(needsEmbedding)}
          AND ${tx.unsafe(NOT_SUPERSEDED_PREDICATE)}
        ORDER BY e.created_at DESC
        LIMIT ${BATCH_LIMIT}
      `;

      if (events.length === 0) {
        return false;
      }

      const eventIds = events.map((e) => Number(e.id));

      await tx`
        INSERT INTO runs (
          organization_id, run_type, status,
          approval_status, action_input, created_at
        ) VALUES (
          ${organizationId}, 'embed_backfill', 'pending',
          'auto', ${sql.json({ event_ids: eventIds })},
          current_timestamp
        )
      `;

      return true;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'idx_runs_active_embed_backfill_per_org')) {
      return false;
    }
    throw error;
  }
}
