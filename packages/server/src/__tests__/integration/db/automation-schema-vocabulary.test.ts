import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMigrationUpSection } from '../../../db/migration-loader';
import { getTestDb } from '../../setup/test-db';

const CUTOVER_MIGRATION = '20260816000000_automation_vocabulary.sql';

function resolveMigrationsDir(): string {
  let dir = __dirname;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, 'db/migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate db/migrations from the test directory');
}

describe('Automation schema vocabulary', () => {
  it('does not mutate or copy append-only event rows during the cutover', () => {
    const up = loadMigrationUpSection(resolveMigrationsDir(), CUTOVER_MIGRATION);
    expect(up).not.toMatch(/\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:public\.)?events\b/i);
  });

  it('does not globally rewrite user-authored SQL, templates, or opaque run JSON', () => {
    const up = loadMigrationUpSection(resolveMigrationsDir(), CUTOVER_MIGRATION);
    expect(up).not.toMatch(/UPDATE\s+public\.(?:watchers|watcher_versions|view_template_versions)\b/i);
    expect(up).not.toMatch(/SET\s+\w+\s*=\s*replace\s*\(\s*replace\s*\([^;]*::text/is);
  });

  it('contains no live schema identifiers or definitions using retired product names', async () => {
    const sql = getTestDb();
    const rows = await sql<{ kind: string; name: string }[]>`
      SELECT 'relation' AS kind, c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname ~* '(watcher|behavior)'
      UNION ALL
      SELECT 'column', table_name || '.' || column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ~* '(watcher|behavior)'
      UNION ALL
      SELECT 'constraint', con.conname
      FROM pg_constraint con
      JOIN pg_namespace n ON n.oid = con.connamespace
      WHERE n.nspname = 'public'
        AND (
          con.conname ~* '(watcher|behavior)'
          OR pg_get_constraintdef(con.oid) ~* '(watcher|behavior)'
        )
      UNION ALL
      SELECT 'trigger', trigger_name
      FROM information_schema.triggers
      WHERE trigger_schema = 'public'
        AND (
          trigger_name ~* '(watcher|behavior)'
          OR action_statement ~* '(watcher|behavior)'
        )
      UNION ALL
      SELECT 'function', p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND (
          p.proname ~* '(watcher|behavior)'
          OR CASE
            WHEN p.prokind IN ('f', 'p')
              THEN pg_get_functiondef(p.oid) ~* '(watcher|behavior)'
            ELSE false
          END
        )
      UNION ALL
      SELECT 'view', viewname
      FROM pg_views
      WHERE schemaname = 'public' AND definition ~* '(watcher|behavior)'
      UNION ALL
      SELECT 'default', table_name || '.' || column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_default ~* '(watcher|behavior)'
      UNION ALL
      SELECT 'index', indexname
      FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef ~* '(watcher|behavior)'
      UNION ALL
      SELECT 'policy', policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND (
          qual ~* '(watcher|behavior)'
          OR with_check ~* '(watcher|behavior)'
        )
      UNION ALL
      SELECT 'comment', COALESCE(c.relname || '.' || a.attname, c.relname, p.proname)
      FROM pg_description d
      LEFT JOIN pg_class c ON c.oid = d.objoid
      LEFT JOIN pg_attribute a ON a.attrelid = d.objoid AND a.attnum = d.objsubid
      LEFT JOIN pg_proc p ON p.oid = d.objoid
      LEFT JOIN pg_namespace n ON n.oid = COALESCE(c.relnamespace, p.pronamespace)
      WHERE n.nspname = 'public' AND d.description ~* '(watcher|behavior)'
      ORDER BY kind, name
    `;

    expect(rows).toEqual([]);
  });
});
