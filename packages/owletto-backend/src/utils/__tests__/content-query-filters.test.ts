/**
 * Content Query Filters Tests
 */

import { describe, expect, it } from 'vitest';
import {
  buildClassificationFilterSQL,
  buildConnectionFilter,
  buildDateFilterSQL,
  buildEngagementFilterSQL,
  buildOrderByClause,
  groupClassificationFilters,
} from '../content-query-filters';

describe('groupClassificationFilters', () => {
  it('should group filters by classifier slug', () => {
    const filters = [
      { classifier_slug: 'sentiment', value: 'positive' },
      { classifier_slug: 'sentiment', value: 'neutral' },
      { classifier_slug: 'topic', value: 'performance' },
    ];
    const grouped = groupClassificationFilters(filters);
    expect(grouped.get('sentiment')).toEqual(['positive', 'neutral']);
    expect(grouped.get('topic')).toEqual(['performance']);
  });

  it('should skip empty slugs and values', () => {
    const filters = [
      { classifier_slug: '', value: 'positive' },
      { classifier_slug: 'topic', value: '' },
    ];
    const grouped = groupClassificationFilters(filters);
    expect(grouped.size).toBe(0);
  });
});

describe('buildClassificationFilterSQL', () => {
  it('should build EXISTS clause for single classifier', () => {
    const { conditions, params } = buildClassificationFilterSQL([
      { classifier_slug: 'sentiment', value: 'positive' },
    ]);
    expect(conditions.length).toBe(1);
    expect(conditions[0]).toContain('EXISTS');
    expect(conditions[0]).toContain('$1'); // value placeholder
    expect(conditions[0]).toContain('$2'); // slug placeholder
    expect(params).toEqual(['positive', 'sentiment']);
  });

  it('should build multiple EXISTS clauses for multiple classifiers', () => {
    const { conditions, params } = buildClassificationFilterSQL([
      { classifier_slug: 'sentiment', value: 'positive' },
      { classifier_slug: 'topic', value: 'ux' },
    ]);
    expect(conditions.length).toBe(2);
    expect(params).toEqual(['positive', 'sentiment', 'ux', 'topic']);
  });

  it('should include source condition when provided', () => {
    const { conditions, params } = buildClassificationFilterSQL(
      [{ classifier_slug: 'sentiment', value: 'positive' }],
      'user'
    );
    expect(conditions[0]).toContain('cc.source = $3');
    expect(params).toEqual(['positive', 'sentiment', 'user']);
  });

  it('should return empty for empty filters and no source', () => {
    const { conditions, params } = buildClassificationFilterSQL([]);
    expect(conditions.length).toBe(0);
    expect(params.length).toBe(0);
  });

  it('should build source-only filter when no classification filters', () => {
    const { conditions, params } = buildClassificationFilterSQL([], 'embedding');
    expect(conditions.length).toBe(1);
    expect(conditions[0]).toContain('cc.source = $1');
    expect(params).toEqual(['embedding']);
  });

  it('should use baseParamIndex for parameter numbering', () => {
    const { conditions, params } = buildClassificationFilterSQL(
      [{ classifier_slug: 'sentiment', value: 'positive' }],
      null,
      'f',
      5
    );
    expect(conditions[0]).toContain('$5'); // value placeholder
    expect(conditions[0]).toContain('$6'); // slug placeholder
    expect(params).toEqual(['positive', 'sentiment']);
  });

  it('should handle multiple values for same classifier with OR logic', () => {
    const { conditions, params } = buildClassificationFilterSQL([
      { classifier_slug: 'sentiment', value: 'positive' },
      { classifier_slug: 'sentiment', value: 'neutral' },
    ]);
    expect(conditions.length).toBe(1); // single EXISTS for same classifier
    expect(conditions[0]).toContain('$1'); // first value
    expect(conditions[0]).toContain('$2'); // second value
    expect(conditions[0]).toContain('$3'); // slug
    expect(params).toEqual(['positive', 'neutral', 'sentiment']);
  });
});

describe('buildConnectionFilter', () => {
  it('should build IN clause for valid IDs', () => {
    const result = buildConnectionFilter([1, 2, 3]);
    expect(result).toBe('f.connection_id IN (1,2,3)');
  });

  it('should return 1=1 for null', () => {
    expect(buildConnectionFilter(null)).toBe('1=1');
  });

  it('should return 1=1 for empty array', () => {
    expect(buildConnectionFilter([])).toBe('1=1');
  });

  it('should filter out NaN values', () => {
    expect(buildConnectionFilter([1, NaN, 3])).toBe('f.connection_id IN (1,3)');
  });

  it('should use custom table alias', () => {
    expect(buildConnectionFilter([1], 'e')).toBe('e.connection_id IN (1)');
  });
});

describe('buildOrderByClause', () => {
  it('should build date descending by default', () => {
    const result = buildOrderByClause();
    expect(result).toContain('occurred_at DESC');
  });

  it('should build score ordering', () => {
    const result = buildOrderByClause('score', 'desc');
    expect(result).toContain('score DESC');
    expect(result).toContain('occurred_at DESC');
  });

  it('should build date ascending', () => {
    const result = buildOrderByClause('date', 'asc');
    expect(result).toContain('occurred_at ASC');
  });

  it('should use custom table alias', () => {
    const result = buildOrderByClause('date', 'desc', 'e');
    expect(result).toContain('e.occurred_at');
  });

  it('should use f alias for final_select context', () => {
    const result = buildOrderByClause('date', 'desc', 'rs', 'final_select');
    expect(result).toContain('f.occurred_at');
  });
});

describe('buildEngagementFilterSQL', () => {
  it('should build min condition', () => {
    const conditions = buildEngagementFilterSQL(50);
    expect(conditions).toEqual(['f.score >= 50']);
  });

  it('should build max condition', () => {
    const conditions = buildEngagementFilterSQL(undefined, 80);
    expect(conditions).toEqual(['f.score <= 80']);
  });

  it('should build both min and max', () => {
    const conditions = buildEngagementFilterSQL(30, 90);
    expect(conditions).toEqual(['f.score >= 30', 'f.score <= 90']);
  });

  it('should return empty for no filters', () => {
    expect(buildEngagementFilterSQL()).toEqual([]);
  });

  it('should use custom table alias', () => {
    const conditions = buildEngagementFilterSQL(50, undefined, 'e');
    expect(conditions).toEqual(['e.score >= 50']);
  });
});

describe('buildDateFilterSQL', () => {
  it('should build since condition', () => {
    const since = new Date('2025-01-01T00:00:00Z');
    const conditions = buildDateFilterSQL(since);
    expect(conditions.length).toBe(1);
    expect(conditions[0]).toContain("f.occurred_at >= '2025-01-01");
  });

  it('should build until condition', () => {
    const until = new Date('2025-06-01T00:00:00Z');
    const conditions = buildDateFilterSQL(null, until);
    expect(conditions.length).toBe(1);
    expect(conditions[0]).toContain("f.occurred_at <= '2025-06-01");
  });

  it('should build both since and until', () => {
    const since = new Date('2025-01-01T00:00:00Z');
    const until = new Date('2025-06-01T00:00:00Z');
    const conditions = buildDateFilterSQL(since, until);
    expect(conditions.length).toBe(2);
  });

  it('should return empty for no dates', () => {
    expect(buildDateFilterSQL()).toEqual([]);
    expect(buildDateFilterSQL(null, null)).toEqual([]);
  });
});
