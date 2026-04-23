/**
 * Shared Classification Query Utility
 *
 * Provides a unified classification query builder for both queue-based
 * and entity-based classification scenarios.
 *
 * Vector operations (cosine similarity) are computed in TypeScript.
 */

import { type DbClient, getDb } from '../db/client';
import { entityLinkMatchSql } from './content-search';
import logger from './logger';
import { combineEmbeddings, cosineSimilarity, roundTo4 } from './vector-math';

/**
 * Default weights for combining child and parent embeddings.
 * Child weight: 0.7 (70%) - emphasizes direct content
 * Parent weight: 0.3 (30%) - incorporates context
 */
const CHILD_EMBEDDING_WEIGHT = 0.7;
const PARENT_EMBEDDING_WEIGHT = 0.3;

interface ClassificationQueryOptions {
  /**
   * Target selection mode
   */
  mode: 'entity' | 'content_ids';

  /**
   * Enabled classifier slugs
   */
  enabledClassifiers: string[];

  /**
   * For mode='entity': Filter by entity type and ID
   */
  entity_type?: string;
  entity_id?: number;

  /**
   * For mode='content_ids': Specific content IDs to classify
   */
  content_ids?: number[];
}

// ── Internal types for intermediate data ───────────────────────────────

interface TargetContent {
  id: number;
  entity_ids: number[];
  parent_id: number | null;
  combined_embedding: number[];
}

interface ClassifierTemplate {
  classifier_id: number;
  version_id: number;
  min_similarity: number;
  fallback_value: string | null;
  attribute_value: string;
  parent_mapping: Record<string, string> | null;
  template_embedding: number[];
}

interface Similarity {
  content_id: number;
  classifier_id: number;
  attribute_value: string;
  parent_mapping: Record<string, string> | null;
  version_id: number;
  min_similarity: number;
  fallback_value: string | null;
  confidence: number;
}

interface BestMatch {
  content_id: number;
  classifier_id: number;
  value: string | null;
  parent_mapping: Record<string, string> | null;
  actual_confidence: number;
  met_threshold: boolean;
  threshold: number;
  best_match_attribute: string;
  version_id: number;
  fallback_value: string | null;
  confidences_map: Record<string, number>;
}

interface AllClassification {
  content_id: number;
  version_id: number;
  value: string;
  confidences_map: Record<string, number>;
  met_threshold: boolean;
  threshold: number;
  best_match_attribute: string;
  actual_confidence: number;
}

interface ClassifierVersionLookup {
  slug: string;
  version_id: number;
}

// ── Step 1: Fetch target content with embeddings ───────────────────────

async function fetchTargetContent(
  sql: DbClient,
  options: ClassificationQueryOptions
): Promise<TargetContent[]> {
  const { mode, enabledClassifiers } = options;

  // Build the classifier version IDs for the "not yet classified" check
  const classifierPlaceholders = enabledClassifiers.map((_, i) => `$${i + 1}`).join(', ');

  let targetRows: Array<{
    id: number;
    entity_ids: number[];
    parent_id: number | null;
    embedding: number[] | null;
    parent_embedding: number[] | null;
  }>;

  if (mode === 'content_ids') {
    const contentIds = options.content_ids!;
    const contentPlaceholders = contentIds.map((_, i) => `$${i + 1}`).join(', ');

    targetRows = await sql.unsafe(
      `SELECT DISTINCT
         f.id,
         f.entity_ids,
         NULL as parent_id,
         f.embedding,
         parent.embedding as parent_embedding
       FROM current_event_records f
       LEFT JOIN current_event_records parent ON parent.origin_id = f.origin_parent_id
       WHERE f.id IN (${contentPlaceholders})
         AND f.embedding IS NOT NULL`,
      contentIds
    );
  } else if (mode === 'entity') {
    const entityId = options.entity_id!;

    // Get current classifier version IDs
    const versionRows = await sql.unsafe<{ version_id: number }>(
      `SELECT fcv.id as version_id
       FROM event_classifiers fc
       JOIN event_classifier_versions fcv ON fc.id = fcv.classifier_id AND fcv.is_current = true
       WHERE fc.slug IN (${classifierPlaceholders})
         AND fc.status = 'active'
         AND fc.watcher_id IS NULL`,
      enabledClassifiers
    );
    const versionIds = versionRows.map((r) => r.version_id);

    if (versionIds.length === 0) return [];

    const versionPlaceholders = versionIds.map((_, i) => `$${i + 2}`).join(', ');
    targetRows = await sql.unsafe(
      `SELECT DISTINCT
         f.id,
         f.entity_ids,
         NULL as parent_id,
         f.embedding,
         parent.embedding as parent_embedding
       FROM current_event_records f
       LEFT JOIN current_event_records parent ON parent.origin_id = f.origin_parent_id
       WHERE (
           ${entityLinkMatchSql('$1::bigint')}
           OR (
             (SELECT parent_id FROM entities WHERE id = $1) IS NULL
             AND f.entity_ids && ARRAY(
               SELECT id FROM entities WHERE parent_id = $1 AND enabled_classifiers IS NULL
             )::bigint[]
           )
         )
         AND f.embedding IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM unnest(ARRAY[${versionPlaceholders}]::bigint[]) AS ccv(version_id)
           WHERE NOT EXISTS (
             SELECT 1 FROM event_classifications cc
             WHERE cc.event_id = f.id
               AND cc.classifier_version_id = ccv.version_id
               AND cc.source = 'embedding'
           )
         )`,
      [entityId, ...versionIds]
    );
  } else {
    throw new Error(`Invalid mode: ${mode}`);
  }

  // Compute combined embeddings in TypeScript
  return targetRows.map((row) => {
    const childEmb = row.embedding as number[];
    const parentEmb = row.parent_embedding as number[] | null;

    const combined =
      parentEmb != null
        ? combineEmbeddings(childEmb, parentEmb, CHILD_EMBEDDING_WEIGHT, PARENT_EMBEDDING_WEIGHT)
        : childEmb;

    return {
      id: row.id,
      entity_ids: row.entity_ids,
      parent_id: row.parent_id,
      combined_embedding: combined,
    };
  });
}

