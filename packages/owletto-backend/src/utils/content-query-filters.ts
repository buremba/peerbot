/**
 * Shared Content Query Filter Utilities
 *
 * Consolidates filter building logic used by:
 * - content-search.ts (hybrid search)
 * - content-scoring.ts (normalized score queries)
 */

// ============================================
// Type Definitions
// ============================================

/**
 * Classification filter for content queries
 */
export interface ClassificationFilter {
  classifier_slug: string;
  value: string;
  min_confidence?: number;
}

// ============================================
// Classification Filter Utilities
// ============================================

/**
 * Group classification filters by classifier slug
 * For building OR-within-classifier, AND-across-classifiers queries
 *
 * @param filters - Array of classification filters
 * @returns Map of slug -> array of values
 */
export function groupClassificationFilters(filters: ClassificationFilter[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();

  for (const filter of filters) {
    const slugStr = String(filter.classifier_slug).trim();
    const valueStr = String(filter.value).trim();

    // Skip empty slugs or values to prevent malformed SQL
    if (!slugStr || !valueStr) {
      continue;
    }

    if (!grouped.has(slugStr)) {
      grouped.set(slugStr, []);
    }
    grouped.get(slugStr)?.push(valueStr);
  }

  return grouped;
}

// Valid classification sources - used for runtime validation
const VALID_CLASSIFICATION_SOURCES = ['user', 'embedding', 'llm'] as const;

/**
 * Validate and sanitize classification source at runtime.
 * Prevents SQL injection even if TypeScript types are bypassed.
 */
function validateClassificationSource(
  source: string | null | undefined
): 'user' | 'embedding' | 'llm' | null {
  if (!source) return null;
  const normalized = String(source).toLowerCase().trim();
  if (VALID_CLASSIFICATION_SOURCES.includes(normalized as any)) {
    return normalized as 'user' | 'embedding' | 'llm';
  }
  return null;
}

/**
 * Build classification filter SQL conditions for raw SQL queries.
 *
 * Generates EXISTS clauses that use AND logic across different classifiers
 * and OR logic within same classifier values.
 *
 * Returns parameterized SQL conditions with $N placeholders and a params array,
 * preventing SQL injection for classifier slugs and values.
 */
export function buildClassificationFilterSQL(
  filters: ClassificationFilter[],
  classificationSource?: 'user' | 'embedding' | 'llm' | null,
  tableAlias: string = 'f',
  baseParamIndex: number = 1
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = baseParamIndex;

  // Runtime validation of classification source to prevent SQL injection
  const validatedSource = validateClassificationSource(classificationSource);

  if (filters.length > 0) {
    const byClassifier = groupClassificationFilters(filters);

    // Each classifier needs an EXISTS subquery
    for (const [slug, values] of byClassifier.entries()) {
      // Skip if no valid values after grouping
      if (values.length === 0) continue;

      // Build parameterized value placeholders for the ARRAY constructor
      const valuePlaceholders = values.map((v) => {
        const placeholder = `$${paramIndex++}`;
        params.push(v);
        return placeholder;
      });
      const valuesArray = valuePlaceholders.join(', ');

      // Slug parameter
      const slugPlaceholder = `$${paramIndex++}`;
      params.push(slug);

      // Source condition uses validated value via parameter
      let sourceCondition = '';
      if (validatedSource) {
        const sourcePlaceholder = `$${paramIndex++}`;
        params.push(validatedSource);
        sourceCondition = ` AND cc.source = ${sourcePlaceholder}`;
      }

      conditions.push(
        `
        EXISTS (
          SELECT 1 FROM event_classifications cc
          JOIN event_classifier_versions ccv ON cc.classifier_version_id = ccv.id
          JOIN event_classifiers ccl ON ccv.classifier_id = ccl.id
          WHERE cc.event_id = ${tableAlias}.id
            AND ccl.slug = ${slugPlaceholder}
            AND cc."values" && ARRAY[${valuesArray}]::text[]
            ${sourceCondition}
        )
      `.trim()
      );
    }
  } else if (validatedSource) {
    // No classification filters but source is specified
    // Filter content that have ANY classification with that source
    const sourcePlaceholder = `$${paramIndex++}`;
    params.push(validatedSource);

    conditions.push(
      `
      EXISTS (
        SELECT 1 FROM event_classifications cc
        WHERE cc.event_id = ${tableAlias}.id
          AND cc.source = ${sourcePlaceholder}
      )
    `.trim()
    );
  }

  return { conditions, params };
}

// ============================================
// Connection Filter Utilities
// ============================================

/**
 * Build connection ID filter condition.
 *
 * This is needed because postgres.js with fetch_types: false
 * doesn't properly serialize JavaScript arrays to PostgreSQL arrays.
 * Using IN clause with joined IDs avoids this issue.
 *
 * @param connectionIds - Array of connection IDs or null
 * @param tableAlias - Table alias for connection_id column (default: 'f')
 * @returns SQL condition string like "f.connection_id IN (1,2,3)" or "1=1"
 */
export function buildConnectionFilter(
  connectionIds: number[] | null | undefined,
  tableAlias: string = 'f'
): string {
  if (!connectionIds || connectionIds.length === 0) {
    // Use 1=1 instead of TRUE to avoid postgres.js treating it as a column identifier
    return '1=1';
  }

  // Ensure all values are valid numbers to prevent SQL injection
  const safeIds = connectionIds.filter(
    (n) => typeof n === 'number' && !Number.isNaN(n) && Number.isInteger(n)
  );

  if (safeIds.length === 0) {
    return '1=1';
  }

  return `${tableAlias}.connection_id IN (${safeIds.join(',')})`;
}

// ============================================
// Order By Utilities
// ============================================

/**
 * Build ORDER BY clause for content sorting
 *
 * Returns SQL fragment (SAFE - constructed from validated enum values only)
 * Used in raw SQL queries where ORDER BY cannot be parameterized
 *
 * Includes secondary and tertiary sort keys for stable ordering:
 * - Primary: score or date (user-selected)
 * - Secondary: occurred_at DESC (newest first for tied scores)
 * - Tertiary: f.id DESC (absolute stability for identical timestamps)
 *
 * @param sortBy - Primary sort field: 'date' or 'score'
 * @param sortOrder - Sort direction: 'asc' or 'desc'
 * @param tableAlias - Table alias (default: 'f')
 * @param context - Query context for field references
 * @returns SQL ORDER BY clause (without "ORDER BY" keyword)
 */
export function buildOrderByClause(
  sortBy: 'date' | 'score' = 'date',
  sortOrder: 'asc' | 'desc' = 'desc',
  tableAlias: string = 'f',
  context: 'result_set' | 'final_select' = 'result_set'
): string {
  const validSortOrder = sortOrder === 'asc' ? 'ASC' : 'DESC';
  const alias = context === 'final_select' ? 'f' : tableAlias;

  if (sortBy === 'score') {
    return `${alias}.score ${validSortOrder}, ${alias}.occurred_at DESC, ${alias}.id DESC`;
  }
  return `${alias}.occurred_at ${validSortOrder}, ${alias}.id ${validSortOrder}`;
}

// ============================================
// Engagement Filter Utilities
// ============================================

/**
 * Build engagement score filter conditions
 *
 * @param engagementMin - Minimum engagement score (0-100)
 * @param engagementMax - Maximum engagement score (0-100)
 * @param tableAlias - Table alias for score column (default: 'f')
 * @returns Array of SQL condition strings
 */
export function buildEngagementFilterSQL(
  engagementMin?: number,
  engagementMax?: number,
  tableAlias: string = 'f'
): string[] {
  const conditions: string[] = [];

  if (engagementMin !== undefined && engagementMin !== null) {
    conditions.push(`${tableAlias}.score >= ${engagementMin}`);
  }

  if (engagementMax !== undefined && engagementMax !== null) {
    conditions.push(`${tableAlias}.score <= ${engagementMax}`);
  }

  return conditions;
}

// ============================================
// Date Filter SQL Utilities
// ============================================

/**
 * Build date range filter conditions for raw SQL
 *
 * @param since - Start date
 * @param until - End date
 * @param tableAlias - Table alias for occurred_at column (default: 'f')
 * @returns Array of SQL condition strings
 */
export function buildDateFilterSQL(
  since?: Date | null,
  until?: Date | null,
  tableAlias: string = 'f'
): string[] {
  const conditions: string[] = [];

  if (since) {
    conditions.push(`${tableAlias}.occurred_at >= '${since.toISOString()}'`);
  }

  if (until) {
    conditions.push(`${tableAlias}.occurred_at <= '${until.toISOString()}'`);
  }

  return conditions;
}
