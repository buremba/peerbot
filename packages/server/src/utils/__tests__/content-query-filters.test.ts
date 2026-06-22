/**
 * Content Query Filters Tests
 */

import { describe, expect, it } from 'vitest';
import {
  buildConnectionFilter,
  buildFeedFilter,
  buildOrderByClause,
  buildRunFilter,
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

describe('buildFeedFilter', () => {
  it('builds an IN clause on feed_id', () => {
    expect(buildFeedFilter([7, 8])).toBe('f.feed_id IN (7,8)');
  });
  it('returns 1=1 for empty/null', () => {
    expect(buildFeedFilter(null)).toBe('1=1');
    expect(buildFeedFilter([])).toBe('1=1');
  });
});

describe('buildRunFilter', () => {
  it('builds an IN clause on run_id', () => {
    expect(buildRunFilter([42], 'e')).toBe('e.run_id IN (42)');
  });
  it('returns 1=1 for empty/null', () => {
    expect(buildRunFilter(null)).toBe('1=1');
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
