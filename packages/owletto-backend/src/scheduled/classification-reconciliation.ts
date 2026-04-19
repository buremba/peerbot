/**
 * Scheduled Job: Classification Reconciliation (Safety Net)
 *
 * This is a FALLBACK mechanism. Classifications should normally be triggered by:
 * 1. Worker API (inline after content are saved with embeddings)
 * 2. Classifier enabled → runs inline (manage_classifiers)
 * 3. Classifier version updated → runs inline (auto-classifier)
 *
 * This reconciliation only catches edge cases where:
 * - Classification failed silently
 * - Worker crashed mid-processing
 * - Database was restored from backup
 *
 * Uses event data and embedding-based classification utilities.
 */

import { getDb, pgTextArray } from '../db/client';
import type { Env } from '../index';
import { entityLinkMatchSql } from '../utils/content-search';
import logger from '../utils/logger';

const MAX_ENTITIES_PER_RUN = 10; // Process up to 10 entities per cron run

async function getEnabledClassifiers(entityId: string | number): Promise<string[]> {
  const sql = getDb();
  const MAX_DEPTH = 10;
  let currentId: number | null = Number(entityId);
  let depth = 0;

  while (currentId !== null) {
    const rows = await sql`
      SELECT enabled_classifiers, parent_id
      FROM entities
      WHERE id = ${currentId}
    `;

    if (rows.length === 0) break;

    const row = rows[0] as any;
    if (row.enabled_classifiers !== null) {
      return Array.isArray(row.enabled_classifiers) ? row.enabled_classifiers : [];
    }

    currentId = row.parent_id;
    depth++;
    if (depth >= MAX_DEPTH) {
      throw new Error('Classifier inheritance depth exceeded');
    }
  }

  return [];
}

interface EntityRow {
  entity_id: number;
}

export async function runClassificationReconciliation(_env: Env): Promise<{
  entities_processed: number;
  content_classified: number;
}> {
  const sql = getDb();

  try {
    // Candidate entities: have embedded content to classify.
    const entities = await sql<EntityRow>`
      SELECT DISTINCT e.id as entity_id
      FROM entities e
      JOIN current_event_records ev ON e.id = ANY(ev.entity_ids)
      WHERE ev.embedding IS NOT NULL
      LIMIT ${MAX_ENTITIES_PER_RUN}
    `;

    if (entities.length === 0) {
      return {
        entities_processed: 0,
        content_classified: 0,
      };
    }

    logger.info(
      `[ClassificationReconciliation] Found ${entities.length} entities needing classification`
    );

    const { executeClassificationQuery } = await import('../utils/classification-query');

    let totalClassified = 0;

    for (const entity of entities) {
      const entityId = Number(entity.entity_id);

      try {
        // Get enabled classifiers for this entity
        const enabledClassifiers = await getEnabledClassifiers(entityId);

        if (enabledClassifiers.length === 0) {
          logger.info(
            `[ClassificationReconciliation] No classifiers enabled for entity ${entityId}`
          );
          continue;
        }

        // Skip entities where all embedded events are already classified for all enabled classifiers.
        const slugArray = pgTextArray(enabledClassifiers);
        const expectedCount = enabledClassifiers.length;
        const missingRows = await sql`
          SELECT 1
          FROM (
            SELECT
              ev.id,
              COUNT(DISTINCT CASE
                WHEN fc.slug = ANY(${slugArray}::text[]) THEN fc.slug
                ELSE NULL
              END) AS classified_count
            FROM current_event_records ev
            LEFT JOIN event_classifications ec ON ec.event_id = ev.id
            LEFT JOIN event_classifier_versions ecv ON ec.classifier_version_id = ecv.id
            LEFT JOIN event_classifiers fc ON ecv.classifier_id = fc.id
            WHERE ${sql.unsafe(entityLinkMatchSql(`${Number(entityId)}::bigint`, 'ev'))}
              AND ev.embedding IS NOT NULL
            GROUP BY ev.id
          ) per_event
          WHERE per_event.classified_count < ${expectedCount}
          LIMIT 1
        `;

        if (missingRows.length === 0) {
          continue;
        }

        // Classify all unclassified events for this entity
        try {
          const results = await executeClassificationQuery({
            mode: 'entity',
            entity_id: entityId,
            enabledClassifiers,
          });

          totalClassified += results.length;

          if (results.length > 0) {
            logger.info(
              `[ClassificationReconciliation] Classified ${results.length} content for entity ${entityId}`
            );
          }
        } catch (classifyError) {
          logger.warn(
            { error: classifyError, entity_id: entityId },
            '[ClassificationReconciliation] Entity classification failed'
          );
        }
      } catch (entityError) {
        logger.warn(
          { error: entityError, entity_id: entityId },
          '[ClassificationReconciliation] Entity processing failed'
        );
      }
    }

    logger.info(
      `[ClassificationReconciliation] Completed: ${entities.length} entities, ${totalClassified} content classified`
    );

    return {
      entities_processed: entities.length,
      content_classified: totalClassified,
    };
  } catch (error) {
    logger.error({ error }, '[ClassificationReconciliation] Failed');
    throw error;
  }
}
