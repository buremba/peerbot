/**
 * query_sql structured error taxonomy and MCP propagation (lobu#2051 Item 2).
 *
 * The handler's resolved `{ rows: [], error }` result carries `error_code` and
 * `retryable`, while the MCP boundary marks it with `isError`. Agents can
 * distinguish a transient timeout from a permanent SQL fault without parsing
 * the message. The hard-throw path (missing feed) carries the code on its
 * ToolUserError.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { ToolUserError } from '../../../utils/errors';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

describe('query_sql error taxonomy', () => {
  let orgId: string;
  let orgSlug: string;
  let ctx: ToolContext;
  let token: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Query Taxonomy Org' });
    orgId = org.id;
    orgSlug = org.slug;
    const user = await createTestUser({ email: 'query-taxonomy@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await createTestOAuthClient();
    token = (
      await createTestAccessToken(user.id, org.id, client.client_id, {
        scope: 'mcp:read profile:read',
      })
    ).token;
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

  it('marks an unknown-table result as an MCP error and renders the cause', async () => {
    const path = `/mcp/${orgSlug}`;
    const initResponse = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: '__test_init__',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'lobu-test', version: '1.0' },
        },
      },
      token,
    });
    const sessionId = initResponse.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await post(path, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers: { 'mcp-session-id': sessionId! },
      token,
    });

    const response = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'query_sql',
          arguments: { sql: 'SELECT platform FROM conversations' },
        },
      },
      headers: { 'mcp-session-id': sessionId! },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('conversations');
    expect(body.result?.content?.[0]?.text).toMatch(/queryable tables/i);
    expect(body.result?.content?.[0]?.text).not.toContain('SQL Query Results');
  }, 60_000);
});
