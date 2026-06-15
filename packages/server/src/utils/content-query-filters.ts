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

// ============================================
// Id-IN Filter Utilities
// ============================================

/**
 * Build an `<alias>.<column> IN (...)` filter from an integer array.
 *
 * postgres.js with `fetch_types: false` doesn't serialize JS arrays to PG arrays
 * cleanly, so we emit a literal `IN (1,2,3)` clause. Inputs are filtered to
 * safe integers to avoid SQL injection.
 *
 * Returns `'1=1'` when no ids are supplied so the caller can splice the result
 * into a `WHERE ... AND <clause>` without conditional logic.
 */
function buildIdInFilter(
  ids: number[] | null | undefined,
  column: 'connection_id' | 'feed_id' | 'run_id',
  tableAlias: string = 'f'
): string {
  if (!ids || ids.length === 0) return '1=1';
  const safeIds = ids.filter(
    (n) => typeof n === 'number' && !Number.isNaN(n) && Number.isInteger(n)
  );
  if (safeIds.length === 0) return '1=1';
  return `${tableAlias}.${column} IN (${safeIds.join(',')})`;
}

export function buildConnectionFilter(
  ids: number[] | null | undefined,
  tableAlias: string = 'f'
): string {
  return buildIdInFilter(ids, 'connection_id', tableAlias);
}

export function buildFeedFilter(
  ids: number[] | null | undefined,
  tableAlias: string = 'f'
): string {
  return buildIdInFilter(ids, 'feed_id', tableAlias);
}

export function buildRunFilter(
  ids: number[] | null | undefined,
  tableAlias: string = 'f'
): string {
  return buildIdInFilter(ids, 'run_id', tableAlias);
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
