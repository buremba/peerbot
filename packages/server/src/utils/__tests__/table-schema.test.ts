import { describe, expect, inject, it } from 'vitest';
import { validateAndScopeQuery } from '../execute-data-sources';
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
      'oauth_clients',
      'oauth_tokens',
      'user',
      'feeds',
      'connector_definitions',
      'entity_relationships',
      'entity_relationship_types',
    ];
    for (const t of expected) {
      expect(QUERYABLE_TABLE_NAMES.has(t)).toBe(true);
    }
  });

  it('should not expose the retired watcher_windows table (canvas-on-events)', () => {
    // Windows are canvas_state event chains now; schema exposure is removed
    // ahead of the two-phase table drop.
    expect(QUERYABLE_TABLE_NAMES.has('watcher_windows')).toBe(false);
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

describe('validateAndScopeQuery', () => {
  it('should validate and scope graph queries', () => {
    const scoped = validateAndScopeQuery(
      `SELECT e.id FROM entities e
       WHERE NOT EXISTS (
         SELECT 1 FROM entity_relationships er
         JOIN entity_relationship_types ert ON ert.id = er.relationship_type_id
         WHERE er.from_entity_id = e.id AND ert.slug = 'works_at')`,
      'org_test',
      { safeColumns: SAFE_COLUMN_DEFS }
    );

    expect(scoped.tableRefs).toEqual(
      expect.arrayContaining(['entities', 'entity_relationships', 'entity_relationship_types'])
    );
    expect(scoped.params).toEqual(['org_test']);
    expect(scoped.sql).toMatch(
      /public\.entity_relationships WHERE organization_id = \$1 AND deleted_at IS NULL/
    );
    expect(scoped.sql).toMatch(
      /public\.entity_relationship_types rt LEFT JOIN public\.organization o.*rt\.deleted_at IS NULL.*rt\.organization_id = \$1 OR o\.visibility = 'public'/
    );
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
    entities: new Set(['embedding', 'content_tsv', 'content_hash', 'field_controls']),
    // superseded_by: the query_sql events CTE reads from current_event_records,
    // which doesn't expose the column — and never usefully can: the Stage-2
    // flip makes the view `WHERE superseded_by IS NULL`, so through the view
    // the column is always NULL. Lineage queries belong on the raw table.
    events: new Set(['superseded_by']),
    connections: new Set(['credentials', 'unhealthy_alerted_at']),
    // Large per-connector JSONB blobs — too big and structure-dependent to expose
    // via raw SQL. Callers should hit the typed connector handler instead.
    connector_definitions: new Set([
      'mcp_config',
      'api_config',
      'openapi_config',
      'default_connection_config',
    ]),
    oauth_clients: new Set(['client_secret', 'client_secret_expires_at']),
    oauth_tokens: new Set(['token_hash']),
    feeds: new Set(['checkpoint']),
    user: new Set(['email', 'phoneNumber', 'phoneNumberVerified']),
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

  it('should execute graph CTEs with local and public relationship types only', async (ctx) => {
    const databaseUrl = inject('databaseUrl');
    if (!databaseUrl) {
      ctx.skip();
      return;
    }
    process.env.DATABASE_URL = databaseUrl;

    const { getDb } = await import('../../db/client');
    const sql = getDb();
    await sql`
      INSERT INTO organization (id, name, slug, visibility)
      VALUES
        ('schema-scope-local', 'Schema Scope Local', 'schema-scope-local', 'private'),
        ('schema-scope-public', 'Schema Scope Public', 'schema-scope-public', 'public'),
        ('schema-scope-private', 'Schema Scope Private', 'schema-scope-private', 'private')
    `;
    await sql`
      INSERT INTO entity_relationship_types
        (organization_id, slug, name, deleted_at)
      VALUES
        ('schema-scope-local', 'schema-scope-local', 'Local', NULL),
        ('schema-scope-public', 'schema-scope-public', 'Public', NULL),
        ('schema-scope-private', 'schema-scope-private', 'Private', NULL),
        ('schema-scope-public', 'schema-scope-deleted', 'Deleted', NOW())
    `;

    const scoped = validateAndScopeQuery(
      `SELECT ert.slug
       FROM entity_relationship_types ert
       LEFT JOIN entity_relationships er ON er.relationship_type_id = ert.id
       WHERE ert.slug LIKE 'schema-scope-%'
       ORDER BY ert.slug`,
      'schema-scope-local',
      { safeColumns: SAFE_COLUMN_DEFS }
    );
    const rows = await sql.unsafe(scoped.sql, scoped.params);

    expect(rows.map((row) => row.slug)).toEqual(['schema-scope-local', 'schema-scope-public']);
  });
});
