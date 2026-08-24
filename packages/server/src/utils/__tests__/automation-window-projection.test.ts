import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addAutomationPeriod,
  type AutomationTimeGranularity,
} from '@lobu/connector-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../db/client';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import {
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import {
  advanceExpectedAutomationWindow,
  readAutomationPendingProjection,
} from '../window-utils';

const CASES: Array<{
  granularity: AutomationTimeGranularity;
  start: string;
}> = [
  { granularity: 'daily', start: '2025-01-01T00:00:00.000Z' },
  { granularity: 'weekly', start: '2025-01-06T00:00:00.000Z' },
  { granularity: 'monthly', start: '2025-01-01T00:00:00.000Z' },
  { granularity: 'quarterly', start: '2025-01-01T00:00:00.000Z' },
];

describe('compact Automation scheduled-coverage projection', () => {
  afterEach(async () => {
    await cleanupTestDatabase();
  });

  it.each(CASES)(
    'merges, prunes, counts, and splits exact $granularity periods',
    async ({ granularity, start }) => {
      const sql = getTestDb();
      const organization = await createTestOrganization();
      const user = await createTestUser();
      const automationId = 9900 + CASES.findIndex((entry) => entry.granularity === granularity);
      const periods = [new Date(start)];
      for (let i = 1; i < 5; i++) {
        periods.push(addAutomationPeriod(periods[i - 1], granularity));
      }
      await sql`
        INSERT INTO automations (
          id, name, slug, organization_id, created_by, automation_group_id,
          next_window_start, completed_window_coverage, window_projection_granularity
        ) VALUES (
          ${automationId}, ${`Projection ${granularity}`}, ${`projection-${granularity}`},
          ${organization.id}, ${user.id}, ${automationId},
          ${periods[0].toISOString()}::timestamptz,
          '{}'::tstzmultirange, ${granularity}
        )
      `;

      await sql.begin((tx) =>
        advanceExpectedAutomationWindow(tx, automationId, periods[2], granularity, periods[4])
      );
      await sql.begin((tx) =>
        advanceExpectedAutomationWindow(tx, automationId, periods[0], granularity, periods[4])
      );

      const split = await readAutomationPendingProjection(
        sql,
        automationId,
        granularity,
        periods[4]
      );
      expect(split.nextWindowStart.toISOString()).toBe(periods[1].toISOString());
      expect(split.pendingPeriodCount).toBe(2);
      expect(split.missingRangeCount).toBe(2);
      expect(split.missingRanges.map((range) => ({
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      }))).toEqual([
        { start: periods[1].toISOString(), end: periods[2].toISOString() },
        { start: periods[3].toISOString(), end: periods[4].toISOString() },
      ]);

      await sql.begin((tx) =>
        advanceExpectedAutomationWindow(tx, automationId, periods[1], granularity, periods[4])
      );

      const [compacted] = await sql<{
        next_window_start: string | Date;
        completed_window_coverage: string;
        last_completed_window_start: string | Date | null;
      }>`
        SELECT next_window_start,
               completed_window_coverage::text AS completed_window_coverage,
               last_completed_window_start
        FROM automations WHERE id = ${automationId}
      `;
      expect(new Date(compacted.next_window_start).toISOString()).toBe(
        periods[3].toISOString()
      );
      expect(compacted.completed_window_coverage).toBe('{}');
      expect(new Date(compacted.last_completed_window_start as string | Date).toISOString()).toBe(
        periods[2].toISOString()
      );

      const pruned = await readAutomationPendingProjection(
        sql,
        automationId,
        granularity,
        periods[4]
      );
      expect(pruned.pendingPeriodCount).toBe(1);
      expect(pruned.missingRanges).toEqual([
        { start: periods[3], end: periods[4] },
      ]);
    }
  );

  it('caps returned gaps while keeping the exact component and period counts', async () => {
    const sql = getTestDb();
    const organization = await createTestOrganization();
    const user = await createTestUser();
    await sql`
      INSERT INTO automations (
        id, name, slug, organization_id, created_by, automation_group_id,
        next_window_start, completed_window_coverage, window_projection_granularity
      ) VALUES (
        9910, 'Capped projection', 'capped-projection', ${organization.id}, ${user.id}, 9910,
        '2025-01-01T00:00:00.000Z'::timestamptz,
        '{["2025-01-02 00:00:00+00","2025-01-03 00:00:00+00"),["2025-01-04 00:00:00+00","2025-01-05 00:00:00+00")}'::tstzmultirange,
        'daily'
      )
    `;

    const projection = await readAutomationPendingProjection(
      sql,
      9910,
      'daily',
      new Date('2025-01-06T00:00:00.000Z'),
      1
    );
    expect(projection.pendingPeriodCount).toBe(3);
    expect(projection.missingRangeCount).toBe(3);
    expect(projection.missingRanges).toHaveLength(1);
    expect(projection.gapsTruncated).toBe(true);
  });
});

describe('bounded Automation pending diagnostics query', () => {
  it('reads one Automation projection and never references run history or elapsed-period generation', async () => {
    const queries: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      queries.push(strings.join('?'));
      return Promise.resolve([
        {
          next_window_start: '2025-01-01T00:00:00.000Z',
          projection_granularity: 'daily',
          pending_period_count: 3,
          missing_range_count: 2,
          gap_start: '2025-01-01T00:00:00.000Z',
          gap_end: '2025-01-02T00:00:00.000Z',
        },
      ]);
    }) as unknown as DbClient;

    await readAutomationPendingProjection(
      sql,
      42,
      'daily',
      new Date('2025-01-05T00:00:00.000Z')
    );

    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/FROM automations/i);
    expect(queries[0]).not.toMatch(/\bFROM runs\b/i);
    expect(queries[0]).not.toMatch(/generate_series/i);
    expect(queries[0]).toMatch(/unnest\(missing\)/i);
    expect(queries[0]).toMatch(/LIMIT/i);

    const getAutomationSource = readFileSync(
      join(__dirname, '../../tools/get_automation.ts'),
      'utf8'
    );
    const diagnostics = getAutomationSource.slice(
      getAutomationSource.indexOf('const projection = await readAutomationPendingProjection'),
      getAutomationSource.indexOf('const unprocessedRanges =')
    );
    expect(diagnostics).toContain('readAutomationPendingProjection');
    expect(diagnostics).not.toMatch(/\bFROM runs\b/i);
    expect(diagnostics).not.toMatch(/\bwhile\s*\(/);
  });
});
