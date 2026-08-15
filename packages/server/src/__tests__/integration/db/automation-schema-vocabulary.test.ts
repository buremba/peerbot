import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMigrationUpSection } from '../../../db/migration-loader';
import { getTestDb } from '../../setup/test-db';
import { createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const CUTOVER_MIGRATION = '20260816000010_automation_vocabulary.sql';
const TRAIT_REWRITE_START = '-- connector-trait-merge-strategy:start';
const TRAIT_REWRITE_END = '-- connector-trait-merge-strategy:end';

class Rollback extends Error {}

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

function loadTraitRewrite(): string {
  const up = loadMigrationUpSection(resolveMigrationsDir(), CUTOVER_MIGRATION);
  const start = up.indexOf(TRAIT_REWRITE_START);
  const end = up.indexOf(TRAIT_REWRITE_END);
  if (start < 0 || end < start) throw new Error('Could not locate connector trait rewrite');
  return up.slice(start + TRAIT_REWRITE_START.length, end);
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

  it('hard-renames persisted connector trait merge policies in definitions and device manifests', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization();
    const user = await createTestUser();
    const legacyTrait = {
      eventPath: 'metadata.display_name',
      behavior: 'prefer_non_empty',
    };
    const feedsSchema = {
      messages: {
        eventKinds: {
          message: {
            attributions: [{ role: 'authored_by', traits: { display_name: legacyTrait } }],
          },
        },
      },
    };

    try {
      await sql.begin(async (tx: typeof sql) => {
        await tx`
          INSERT INTO connector_definitions
            (organization_id, key, name, version, auth_schema, feeds_schema, status)
          VALUES (
            ${org.id}, 'merge-strategy-cutover', 'Merge strategy cutover', '1.0.0',
            ${tx.json({ methods: [{ type: 'none' }] })}, ${tx.json(feedsSchema)}, 'active'
          )
        `;
        await tx`
          INSERT INTO device_workers
            (user_id, worker_id, platform, app_version, capabilities, label,
             organization_id, connector_manifests)
          VALUES (
            ${user.id}, 'merge-strategy-cutover', 'macos', '1.0.0',
            ${tx.json(['test'])}, 'Merge strategy cutover', ${org.id},
            ${tx.json({
              test: {
                manifest_hash: 'legacy',
                received_at: '2026-08-15T00:00:00.000Z',
                manifest: { key: 'test', feeds_schema: feedsSchema },
              },
            })}
          )
        `;

        const rewrite = loadTraitRewrite();
        await tx.unsafe(rewrite);
        await tx.unsafe(rewrite);

        const [definition] = await tx<{ feeds_schema: Record<string, unknown> }[]>`
          SELECT feeds_schema
          FROM connector_definitions
          WHERE organization_id = ${org.id} AND key = 'merge-strategy-cutover'
        `;
        const [device] = await tx<{ connector_manifests: Record<string, unknown> }[]>`
          SELECT connector_manifests
          FROM device_workers
          WHERE user_id = ${user.id} AND worker_id = 'merge-strategy-cutover'
        `;

        const definitionText = JSON.stringify(definition.feeds_schema);
        const manifestText = JSON.stringify(device.connector_manifests);
        expect(definitionText).toContain('"mergeStrategy":"prefer_non_empty"');
        expect(manifestText).toContain('"mergeStrategy":"prefer_non_empty"');
        expect(definitionText).not.toContain('"behavior"');
        expect(manifestText).not.toContain('"behavior"');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
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
