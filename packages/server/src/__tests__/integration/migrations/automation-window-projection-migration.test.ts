import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import {
  executeMigrationSection,
  loadMigrationUp,
  type MigrationSection,
} from '../../../db/migration-loader';
import { nextAutomationWindowStart } from '../../../utils/window-utils';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const MIGRATION = '20260822170000_automation_expected_window_cursor.sql';

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

describe('Automation scheduled-coverage projection migration', () => {
  let up: MigrationSection;
  let organizationId: string;
  let userId: string;

  beforeAll(async () => {
    await initWorkspaceProvider();
    up = loadMigrationUp(resolveMigrationsDir(), MIGRATION);
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    // Seed genuine pre-migration history. Replaying the migration recreates and
    // enables the compatibility trigger before running the backfill.
    await getDb().unsafe(
      'ALTER TABLE public.runs DISABLE TRIGGER advance_automation_window_projection_from_run'
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
  });

  async function seedAutomation(id: number, schedule = '0 9 * * *'): Promise<void> {
    await getDb()`
      INSERT INTO automations (
        id, name, slug, organization_id, created_by, automation_group_id,
        schedule, next_window_start, completed_window_coverage,
        window_projection_granularity
      ) VALUES (
        ${id}, ${`Projection ${id}`}, ${`projection-${id}`}, ${organizationId},
        ${userId}, ${id}, ${schedule}, NULL, '{}'::tstzmultirange, NULL
      )
    `;
  }

  async function seedRun(options: {
    automationId: number;
    start: string;
    end: string;
    status: 'completed' | 'failed' | 'timeout';
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

  it('backfills a sequential history to the first period after it', async () => {
    await seedAutomation(9801);
    await seedRun({
      automationId: 9801,
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-02T00:00:00.000Z',
      status: 'completed',
    });
    await seedRun({
      automationId: 9801,
      start: '2026-01-02T00:00:00.000Z',
      end: '2026-01-03T00:00:00.000Z',
      status: 'completed',
    });

    await runMigration();

    const [projection] = await getDb()<{
      next_window_start: string | Date;
      completed_window_coverage: string;
      window_projection_granularity: string;
    }>`
      SELECT next_window_start, completed_window_coverage::text AS completed_window_coverage,
             window_projection_granularity
      FROM automations WHERE id = 9801
    `;
    expect(new Date(projection.next_window_start).toISOString()).toBe(
      '2026-01-03T00:00:00.000Z'
    );
    expect(projection.completed_window_coverage).toBe('{}');
    expect(projection.window_projection_granularity).toBe('daily');
  });

  it('keeps a failed hole pending while projecting a later completion', async () => {
    await seedAutomation(9802);
    await seedRun({
      automationId: 9802,
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-02T00:00:00.000Z',
      status: 'completed',
    });
    await seedRun({
      automationId: 9802,
      start: '2026-01-02T00:00:00.000Z',
      end: '2026-01-03T00:00:00.000Z',
      status: 'failed',
    });
    await seedRun({
      automationId: 9802,
      start: '2026-01-03T00:00:00.000Z',
      end: '2026-01-04T00:00:00.000Z',
      status: 'completed',
    });

    await runMigration();

    const [projection] = await getDb()<{
      next_window_start: string | Date;
      covers_later: boolean;
      covers_hole: boolean;
    }>`
      SELECT next_window_start,
             completed_window_coverage @> '2026-01-03T12:00:00.000Z'::timestamptz AS covers_later,
             completed_window_coverage @> '2026-01-02T12:00:00.000Z'::timestamptz AS covers_hole
      FROM automations WHERE id = 9802
    `;
    expect(new Date(projection.next_window_start).toISOString()).toBe(
      '2026-01-02T00:00:00.000Z'
    );
    expect(projection.covers_later).toBe(true);
    expect(projection.covers_hole).toBe(false);
  });

  it('seeds a no-run Automation at the previous current schedule period', async () => {
    await seedAutomation(9803, '0 9 1 * *');
    const before = nextAutomationWindowStart(null, new Date(), 'monthly').toISOString();
    await runMigration();
    const after = nextAutomationWindowStart(null, new Date(), 'monthly').toISOString();

    const [projection] = await getDb()<{
      next_window_start: string | Date;
      completed_window_coverage: string;
      window_projection_granularity: string;
    }>`
      SELECT next_window_start, completed_window_coverage::text AS completed_window_coverage,
             window_projection_granularity
      FROM automations WHERE id = 9803
    `;
    expect([before, after]).toContain(new Date(projection.next_window_start).toISOString());
    expect(projection.completed_window_coverage).toBe('{}');
    expect(projection.window_projection_granularity).toBe('monthly');
  });

  it('normalizes a legacy inclusive end from the scheduled period start', async () => {
    await seedAutomation(9804);
    await seedRun({
      automationId: 9804,
      start: '2026-01-05T00:00:00.000Z',
      end: '2026-01-05T23:59:59.999Z',
      status: 'completed',
    });

    await runMigration();

    const [projection] = await getDb()<{
      next_window_start: string | Date;
    }>`SELECT next_window_start FROM automations WHERE id = 9804`;
    expect(new Date(projection.next_window_start).toISOString()).toBe(
      '2026-01-06T00:00:00.000Z'
    );
  });
});
