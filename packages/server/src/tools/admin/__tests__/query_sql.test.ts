import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../../registry';
import { querySql } from '../query_sql';

type QuerySqlArgs = Parameters<typeof querySql>[0];

const ctx: ToolContext = {
  organizationId: 'org_123',
  userId: 'user_123',
  memberRole: 'admin',
  isAuthenticated: true,
  tokenType: 'oauth',
  scopedToOrg: false,
  allowCrossOrg: true,
};

describe('querySql input validation', () => {
  it('returns a structured error when callers send query instead of sql', async () => {
    const result = await querySql(
      { query: 'select * from events', sort_by: 'id' } as unknown as QuerySqlArgs,
      {},
      ctx
    );

    expect(result.error).toBe('sql (string) is required.');
    expect(result.rows).toEqual([]);
    expect(result.total_count).toBe(0);
  });

  it('returns a structured error when tool arguments are not an object', async () => {
    const result = await querySql(null as unknown as QuerySqlArgs, {}, ctx);

    expect(result.error).toBe('Tool arguments must be an object.');
    expect(result.rows).toEqual([]);
    expect(result.total_count).toBe(0);
  });

  it('rejects an invalid sort_by column name (sort_by is optional, but must be a bare identifier when given)', async () => {
    const result = await querySql(
      { sql: 'select * from events', sort_by: 'a; DROP' } as unknown as QuerySqlArgs,
      {},
      ctx
    );

    expect(result.error).toBe('Invalid sort_by column name: a; DROP');
  });
});
