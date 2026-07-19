import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { loadMigrationDownSection, loadMigrationUpSection } from '../../../db/migration-loader';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestAgent, seedOwnerContext } from '../../setup/test-fixtures';

const TRIGGER_MIGRATION = '20260717121000_behavior_triggers.sql';
const SUBSCRIPTION_MIGRATION = '20260717123000_behavior_channel_subscriptions.sql';

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

class Rollback extends Error {}

describe('Behavior trigger migration', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('bridges legacy schedule writes, preserves canonical writes, and rolls back cleanly', async () => {
    const { org, user } = await seedOwnerContext();
    const agent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: user.id,
      agentId: 'schedule-bridge-agent',
    });
    const migrationsDir = resolveMigrationsDir();
    const up = loadMigrationUpSection(migrationsDir, TRIGGER_MIGRATION);
    const down = loadMigrationDownSection(migrationsDir, TRIGGER_MIGRATION);
    const subscriptionDown = loadMigrationDownSection(
      migrationsDir,
      SUBSCRIPTION_MIGRATION
    );
    const sql = getDb();
    const canonicalWrite = [
      {
        kind: 'event',
        connector_key: 'github',
        event_types: ['pull_request.created'],
        execution: 'turn',
        active_run: 'queue',
        output: 'silent',
        skip_if_unchanged: true,
      },
      {
        kind: 'schedule',
        cron: '30 8 * * *',
        timezone: 'UTC',
        execution: 'window',
        active_run: 'coalesce',
        skip_if_unchanged: true,
      },
    ];
    let captured:
      | {
          inserted: unknown;
          canonical: unknown;
          updated: unknown;
          removed: unknown;
          remainingArtifacts: number;
        }
      | undefined;

    try {
      await sql.begin(async (tx: typeof sql) => {
        await tx.unsafe(up);
        const [ids] = await tx<{ watcherId: number }>`
          SELECT (COALESCE(MAX(id), 0) + 1)::int AS "watcherId" FROM watchers
        `;
        const watcherId = ids.watcherId;
        await tx`
          INSERT INTO watchers (
            id, name, slug, organization_id, entity_ids, schedule, timezone,
            next_run_at, agent_id, model_config, sources, version, tags, status,
            created_by, created_at, updated_at, watcher_group_id
          ) VALUES (
            ${watcherId}, 'Legacy schedule insert', 'legacy-schedule-insert',
            ${org.id}, '{}'::bigint[], '0 9 * * *', 'Europe/London', NOW(),
            ${agent.agentId}, '{}'::jsonb, '[]'::jsonb, 1, '{}'::text[],
            'active', ${user.id}, NOW(), NOW(), ${watcherId}
          )
        `;
        const [inserted] = await tx<{ triggers: unknown }>`
          SELECT triggers FROM watchers WHERE id = ${watcherId}
        `;

        await tx`
          UPDATE watchers
          SET schedule = '30 8 * * *', timezone = 'UTC',
              triggers = ${tx.json(canonicalWrite)}
          WHERE id = ${watcherId}
        `;
        const [canonical] = await tx<{ triggers: unknown }>`
          SELECT triggers FROM watchers WHERE id = ${watcherId}
        `;

        await tx`
          UPDATE watchers
          SET schedule = '15 7 * * 1', timezone = 'America/New_York'
          WHERE id = ${watcherId}
        `;
        const [updated] = await tx<{ triggers: unknown }>`
          SELECT triggers FROM watchers WHERE id = ${watcherId}
        `;

        await tx`
          UPDATE watchers SET schedule = NULL, timezone = NULL
          WHERE id = ${watcherId}
        `;
        const [removed] = await tx<{ triggers: unknown }>`
          SELECT triggers FROM watchers WHERE id = ${watcherId}
        `;

        // Roll migrations back in production order: the later subscription
        // projection depends on watchers.triggers and must be removed first.
        await tx.unsafe(subscriptionDown);
        await tx.unsafe(down);
        const [artifacts] = await tx<{ count: number }>`
          SELECT (
            SELECT COUNT(*)::int FROM pg_trigger
            WHERE NOT tgisinternal
              AND tgname = 'sync_legacy_watcher_schedule_trigger'
          ) + (
            SELECT COUNT(*)::int FROM pg_proc
            WHERE proname = 'sync_legacy_watcher_schedule_trigger'
          ) AS count
        `;
        captured = {
          inserted: inserted.triggers,
          canonical: canonical.triggers,
          updated: updated.triggers,
          removed: removed.triggers,
          remainingArtifacts: artifacts.count,
        };
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(captured).toEqual({
      inserted: [
        {
          kind: 'schedule',
          cron: '0 9 * * *',
          timezone: 'Europe/London',
          execution: 'window',
          active_run: 'coalesce',
          skip_if_unchanged: false,
        },
      ],
      canonical: canonicalWrite,
      updated: [
        canonicalWrite[0],
        {
          ...canonicalWrite[1],
          cron: '15 7 * * 1',
          timezone: 'America/New_York',
        },
      ],
      removed: [canonicalWrite[0]],
      remainingArtifacts: 0,
    });
  });
});
