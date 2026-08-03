import { describe, expect, it } from 'vitest';
import { getTestDb } from '../../setup/test-db';

describe('Behavior schema vocabulary', () => {
  it('contains no live schema identifiers or definitions using the retired name', async () => {
    const sql = getTestDb();
    const rows = await sql<{ kind: string; name: string }[]>`
      SELECT 'relation' AS kind, c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname ~* 'watcher'
      UNION ALL
      SELECT 'column', table_name || '.' || column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ~* 'watcher'
      UNION ALL
      SELECT 'constraint', con.conname
      FROM pg_constraint con
      JOIN pg_namespace n ON n.oid = con.connamespace
      WHERE n.nspname = 'public'
        AND (con.conname ~* 'watcher' OR pg_get_constraintdef(con.oid) ~* 'watcher')
      UNION ALL
      SELECT 'trigger', trigger_name
      FROM information_schema.triggers
      WHERE trigger_schema = 'public'
        AND (trigger_name ~* 'watcher' OR action_statement ~* 'watcher')
      UNION ALL
      SELECT 'function', p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND (
          p.proname ~* 'watcher'
          OR CASE
            WHEN p.prokind IN ('f', 'p') THEN pg_get_functiondef(p.oid) ~* 'watcher'
            ELSE false
          END
        )
      UNION ALL
      SELECT 'view', viewname
      FROM pg_views
      WHERE schemaname = 'public' AND definition ~* 'watcher'
      UNION ALL
      SELECT 'default', table_name || '.' || column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_default ~* 'watcher'
      UNION ALL
      SELECT 'index', indexname
      FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef ~* 'watcher'
      UNION ALL
      SELECT 'policy', policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND (qual ~* 'watcher' OR with_check ~* 'watcher')
      UNION ALL
      SELECT 'comment', COALESCE(c.relname || '.' || a.attname, c.relname, p.proname)
      FROM pg_description d
      LEFT JOIN pg_class c ON c.oid = d.objoid
      LEFT JOIN pg_attribute a ON a.attrelid = d.objoid AND a.attnum = d.objsubid
      LEFT JOIN pg_proc p ON p.oid = d.objoid
      LEFT JOIN pg_namespace n ON n.oid = COALESCE(c.relnamespace, p.pronamespace)
      WHERE n.nspname = 'public' AND d.description ~* 'watcher'
      ORDER BY kind, name
    `;

    expect(rows).toEqual([]);
  });
});
