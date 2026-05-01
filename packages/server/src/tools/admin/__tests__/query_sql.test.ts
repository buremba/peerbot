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

  it('requires an explicit sort_by column before building SQL', async () => {
    const result = await querySql(
      { sql: 'select * from events' } as unknown as QuerySqlArgs,
      {},
      ctx
    );

    expect(result.error).toBe('sort_by (string column name) is required.');
  });
});
