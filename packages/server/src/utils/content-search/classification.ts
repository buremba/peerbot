/**
 * Classification filter helpers:
 * collectVersionIds, resolveClassifierVersionIds, buildClassificationExistsClauses.
 */

import type { DbClient } from '../../db/client';
import logger from '../logger';

function collectVersionIds(rows: unknown[], mapping: Map<string, number[]>): void {
  for (const row of rows as Array<{ slug: string; version_id: number | string }>) {
    const slug = String(row.slug);
    const versionId = typeof row.version_id === 'number' ? row.version_id : Number(row.version_id);
    if (Number.isNaN(versionId)) continue;
    const existing = mapping.get(slug);
    if (existing) {
      existing.push(versionId);
    } else {
      mapping.set(slug, [versionId]);
    }
  }
}

export async function resolveClassifierVersionIds(
  sql: DbClient,
  filtersBySlug: Map<string, string[]>,
  entityId: number | undefined
): Promise<Map<string, number[]>> {
  const slugs = Array.from(filtersBySlug.keys())
    .map((slug) => String(slug).trim())
    .filter((slug) => slug.length > 0);

  if (slugs.length === 0) return new Map();

  const placeholders = slugs.map((_, index) => `$${index + 1}`).join(', ');
  const mapping = new Map<string, number[]>();

  if (entityId) {
    const entityRows = await sql.unsafe(
      `
      SELECT ccl.slug, ccv.id as version_id
      FROM event_classifiers ccl
      JOIN event_classifier_versions ccv ON ccv.classifier_id = ccl.id
      JOIN watchers i ON i.id = ccl.watcher_id
      WHERE ccv.is_current = true
        AND ccl.slug IN (${placeholders})
        AND $${slugs.length + 1} = ANY(i.entity_ids)
    `,
      [...slugs, entityId]
    );
    collectVersionIds(entityRows, mapping);
  }

  const missingSlugs = slugs.filter((slug) => !mapping.has(slug));
  if (missingSlugs.length > 0) {
    const globalPlaceholders = missingSlugs.map((_, index) => `$${index + 1}`).join(', ');
    const globalRows = await sql.unsafe(
      `
      SELECT ccl.slug, ccv.id as version_id
      FROM event_classifiers ccl
      JOIN event_classifier_versions ccv ON ccv.classifier_id = ccl.id
      WHERE ccv.is_current = true
        AND ccl.slug IN (${globalPlaceholders})
        AND ccl.watcher_id IS NULL
    `,
      missingSlugs
    );
    collectVersionIds(globalRows, mapping);
  }

  return mapping;
}

/**
 * Build a source-only EXISTS clause (no classifier-value filters).
 *
 * Mirrors the inline `$8` predicate emitted by `buildStandardWhereSql` so the
 * date-sort and score-sort paths return identical rows when only a
 * `classification_source` filter is supplied. Uses `latest_event_classifications`
 * (the dedup'd, current-version-aware view) keyed by `f.id`.
 *
 * `tableAlias` is the alias of the outer event row (always `f` in both paths).
 */
export function buildSourceOnlyExistsClause(
  classificationSource: 'user' | 'embedding' | 'llm',
  baseParamIndex: number,
  tableAlias = 'f'
): { clause: string; params: any[] } {
  return {
    clause: `
      EXISTS (
        SELECT 1 FROM latest_event_classifications lc_source
        WHERE lc_source.event_id = ${tableAlias}.id
          AND lc_source.source = $${baseParamIndex}::text
      )
    `.trim(),
    params: [classificationSource],
  };
}

export function buildClassificationExistsClauses(
  filtersBySlug: Map<string, string[]>,
  classifierVersionIds: Map<string, number[]>,
  classificationSource: 'user' | 'embedding' | 'llm' | undefined,
  baseParamIndex: number
): { clauses: string[]; params: any[] } | null {
  const clauses: string[] = [];
  const params: any[] = [];
  let paramIndex = baseParamIndex;

  let sourceCondition = '';
  if (classificationSource) {
    params.push(classificationSource);
    sourceCondition = ` AND cc.source = $${paramIndex}`;
    paramIndex++;
  }

  for (const [slug, values] of filtersBySlug.entries()) {
    const slugStr = String(slug);
    const valuesArr = Array.isArray(values) ? values.map((v) => String(v)) : [String(values)];

    if (valuesArr.length === 0) {
      logger.warn({ slug: slugStr }, 'Skipping empty values array for classification filter');
      continue;
    }

    const versionIds = (classifierVersionIds.get(slugStr) || []).filter(
      (value) => typeof value === 'number' && Number.isInteger(value)
    );
    if (versionIds.length === 0) {
      logger.warn({ slug: slugStr }, 'Skipping classification filter without current version');
      return null;
    }

    // Parameterize values array
    params.push(valuesArr);
    const valuesParamSQL = `$${paramIndex}::text[]`;
    paramIndex++;

    // Parameterize version IDs
    params.push(versionIds);
    const versionFilterSql = `cc.classifier_version_id = ANY($${paramIndex}::int[])`;
    paramIndex++;

    clauses.push(
      `
      EXISTS (
        SELECT 1 FROM event_classifications cc
        WHERE cc.event_id = f.id
          AND ${versionFilterSql}
          AND cc."values" && ${valuesParamSQL}
          ${sourceCondition}
      )
    `.trim()
    );
  }

  if (clauses.length === 0) {
    return null;
  }

  return { clauses, params };
}
