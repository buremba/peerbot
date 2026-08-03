import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  executeMigrationSection,
  loadMigrationDown,
  loadMigrationUp,
} from '../../../db/migration-loader';
import { getTestDb } from '../../setup/test-db';
import { createTestEntity, createTestOrganization } from '../../setup/test-fixtures';

const MIGRATION = '20260803010000_behavior_engine_vocabulary.sql';

function resolveMigrationsDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'db/migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate db/migrations from the test directory');
}

describe('Behavior vocabulary migration', () => {
  it('rolls back and reapplies the schema cutover', async () => {
    const sql = getTestDb();
    const migrationsDir = resolveMigrationsDir();
    const down = loadMigrationDown(migrationsDir, MIGRATION);
    const up = loadMigrationUp(migrationsDir, MIGRATION);

    await executeMigrationSection((statement) => sql.unsafe(statement), down);
    try {
      const remaining = await sql<{ kind: string; name: string }[]>`
        SELECT 'constraint' AS kind, con.conname AS name
        FROM pg_constraint con
        JOIN pg_namespace n ON n.oid = con.connamespace
        WHERE n.nspname = 'public' AND con.conname ~* 'behavior'
        UNION ALL
        SELECT CASE c.relkind WHEN 'i' THEN 'index' ELSE 'sequence' END, c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('i', 'S')
          AND c.relname ~* 'behavior'
        ORDER BY kind, name
      `;
      expect(remaining).toEqual([
        {
          kind: 'constraint',
          name: 'connector_definitions_behavior_events_array_check',
        },
        { kind: 'index', name: 'idx_runs_executing_per_behavior' },
        { kind: 'index', name: 'idx_runs_pending_non_event_per_behavior' },
      ]);
      expect(await sql`SELECT to_regclass('public.watchers') AS name`).toEqual([
        { name: 'watchers' },
      ]);
      expect(await sql`SELECT to_regclass('public.behaviors') AS name`).toEqual([
        { name: null },
      ]);

      const definitions = await sql<
        { canvas_view: string; canvas_index: string; policy_check: string; stamp: string }[]
      >`
        SELECT
          pg_get_viewdef('public.canvas_windows'::regclass, true) AS canvas_view,
          pg_get_indexdef('public.idx_canvas_chain_root'::regclass) AS canvas_index,
          pg_get_constraintdef(
            (
              SELECT oid
              FROM pg_constraint
              WHERE conname = 'runs_policy_principal_kind_check'
            )
          ) AS policy_check,
          pg_get_functiondef(
            'public.stamp_watcher_last_run_completed_at()'::regprocedure
          ) AS stamp
      `;
      expect(definitions[0]?.canvas_view).toContain("metadata ->> 'watcher_id'");
      expect(definitions[0]?.canvas_index).toContain("metadata ->> 'watcher_id'");
      expect(definitions[0]?.policy_check).toContain("'watcher'::text");
      expect(definitions[0]?.stamp).toContain('UPDATE public.watchers');
      expect(definitions[0]?.stamp).toContain('NEW.watcher_id');
    } finally {
      await executeMigrationSection((statement) => sql.unsafe(statement), up);
    }

    expect(await sql`SELECT to_regclass('public.behaviors') AS name`).toEqual([
      { name: 'behaviors' },
    ]);
    expect(await sql`SELECT to_regclass('public.watchers') AS name`).toEqual([
      { name: null },
    ]);
  });

  it('carries the durable values across the cutover, not just the identifiers', async () => {
    const sql = getTestDb();
    const migrationsDir = resolveMigrationsDir();
    const down = loadMigrationDown(migrationsDir, MIGRATION);
    const up = loadMigrationUp(migrationsDir, MIGRATION);

    // Renaming a column does not rewrite the strings stored in it. Every value
    // below is matched by literal equality on a live read path, so a cutover
    // that moves only the identifiers orphans each of these rows.
    const org = await createTestOrganization({ name: 'Vocabulary values' });
    const entity = await createTestEntity({
      name: 'Vocabulary values co',
      organization_id: org.id,
    });
    await sql`
      INSERT INTO entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector
      )
      VALUES (${org.id}, ${entity.id}, 'behavior_key', ${`4242::vocab-${Date.now()}`}, 'behavior')
    `;
    await sql`
      UPDATE "organization"
      SET metadata = ${JSON.stringify({ default_behavior_provisioned: '2026-08-03T00:00:00Z' })}
      WHERE id = ${org.id}
    `;
    await sql`
      INSERT INTO write_approval_policies (
        organization_id, resource_class, principal_kind, principal_id
      )
      VALUES (${org.id}, 'entity', 'behavior', 'behavior:4242')
    `;

    const readBack = async () => {
      const [identity] = await sql<{ namespace: string; source_connector: string }[]>`
        SELECT namespace, source_connector FROM entity_identities WHERE entity_id = ${entity.id}
      `;
      const [organization] = await sql<{ metadata: string }[]>`
        SELECT metadata FROM "organization" WHERE id = ${org.id}
      `;
      const [policy] = await sql<{ principal_kind: string; principal_id: string }[]>`
        SELECT principal_kind, principal_id
        FROM write_approval_policies
        WHERE organization_id = ${org.id}
      `;
      return {
        identity,
        policy,
        sentinels: Object.keys(JSON.parse(organization?.metadata ?? '{}')),
      };
    };

    await executeMigrationSection((statement) => sql.unsafe(statement), down);
    let canvasEventId: string | undefined;
    try {
      const rolledBack = await readBack();
      expect(rolledBack.identity).toEqual({
        namespace: 'watcher_key',
        source_connector: 'watcher',
      });
      expect(rolledBack.policy).toEqual({
        principal_kind: 'watcher',
        principal_id: 'watcher:4242',
      });
      expect(rolledBack.sentinels).toEqual(['default_watcher_provisioned']);
      await sql`
        INSERT INTO runs (organization_id, run_type, status, run_at, error_message)
        VALUES (
          ${org.id}, 'internal', 'failed', current_timestamp,
          'Use client.watchers.completeWindow to finish'
        )
      `;
      const [canvasEvent] = await sql<{ id: string }[]>`
        INSERT INTO events (
          organization_id, origin_id, semantic_type, payload_type, metadata
        )
        VALUES (
          ${org.id}, ${`vocab-canvas-${Date.now()}`}, 'canvas_state', 'empty',
          ${sql.json({
            watcher_id: 4242,
            source: 'watcher_canvas',
            granularity: 'day',
            window_start: '2026-08-03T00:00:00Z',
            window_end: '2026-08-04T00:00:00Z',
          })}
        )
        RETURNING id
      `;
      canvasEventId = canvasEvent?.id;
      await sql`
        UPDATE entities
        SET metadata = ${sql.json({
          source: 'watcher_promotion',
          watcher_id: 4242,
        })}
        WHERE id = ${entity.id}
      `;
    } finally {
      await executeMigrationSection((statement) => sql.unsafe(statement), up);
    }

    const reapplied = await readBack();
    expect(reapplied.identity).toEqual({
      namespace: 'behavior_key',
      source_connector: 'behavior',
    });
    expect(reapplied.policy).toEqual({
      principal_kind: 'behavior',
      principal_id: 'behavior:4242',
    });
    expect(reapplied.sentinels).toEqual(['default_behavior_provisioned']);
    expect(
      await sql<{ error_message: string }[]>`
        SELECT error_message
        FROM runs
        WHERE organization_id = ${org.id} AND error_message LIKE '%completeWindow%'
      `,
    ).toEqual([{ error_message: 'Use client.behaviors.completeWindow to finish' }]);
    expect(
      await sql<{ behavior_id: string }[]>`
        SELECT behavior_id::text
        FROM canvas_windows
        WHERE id = ${canvasEventId}
      `,
    ).toEqual([{ behavior_id: '4242' }]);
    expect(
      await sql<{ id: string }[]>`
        SELECT id::text
        FROM entities
        WHERE metadata->>'source' = 'behavior_promotion'
          AND (metadata->>'behavior_id')::bigint = 4242
          AND id = ${entity.id}
      `,
    ).toEqual([{ id: String(entity.id) }]);
  });
});