// ── Step 2: Fetch classifier templates ─────────────────────────────────

async function fetchClassifierTemplates(
  sql: DbClient,
  enabledClassifiers: string[],
  targetContent: TargetContent[]
): Promise<ClassifierTemplate[]> {
  if (targetContent.length === 0) return [];

  const classifierPlaceholders = enabledClassifiers.map((_, i) => `$${i + 1}`).join(', ');

  // Fetch classifier versions with their attribute_values JSON
  const rows = await sql.unsafe<{
    classifier_id: number;
    version_id: number;
    min_similarity: number;
    fallback_value: string | null;
    attribute_values: string | Record<string, unknown>;
    entity_ids: number[] | null;
  }>(
    `SELECT DISTINCT
       fc.id as classifier_id,
       fcv.id as version_id,
       fcv.min_similarity,
       fcv.fallback_value,
       fcv.attribute_values,
       fc.entity_ids
     FROM event_classifiers fc
     JOIN event_classifier_versions fcv
       ON fc.id = fcv.classifier_id AND fcv.is_current = true
     WHERE fc.slug IN (${classifierPlaceholders})
       AND fc.status = 'active'
       AND fc.watcher_id IS NULL`,
    enabledClassifiers
  );

  // Collect unique entity_ids from target content for scoping
  const targetEntityIds = new Set(targetContent.flatMap((tc) => tc.entity_ids));

  // Expand attribute_values JSON into individual templates in TypeScript
  const templates: ClassifierTemplate[] = [];

  for (const row of rows) {
    // Scope check: classifier must be global (empty entity_ids) OR overlap with target content entity_ids
    const classifierEntityIds = row.entity_ids ?? [];
    if (
      classifierEntityIds.length > 0 &&
      !classifierEntityIds.some((id) => targetEntityIds.has(id))
    ) {
      continue;
    }

    const attrValues = row.attribute_values as Record<string, unknown>;

    for (const [key, val] of Object.entries(attrValues)) {
      const attrObj = val as Record<string, unknown>;
      const embeddingArr = attrObj.embedding as number[] | undefined;
      if (!embeddingArr) continue;

      const parentMapping = attrObj.parent as Record<string, string> | undefined;

      templates.push({
        classifier_id: row.classifier_id,
        version_id: row.version_id,
        min_similarity: row.min_similarity,
        fallback_value: row.fallback_value,
        attribute_value: key,
        parent_mapping: parentMapping && typeof parentMapping === 'object' ? parentMapping : null,
        template_embedding: embeddingArr,
      });
    }
  }

  return templates;
}

// ── Step 3: Compute similarities in TypeScript ─────────────────────────

function computeSimilarities(
  targetContent: TargetContent[],
  templates: ClassifierTemplate[]
): Similarity[] {
  const similarities: Similarity[] = [];

  for (const tc of targetContent) {
    for (const ct of templates) {
      const confidence = cosineSimilarity(tc.combined_embedding, ct.template_embedding);
      similarities.push({
        content_id: tc.id,
        classifier_id: ct.classifier_id,
        attribute_value: ct.attribute_value,
        parent_mapping: ct.parent_mapping,
        version_id: ct.version_id,
        min_similarity: ct.min_similarity,
        fallback_value: ct.fallback_value,
        confidence,
      });
    }
  }

  return similarities;
}

