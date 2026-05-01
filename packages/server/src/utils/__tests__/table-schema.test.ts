import { describe, expect, it } from 'vitest';
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
    expect(cols).toContain('"extraction_schema"');
    expect(cols).toContain('"classifiers"');
  });

  it('should prefix columns with alias', () => {
    const defs = SAFE_COLUMN_DEFS.get('watcher_versions')!;
    const cols = buildColumnList(defs, 'wv');
    expect(cols).toContain('wv."prompt"');
    expect(cols).toContain('wv."extraction_schema"');
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
 * Schema drift detection — runs when DATABASE_URL is available.
 * Ensures every real column in queryable tables is listed in QUERYABLE_SCHEMA
 * so the polyglot-sql validator doesn't reject valid JOINs.
 */
const hasDb = !!process.env.DATABASE_URL;
describe.skipIf(!hasDb)('QUERYABLE_SCHEMA vs database (drift detection)', () => {
  const INTENTIONALLY_OMITTED: Record<string, Set<string>> = {
    entities: new Set(['embedding', 'content_tsv', 'content_hash']),
    events: new Set([]),
    connections: new Set(['credentials']),
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
  };

  it('should have every DB column listed in the schema (or intentionally omitted)', async () => {
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
