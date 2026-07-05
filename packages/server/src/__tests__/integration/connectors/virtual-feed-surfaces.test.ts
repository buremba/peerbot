/**
 * Virtual feeds surfaced EVERYWHERE (follow-up to #1702) — two seams, one file:
 *
 *  (1) search_memory recall: the `virtualSource` in RECALL_SOURCES runs a virtual
 *      feed's search() LIVE and returns a `virtual_feeds` facet — but ONLY for
 *      feeds that opt in via `config.recall === true`, capped + logged, ACL-fenced,
 *      failing independently. A feed without the flag stays invisible to recall.
 *
 *  (2) query_sql({ feed }): a virtual feed's STORED query runs LIVE, addressable
 *      by numeric id OR "connection_slug/feed_key". `search_term` narrows via the
 *      connector's search(); `feed`+`connection` together is rejected; the same
 *      AuthzScope visibility fence applies; a non-virtual feed ref is refused.
 *
 * Reuses the #1702 pattern: the "external" connection points back at the test DB,
 * so the postgres connector reads a throwaway table as if it were an external
 * source — a real end-to-end pushdown (subprocess compile + fork + live query),
 * no mocking.
 *
 * Red→green: without `virtualSource` in RECALL_SOURCES, (1) returns no
 * virtual_feeds facet; without the `feed` branch in query_sql, (2) can't address
 * a feed by id/key.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthzScope } from '../../../authz/scope';
import type { Env } from '../../../index';
import { manageFeeds } from '../../../tools/admin/manage_feeds';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { gatherRecall, type RecallContext } from '../../../tools/search';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';

const VFEED_SQL = 'SELECT id, name, amount FROM vfsurf_ext';

describe('virtual feed surfaces (recall + query_sql)', () => {
  let orgId: string;
  let ownerId: string;
  let ownerCtx: ToolContext;
  let recallFeedId: number; // opt-in virtual feed (config.recall=true)
  let plainFeedId: number; // virtual feed WITHOUT the recall flag
  let privRecallFeedId: number; // opt-in but on a PRIVATE connection (owner-only)
  let nonVirtualFeedId: number;

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

  const recallCtx = (query: string): RecallContext => ({
    query,
    contentAgentId: undefined,
    contentLimit: 10,
    env: {} as Env,
  });

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'VFeedSurfaces' });
    orgId = org.id;
    const user = await createTestUser({ email: 'vfsurf@test.com' });
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
      displayName: 'ext db',
      profileKind: 'env',
      authData: { DATABASE_URL: process.env.DATABASE_URL as string },
    });

    // Register the bundled postgres connector for this org (runnable from bundle;
    // compiled_code NULL → resolveConnectorCode compiles on demand).
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

    // Org-visible connection with THREE feeds: an opt-in recall feed, a plain
    // virtual feed (no recall flag), and a non-virtual control.
    const [orgConn] = await db`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by, created_at, updated_at)
      VALUES
        (${orgId}, 'postgres', 'vfsurf-org-db', 'Org DB', 'active', ${profile.id}, 'org', ${ownerId}, NOW(), NOW())
      RETURNING id
    `;
    const orgConnId = Number((orgConn as { id: number }).id);

    const [recallFeed] = await db`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, kind, virtual, config, created_at, updated_at)
      VALUES (${orgId}, ${orgConnId}, 'inbox', 'active', 'virtual', true,
        ${db.json({ query: VFEED_SQL, primary_key: 'id', cursor_column: 'id', recall: true })}, NOW(), NOW())
      RETURNING id
    `;
    recallFeedId = Number((recallFeed as { id: number }).id);

    const [plainFeed] = await db`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, kind, virtual, config, created_at, updated_at)
      VALUES (${orgId}, ${orgConnId}, 'plain', 'active', 'virtual', true,
        ${db.json({ query: VFEED_SQL, primary_key: 'id', cursor_column: 'id' })}, NOW(), NOW())
      RETURNING id
    `;
    plainFeedId = Number((plainFeed as { id: number }).id);

    const [normalFeed] = await db`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, kind, virtual, config, created_at, updated_at)
      VALUES (${orgId}, ${orgConnId}, 'synced', 'active', 'collected', false,
        ${db.json({ query: VFEED_SQL, primary_key: 'id', cursor_column: 'id' })}, NOW(), NOW())
      RETURNING id
    `;
    nonVirtualFeedId = Number((normalFeed as { id: number }).id);

    // PRIVATE connection owned by the owner + an opt-in recall feed on it — a
    // member must NOT see it surfaced in recall or reachable via query_sql.
    const [privConn] = await db`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by, created_at, updated_at)
      VALUES
        (${orgId}, 'postgres', 'vfsurf-priv-db', 'Private DB', 'active', ${profile.id}, 'private', ${ownerId}, NOW(), NOW())
      RETURNING id
    `;
    const privConnId = Number((privConn as { id: number }).id);
    const [privRecallFeed] = await db`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, kind, virtual, config, created_at, updated_at)
      VALUES (${orgId}, ${privConnId}, 'priv-inbox', 'active', 'virtual', true,
        ${db.json({ query: VFEED_SQL, primary_key: 'id', cursor_column: 'id', recall: true })}, NOW(), NOW())
      RETURNING id
    `;
    privRecallFeedId = Number((privRecallFeed as { id: number }).id);
  }, 120_000);

  afterAll(async () => {
    await getTestDb()`DROP TABLE IF EXISTS vfsurf_ext`;
  });

  // ---- (1) search_memory recall ------------------------------------------

  it('(1) gatherRecall surfaces an OPT-IN virtual feed as a virtual_feeds facet (live search)', async () => {
    const res = await gatherRecall(ownerScope(), recallCtx('ap'));
    expect(res.virtual_feeds).toBeDefined();
    // Only the org-visible opt-in feed matches for the owner (the private one also
    // opts in and the owner CAN see it — so expect BOTH the org + private feed).
    const byKey = new Map((res.virtual_feeds ?? []).map((b) => [b.feed_key, b]));
    expect(byKey.has('inbox')).toBe(true);
    // search('ap') → apple + apricot at the source (ILIKE pushdown), banana excluded.
    const inbox = byKey.get('inbox');
    expect((inbox?.rows ?? []).map((r) => r.name).sort()).toEqual(['apple', 'apricot']);
    expect(inbox?.feed_id).toBe(recallFeedId);
  }, 60_000);

  it('(1) does NOT surface a virtual feed that has not opted in (config.recall unset)', async () => {
    const res = await gatherRecall(ownerScope(), recallCtx('ap'));
    const keys = (res.virtual_feeds ?? []).map((b) => b.feed_key);
    expect(keys).not.toContain('plain'); // plainFeedId is virtual but not recall:true
  }, 60_000);

  it('(1) fences recall by AuthzScope: a member does not see the owner’s PRIVATE recall feed', async () => {
    const ownerRes = await gatherRecall(ownerScope(), recallCtx('ap'));
    const ownerKeys = (ownerRes.virtual_feeds ?? []).map((b) => b.feed_key);
    expect(ownerKeys).toContain('priv-inbox'); // owner sees it

    const memberRes = await gatherRecall(memberScope(), recallCtx('ap'));
    const memberKeys = (memberRes.virtual_feeds ?? []).map((b) => b.feed_key);
    expect(memberKeys).not.toContain('priv-inbox'); // member is fenced out
    expect(memberKeys).toContain('inbox'); // …but the org-visible one is visible
  }, 60_000);

  it('(1) omits the facet when the query matches no live rows', async () => {
    const res = await gatherRecall(ownerScope(), recallCtx('zzz-no-match'));
    expect(res.virtual_feeds).toBeUndefined();
  }, 60_000);

  it('(1) omits the facet entirely when there is no query text', async () => {
    const res = await gatherRecall(ownerScope(), recallCtx(''));
    expect(res.virtual_feeds).toBeUndefined();
  }, 60_000);

  // ---- (2) query_sql({ feed }) -------------------------------------------

  it('(2) query_sql addresses a virtual feed by numeric id and runs its STORED query live', async () => {
    const res = await querySql({ feed: String(recallFeedId), limit: 10 }, {}, ownerCtx);
    expect(res.error).toBeUndefined();
    expect(res.rows.map((r) => r.name).sort()).toEqual(['apple', 'apricot', 'banana']);
  }, 60_000);

  it('(2) query_sql warns that events SQL omits accessible virtual feeds', async () => {
    const ownerRes = await querySql({ sql: 'SELECT id FROM events LIMIT 1' }, {}, ownerCtx);
    expect(ownerRes.error).toBeUndefined();
    expect(ownerRes.coverage?.source).toBe('persisted_events_only');
    expect(ownerRes.coverage?.suggested_virtual_feeds.map((f) => f.feed).sort()).toEqual([
      'vfsurf-org-db/inbox',
      'vfsurf-org-db/plain',
      'vfsurf-priv-db/priv-inbox',
    ]);
    expect(ownerRes.coverage?.suggested_execution.example).toContain(
      'client.feeds.readMany'
    );

    const memberRes = await querySql({ sql: 'SELECT id FROM events LIMIT 1' }, {}, memberCtx());
    expect(memberRes.coverage?.suggested_virtual_feeds.map((f) => f.feed).sort()).toEqual([
      'vfsurf-org-db/inbox',
      'vfsurf-org-db/plain',
    ]);
  }, 60_000);

  it('(2) query_sql addresses a virtual feed by "connection_slug/feed_key"', async () => {
    const res = await querySql({ feed: 'vfsurf-org-db/inbox', limit: 10 }, {}, ownerCtx);
    expect(res.error).toBeUndefined();
    expect(res.rows.map((r) => r.name).sort()).toEqual(['apple', 'apricot', 'banana']);
  }, 60_000);

  it('(2) search_term narrows the feed read via the connector search() pushdown', async () => {
    const res = await querySql({ feed: String(recallFeedId), search_term: 'ap', limit: 10 }, {}, ownerCtx);
    expect(res.error).toBeUndefined();
    expect(res.rows.map((r) => r.name).sort()).toEqual(['apple', 'apricot']);
    expect(res.total_count).toBe(2);
  }, 60_000);

  it('(2) rejects passing both feed and connection', async () => {
    const res = await querySql({ feed: String(recallFeedId), connection: 'vfsurf-org-db' }, {}, ownerCtx);
    expect(res.error).toMatch(/either .*feed.* or .*connection/i);
  }, 60_000);

  it('(2) refuses to address a NON-virtual feed', async () => {
    const res = await querySql({ feed: String(nonVirtualFeedId) }, {}, ownerCtx);
    expect(res.error).toMatch(/not a virtual feed/i);
  }, 60_000);

  it('(2) errors on an unresolvable feed reference', async () => {
    const res = await querySql({ feed: 'vfsurf-org-db/nope' }, {}, ownerCtx);
    expect(res.error).toMatch(/not found or not accessible/i);
  }, 60_000);

  it('(2) a member cannot reach a feed on another user’s PRIVATE connection', async () => {
    const res = await querySql({ feed: String(privRecallFeedId) }, {}, memberCtx());
    expect(res.rows).toHaveLength(0);
    expect(res.error).toMatch(/not found or not accessible/i);
    // …and the owner still can.
    const ok = await querySql({ feed: String(privRecallFeedId) }, {}, ownerCtx);
    expect(ok.error).toBeUndefined();
    expect(ok.rows.length).toBe(3);
  }, 60_000);

  // ---- (3) manage_feeds read_feeds ---------------------------------------

  it('(3) read_feeds returns per-feed successes and failures', async () => {
    const res = (await manageFeeds(
      {
        action: 'read_feeds',
        feed_ids: [recallFeedId, 999_999_999],
        limit: 2,
      },
      {},
      ownerCtx
    )) as {
      action: 'read_feeds';
      failures: number;
      results: Array<{
        feed_id: number;
        ok: boolean;
        result?: any;
        error?: string;
      }>;
    };

    expect(res.action).toBe('read_feeds');
    expect(res.failures).toBe(1);
    const ok = res.results.find((r) => r.feed_id === recallFeedId);
    expect(ok?.ok).toBe(true);
    expect(ok?.result?.kind).toBe('virtual');
    expect(ok?.result?.rows).toHaveLength(2);
    const missing = res.results.find((r) => r.feed_id === 999_999_999);
    expect(missing).toMatchObject({ ok: false, error: 'Feed not found' });
  }, 60_000);

  it('(3) read_feeds preserves per-feed visibility failures', async () => {
    const res = (await manageFeeds(
      {
        action: 'read_feeds',
        feed_ids: [recallFeedId, privRecallFeedId],
        limit: 2,
      },
      {},
      memberCtx()
    )) as {
      failures: number;
      results: Array<{ feed_id: number; ok: boolean; error?: string }>;
    };

    expect(res.failures).toBe(1);
    expect(res.results.find((r) => r.feed_id === recallFeedId)?.ok).toBe(true);
    expect(res.results.find((r) => r.feed_id === privRecallFeedId)).toMatchObject({
      ok: false,
      error: 'Feed not found',
    });
  }, 60_000);
});