// ── Step 4: Determine best matches ─────────────────────────────────────

function determineBestMatches(similarities: Similarity[]): BestMatch[] {
  // Group by (content_id, classifier_id)
  const groups = new Map<string, Similarity[]>();
  for (const s of similarities) {
    const key = `${s.content_id}:${s.classifier_id}`;
    const group = groups.get(key);
    if (group) {
      group.push(s);
    } else {
      groups.set(key, [s]);
    }
  }

  const bestMatches: BestMatch[] = [];

  for (const group of groups.values()) {
    // Build confidences map (all attribute_value -> confidence for this group)
    const confidencesMap: Record<string, number> = {};
    for (const s of group) {
      confidencesMap[s.attribute_value] = roundTo4(s.confidence);
    }

    // Sort by confidence descending and pick the best
    group.sort((a, b) => b.confidence - a.confidence);
    const best = group[0];

    const metThreshold = best.confidence >= best.min_similarity;
    const value = metThreshold ? best.attribute_value : best.fallback_value;
    const parentMapping = metThreshold ? best.parent_mapping : null;

    bestMatches.push({
      content_id: best.content_id,
      classifier_id: best.classifier_id,
      value,
      parent_mapping: parentMapping,
      actual_confidence: roundTo4(best.confidence),
      met_threshold: metThreshold,
      threshold: best.min_similarity,
      best_match_attribute: best.attribute_value,
      version_id: best.version_id,
      fallback_value: best.fallback_value,
      confidences_map: confidencesMap,
    });
  }

  return bestMatches;
}

// ── Step 5: Generate parent classifications ────────────────────────────

function generateParentClassifications(
  bestMatches: BestMatch[],
  classifierVersionLookup: Map<string, number>
): AllClassification[] {
  const parentClassifications: AllClassification[] = [];

  for (const bm of bestMatches) {
    if (bm.value == null || bm.parent_mapping == null) continue;

    for (const [parentSlug, parentValue] of Object.entries(bm.parent_mapping)) {
      const parentVersionId = classifierVersionLookup.get(parentSlug);
      if (parentVersionId == null) continue;

      parentClassifications.push({
        content_id: bm.content_id,
        version_id: parentVersionId,
        value: parentValue,
        confidences_map: {},
        met_threshold: true,
        threshold: 0,
        best_match_attribute: parentValue,
        actual_confidence: bm.actual_confidence,
      });
    }
  }

  return parentClassifications;
}

// ── Step 6: Fetch all classifier version slugs for parent lookups ──────

async function fetchAllClassifierVersions(sql: DbClient): Promise<ClassifierVersionLookup[]> {
  return sql.unsafe<ClassifierVersionLookup>(
    `SELECT fc.slug, fcv.id as version_id
     FROM event_classifiers fc
     JOIN event_classifier_versions fcv ON fc.id = fcv.classifier_id AND fcv.is_current = true
     WHERE fc.status = 'active' AND fc.watcher_id IS NULL`,
    []
  );
}

// ── Step 7: Upsert classifications via DELETE + INSERT ─────────────────

