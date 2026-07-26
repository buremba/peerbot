/**
 * `query_sql` redacts `connections.config` / `feeds.config` in SQL, at the
 * table-schema chokepoint, because the tool is member-safe and neither table is
 * in ADMIN_ONLY_QUERYABLE_TABLES. That means the denylist exists twice: once in
 * TypeScript (`isSecretKey` in @lobu/core, used by every serializer) and once
 * as a SQL regex + IN-list inside the generated CTE expression.
 *
 * Two implementations of one security rule drift. These tests pin them
 * together: every key name the TS side calls secret must also be matched by the
 * SQL expression, and vice versa. If you add a term to one, this fails until
 * you add it to the other.
 */

import { isSecretKey } from '@lobu/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { getTestDb } from '../../__tests__/setup/test-db';
import { SAFE_COLUMN_DEFS, buildColumnList } from '../table-schema';

/** Key names probed against both implementations. */
const SECRET_KEYS = [
  'password',
  'passwd',
  'token',
  'access_token',
  'refresh_token',
  'accessToken',
  'api_key',
  'apiKey',
  'secret',
  'client_secret',
  'clientSecret',
  'private_key',
  'credential',
  'credentials',
  'session_id',
  'sessionId',
  'authorization',
  'cookie',
  'bearer',
  'DATABASE_URL',
  'database_url',
  'databaseUrl',
  'db_url',
  'connection_string',
  'dsn',
];

const NON_SECRET_KEYS = [
  'host',
  'port',
  'channel',
  'base_url',
  'webhook_url',
  'tokenizer',
  'keyboard',
  'secretsPolicy',
  'display_name',
  'feed_key',
];

describe('table-schema config redaction', () => {
  it('emits a redacting expression for connections.config and feeds.config', () => {
    for (const table of ['connections', 'feeds']) {
      const defs = SAFE_COLUMN_DEFS.get(table);
      expect(defs, `${table} must be queryable`).toBeDefined();
      const config = defs?.find((c) => c.name === 'config');
      expect(config, `${table}.config must stay queryable`).toBeDefined();
      expect(
        config?.expr,
        `${table}.config must carry a redacting expr, not be selected raw`
      ).toBeTruthy();
      // The generated list must never contain a bare reference to the column.
      const list = buildColumnList(defs ?? [], 'x');
      expect(list).toContain('as "config"');
      expect(list).not.toMatch(/x\."config" as "config"/);
    }
  });

  describe('SQL denylist matches the TypeScript denylist', () => {
    let sql: ReturnType<typeof getTestDb>;

    beforeAll(() => {
      sql = getTestDb();
    });

    /**
     * Run the real generated expression over a one-row jsonb literal and report
     * whether the value under `key` came back redacted.
     */
    async function sqlRedacts(key: string): Promise<boolean> {
      const defs = SAFE_COLUMN_DEFS.get('connections') ?? [];
      const expr = defs.find((c) => c.name === 'config')?.expr;
      if (!expr) throw new Error('connections.config has no redaction expr');
      // The expr references the source column via the $COL$ marker, which
      // buildColumnList substitutes; here we bind it to the probe literal.
      const bound = expr.split('$COL$').join('probe.config');
      // The key is inlined as a quoted literal rather than bound: postgres.js
      // cannot infer a type for the right-hand side of `->>`, so a $N parameter
      // there comes back NULL and every probe would read as "redacted". Keys
      // come from the fixed arrays above, and quotes are escaped.
      const keyLiteral = `'${key.replace(/'/g, "''")}'`;
      const rows = await sql.unsafe(
        `SELECT (${bound}) ->> ${keyLiteral} AS value
         FROM (SELECT $1::jsonb AS config) probe`,
        [sql.json({ [key]: 'probe-value' }) as unknown as string]
      );
      return (rows[0] as { value: string | null }).value !== 'probe-value';
    }

    it.each(SECRET_KEYS)('SQL redacts %s (TS agrees)', async (key) => {
      expect(isSecretKey(key), `TS denylist must classify ${key} as secret`).toBe(true);
      expect(await sqlRedacts(key), `SQL denylist must redact ${key}`).toBe(true);
    });

    it.each(NON_SECRET_KEYS)('SQL preserves %s (TS agrees)', async (key) => {
      expect(isSecretKey(key), `TS denylist must NOT classify ${key} as secret`).toBe(false);
      expect(await sqlRedacts(key), `SQL denylist must preserve ${key}`).toBe(false);
    });

    it('redacts a nested secret, not just the top level', async () => {
      const defs = SAFE_COLUMN_DEFS.get('connections') ?? [];
      const expr = defs.find((c) => c.name === 'config')?.expr;
      const bound = (expr ?? '').split('$COL$').join('probe.config');
      const rows = await sql.unsafe(
        `SELECT (${bound}) #>> '{nested,database,password}' AS value
         FROM (SELECT $1::jsonb AS config) probe`,
        [sql.json({ nested: { database: { password: 'probe-value' } } }) as unknown as string]
      );
      expect((rows[0] as { value: string | null }).value).not.toBe('probe-value');
    });

    it('preserves a nested non-secret value', async () => {
      const defs = SAFE_COLUMN_DEFS.get('connections') ?? [];
      const expr = defs.find((c) => c.name === 'config')?.expr;
      const bound = (expr ?? '').split('$COL$').join('probe.config');
      const rows = await sql.unsafe(
        `SELECT (${bound}) #>> '{nested,database,host}' AS value
         FROM (SELECT $1::jsonb AS config) probe`,
        [sql.json({ nested: { database: { host: 'db.internal' } } }) as unknown as string]
      );
      expect((rows[0] as { value: string | null }).value).toBe('db.internal');
    });
  });
});
