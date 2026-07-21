/**
 * query_sql structured error taxonomy (lobu#2051 Item 2).
 *
 * The soft-error path (a `{ rows: [], error }` result the agent reads as a normal
 * outcome, NOT a throw — deliberate per #2042) now also carries `error_code` +
 * `retryable`, so an agent can tell a transient timeout from a permanent SQL fault
 * without parsing the message string. The hard-throw path (missing feed) carries
 * the code on the thrown ToolUserError.
 *
 * Red on origin/main (no `error_code`/`retryable` fields exist there); green here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { ToolUserError } from '../../../utils/errors';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('query_sql error taxonomy', () => {
  let orgId: string;
  let ctx: ToolContext;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Query Taxonomy Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'query-taxonomy@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    ctx = {
      organizationId: orgId,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: false,
    };
  }, 120_000);

  afterAll(async () => {
    await getTestDb()`SELECT 1`; // keep the pool warm for teardown ordering
  });

  it('tags a write query (read-only violation) as VALIDATION, not retryable', async () => {
    // A CTE that mutates is the read-only-violation shape query_sql guards against.
    const res = await querySql(
      { sql: 'WITH x AS (DELETE FROM events RETURNING id) SELECT count(*) AS n FROM x' },
      {},
      ctx
    );
    expect(res.error).toBeTruthy();
    expect(res.error_code).toBe('VALIDATION');
    expect(res.retryable).toBe(false);
  }, 60_000);

  it('tags a disallowed table reference as a non-retryable code', async () => {
    const res = await querySql(
      { sql: 'SELECT access_token FROM oauth_tokens LIMIT 1' },
      {},
      ctx
    );
    expect(res.error).toBeTruthy();
    // A rejected/unscopable table is the caller's problem — never retryable.
    expect(res.retryable).toBe(false);
    expect(res.error_code).toBeTruthy();
  }, 60_000);

  it('throws NOT_FOUND (with code) for an unknown feed reference', async () => {
    let caught: unknown;
    try {
      await querySql({ feed: 'no-such-feed-xyz' }, {}, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    expect((caught as ToolUserError).code).toBe('NOT_FOUND');
    expect((caught as ToolUserError).retryable).toBe(false);
    expect((caught as ToolUserError).httpStatus).toBe(404);
  }, 60_000);

  it('a successful query carries no error_code/retryable', async () => {
    const res = await querySql({ sql: 'SELECT id FROM events LIMIT 1' }, {}, ctx);
    expect(res.error).toBeUndefined();
    expect(res.error_code).toBeUndefined();
    expect(res.retryable).toBeUndefined();
  }, 60_000);
});