async function upsertClassifications(
  sql: DbClient,
  classifications: AllClassification[]
): Promise<{ content_id: number }[]> {
  if (classifications.length === 0) return [];

  // Deduplicate: for each (content_id, version_id), keep the one with highest confidence
  // and merge values/confidences (matches the old ON CONFLICT behavior)
  const deduped = new Map<string, AllClassification & { merged_values: string[] }>();
  for (const c of classifications) {
    const key = `${c.content_id}:${c.version_id}`;
    const existing = deduped.get(key);
    if (existing) {
      // Merge values (distinct)
      if (!existing.merged_values.includes(c.value)) {
        existing.merged_values.push(c.value);
      }
      // Merge confidences
      Object.assign(existing.confidences_map, c.confidences_map);
      // Keep higher confidence
      if (c.actual_confidence > existing.actual_confidence) {
        existing.met_threshold = c.met_threshold;
        existing.threshold = c.threshold;
        existing.best_match_attribute = c.best_match_attribute;
        existing.actual_confidence = c.actual_confidence;
      }
    } else {
      deduped.set(key, { ...c, merged_values: [c.value] });
    }
  }

  const allClassifications = [...deduped.values()];

  // Build the conflict keys for DELETE
  const deleteConditions = allClassifications.map((c) => ({
    event_id: c.content_id,
    version_id: c.version_id,
  }));

  // Delete existing non-manual embedding classifications for these (event_id, version_id) pairs
  // Process in batches to avoid overly long SQL
  const BATCH_SIZE = 500;
  for (let i = 0; i < deleteConditions.length; i += BATCH_SIZE) {
    const batch = deleteConditions.slice(i, i + BATCH_SIZE);
    const whereClauses = batch
      .map(
        (_, j) =>
          `(event_id = $${j * 2 + 1} AND classifier_version_id = $${j * 2 + 2} AND source = 'embedding' AND COALESCE(watcher_id, 0) = 0)`
      )
      .join(' OR ');
    const params = batch.flatMap((d) => [d.event_id, d.version_id]);

    await sql.unsafe(
      `DELETE FROM event_classifications
       WHERE NOT is_manual AND (${whereClauses})`,
      params
    );
  }

  // Insert new classifications in batches
  const affectedContentIds = new Set<number>();

  for (let i = 0; i < allClassifications.length; i += BATCH_SIZE) {
    const batch = allClassifications.slice(i, i + BATCH_SIZE);

    // Each row needs 10 params: event_id, classifier_version_id, values, confidences,
    // source, is_manual, met_threshold, threshold, best_match_attribute, embedding_confidence
    const valuePlaceholders = batch
      .map((_, j) => {
        const base = j * 10;
        return `($${base + 1}, $${base + 2}, NULL, NULL, $${base + 3}, $${base + 4}::JSON, 'embedding', false, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
      })
      .join(', ');

    const params = batch.flatMap((c) => [
      c.content_id,
      c.version_id,
      c.merged_values,
      JSON.stringify(c.confidences_map),
      c.met_threshold,
      c.threshold,
      c.best_match_attribute,
      c.actual_confidence,
    ]);

    await sql.unsafe(
      `INSERT INTO event_classifications (
         event_id, classifier_version_id, watcher_id, window_id,
         "values", confidences, source, is_manual,
         met_threshold, threshold, best_match_attribute, embedding_confidence
       )
       VALUES ${valuePlaceholders}`,
      params
    );

    for (const c of batch) {
      affectedContentIds.add(c.content_id);
    }
  }

  return [...affectedContentIds].map((content_id) => ({ content_id }));
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Execute classification query with shared logic.
 *
 * Returns array of {content_id} for successfully classified content.
 */
export async function executeClassificationQuery(
  options: ClassificationQueryOptions
): Promise<{ content_id: number }[]> {
  const { mode, enabledClassifiers } = options;

  if (enabledClassifiers.length === 0) {
    return [];
  }

  try {
    const sql = getDb();

    // Step 1: Fetch target content with embeddings
    const targetContent = await fetchTargetContent(sql, options);
    if (targetContent.length === 0) {
      logger.info({ mode }, '[Classification Query] No target content to classify');
      return [];
    }

    // Step 2: Fetch classifier templates (attribute_values expanded in TypeScript)
    const templates = await fetchClassifierTemplates(sql, enabledClassifiers, targetContent);
    if (templates.length === 0) {
      logger.info({ mode }, '[Classification Query] No classifier templates found');
      return [];
    }

    // Step 3: Compute cosine similarities in TypeScript
    const similarities = computeSimilarities(targetContent, templates);

    // Step 4: Determine best matches per (content_id, classifier_id)
    const bestMatches = determineBestMatches(similarities);

    // Step 5: Build parent classifications from parent_mapping
    const classifierVersionRows = await fetchAllClassifierVersions(sql);
    const classifierVersionLookup = new Map(
      classifierVersionRows.map((r) => [r.slug, r.version_id])
    );
    const parentClassifications = generateParentClassifications(
      bestMatches,
      classifierVersionLookup
    );

    // Step 6: Combine direct and parent classifications
    const directClassifications: AllClassification[] = bestMatches
      .filter((bm) => bm.value != null)
      .map((bm) => ({
        content_id: bm.content_id,
        version_id: bm.version_id,
        value: bm.value!,
        confidences_map: bm.confidences_map,
        met_threshold: bm.met_threshold,
        threshold: bm.threshold,
        best_match_attribute: bm.best_match_attribute,
        actual_confidence: bm.actual_confidence,
      }));

    const allClassifications = [...directClassifications, ...parentClassifications];

    // Step 7: Upsert into event_classifications (DELETE + INSERT)
    const results = await upsertClassifications(sql, allClassifications);

    const logContext: Record<string, unknown> = { count: results.length, mode };
    if (mode === 'entity') {
      logContext.entity_type = options.entity_type;
      logContext.entity_id = options.entity_id;
    }
    if (mode === 'content_ids') logContext.content_count = options.content_ids?.length;

    logger.info(logContext, '[Classification Query] Success');
    return results;
  } catch (error) {
    logger.error(
      {
        mode,
        classifiers: enabledClassifiers,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack?.split('\n').slice(0, 10),
              }
            : String(error),
      },
      '[Classification Query] FAILED'
    );
    throw error;
  }
}
