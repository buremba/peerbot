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
import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';
import { compileConnectorSource } from '../../../utils/connector-compiler';
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

  // Routing regression: `connector_definitions.runtime` is DESCRIPTIVE metadata
  // (platforms, nix inputs), not a durable "device-only" claim. A connector that
  // declares one and still has code — as this bundled one does, with
  // `connector_versions.compiled_code IS NULL` and its source on disk — must keep
  // the compiled pushdown. Routing it to a device would demote a real `query()`
  // to a round-trip and fail outright wherever no device is paired.
  it('keeps a runtime-declaring COMPILED connector on the pushdown, not the device seam', async () => {
    const db = getTestDb();
    await db`
      UPDATE connector_definitions
      SET runtime = ${db.json({ platforms: ['macos', 'linux'], nix: { packages: ['postgresql'] } })}
      WHERE key = 'postgres' AND organization_id = ${orgId}
    `;
    try {
      const res = await readVirtualFeed({ scope: ownerScope(), feedId: orgFeedId, limit: 10 });
      // Real rows from the connector's own query(), so the compiled path ran.
      expect(res.rows.map((r) => r.name).sort()).toEqual(['apple', 'apricot', 'banana']);
      // And no device action run was enqueued behind it.
      const actions = await db`
        SELECT count(*)::int AS n FROM runs
        WHERE organization_id = ${orgId} AND run_type = 'action'
      `;
      expect(Number((actions[0] as { n: number }).n)).toBe(0);
    } finally {
      await db`
        UPDATE connector_definitions SET runtime = NULL
        WHERE key = 'postgres' AND organization_id = ${orgId}
      `;
    }
  }, 60_000);

  it('refuses to read a NON-virtual feed live', async () => {
    await expect(
      readVirtualFeed({ scope: ownerScope(), feedId: nonVirtualFeedId })
    ).rejects.toThrow(/not a virtual feed/i);
  }, 60_000);

  it('refuses to read a PAUSED virtual feed live (status gate)', async () => {
    // A paused (or error) feed is not deleted but must not serve live reads —
    // the lookup gates on f.status = 'active', so it resolves to "not found".
    const db = getTestDb();
    const [paused] = await db`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, virtual, config, created_at, updated_at)
      VALUES (${orgId}, ${orgConnId}, 'query', 'paused', true,
        ${db.json({ query: VFEED_SQL, primary_key: 'id', cursor_column: 'id' })}, NOW(), NOW())
      RETURNING id
    `;
    const pausedId = Number((paused as { id: number }).id);
    await expect(
      readVirtualFeed({ scope: ownerScope(), feedId: pausedId })
    ).rejects.toThrow(/not found or not accessible/i);
  }, 60_000);
});

/**
 * Which virtual feeds take the DEVICE seam, and which stay on the compiled
 * pushdown.
 *
 * `connector_definitions.runtime` is descriptive metadata (platforms, nix
 * inputs). On its own it is not a durable "no server code" signal, so routing
 * asks the same question the EXECUTION resolver asks: does
 * `resolveConnectorCodeForKey` → `resolveConnectorCode` have something to run?
 * That is `connector_versions.compiled_code`, or a bundled source file on disk —
 * and nothing else.
 *
 * `source_path` is deliberately excluded, and this file pins that. It appears in
 * queue-service's `resolveActiveConnectorVersion`, but that is a laxer READINESS
 * gate; `resolveConnectorCode` never loads it. Device manifests set it to
 * `device-manifest://…` precisely as a non-executable marker, so adopting the
 * laxer union would classify every device connector as having code and break
 * this routing outright.
 */

const RUNTIME_META = { platforms: ['macos', 'linux'], nix: { packages: ['ffmpeg'] } };

const COMPILED_KEY = 'demo.routing.compiled';
const SOURCE_PATH_ONLY_KEY = 'demo.routing.source_path_only';

const COMPILED_SOURCE = `
export class MyConnector {
  definition = {
    key: '${COMPILED_KEY}',
    name: 'Compiled With Runtime',
    version: '1.0.0',
    feeds: { rows: { name: 'Rows' } },
  };
  async sync() { return { items: [] }; }
  async execute() { return { success: true, output: {} }; }
  async query() {
    return {
      rows: [{ id: 1, name: 'from compiled query()' }],
      columns: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }],
      total: 1,
    };
  }
}
`;

