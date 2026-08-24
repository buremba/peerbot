/**
 * Explicit source-read contract. Search reports visible source feeds without
 * querying them; feeds.get is metadata-only; feeds.readMany is the one bounded
 * live-read seam.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthzScope } from '../../../authz/scope';
import type { Env } from '../../../index';
import { manageFeeds } from '../../../tools/admin/manage_feeds';
import { QuerySqlSchema } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { gatherLocalRecall, type RecallContext } from '../../../tools/search';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';

const SOURCE_SQL = 'SELECT id, name, amount FROM vfsurf_ext ORDER BY id';

describe('explicit feed source reads', () => {
  let orgId: string;
  let ownerId: string;
  let ownerCtx: ToolContext;
  let publicFeedId: number;
  let privateFeedId: number;
  let collectedFeedId: number;

  const recallContext = (): RecallContext => ({
    query: 'apple',
    contentAgentId: undefined,
    contentLimit: 10,
    env: {} as Env,
  });
  const ownerScope = (): AuthzScope => ({ organizationId: orgId, principal: ownerId });
  const memberScope = (): AuthzScope => ({ organizationId: orgId, principal: 'member-x' });
  const memberCtx = (): ToolContext => ({
    organizationId: orgId,
    userId: 'member-x',
    memberRole: 'member',
    isAuthenticated: true,
    tokenType: 'oauth',
    scopedToOrg: false,
    allowCrossOrg: false,
    scopes: ['mcp:read'],
  });

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'ExplicitFeedReads' });
    orgId = org.id;
    const user = await createTestUser({ email: 'explicit-feed-read@test.com' });
    ownerId = user.id;
    await addUserToOrganization(user.id, org.id, 'owner');
    ownerCtx = ownerToolContext(orgId, user.id);

    const db = getTestDb();
    await db`DROP TABLE IF EXISTS vfsurf_ext`;
    await db`CREATE TABLE vfsurf_ext (id bigserial primary key, name text, amount numeric)`;
    await db`INSERT INTO vfsurf_ext (name, amount) VALUES ('apple', 10), ('banana', 5), ('apricot', 7)`;

    const profile = await createAuthProfile({
      organizationId: orgId,
      connectorKey: 'postgres',
      displayName: 'external db',
      profileKind: 'env',
      authData: { DATABASE_URL: process.env.DATABASE_URL as string },
    });
    await db`
      INSERT INTO connector_definitions
        (key, name, version, feeds_schema, auth_schema, organization_id, status, created_at, updated_at)
      VALUES ('postgres', 'PostgreSQL', '1.0.0', ${db.json({})}, ${db.json({})}, ${orgId}, 'active', NOW(), NOW())
      ON CONFLICT DO NOTHING
    `;
    await db`
      INSERT INTO connector_versions (connector_key, version, compiled_code, source_path, created_at)
      VALUES ('postgres', '1.0.0', NULL, NULL, NOW())
      ON CONFLICT DO NOTHING
    `;

    const createConnection = async (slug: string, visibility: 'org' | 'private') => {
      const [row] = await db`
        INSERT INTO connections
          (organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by, created_at, updated_at)
        VALUES (${orgId}, 'postgres', ${slug}, ${slug}, 'active', ${profile.id}, ${visibility}, ${ownerId}, NOW(), NOW())
        RETURNING id
      `;
      return Number((row as { id: number }).id);
    };
    const publicConnectionId = await createConnection('explicit-public', 'org');
    const privateConnectionId = await createConnection('explicit-private', 'private');

    const createFeed = async (connectionId: number, feedKey: string, virtual: boolean) => {
      const [row] = await db`
        INSERT INTO feeds
          (organization_id, connection_id, feed_key, display_name, status, kind, virtual, config, created_at, updated_at)
        VALUES (${orgId}, ${connectionId}, ${feedKey}, ${feedKey}, 'active',
          ${virtual ? 'virtual' : 'collected'}, ${virtual},
          ${db.json({ query: SOURCE_SQL, primary_key: 'id', cursor_column: 'id' })}, NOW(), NOW())
        RETURNING id
      `;
      return Number((row as { id: number }).id);
    };
    publicFeedId = await createFeed(publicConnectionId, 'public-source', true);
    privateFeedId = await createFeed(privateConnectionId, 'private-source', true);
    collectedFeedId = await createFeed(publicConnectionId, 'collected', false);
  }, 120_000);

  afterAll(async () => {
    await getTestDb()`DROP TABLE IF EXISTS vfsurf_ext`;
  });

  it('search stays local and reports source feeds as not queried under the visibility fence', async () => {
    const owner = await gatherLocalRecall(ownerScope(), recallContext());
    expect(owner.coverage).toMatchObject({
      source_queried: false,
      source_feed_discovery: 'complete',
    });
    expect(owner.coverage?.source_feeds.map((feed) => feed.feed_id).sort()).toEqual(
      [publicFeedId, privateFeedId].sort()
    );
    expect(owner.coverage?.source_feeds.every((feed) => feed.status === 'not_queried')).toBe(true);

    const member = await gatherLocalRecall(memberScope(), recallContext());
    expect(member.coverage?.source_feeds.map((feed) => feed.feed_id)).toEqual([publicFeedId]);
  });

  it('feeds.get returns metadata and never source rows', async () => {
    const result = await manageFeeds(
      { action: 'read_feed', feed_id: publicFeedId },
      {},
      ownerCtx
    );
    expect(result).toMatchObject({ action: 'read_feed', kind: 'virtual' });
    expect(result).toHaveProperty('recent_runs');
    expect(result).not.toHaveProperty('rows');
  });

  it('query_sql no longer accepts a feed argument', () => {
    expect(QuerySqlSchema.properties).not.toHaveProperty('feed');
    expect(QuerySqlSchema.required).toContain('sql');
  });

  it('readMany returns partial failures and structured error metadata', async () => {
    const result = await manageFeeds(
      {
        action: 'read_feeds',
        reads: [
          { feed_id: publicFeedId, limit: 2 },
          { feed_id: 999_999_999 },
          { feed_id: collectedFeedId },
        ],
      },
      {},
      ownerCtx
    );
    if (result.action !== 'read_feeds') throw new Error('expected read_feeds result');
    expect(result.failures).toBe(2);
    expect(result.results[0]).toMatchObject({ feed_id: publicFeedId, ok: true });
    expect(result.results[0].rows).toHaveLength(2);
    expect(result.results[1]).toMatchObject({
      ok: false,
      error_code: 'NOT_FOUND',
      retryable: false,
    });
    expect(result.results[2]).toMatchObject({
      ok: false,
      error_code: 'VALIDATION',
      retryable: false,
    });
  }, 60_000);

  it('supports per-feed query and opaque query-bound pagination cursors', async () => {
    const first = await manageFeeds(
      { action: 'read_feeds', reads: [{ feed_id: publicFeedId, query: 'ap', limit: 1 }] },
      {},
      ownerCtx
    );
    if (first.action !== 'read_feeds') throw new Error('expected read_feeds result');
    const firstRead = first.results[0];
    expect(firstRead.rows).toHaveLength(1);
    expect(firstRead.next_cursor).toBeTypeOf('string');

    const second = await manageFeeds(
      {
        action: 'read_feeds',
        reads: [
          {
            feed_id: publicFeedId,
            query: 'ap',
            limit: 1,
            cursor: firstRead.next_cursor,
          },
        ],
      },
      {},
      ownerCtx
    );
    if (second.action !== 'read_feeds') throw new Error('expected read_feeds result');
    expect(second.results[0].rows).toHaveLength(1);
    expect(second.results[0].rows?.[0]).not.toEqual(firstRead.rows?.[0]);

    const mismatched = await manageFeeds(
      {
        action: 'read_feeds',
        reads: [
          { feed_id: publicFeedId, query: 'banana', cursor: firstRead.next_cursor },
        ],
      },
      {},
      ownerCtx
    );
    if (mismatched.action !== 'read_feeds') throw new Error('expected read_feeds result');
    expect(mismatched.results[0]).toMatchObject({ ok: false, error_code: 'VALIDATION' });
  }, 60_000);

  it('keeps each explicit source read visibility-fenced', async () => {
    const result = await manageFeeds(
      {
        action: 'read_feeds',
        reads: [{ feed_id: publicFeedId }, { feed_id: privateFeedId }],
      },
      {},
      memberCtx()
    );
    if (result.action !== 'read_feeds') throw new Error('expected read_feeds result');
    expect(result.results[0].ok).toBe(true);
    expect(result.results[1]).toMatchObject({ ok: false, error_code: 'NOT_FOUND' });
  }, 60_000);
});
