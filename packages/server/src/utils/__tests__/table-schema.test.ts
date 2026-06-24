import { describe, expect, inject, it } from 'vitest';
import {
  buildColumnList,
  QUERYABLE_SCHEMA,
  QUERYABLE_TABLE_NAMES,
  SAFE_COLUMN_DEFS,
  validateTableQuery,
} from '../table-schema';

describe('QUERYABLE_TABLE_NAMES', () => {
  it('should include all expected core tables', () => {
    const expected = [
      'entities',
      'events',
      'connections',
      'watchers',
      'event_classifications',
      'watcher_versions',
      'watcher_windows',
      'oauth_clients',
      'oauth_tokens',
      'user',
      'feeds',
      'connector_definitions',
    ];
    for (const t of expected) {
      expect(QUERYABLE_TABLE_NAMES.has(t)).toBe(true);
    }
  });

  it('should not include non-allowlisted tables', () => {
    expect(QUERYABLE_TABLE_NAMES.has('session')).toBe(false);
    expect(QUERYABLE_TABLE_NAMES.has('member')).toBe(false);
  });
});

describe('SAFE_COLUMN_DEFS', () => {
  function colList(table: string) {
    return buildColumnList(SAFE_COLUMN_DEFS.get(table)!);
  }

  it('should exclude sensitive columns from connections', () => {
    expect(colList('connections')).not.toContain('"credentials"');
  });

  it('should exclude sensitive columns from oauth_clients', () => {
    expect(colList('oauth_clients')).not.toContain('"client_secret"');
  });

  it('should exclude sensitive columns from oauth_tokens', () => {
    expect(colList('oauth_tokens')).not.toContain('"token_hash"');
  });

  it('should exclude PII from user', () => {
    const cols = colList('user');
    expect(cols).not.toContain('"email"');
    expect(cols).not.toContain('"phoneNumber"');
  });

  it('should exclude embeddings from entities', () => {
    const cols = colList('entities');
    expect(cols).not.toContain('"embedding"');
    expect(cols).not.toContain('"content_tsv"');
  });

  it('should emit direct columns for watcher_versions', () => {
    const cols = colList('watcher_versions');
    expect(cols).toContain('"prompt"');
    expect(cols).toContain('"classifiers"');
  });

  it('should prefix columns with alias', () => {
    const defs = SAFE_COLUMN_DEFS.get('watcher_versions')!;
    const cols = buildColumnList(defs, 'wv');
    expect(cols).toContain('wv."prompt"');
    expect(cols).toContain('wv."id"');
  });
});

describe('validateTableQuery', () => {
  it('should accept queries referencing allowlisted tables', () => {
    const result = validateTableQuery('SELECT id, name FROM entities');
    expect(result.valid).toBe(true);
  });

  it('should reject queries referencing unknown tables', () => {
    const result = validateTableQuery('SELECT * FROM session');
    expect(result.valid).toBe(false);
  });

  it('should reject queries referencing sensitive columns', () => {
    const result = validateTableQuery('SELECT credentials FROM connections');
    expect(result.valid).toBe(false);
  });

  it('should reject queries referencing excluded PII columns', () => {
    const result = validateTableQuery('SELECT email FROM "user"');
    expect(result.valid).toBe(false);
  });
});

/**
 * Schema drift detection — runs whenever the suite has a Postgres backend.
 * Ensures every real column in queryable tables is listed in QUERYABLE_SCHEMA
 * so the polyglot-sql validator doesn't reject valid JOINs.
 *
 * Gating note: the previous `describe.skipIf(!process.env.DATABASE_URL)` was
 * evaluated at module load. In the embedded-PG path the URL is set by
 * global-setup in the SETUP process; whether a forked vitest worker observes it
 * at module-load time is timing-dependent, so the block could silently
 * self-skip and the gate was toothless. We now gate on the URL `provide()`d by
 * global-setup and read via `inject()` at runtime — vitest's transport-level
 * channel always reaches forks — and skip from inside the test so the decision
 * is made against the authoritative value.
 */
describe('QUERYABLE_SCHEMA vs database (drift detection)', () => {
  const INTENTIONALLY_OMITTED: Record<string, Set<string>> = {
    entities: new Set(['embedding', 'content_tsv', 'content_hash']),
    events: new Set([]),
    connections: new Set(['credentials', 'unhealthy_alerted_at']),
    // Large per-connector JSONB blobs — too big and structure-dependent to expose
    // via raw SQL. Callers should hit the typed connector handler instead.
    connector_definitions: new Set([
      'mcp_config',
      'api_config',
      'openapi_config',
      'default_connection_config',
      'entity_link_overrides',
    ]),
    oauth_clients: new Set(['client_secret', 'client_secret_expires_at']),
    oauth_tokens: new Set(['token_hash']),
    feeds: new Set(['checkpoint']),
    user: new Set(['email', 'phoneNumber', 'phoneNumberVerified']),
    // Two-phase removal in progress: watcher inline json_template and
    // extraction_schema were dropped from QUERYABLE_SCHEMA (rendering is the
    // type's job; the contract is derived/reaction-owned), but the DROP COLUMN
    // is deferred to a contract release. Omit until the column is gone.
    watcher_versions: new Set(['json_template', 'extraction_schema']),
  };

  it('should have every DB column listed in the schema (or intentionally omitted)', async (ctx) => {
    const databaseUrl = inject('databaseUrl');
    if (!databaseUrl) {
      // Only reachable when SKIP_TEST_DB_SETUP=1 — no backend to diff against.
      ctx.skip();
      return;
    }
    // Defensive: pin the env the db client reads to the authoritative URL from
    // global-setup, independent of env-propagation timing into this fork.
    process.env.DATABASE_URL = databaseUrl;

    const { getDb, pgTextArray } = await import('../../db/client');
    const sql = getDb();

    const tableNames = QUERYABLE_SCHEMA.tables.map((t) => t.name);

    const dbColumns = await sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY(${pgTextArray(tableNames)}::text[])
      ORDER BY table_name, ordinal_position
    `;

    const schemaColumnsByTable = new Map<string, Set<string>>();
    for (const t of QUERYABLE_SCHEMA.tables) {
      schemaColumnsByTable.set(t.name, new Set(t.columns.map((c) => c.name)));
    }

    const missing: string[] = [];
    for (const row of dbColumns) {
      const table = row.table_name as string;
      const column = row.column_name as string;
      const schemaCols = schemaColumnsByTable.get(table);
      if (!schemaCols) continue;

      const omitted = INTENTIONALLY_OMITTED[table];
      if (omitted?.has(column)) continue;

      if (!schemaCols.has(column)) {
        missing.push(`${table}.${column}`);
      }
    }

    expect(missing, `DB columns missing from QUERYABLE_SCHEMA:\n  ${missing.join('\n  ')}`).toEqual(
      []
    );
  });
});
