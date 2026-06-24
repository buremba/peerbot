import { describe, expect, it } from 'vitest';
import { buildEntityTypesFilterClause } from '../entity-types-filter';

describe('buildEntityTypesFilterClause', () => {
  it('returns empty fragment when entity_types is absent', () => {
    const result = buildEntityTypesFilterClause({
      organization_id: 'org-1',
      baseParamIndex: 3,
    });
    expect(result).toEqual({ sql: '', predicate: '', params: [] });
  });

  it('returns empty fragment when organization_id is absent', () => {
    const result = buildEntityTypesFilterClause({
      entity_types: ['person'],
      baseParamIndex: 3,
    });
    expect(result).toEqual({ sql: '', predicate: '', params: [] });
  });

  it('builds overlap predicate against entities of matching type slugs', () => {
    const result = buildEntityTypesFilterClause({
      entity_types: ['person', 'company'],
      organization_id: 'org-abc',
      baseParamIndex: 5,
    });

    expect(result.params).toEqual(['org-abc', '{"person","company"}']);
    expect(result.sql).toContain('f.entity_ids &&');
    expect(result.sql).toContain('$5::text');
    expect(result.sql).toContain('$6::text[]');
    expect(result.predicate).toContain('et.slug = ANY($6::text[])');
    expect(result.predicate).toContain('e.organization_id = $5::text');
  });
});