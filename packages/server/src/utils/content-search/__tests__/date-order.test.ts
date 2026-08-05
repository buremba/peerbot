/**
 * Unit tests for the chronological-feed ordering/cursor helpers in
 * content-search/types.ts.
 *
 * The recency key is the EFFECTIVE occurrence time — COALESCE(occurred_at,
 * created_at) — so a row whose source timestamp was never recorded ranks by
 * its record time (exactly what the API surfaces for such rows) instead of
 * pinning itself to the top of a newest-first feed: Postgres
 * `ORDER BY occurred_at DESC` defaults to NULLS FIRST, which is what put a
 * 9-day-old NULL-timestamp approval card above everything in prod.
 */

import { describe, expect, it } from 'vitest';
import { buildDateCandidateOrderBy, buildDateCursorClause } from '../types';

describe('buildDateCandidateOrderBy', () => {
  it('orders newest-first on the effective occurrence time (desc)', () => {
    expect(buildDateCandidateOrderBy(null, 'f')).toBe(
      'COALESCE(f.occurred_at, f.created_at) DESC, f.id DESC'
    );
  });

  it('orders oldest-first on the effective occurrence time for an after cursor', () => {
    const cursor = { direction: 'after' as const, occurredAtIso: 'x', id: 1 };
    expect(buildDateCandidateOrderBy(cursor, 'fi')).toBe(
      'COALESCE(fi.occurred_at, fi.created_at) ASC, fi.id ASC'
    );
  });
});

describe('buildDateCursorClause', () => {
  const cursor = {
    direction: 'before' as const,
    occurredAtIso: '2026-07-28T03:04:17.894Z',
    id: 4669806,
  };

  it('keyset-comparison uses the effective occurrence time so NULL rows stay reachable', () => {
    const clause = buildDateCursorClause(
      cursor,
      'COALESCE(f.occurred_at, f.created_at)',
      'f.id',
      1
    );
    expect(clause.sql).toBe(
      'AND (COALESCE(f.occurred_at, f.created_at) < $1::timestamptz OR (COALESCE(f.occurred_at, f.created_at) = $1::timestamptz AND f.id < $2::bigint))'
    );
    expect(clause.params).toEqual([cursor.occurredAtIso, cursor.id]);
  });
});
