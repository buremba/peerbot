import { describe, expect, it } from 'vitest';
import { getIncludeSupersededValidationErrors } from '../../tools/get_content';

describe('getIncludeSupersededValidationErrors', () => {
  it('accepts entity-scoped chronological listings', () => {
    expect(
      getIncludeSupersededValidationErrors({
        entity_id: 42,
        include_superseded: true,
        sort_by: 'date',
        sort_order: 'asc',
      })
    ).toEqual([]);
  });

  it('rejects unsupported query mode combinations', () => {
    expect(
      getIncludeSupersededValidationErrors({
        entity_id: 42,
        include_superseded: true,
        query: 'original budget',
      })
    ).toContain('query is not supported');
  });

  it('rejects score sorting and classification filters', () => {
    expect(
      getIncludeSupersededValidationErrors({
        entity_id: 42,
        include_superseded: true,
        sort_by: 'score',
        classification_source: 'llm',
        classification_filters: { sentiment: ['positive'] },
      })
    ).toEqual([
      'sort_by=score is not supported',
      'classification_source is not supported',
      'classification_filters is not supported',
    ]);
  });

  it('requires entity scope and rejects cursor pagination', () => {
    expect(
      getIncludeSupersededValidationErrors({
        include_superseded: true,
        before_occurred_at: '2025-01-01T00:00:00.000Z',
        before_id: 7,
      })
    ).toEqual(['entity_id is required', 'cursor pagination is not supported']);
  });
});
