/**
 * Virtual feed flag (Slice 2) — end-to-end.
 *
 * Proves the three capability guarantees:
 *  (a) the sync scheduler NEVER selects a `virtual = true` feed for sync — even
 *      one whose next_run_at is in the past (so the guard, not a NULL schedule,
 *      is what excludes it);
 *  (b) `readVirtualFeed` returns LIVE rows via the connector's query()/search()
 *      pushdown WITHOUT writing to `events`;
 *  (c) an out-of-scope user is fenced by the AuthzScope connection-visibility
 *      rule (a member cannot read another user's PRIVATE virtual feed).
 *
 * Red→green: without `AND f.virtual IS NOT TRUE` in check-due-feeds, assertion
 * (a) fails (the virtual feed gets a sync run); without the `virtual` column +
 * readVirtualFeed seam, (b)/(c) don't compile/run.
 *
 * The "external" connection points back at the test DB URL, so the connector
 * opens a fresh pool and reads a throwaway table as if it were an external source.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthzScope } from '../../../authz/scope';
import type { Env } from '../../../index';
import { readVirtualFeed } from '../../../lib/connector-pushdown';
import { materializeDueFeeds } from '../../../scheduled/check-due-feeds';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { addUserToOrganization, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const VFEED_SQL = 'SELECT id, name, amount FROM vfeed_ext';

describe('virtual feed flag (Slice 2)', () => {
  let orgId: string;
  let ownerId: string;
  let orgConnId: number;
  let orgFeedId: number;
  let privFeedId: number;
  let nonVirtualFeedId: number;

  const ownerScope = (): AuthzScope => ({ organizationId: orgId, principal: ownerId });
  const memberScope = (): AuthzScope => ({ organizationId: orgId, principal: 'member-x' });

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'VirtualFeed' });
    orgId = org.id;
    const user = await createTestUser({ email: 'vfeed@test.com' });
    ownerId = user.id;
    await addUserToOrganization(user.id, org.id, 'owner');

    const db = getTestDb();
    await db`DROP TABLE IF EXISTS vfeed_ext`;
    await db`CREATE TABLE vfeed_ext (id bigserial primary key, name text, amount numeric)`;
    await db`INSERT INTO vfeed_ext (name, amount) VALUES ('apple', 10), ('banana', 5), ('apricot', 7)`;

    const profile = await createAuthProfile({
      organizationId: orgId,
      connectorKey: 'postgres',
      displayName: 'ext db',
      profileKind: 'env',
      authData: { DATABASE_URL: process.env.DATABASE_URL as string },
    });

    // Register the postgres connector for this org so the scheduler's
    // createSyncRun resolves it as runnable (the non-virtual control feed gets a
    // real run instead of being soft-deleted as an orphan). compiled_code is
    // NULL — postgres is a BUNDLED connector, so it's runnable from the bundle
    // and the live read still compiles it on demand (no stub to break query()).
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

    // Org-visible connection + a VIRTUAL feed (virtual=true; sync-lifecycle
    // columns NULL). config.query holds the live read-only SELECT.
    const [orgConn] = await db`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by, created_at, updated_at)
      VALUES
        (${orgId}, 'postgres', 'vfeed-org-db', 'Org DB', 'active', ${profile.id}, 'org', ${ownerId}, NOW(), NOW())
      RETURNING id
    `;
    orgConnId = Number((orgConn as { id: number }).id);
    const [orgFeed] = await db`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, virtual, config, created_at, updated_at)
      VALUES (${orgId}, ${orgConnId}, 'query', 'active', true,
        ${db.json({ query: VFEED_SQL, primary_key: 'id', cursor_column: 'id' })}, NOW(), NOW())
      RETURNING id
    `;
    orgFeedId = Number((orgFeed as { id: number }).id);

    // A NON-virtual feed on the same connection, due in the past — the scheduler
    // control: it MUST be picked while the virtual one is skipped.
    const [normalFeed] = await db`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, virtual, config, next_run_at, schedule, created_at, updated_at)
      VALUES (${orgId}, ${orgConnId}, 'query', 'active', false,
        ${db.json({ query: VFEED_SQL, primary_key: 'id', cursor_column: 'id' })},
        NOW() - INTERVAL '1 minute', '*/5 * * * *', NOW(), NOW())
      RETURNING id
    `;
    nonVirtualFeedId = Number((normalFeed as { id: number }).id);

    // A PRIVATE connection owned by the owner + its virtual feed — a member must
    // not reach it through the AuthzScope visibility rule.
    const [privConn] = await db`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by, created_at, updated_at)
      VALUES
        (${orgId}, 'postgres', 'vfeed-priv-db', 'Private DB', 'active', ${profile.id}, 'private', ${ownerId}, NOW(), NOW())
      RETURNING id
    `;
    const privConnId = Number((privConn as { id: number }).id);
    const [privFeed] = await db`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, virtual, config, created_at, updated_at)
      VALUES (${orgId}, ${privConnId}, 'query', 'active', true,
        ${db.json({ query: VFEED_SQL, primary_key: 'id', cursor_column: 'id' })}, NOW(), NOW())
      RETURNING id
    `;
    privFeedId = Number((privFeed as { id: number }).id);
  }, 120_000);

  afterAll(async () => {
    await getTestDb()`DROP TABLE IF EXISTS vfeed_ext`;
  });

  it('(a) the sync scheduler skips the virtual feed but selects the non-virtual one', async () => {
    const db = getTestDb();
    // Force the virtual feed "due" — past next_run_at — to prove the `virtual`
    // guard (not a NULL schedule) is what excludes it.
    await db`UPDATE feeds SET next_run_at = NOW() - INTERVAL '1 minute' WHERE id = ${orgFeedId}`;

    await materializeDueFeeds({} as Env, db);

    const virtualRuns = await db`
      SELECT count(*)::int AS n FROM runs WHERE feed_id = ${orgFeedId} AND run_type = 'sync'
    `;
    expect(Number((virtualRuns[0] as { n: number }).n)).toBe(0);

    const normalRuns = await db`
      SELECT count(*)::int AS n FROM runs WHERE feed_id = ${nonVirtualFeedId} AND run_type = 'sync'
    `;
    expect(Number((normalRuns[0] as { n: number }).n)).toBeGreaterThan(0);
  }, 60_000);

  it('(b) readVirtualFeed returns live rows via query() and persists no events', async () => {
    const res = await readVirtualFeed({ scope: ownerScope(), feedId: orgFeedId, limit: 10 });
    expect(res.rows.map((r) => r.name).sort()).toEqual(['apple', 'apricot', 'banana']);

    // No events were written — a virtual read is live, never a sync.
    const events = await getTestDb()`SELECT count(*)::int AS n FROM events WHERE connection_id = ${orgConnId}`;
    expect(Number((events[0] as { n: number }).n)).toBe(0);
  }, 60_000);

  it('(b) readVirtualFeed pushes keyword terms down via search() (ILIKE at source)', async () => {
    const res = await readVirtualFeed({ scope: ownerScope(), feedId: orgFeedId, terms: ['ap'] });
    // 'apple' + 'apricot' match 'ap'; 'banana' does not.
    expect(res.rows.map((r) => r.name).sort()).toEqual(['apple', 'apricot']);
    expect(res.total).toBe(2);

    const events = await getTestDb()`SELECT count(*)::int AS n FROM events WHERE connection_id = ${orgConnId}`;
    expect(Number((events[0] as { n: number }).n)).toBe(0);
  }, 60_000);

  it('(c) a member cannot read another user’s PRIVATE virtual feed (AuthzScope fence)', async () => {
    await expect(
      readVirtualFeed({ scope: memberScope(), feedId: privFeedId })
    ).rejects.toThrow(/not found or not accessible/i);

    // …and the owner still can.
    const ok = await readVirtualFeed({ scope: ownerScope(), feedId: privFeedId });
    expect(ok.rows.length).toBe(3);
  }, 60_000);

  it('refuses to read a NON-virtual feed live', async () => {
    await expect(
      readVirtualFeed({ scope: ownerScope(), feedId: nonVirtualFeedId })
    ).rejects.toThrow(/not a virtual feed/i);
  }, 60_000);
});
