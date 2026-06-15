/**
 * Classification filter builder tests.
 *
 * These assert that the single version-ID-aware builder
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
  it('emits a version-ID-scoped EXISTS clause keyed on the current version', () => {
    const filtersBySlug = groupClassificationFilters([
      { classifier_slug: 'sentiment', value: 'positive' },
    ]);
    const versionIds = new Map<string, number[]>([['sentiment', [42]]]);

    const result = buildClassificationExistsClauses(filtersBySlug, versionIds, undefined, 1);
    expect(result).not.toBeNull();
    expect(result?.clauses.length).toBe(1);
    // Must filter by classifier_version_id (current-version aware), NOT a slug join.
    expect(result?.clauses[0]).toContain('cc.classifier_version_id = ANY($2::int[])');
    expect(result?.clauses[0]).not.toContain('ccl.slug');
    expect(result?.clauses[0]).toContain('cc.event_id = f.id');
    // params: [values[], versionIds[]]
    expect(result?.params).toEqual([['positive'], [42]]);
  });

  it('returns null (drop-all) when a requested classifier has no current version', () => {
    const filtersBySlug = groupClassificationFilters([
      { classifier_slug: 'sentiment', value: 'positive' },
    ]);
    // Empty version map = no current version resolved for this slug.
    const versionIds = new Map<string, number[]>();

    const result = buildClassificationExistsClauses(filtersBySlug, versionIds, undefined, 1);
    expect(result).toBeNull();
  });

  it('appends the source condition inside the EXISTS when a source is given', () => {
    const filtersBySlug = groupClassificationFilters([
      { classifier_slug: 'sentiment', value: 'positive' },
    ]);
    const versionIds = new Map<string, number[]>([['sentiment', [7]]]);

    const result = buildClassificationExistsClauses(filtersBySlug, versionIds, 'user', 1);
    expect(result).not.toBeNull();
    // source is the first param ($1), then values ($2), then version ids ($3)
    expect(result?.clauses[0]).toContain('cc.source = $1');
    expect(result?.params).toEqual(['user', ['positive'], [7]]);
  });
});

describe('buildSourceOnlyExistsClause', () => {
  it('matches the inline $8 predicate used by the date-sort standard WHERE', () => {
    const { clause, params } = buildSourceOnlyExistsClause('embedding', 8, 'f');
    // Must use the dedup'd, current-version-aware view keyed on f.id, so the
    // score-sort source-only filter returns the same rows as the date-sort one.
    expect(clause).toContain('FROM latest_event_classifications lc_source');
    expect(clause).toContain('lc_source.event_id = f.id');
    expect(clause).toContain('lc_source.source = $8::text');
    expect(params).toEqual(['embedding']);
  });
});
