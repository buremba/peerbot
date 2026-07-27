/**
 * `query_sql` redacts `connections.config` / `feeds.config` in SQL, at the
 * table-schema chokepoint, because the tool is member-safe and neither table is
 * in ADMIN_ONLY_QUERYABLE_TABLES. That means the denylist exists twice: once in
 * TypeScript (`isSecretKey` in @lobu/core, used by the config serializers) and
 * once as a SQL regex + IN-list inside the generated CTE expression.
 *
 * Two implementations of one security rule drift. These tests pin them
 * together: every key name the TS side calls secret must also be matched by the
 * SQL expression, and vice versa. The value-shaped URI credential backstop is
 * also exercised against the generated expression.
 */

import { isSecretKey } from '@lobu/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { getTestDb } from '../../__tests__/setup/test-db';
import {
  DECLARED_SECRETS_REF,
  SAFE_COLUMN_DEFS,
  buildColumnList,
} from '../table-schema';

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
  'X-Api-Key',
  'Proxy-Authorization',
  'Set-Cookie',
  'client-secret',
  ' password ',
  // Unseparated acronym runs: `normalizeKey` only splits on a
  // lowercase-to-uppercase boundary, so these collapse to one unspaced token
  // the suffix pattern cannot reach. Covered by explicit exact-key entries on
  // both sides; removing those entries makes exactly these three go plaintext.
  'DBUrl',
  'DBURL',
  'DATABASEURL',
  'AWSSecretKey',
  'AWS_SECRET_KEY',
  'AWSSecretAccessKey',
  'AWS_SECRET_ACCESS_KEY',
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
  // A bare `key` is not a credential suffix: `feed_key`, `sort_key`, and
  // `idempotency_key` are ordinary identifiers. Explicit credential compounds
  // such as `secret_key`, `api_key`, and `private_key` are covered above.
  'sort_key',
  'idempotency_key',
];

describe('table-schema config redaction', () => {
  /**
   * The heuristic denylist is only ONE of the two layers the TypeScript
   * serializers apply; the other is what the connector DECLARES secret. The SQL
   * path must carry both, or a declared secret with an off-denylist name
   * (`signingMaterial`) is redacted by list()/get() and plaintext via query_sql.
   *
   * The parity cases below compare SQL to `isSecretKey` and by construction can
   * never catch that, so the declared layer is pinned structurally here.
   */
  it('incorporates connector-declared secrets for connections, not just the denylist', () => {
    const connectionsConfig = SAFE_COLUMN_DEFS.get('connections')?.find(
      (c) => c.name === 'config'
    );
    expect(connectionsConfig?.expr).toContain(DECLARED_SECRETS_REF);

    // Bound to an alias, the marker must resolve to a real correlated lookup
    // over connector_definitions — not silently vanish.
    const bound = buildColumnList(
      SAFE_COLUMN_DEFS.get('connections') ?? [],
      'cn',
      'connections'
    );
    expect(bound).not.toContain(DECLARED_SECRETS_REF);
    expect(bound).toContain('connector_definitions');
    expect(bound).toContain("'password'");
    expect(bound).toContain("af->>'secret'");
    // Correlation must be org-scoped: another tenant's connector definition
    // must not decide what this row redacts.
    expect(bound).toContain('cn.organization_id');
    expect(bound).toContain('cn.connector_key');
  });

  it('incorporates connector-declared secrets for feeds, correlated via connection_id', () => {
    // `feeds` carries no `connector_key`, so the definition is reached through
    // `connection_id` -> `connections` -> `connector_definitions`. An earlier
    // pass claimed this was not correlatable and left the feeds arm
    // heuristic-only; it IS correlatable, and this pins it.
    const bound = buildColumnList(SAFE_COLUMN_DEFS.get('feeds') ?? [], 'fd', 'feeds');
    expect(bound).not.toContain(DECLARED_SECRETS_REF);
    expect(bound).toContain('connector_definitions');
    expect(bound).toContain("'configSchema'");
    expect(bound).toContain('fd.connection_id');
    expect(bound).toContain('fd.feed_key');
    // Org-scoped on BOTH hops.
    expect(bound).toContain('fd.organization_id');
    expect(bound).toContain('cdfeed.organization_id = cfeed.organization_id');
  });

  it('falls back to the empty set for an unrecognized table', () => {
    // No correlation available -> heuristic-only, never MORE exposed.
    const bound = buildColumnList(SAFE_COLUMN_DEFS.get('feeds') ?? [], 'z', 'not_a_table');
    expect(bound).not.toContain(DECLARED_SECRETS_REF);
    expect(bound).toContain('ARRAY[]::text[]');
  });

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
      const list = buildColumnList(defs ?? [], 'x', table);
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
     * Bind the generated expression's markers for a synthetic probe row.
     *
     * `$COL$` becomes the probe's jsonb literal. `$DECLARED$` becomes the empty
     * array: these cases probe the HEURISTIC layer against a row with no
     * connector to correlate to, and an unbound `$DECLARED$` would additionally
     * be parsed by Postgres as a dollar-quote and blow up the statement. The
     * declared-secret layer is covered separately, structurally above and
     * end-to-end in connections-config-redaction.test.ts.
     */
    function bindExpr(expr: string): string {
      return expr
        .split('$COL$')
        .join('probe.config')
        .split('$DECLARED$')
        .join('ARRAY[]::text[]');
    }

    /**
     * Run the real generated expression over a one-row jsonb literal and report
     * whether the value under `key` came back redacted.
     */
    async function sqlRedacts(key: string): Promise<boolean> {
      const defs = SAFE_COLUMN_DEFS.get('connections') ?? [];
      const expr = defs.find((c) => c.name === 'config')?.expr;
      if (!expr) throw new Error('connections.config has no redaction expr');
      const bound = bindExpr(expr);
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
      const bound = bindExpr(expr ?? '');
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
      const bound = bindExpr(expr ?? '');
      const rows = await sql.unsafe(
        `SELECT (${bound}) #>> '{nested,database,host}' AS value
         FROM (SELECT $1::jsonb AS config) probe`,
        [sql.json({ nested: { database: { host: 'db.internal' } } }) as unknown as string]
      );
      expect((rows[0] as { value: string | null }).value).toBe('db.internal');
    });

    it('redacts URI credentials under a non-secret key', async () => {
      const defs = SAFE_COLUMN_DEFS.get('connections') ?? [];
      const expr = defs.find((c) => c.name === 'config')?.expr;
      const bound = bindExpr(expr ?? '');
      const rows = await sql.unsafe(
        `SELECT (${bound}) ->> 'primary' AS value
         FROM (SELECT $1::jsonb AS config) probe`,
        [
          sql.json({
            primary: 'postgres://user:pw-LEAK-uri@db.internal:5432/app',
          }) as unknown as string,
        ]
      );
      expect((rows[0] as { value: string | null }).value).not.toContain('pw-LEAK-uri');
    });
  });
});
