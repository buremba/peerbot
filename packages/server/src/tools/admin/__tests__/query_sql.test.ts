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
  // Shape errors (missing/mistyped fields, non-object args) now reject at the
  // tool boundary (withValidatedArgs, lobu#1137) with the field name in the
  // message, instead of resolving to a structured { error } result.
  it('rejects callers that send query instead of sql, naming the missing field', async () => {
    await expect(
      querySql({ query: 'select * from events', sort_by: 'id' } as unknown as QuerySqlArgs, {}, ctx)
    ).rejects.toThrow(/sql/);
  });

  it('rejects non-object tool arguments', async () => {
    await expect(querySql(null as unknown as QuerySqlArgs, {}, ctx)).rejects.toThrow(
      /Invalid arguments for query_sql/
    );
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
