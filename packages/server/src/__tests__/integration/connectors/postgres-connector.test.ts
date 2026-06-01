/**
 * Postgres connector sync — keyset incremental + validation, against a real DB.
 *
 * Drives the connector directly (the same class the connector-worker runs),
 * pointed at the test DB URL, reading a throwaway table. Exercises
 * validateBaseQuery → keyset compound-cursor wrap → column-type probe →
 * checkpoint round-trip end to end.
 */

import PostgresConnector from '@lobu/connectors/postgres';
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

  it('rejects invalid base queries before connecting', async () => {
    await expect(run({ query: 'SELECT 1; DROP TABLE pgc_it' }, null)).rejects.toThrow(
      /single statement/i
    );
    await expect(run({ query: 'SELECT id, created_at FROM pgc_it LIMIT 5' }, null)).rejects.toThrow(
      /LIMIT/i
    );
    await expect(run({ query: 'UPDATE pgc_it SET email = NULL' }, null)).rejects.toThrow(/SELECT/i);
  });
});
