/**
 * Classification filter builder tests.
 *
 * These assert that the single classifier-ID-aware builder
 * (`buildClassificationExistsClauses` + `buildSourceOnlyExistsClause`) — now
 * used by BOTH the date-sort path (list-path.ts) and the score-sort path
 * (content-scoring.ts) — emits identical SQL/params for a given filter, so the
 * two sort orders return the same row set (F6).
 */

import { describe, expect, it } from 'vitest';
import { groupClassificationFilters } from '../../content-query-filters';
import {
  buildClassificationExistsClauses,
  buildSourceOnlyExistsClause,
} from '../classification';

describe('buildClassificationExistsClauses', () => {
  it('emits a classifier-ID-scoped EXISTS clause keyed on the stable classifier_id', () => {
    const filtersBySlug = groupClassificationFilters([
      { classifier_slug: 'sentiment', value: 'positive' },
    ]);
    const classifierIds = new Map<string, number[]>([['sentiment', [42]]]);

    const result = buildClassificationExistsClauses(filtersBySlug, classifierIds, undefined, 1);
    expect(result).not.toBeNull();
    expect(result?.clauses.length).toBe(1);
    // Must filter by the stable classifier_id (any version's classifications), NOT a slug join.
    expect(result?.clauses[0]).toContain('cc.classifier_id = ANY($2::bigint[])');
    expect(result?.clauses[0]).not.toContain('ccl.slug');
    expect(result?.clauses[0]).toContain('cc.event_id = f.id');
    // params: [values text[] literal, classifierIds bigint[] literal]. Under the
    // prod client (fetch_types:false) raw JS arrays serialize to malformed array
    // literals, so the builder binds pgTextArray()/pgBigintArray() pg-literals.
    expect(result?.params).toEqual(['{"positive"}', '{42}']);
  });

  it('returns null (drop-all) when a requested classifier resolves to nothing', () => {
    const filtersBySlug = groupClassificationFilters([
      { classifier_slug: 'sentiment', value: 'positive' },
    ]);
    // Empty classifier map = no classifier resolved for this slug.
    const classifierIds = new Map<string, number[]>();

    const result = buildClassificationExistsClauses(filtersBySlug, classifierIds, undefined, 1);
    expect(result).toBeNull();
  });

  it('appends the source condition inside the EXISTS when a source is given', () => {
    const filtersBySlug = groupClassificationFilters([
      { classifier_slug: 'sentiment', value: 'positive' },
    ]);
    const classifierIds = new Map<string, number[]>([['sentiment', [7]]]);

    const result = buildClassificationExistsClauses(filtersBySlug, classifierIds, 'user', 1);
    expect(result).not.toBeNull();
    // source is the first param ($1), then values ($2), then classifier ids ($3).
    // values/ids are pg-literal strings (see note above), not raw JS arrays.
    expect(result?.clauses[0]).toContain('cc.source = $1');
    expect(result?.params).toEqual(['user', '{"positive"}', '{7}']);
  });
});

describe('buildSourceOnlyExistsClause', () => {
  it('matches the inline $8 predicate used by the date-sort standard WHERE', () => {
    const { clause, params } = buildSourceOnlyExistsClause('embedding', 8, 'f');
    // Reads event_classifications (the source-of-truth output table) keyed on f.id,
    // so the score-sort source-only filter returns the same rows as the date-sort one.
    // (was the dead latest_event_classifications cache, dropped in the P4 collapse.)
    expect(clause).toContain('FROM event_classifications lc_source');
    expect(clause).toContain('lc_source.event_id = f.id');
    expect(clause).toContain('lc_source.source = $8::text');
    expect(params).toEqual(['embedding']);
  });
});
