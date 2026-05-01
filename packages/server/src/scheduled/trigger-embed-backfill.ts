/**
 * Scheduled Job: Trigger Embedding Backfill
 *
 * Runs periodically to check for events missing embeddings.
 * Creates a single 'embed_backfill' run per organization batch.
 * The worker claims the run, generates embeddings, and updates the events.
 */

import { getDb } from '../db/client';
import type { Env } from '../index';
import logger from '../utils/logger';
import { isUniqueViolation } from '../utils/pg-errors';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../utils/run-statuses';

const BATCH_LIMIT = 100;

interface BackfillResult {
  organizations: number;
  runsCreated: number;
  totalEvents: number;
}

interface OrgBatch {
  organization_id: string;
  event_count: number;
}

export async function triggerEmbedBackfill(_env: Env): Promise<BackfillResult> {
  const sql = getDb();

  try {
    // Find organizations with events missing embeddings, grouped for batch runs
    const orgBatches = await sql<OrgBatch>`
      SELECT ev.organization_id, COUNT(*)::int AS event_count
      FROM current_event_records ev
      LEFT JOIN event_embeddings emb ON emb.event_id = ev.id
      WHERE emb.event_id IS NULL
        AND ev.payload_text IS NOT NULL
        AND ev.payload_text != ''
        AND ev.organization_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM runs r
          WHERE r.organization_id = ev.organization_id
            AND r.run_type = 'embed_backfill'
            AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
        )
      GROUP BY ev.organization_id
      ORDER BY event_count DESC
      LIMIT 10
    `;

    if (orgBatches.length === 0) {
      return { organizations: 0, runsCreated: 0, totalEvents: 0 };
    }

    let runsCreated = 0;
    let totalEvents = 0;

    for (const batch of orgBatches) {
      try {
        const created = await createBackfillRun(batch.organization_id);
        if (created) {
          runsCreated++;
          totalEvents += batch.event_count;
          logger.info(
            { organization_id: batch.organization_id, event_count: batch.event_count },
            '[EmbedBackfill] Created run'
          );
        }
      } catch (error) {
        logger.error(
          { error, organization_id: batch.organization_id },
          '[EmbedBackfill] Failed to create run'
        );
      }
    }

    if (runsCreated > 0) {
      logger.info({ runsCreated, totalEvents }, '[EmbedBackfill] Batch complete');
    }

    return { organizations: orgBatches.length, runsCreated, totalEvents };
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

  try {
    return await sql.begin(async (tx) => {
      // Collect event IDs that need embeddings (up to batch limit)
      const events = await tx`
        SELECT ev.id
        FROM current_event_records ev
        LEFT JOIN event_embeddings emb ON emb.event_id = ev.id
        WHERE emb.event_id IS NULL
          AND ev.payload_text IS NOT NULL
          AND ev.payload_text != ''
          AND ev.organization_id = ${organizationId}
        ORDER BY ev.created_at ASC
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
