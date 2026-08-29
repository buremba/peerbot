/**
 * query_sql internal-path pagination contract.
 *
 * The internal path runs the scoped subquery ONCE and carries the total via a
 * `COUNT(*) OVER ()` window column instead of a second full COUNT pass (the
 * scoped subquery can be expensive — derived views aggregate large event
 * ranges). Two fallbacks keep the legacy contract exact, and this file pins
 * them:
 *
 *  1. Empty / out-of-range pages carry no row to bear the window count, so an
 *     explicit COUNT runs for them — `total_count` must stay exact (and
 *     `has_more` false), never collapse to 0.
 *  2. If the caller's own query projects a column named like the internal
 *     window alias (`__lobu_total_count__`), the tool falls back to the plain
 *     two-query shape — the caller's column survives untouched, exactly once,
 *     and `total_count` is still exact.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { QUERY_SQL_RESULT_MAX_BYTES } from '../../../utils/content-read-bounds';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';

describe('query_sql internal-path pagination contract', () => {
  let orgId: string;
  let ownerCtx: ToolContext;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'QuerySqlPagination' });
    orgId = org.id;
    const user = await createTestUser({ email: 'qsql-page@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    ownerCtx = ownerToolContext(orgId, user.id);

    for (let i = 0; i < 5; i++) {
      await createTestEvent({
        organization_id: orgId,
        content: `pagination event ${i}`,
        title: `pagination event ${i}`,
      });
    }
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('reports exact total_count and has_more across in-range pages', async () => {
    const res = await querySql({ sql: 'SELECT id FROM events', limit: 2, offset: 0 }, {}, ownerCtx);
    expect(res.error).toBeUndefined();
    expect(res.rows).toHaveLength(2);
    expect(res.total_count).toBe(5);
    expect(res.has_more).toBe(true);
    expect(res.omitted_rows).toBeUndefined();
    // The internal window column must never leak into rows or columns.
    expect(res.columns.map((c) => c.name)).not.toContain('__lobu_total_count__');
    expect(Object.keys(res.rows[0])).not.toContain('__lobu_total_count__');
  });

  it('does not bind an unused organization parameter for table-free reads', async () => {
    const res = await querySql(
      { sql: 'SELECT generate_series(1, 25) AS row_number', limit: 50 },
      {},
      ownerCtx
    );

    expect(res.error).toBeUndefined();
    expect(res.rows).toHaveLength(25);
    expect(res.total_count).toBe(25);
    expect(res.rows[0]).toEqual({ row_number: 1 });
    expect(res.rows[24]).toEqual({ row_number: 25 });
  });

  it('caps the serialized dynamic row list and reports omitted rows as more data', async () => {
    const res = await querySql(
      {
        sql: "SELECT generate_series(1, 500) AS id, repeat('x', 8000) AS body",
        limit: 500,
      },
      {},
      ownerCtx
    );

    expect(res.error).toBeUndefined();
    expect(res.total_count).toBe(500);
    expect(res.rows.length).toBeLessThan(500);
    expect(res.omitted_rows).toBe(500 - res.rows.length);
    expect(res.has_more).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThanOrEqual(
      QUERY_SQL_RESULT_MAX_BYTES
    );
  });

  it('rejects incompatible caller-projected truncation sidecars', async () => {
    const res = await querySql(
      {
        sql: `SELECT repeat('x', 5000) AS payload_text,
          false AS payload_truncated, 7 AS content_length`,
        limit: 1,
      },
      {},
      ownerCtx
    );

    expect(res.rows).toEqual([]);
    expect(res.error_code).toBe('VALIDATION');
    expect(res.retryable).toBe(false);
    expect(res.error).toContain('content_length, payload_truncated');
  });

  it('fails closed when one bounded row cannot fit under the hard ceiling', async () => {
    const wideColumns = Array.from(
      { length: 280 },
      (_, index) => `repeat('x', 4000) AS pad_${index}`
    ).join(', ');
    const res = await querySql(
      { sql: `SELECT ${wideColumns}`, limit: 1 },
      {},
      ownerCtx
    );

    expect(res.rows).toEqual([]);
    expect(res.total_count).toBe(1);
    expect(res.has_more).toBe(false);
    expect(res.omitted_rows).toBe(1);
    expect(res.error_code).toBe('VALIDATION');
    expect(res.retryable).toBe(false);
    expect(res.error).toContain('Select fewer or narrower columns');
  });

  it('counts the response envelope when deciding whether one bounded row fits', async () => {
    const wideColumns = Array.from(
      { length: 260 },
      (_, index) => `repeat('x', 4000) AS pad_${index}`
    ).join(', ');
    const res = await querySql(
      { title: 'W'.repeat(200), sql: `SELECT ${wideColumns}`, limit: 1 },
      {},
      ownerCtx
    );

    expect(res.error_code).toBe('VALIDATION');
    expect(res.sql).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThanOrEqual(
      QUERY_SQL_RESULT_MAX_BYTES
    );
  });

  it('fails closed within the ceiling when an empty result has an oversized echoed SQL envelope', async () => {
    const oversizedComment = 'x'.repeat(QUERY_SQL_RESULT_MAX_BYTES);
    const res = await querySql(
      {
        title: 'T'.repeat(200),
        sql: `/* ${oversizedComment} */ SELECT 1 AS id WHERE false`,
        limit: 1,
      },
      {},
      ownerCtx
    );

    expect(res.rows).toEqual([]);
    expect(res.error_code).toBe('VALIDATION');
    expect(res.error).toContain('response envelope exceeds');
    expect(res.sql).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThanOrEqual(
      QUERY_SQL_RESULT_MAX_BYTES
    );
  });

  it('routes oversized early validation errors through the same response ceiling', async () => {
    const res = await querySql(
      {
        sql: 'SELECT 1 AS id',
        sort_by: `${'x'.repeat(QUERY_SQL_RESULT_MAX_BYTES)}-`,
      },
      {},
      ownerCtx
    );

    expect(res.rows).toEqual([]);
    expect(res.error_code).toBe('VALIDATION');
    expect(res.error).toContain('response envelope exceeds');
    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThanOrEqual(
      QUERY_SQL_RESULT_MAX_BYTES
    );
  });

  it('keeps total_count exact on an out-of-range offset (empty page fallback)', async () => {
    const res = await querySql(
      { sql: 'SELECT id FROM events', limit: 2, offset: 100 },
      {},
      ownerCtx
    );
    expect(res.error).toBeUndefined();
    expect(res.rows).toHaveLength(0);
    // No row carries the window count here — the explicit COUNT fallback must
    // still report the true total, not 0.
    expect(res.total_count).toBe(5);
    expect(res.has_more).toBe(false);
  });

  it('reports total_count 0 when nothing matches', async () => {
    const res = await querySql(
      { sql: "SELECT id FROM events WHERE title = 'no such title anywhere'", limit: 2 },
      {},
      ownerCtx
    );
    expect(res.error).toBeUndefined();
    expect(res.rows).toHaveLength(0);
    expect(res.total_count).toBe(0);
    expect(res.has_more).toBe(false);
  });

  it('preserves a caller-projected __lobu_total_count__ column (alias collision fallback)', async () => {
    const res = await querySql(
      { sql: 'SELECT id, 42 AS "__lobu_total_count__" FROM events', limit: 2, offset: 0 },
      {},
      ownerCtx
    );
    expect(res.error).toBeUndefined();
    // The caller's column survives untouched, exactly once.
    const colNames = res.columns.map((c) => c.name);
    expect(colNames.filter((n) => n === '__lobu_total_count__')).toHaveLength(1);
    expect(res.rows).toHaveLength(2);
    for (const row of res.rows) {
      expect(row.__lobu_total_count__).toBe(42);
    }
    // And the real total is still exact via the fallback COUNT.
    expect(res.total_count).toBe(5);
    expect(res.has_more).toBe(true);
  });
});
