/**
 * Scheduled Job: Trigger Embedding Backfill
 *
 * Runs periodically to check for events missing embeddings.
 * Creates a single 'embed_backfill' run per organization batch.
 * The worker claims the run, generates embeddings, and updates the events.
 */

import { getDb } from '../db/client';
import { needsEmbeddingSql } from '../utils/embeddings';
import type { Env } from '../index';
import logger from '../utils/logger';
import { isQueryCanceled, isUniqueViolation } from '../utils/pg-errors';
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

// Hard ceiling on the org-discovery scan below. The query is *designed* to be
// ~30ms (newest-N partial-index scan — see RECENT_SCAN_LIMIT), but its three
// correlated NOT EXISTS anti-joins degrade badly when the recent window fills
// with unembedded rows — e.g. the embeddings service is OOM-looping and not
// draining the backlog. On the shared single-instance DB node a scan that heavy
// spikes CPU enough to starve the Postgres liveness probe, which CNPG answers
// by RESTARTING the primary — a full prod outage with no replica to fail over
// to (incident 2026-06-22: this scan hit 14.5s and took prod down). Bounding it
// makes a degraded scan abort cheaply instead of melting the node; a skipped
// cycle is harmless — the next */5 tick retries, and createBackfillRun
// re-collects the exact ids per org regardless. Overridable for ops/tests.
const DISCOVERY_SCAN_TIMEOUT = process.env.EMBED_BACKFILL_SCAN_TIMEOUT || '8s';

interface BackfillResult {
  organizations: number;
  runsCreated: number;
  totalEvents: number;
}

interface OrgBatch {
  organization_id: string;
  event_count: number;
}

// A row needs (re)embedding when it has no representative (chunk 0) vector for
// the configured model — covering "no embedding at all", a stale model, and a
// NULL stamp. The shared predicate (utils/embeddings) keeps this identical to
// the worker fetch. Correlated anti-join lets the planner drive off `events`
// (and the partial index) instead of hash-joining the whole event_embeddings
// table. (The contract release adds the long-content "needs tail chunks" arm.)
function needsEmbeddingPredicate(): string {
  return needsEmbeddingSql('e');
}

// current_event_records masks superseded rows with this anti-join. We query the
// base `events` table directly (so the partial index is usable) and replicate
// the mask here. Correlates on `e`.
const NOT_SUPERSEDED_PREDICATE =
  'NOT EXISTS (SELECT 1 FROM events newer WHERE newer.supersedes_event_id = e.id)';

// Org-discovery scan, bounded by statement_timeout and run READ ONLY. Returns
// the per-org recent-window backlog counts (top 10). If the scan exceeds
// DISCOVERY_SCAN_TIMEOUT it is aborted by Postgres (SQLSTATE 57014) and we skip
// this cycle rather than error — see DISCOVERY_SCAN_TIMEOUT for why a heavy
// scan is dangerous. The timeout is set via tx.unsafe (SET rejects bind
// params; the value is a server-controlled constant, not user input).
async function discoverBacklogOrgs(needsEmbedding: string): Promise<readonly OrgBatch[]> {
  const sql = getDb();
  try {
    return await sql.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx.unsafe(`SET LOCAL statement_timeout = '${DISCOVERY_SCAN_TIMEOUT}'`);
      return await tx<OrgBatch>`
        SELECT organization_id, COUNT(*)::int AS event_count
        FROM (
          SELECT e.organization_id
          FROM events e
          WHERE e.payload_text IS NOT NULL
            AND e.payload_text != ''
            AND e.organization_id IS NOT NULL
            AND ${tx.unsafe(needsEmbedding)}
            AND ${tx.unsafe(NOT_SUPERSEDED_PREDICATE)}
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
      `;
    });
  } catch (error) {
    if (isQueryCanceled(error)) {
      logger.warn(
        { timeout: DISCOVERY_SCAN_TIMEOUT },
        '[EmbedBackfill] Org-discovery scan exceeded statement_timeout — skipping this cycle. The recent-events window is likely saturated with unembedded rows (embeddings service behind?); the scan was aborted to protect DB CPU.'
      );
      return [];
    }
    throw error;
  }
}

export async function triggerEmbedBackfill(_env: Env): Promise<BackfillResult> {
  const needsEmbedding = needsEmbeddingPredicate();

  try {
    let totalEvents = 0;

    const counts = await materializeDueItems<OrgBatch>({
      label: 'EmbedBackfill',
      // Find organizations with events missing/stale embeddings, grouped for
      // batch runs. Scoped to the most-recent RECENT_SCAN_LIMIT unembedded
      // events (the genuine backlog is recent — see RECENT_SCAN_LIMIT), then
      // grouped by org. event_count is the recent-window count, used only to
      // rank/log; createBackfillRun re-collects the exact ids per org. Bounded
      // by DISCOVERY_SCAN_TIMEOUT so a degraded scan can't spike DB CPU.
      fetchDue: () => discoverBacklogOrgs(needsEmbedding),
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