describe('virtual feed routing — device seam vs compiled pushdown', () => {
  let routingOrgId: string;
  let routingUserId: string;
  let compiledFeedId: number;
  let sourcePathFeedId: number;

  const routingScope = (): AuthzScope => ({
    organizationId: routingOrgId,
    principal: routingUserId,
  });

  /** A definition + connection + virtual feed for one connector key. */
  async function seedRoutingConnector(opts: {
    key: string;
    compiledCode: string | null;
    sourcePath: string | null;
  }): Promise<number> {
    const db = getTestDb();
    await db`
      INSERT INTO connector_definitions
        (key, name, version, runtime, feeds_schema, auth_schema, organization_id, status,
         created_at, updated_at)
      VALUES (${opts.key}, ${opts.key}, '1.0.0', ${db.json(RUNTIME_META)},
              ${db.json({ rows: { key: 'rows', virtual: true } })}, ${db.json({})},
              ${routingOrgId}, 'active', NOW(), NOW())
    `;
    await db`
      INSERT INTO connector_versions
        (connector_key, version, compiled_code, source_path, compile_config_hash, created_at)
      VALUES (${opts.key}, '1.0.0', ${opts.compiledCode}, ${opts.sourcePath},
              ${opts.compiledCode ? COMPILE_CONFIG_HASH : null}, NOW())
    `;
    const [conn] = await db`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, visibility,
         created_by, created_at, updated_at)
      VALUES (${routingOrgId}, ${opts.key}, ${`c-${opts.key}`}, ${opts.key}, 'active',
              'org', ${routingUserId}, NOW(), NOW())
      RETURNING id
    `;
    const [feed] = await db`
      INSERT INTO feeds
        (organization_id, connection_id, feed_key, status, virtual, kind, config,
         created_at, updated_at)
      VALUES (${routingOrgId}, ${Number((conn as { id: number }).id)}, 'rows', 'active', true,
              'virtual', ${db.json({})}, NOW(), NOW())
      RETURNING id
    `;
    return Number((feed as { id: number }).id);
  }

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'VFeedRouting' });
    routingOrgId = org.id;
    const user = await createTestUser({ email: 'vfeed-routing@test.com' });
    routingUserId = user.id;
    await addUserToOrganization(user.id, org.id, 'owner');

    // Representation 1: a stored compiled artifact.
    const compiled = await compileConnectorSource(COMPILED_SOURCE);
    compiledFeedId = await seedRoutingConnector({
      key: COMPILED_KEY,
      compiledCode: compiled.compiledCode,
      sourcePath: null,
    });

    // The device-manifest shape: NO compiled code, NO bundled file on disk, and
    // a `source_path` that is a marker rather than loadable source.
    sourcePathFeedId = await seedRoutingConnector({
      key: SOURCE_PATH_ONLY_KEY,
      compiledCode: null,
      sourcePath: `device-manifest://macos/${SOURCE_PATH_ONLY_KEY}@1.0.0`,
    });
  }, 120_000);

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  // Representation 1 of "has runnable code": a STORED compiled artifact.
  it('keeps a runtime-declaring connector with STORED compiled code on the pushdown', async () => {
    const res = await readVirtualFeed({ scope: routingScope(), feedId: compiledFeedId });
    // Rows produced by the connector's own query(), so the compiled path ran.
    expect(res.rows).toEqual([{ id: 1, name: 'from compiled query()' }]);
    const actions = await getTestDb()`
      SELECT count(*)::int AS n FROM runs
      WHERE organization_id = ${routingOrgId} AND run_type = 'action'
    `;
    expect(Number((actions[0] as { n: number }).n)).toBe(0);
  }, 60_000);

  // Representation 2 — a BUNDLED on-disk source with compiled_code NULL — is
  // covered by the postgres fixture in the suite above ('keeps a
  // runtime-declaring COMPILED connector on the pushdown, not the device seam').

  // The negative, and the reason routing must not borrow queue-service's laxer
  // runnable union: `source_path` alone is NOT executable code. If it counted,
  // every device-manifest connector would be misrouted to the compiled path and
  // die in resolveConnectorCodeForKey instead of reaching its paired Mac.
  it('routes a runtime connector whose only artifact is a source_path to the device seam', async () => {
    const error = await readVirtualFeed({
      scope: routingScope(),
      feedId: sourcePathFeedId,
    }).then(
      () => null,
      (err: Error) => err
    );
    if (!error) throw new Error('expected the read to be refused');
    // The DEVICE seam's preflight spoke, not the compiled resolver. That is the
    // routing assertion: a compiled-path failure would say "No compiled code".
    expect(error.message).toMatch(/Live read of feed 'rows' is unavailable/);
    expect(error.message).not.toMatch(/No compiled code/);
  }, 60_000);
});
