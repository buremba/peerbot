/**
 * Postgres connector sync — keyset incremental + validation, against a real DB.
 *
 * Drives the connector directly (the same class the connector-worker runs),
 * pointed at the test DB URL, reading a throwaway table. Exercises
 * validateBaseQuery → keyset compound-cursor wrap → column-type probe →
 * checkpoint round-trip end to end.
 */

import { createPinnedSocketFactory } from '@lobu/connectors/db-egress-guard';
import PostgresConnector from '@lobu/connectors/postgres';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestDb } from '../../setup/test-db';

const conn = new PostgresConnector();
const cfg = {
  query: 'SELECT id, email, created_at FROM pgc_it',
  primary_key: 'id',
  cursor_column: 'created_at',
};
const run = (over: Record<string, unknown>, checkpoint: unknown) =>
  conn.sync({
    feedKey: 'query',
    config: { DATABASE_URL: process.env.DATABASE_URL, ...cfg, ...over } as never,
    checkpoint: checkpoint as never,
    credentials: null,
    entityIds: [],
  });

describe('PostgresConnector.sync (keyset incremental, real DB)', () => {
  beforeAll(async () => {
    const db = getTestDb();
    await db`DROP TABLE IF EXISTS pgc_it`;
    await db`CREATE TABLE pgc_it (id bigserial primary key, email text, created_at timestamptz)`;
    // two rows share created_at → exercises the (cursor, pk) keyset tiebreak.
    await db`INSERT INTO pgc_it (email, created_at) VALUES
      ('a@x.com','2026-01-01T10:00:00Z'),
      ('b@x.com','2026-01-01T10:00:00Z'),
      ('c@x.com','2026-01-02T10:00:00Z')`;
  });

  afterAll(async () => {
    await getTestDb()`DROP TABLE IF EXISTS pgc_it`;
  });

  it('pulls all rows on first sync and advances the compound checkpoint', async () => {
    const r = await run({}, null);
    expect(r.events.map((e) => e.origin_id)).toEqual(['query:1', 'query:2', 'query:3']);
    expect(r.checkpoint).toMatchObject({
      last_cursor: expect.any(String),
      last_pk: expect.any(String),
    });
  });

  it('is incremental: a re-sync from the checkpoint yields no rows', async () => {
    const r1 = await run({}, null);
    const r2 = await run({}, r1.checkpoint);
    expect(r2.events).toHaveLength(0);
  });

  it('picks up only newly-inserted rows past the watermark', async () => {
    const r1 = await run({}, null);
    const db = getTestDb();
    await db`INSERT INTO pgc_it (email, created_at) VALUES ('d@x.com','2026-01-03T10:00:00Z')`;
    try {
      const r2 = await run({}, r1.checkpoint);
      expect(r2.events.map((e) => e.origin_id)).toEqual(['query:4']);
    } finally {
      await db`DELETE FROM pgc_it WHERE email = 'd@x.com'`;
    }
  });

  it('accepts exotic-but-valid Postgres (no SQL parser to false-reject it)', async () => {
    // The connector does a structural read-only check, not an AST parse, so SQL a
    // Postgres-grammar parser would choke on (`IS NOT DISTINCT FROM`, FTS @@,
    // jsonpath, GROUPING SETS, range casts …) runs fine — the read-only
    // transaction is the real write seal.
    const r = await run(
      { query: 'SELECT id, email, created_at FROM pgc_it WHERE email IS NOT DISTINCT FROM email' },
      null
    );
    expect(r.events.map((e) => e.origin_id)).toEqual(['query:1', 'query:2', 'query:3']);
  });

  it('namespaces origin_id by feed instance so two feeds on one connection do not collide', async () => {
    // Both feeds share feedKey 'query' and the same primary keys; distinct feedId
    // must keep their origin_ids apart (else one supersedes the other's events).
    const conn = new PostgresConnector();
    const base = {
      DATABASE_URL: process.env.DATABASE_URL,
      query: 'SELECT id, email, created_at FROM pgc_it',
      primary_key: 'id',
      cursor_column: 'created_at',
    };
    const feedA = await conn.sync({
      feedKey: 'query',
      feedId: 101,
      config: base as never,
      checkpoint: null as never,
      credentials: null,
      entityIds: [],
    });
    const feedB = await conn.sync({
      feedKey: 'query',
      feedId: 202,
      config: base as never,
      checkpoint: null as never,
      credentials: null,
      entityIds: [],
    });
    expect(feedA.events[0].origin_id).toBe('101:1');
    expect(feedB.events[0].origin_id).toBe('202:1');
    // Same pk, different feed → no collision.
    const aIds = new Set(feedA.events.map((e) => e.origin_id));
    expect(feedB.events.some((e) => aIds.has(e.origin_id))).toBe(false);
  });

  it('rejects invalid base queries before connecting', async () => {
    await expect(run({ query: 'SELECT 1; DROP TABLE pgc_it' }, null)).rejects.toThrow(
      /single statement/i
    );
    await expect(run({ query: 'SELECT id, created_at FROM pgc_it LIMIT 5' }, null)).rejects.toThrow(
      /LIMIT/i
    );
    await expect(run({ query: 'UPDATE pgc_it SET email = NULL' }, null)).rejects.toThrow(/SELECT/i);
  });

  it('blocks an internal host under the block-private egress policy (cloud)', async () => {
    // The test DB is on loopback; block-private rejects it before any socket
    // opens. The TLS gate runs FIRST (fail fast, no DNS), so strip any
    // sslmode=disable off the test URL to reach the host classifier.
    // (allow-private — the default exercised by every other case here — allows it.)
    const noSslmode = (process.env.DATABASE_URL ?? '').replace(/[?&]sslmode=[^&]*/, '');
    await expect(
      run({ DATABASE_URL: noSslmode, LOBU_DB_EGRESS_POLICY: 'block-private' }, null)
    ).rejects.toThrow(/blocked internal\/metadata/i);
  });

  it('rejects sslmode=disable under block-private BEFORE the host check (forced TLS)', async () => {
    const base = (process.env.DATABASE_URL ?? '').replace(/[?&]sslmode=[^&]*/, '');
    const disabled = base + (base.includes('?') ? '&' : '?') + 'sslmode=disable';
    await expect(
      run({ DATABASE_URL: disabled, LOBU_DB_EGRESS_POLICY: 'block-private' }, null)
    ).rejects.toThrow(/TLS is required/i);
  });

  it('query() also enforces the egress policy', async () => {
    const conn2 = new PostgresConnector();
    const noSslmode = (process.env.DATABASE_URL ?? '').replace(/[?&]sslmode=[^&]*/, '');
    await expect(
      conn2.query({
        feedKey: null,
        query: 'SELECT 1 AS one',
        config: {
          DATABASE_URL: noSslmode,
          LOBU_DB_EGRESS_POLICY: 'block-private',
        },
        credentials: null,
      } as never)
    ).rejects.toThrow(/blocked internal\/metadata/i);
  });

  it('postgres.js completes a real session through the pinned socket factory', async () => {
    // The riskiest hardening assumption is that postgres.js honors a custom
    // `socket` option end to end (it is unpublished in its types). Prove it
    // against the real test DB: pin the URL's host to its loopback IP and run a
    // query through the factory-made socket. (block-private itself cannot be
    // exercised against loopback — it would rightly reject the host — so this
    // validates the MECHANISM the cloud path relies on.)
    const url = new URL((process.env.DATABASE_URL ?? '').replace(/^postgres(ql)?:/, 'http:'));
    const pinned = new Map([[url.hostname.toLowerCase(), '127.0.0.1']]);
    const sql = postgres(process.env.DATABASE_URL as string, {
      max: 1,
      prepare: false,
      socket: createPinnedSocketFactory(pinned),
    } as never);
    try {
      const rows = await sql.unsafe('SELECT 41 + 1 AS answer');
      expect(rows[0]?.answer).toBe(42);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('labels result column types from the OID map (incl. name / jsonb / oid)', async () => {
    const conn2 = new PostgresConnector();
    const r = await conn2.query({
      feedKey: null,
      query:
        "SELECT 1::bigint AS a, 'x'::text AS b, true AS c, now() AS d, '{}'::jsonb AS e, 'y'::name AS f, 1::oid AS g, 1.5::numeric AS h",
      config: { DATABASE_URL: process.env.DATABASE_URL },
      credentials: null,
    } as never);
    const types = Object.fromEntries((r.columns ?? []).map((c) => [c.name, c.type]));
    expect(types).toMatchObject({
      a: 'bigint',
      b: 'text',
      c: 'boolean',
      d: 'timestamptz',
      e: 'jsonb',
      f: 'name',
      g: 'oid',
      h: 'numeric',
    });
  });

  it('rejects a write-capable CTE (read-only connector contract)', async () => {
    await expect(
      run(
        {
          query:
            "WITH x AS (INSERT INTO pgc_it (email, created_at) VALUES ('hack','2030-01-01') RETURNING id) SELECT * FROM x",
        },
        null
      )
    ).rejects.toThrow(/data-modifying/i);
    // The write must NOT have happened.
    const [{ n }] = await getTestDb()`SELECT count(*)::int AS n FROM pgc_it WHERE email = 'hack'`;
    expect(Number(n)).toBe(0);
  });

  it('executes postgres query inside V8 isolate with host-mediated socket and egress policy', async () => {
    const { createIsolateConnectorCompiler } = await import('@lobu/connector-worker/compile');
    const { IsolateExecutor } = await import('@lobu/connector-worker/executor/isolate');
    const path = await import('node:path');
    const { compileConnectorForIsolateFromFile } = createIsolateConnectorCompiler();
    const connectorPath = path.resolve(__dirname, '../../../../../connectors/src/postgres.ts');
    const code = await compileConnectorForIsolateFromFile(connectorPath);

    const executor = new IsolateExecutor({ timeoutMs: 10000, memoryMb: 512 });

    // The TLS gate runs before the host classifier on this lane too (case 4),
    // so strip any `sslmode=disable` off the test URL to reach the address
    // checks -- the same strip the direct-drive cases above use.
    const baseUrl = (process.env.DATABASE_URL ?? '').replace(/[?&]sslmode=[^&]*/, '');

    // 1. Under block-private policy in env, connection to 127.0.0.1 test DB is blocked by SSRF egress guard
    await expect(
      executor.execute(code, {
        mode: 'query',
        query: 'SELECT 1 AS n',
        config: { DATABASE_URL: baseUrl },
        checkpoint: null,
        credentials: null,
        sessionState: null,
        env: { LOBU_DB_EGRESS_POLICY: 'block-private' },
      })
    ).rejects.toThrow(/EgressDenied/);

    // 1b. Policy passed via config (gateway pushdown pattern) is also enforced
    await expect(
      executor.execute(code, {
        mode: 'query',
        query: 'SELECT 1 AS n',
        config: {
          DATABASE_URL: baseUrl,
          LOBU_DB_EGRESS_POLICY: 'block-private',
        },
        checkpoint: null,
        credentials: null,
        sessionState: null,
        env: {},
      })
    ).rejects.toThrow(/EgressDenied/);

    // 2. Under allow-private policy, connection succeeds through isolate host socket
    const res = await executor.execute(code, {
      mode: 'query',
      query: 'SELECT count(*)::int AS n FROM pgc_it',
      config: { DATABASE_URL: process.env.DATABASE_URL },
      checkpoint: null,
      credentials: null,
      sessionState: null,
      env: { LOBU_DB_EGRESS_POLICY: 'allow-private' },
    });
    expect(res).toBeDefined();
    expect((res as any).rows[0].n).toBe(3);

    // 3. Under allow-private policy, sync mode runs inside isolate and emits all events
    const emittedEvents: any[] = [];
    const syncRes = await executor.execute(
      code,
      {
        mode: 'sync',
        feedKey: 'query',
        config: {
          DATABASE_URL: process.env.DATABASE_URL,
          query: 'SELECT id, email, created_at FROM pgc_it',
          primary_key: 'id',
          cursor_column: 'created_at',
        },
        checkpoint: null,
        credentials: null,
        sessionState: null,
        env: { LOBU_DB_EGRESS_POLICY: 'allow-private' },
      },
      {
        onEventChunk: (events) => {
          emittedEvents.push(...events);
        },
      }
    );
    expect(syncRes).toMatchObject({ mode: 'sync' });
    expect(emittedEvents.map((e: any) => e.origin_id)).toEqual(['query:1', 'query:2', 'query:3']);

    // 4. block-private forces TLS on the isolate lane too. The guest cannot
    // resolve a name, so the HOST owns the address half of the policy (cases 1
    // and 1b above) -- but nothing on the wire tells the host that THIS socket
    // carries database credentials, and postgres.js only upgrades a connection
    // when the pool was handed `ssl`. So the connector still resolves
    // `requiredTlsMode` in the isolate, and `sslmode=disable` is refused before
    // any socket opens. Without that the cloud lane would send credentials in
    // cleartext -- proven by mutation: dropping the `ssl` option lets a
    // block-private run with `127.0.0.1` allowlisted sync happily unencrypted.
    const disabledTls = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}sslmode=disable`;
    await expect(
      executor.execute(code, {
        mode: 'query',
        query: 'SELECT 1 AS n',
        config: {
          DATABASE_URL: disabledTls,
          LOBU_DB_EGRESS_POLICY: 'block-private',
          LOBU_DB_EGRESS_ALLOW_HOSTS: '127.0.0.1',
        },
        checkpoint: null,
        credentials: null,
        sessionState: null,
        env: {},
      })
    ).rejects.toThrow(/TLS is required/i);

    // 5. ...and self-hosted is untouched: the same URL under allow-private
    // still connects in cleartext, so the floor is a CLOUD rule, not a new
    // requirement on every install.
    const selfHosted = await executor.execute(code, {
      mode: 'query',
      query: 'SELECT 1 AS n',
      config: { DATABASE_URL: disabledTls },
      checkpoint: null,
      credentials: null,
      sessionState: null,
      env: { LOBU_DB_EGRESS_POLICY: 'allow-private' },
    });
    expect((selfHosted as any).rows[0].n).toBe(1);
  });
});
