import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import {
  executeMigrationSection,
  loadMigrationUp,
  type MigrationSection,
} from '../../../db/migration-loader';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const MIGRATION = '20260822230000_automation_last_completed_window.sql';

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

describe('Automation latest-completed-window projection migration', () => {
  let up: MigrationSection;
  let organizationId: string;
  let userId: string;

  beforeAll(async () => {
    await initWorkspaceProvider();
    up = loadMigrationUp(resolveMigrationsDir(), MIGRATION);
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    await getDb().unsafe(
      'ALTER TABLE public.runs DISABLE TRIGGER advance_automation_window_projection_from_run'
    );
    await getDb().unsafe(
      'ALTER TABLE public.runs DISABLE TRIGGER record_automation_last_completed_window_from_run'
    );
    const organization = await createTestOrganization();
    const user = await createTestUser();
    await addUserToOrganization(user.id, organization.id, 'owner');
    organizationId = organization.id;
    userId = user.id;
  });

  afterEach(async () => {
    await getDb().unsafe(
      'ALTER TABLE public.runs ENABLE TRIGGER advance_automation_window_projection_from_run'
    );
    await getDb().unsafe(
      'ALTER TABLE public.runs ENABLE TRIGGER record_automation_last_completed_window_from_run'
    );
  });

  async function seedAutomation(id: number): Promise<void> {
    await getDb()`
      INSERT INTO automations (
        id, name, slug, organization_id, created_by, automation_group_id,
        schedule, next_window_start, completed_window_coverage,
        window_projection_granularity, last_completed_window_start
      ) VALUES (
        ${id}, ${`Latest ${id}`}, ${`latest-${id}`}, ${organizationId},
        ${userId}, ${id}, '0 9 * * *',
        '2026-01-01T00:00:00.000Z'::timestamptz,
        '{}'::tstzmultirange, 'daily', NULL
      )
    `;
  }

  async function seedRun(options: {
    automationId: number;
    start: string;
    end: string;
    status: 'completed' | 'failed';
  }): Promise<void> {
    const sql = getDb();
    await sql`
      INSERT INTO runs (
        organization_id, run_type, automation_id, status, outcome,
        approved_input, action_output, created_at, completed_at
      ) VALUES (
        ${organizationId}, 'automation', ${options.automationId}, ${options.status},
        ${options.status === 'completed' ? 'scoreable' : 'agent_error'},
        ${sql.json({
          dispatch_source: 'scheduled',
          granularity: 'daily',
          window_start: options.start,
          window_end: options.end,
        })},
        ${options.status === 'completed' ? sql.json({}) : null},
        ${options.start}::timestamptz, ${options.end}::timestamptz
      )
    `;
  }

  async function runMigration(): Promise<void> {
    await executeMigrationSection((statement) => getDb().unsafe(statement), up);
  }

  async function readLastCompleted(id: number): Promise<string | null> {
    const [row] = await getDb()<{
      last_completed_window_start: string | Date | null;
    }>`
      SELECT last_completed_window_start FROM automations WHERE id = ${id}
    `;
    return row.last_completed_window_start
      ? new Date(row.last_completed_window_start).toISOString()
      : null;
  }

  it('backfills the latest period from sequential completed history', async () => {
    await seedAutomation(9851);
    await seedRun({
      automationId: 9851,
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-02T00:00:00.000Z',
      status: 'completed',
    });
    await seedRun({
      automationId: 9851,
      start: '2026-01-02T00:00:00.000Z',
      end: '2026-01-03T00:00:00.000Z',
      status: 'completed',
    });

    await runMigration();

    expect(await readLastCompleted(9851)).toBe('2026-01-02T00:00:00.000Z');
  });

  it('ignores a failed hole and keeps a later completed period', async () => {
    await seedAutomation(9852);
    await seedRun({
      automationId: 9852,
      start: '2026-01-02T00:00:00.000Z',
      end: '2026-01-03T00:00:00.000Z',
      status: 'failed',
    });
    await seedRun({
      automationId: 9852,
      start: '2026-01-03T00:00:00.000Z',
      end: '2026-01-04T00:00:00.000Z',
      status: 'completed',
    });

    await runMigration();

    expect(await readLastCompleted(9852)).toBe('2026-01-03T00:00:00.000Z');
  });

  it('leaves a no-run Automation without a synthetic completion', async () => {
    await seedAutomation(9853);

    await runMigration();

    expect(await readLastCompleted(9853)).toBeNull();
  });

  it('normalizes a legacy inclusive end from the scheduled period start', async () => {
    await seedAutomation(9854);
    await seedRun({
      automationId: 9854,
      start: '2026-01-05T00:00:00.000Z',
      end: '2026-01-05T23:59:59.999Z',
      status: 'completed',
    });

    await runMigration();

    expect(await readLastCompleted(9854)).toBe('2026-01-05T00:00:00.000Z');
  });
});
