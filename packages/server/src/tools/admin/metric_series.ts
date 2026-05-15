/**
 * Tool: metric_series
 *
 * Generic read-only SQL endpoint for dashboard sparklines + stat chips.
 * The caller passes a single SELECT statement that returns N columns of
 * time-bucketed counts (e.g. one bucket column + one column per stat). The
 * query is validated and auto-scoped to the caller's organization via the
 * same `validateAndScopeQuery` guard that powers `query_sql`, so:
 *
 *   - mutations are rejected
 *   - table references are restricted to the allowlist
 *   - `$1` is always the caller's `organization_id` (server-injected)
 *
 * Returns `{ columns: string[], rows: unknown[][] }` — a standard tabular
 * shape the frontend pivots into per-stat series for the StatsStrip chips.
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb } from '../../db/client';
import { validateAndScopeQuery } from '../../utils/execute-data-sources';
import logger from '../../utils/logger';
import type { ToolContext } from '../registry';

export const MetricSeriesSchema = Type.Object({
  sql: Type.String({
    description:
      'A single SELECT returning a bucket column plus one or more numeric stat columns. Table references are auto-scoped to the caller\'s organization; `$1` is the organization id (injected — do not pass it).',
  }),
});

type MetricSeriesArgs = Static<typeof MetricSeriesSchema>;

// Statement timeout in ms. Dashboards refresh frequently — keep tight.
const STATEMENT_TIMEOUT_MS = 5000;

export interface MetricSeriesResult {
  columns: string[];
  rows: unknown[][];
}

export async function metricSeries(
  args: MetricSeriesArgs,
  _env: unknown,
  ctx: ToolContext
): Promise<MetricSeriesResult> {
  const orgId = ctx.organizationId;
  if (!orgId) {
    throw new Error('metric_series: caller must be scoped to an organization');
  }

  const { sql: scopedSql, params } = validateAndScopeQuery(args.sql, orgId);
  const db = getDb();

  // Run inside a transaction so SET LOCAL applies for the user query only.
  let rows: Record<string, unknown>[];
  try {
    rows = (await db.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`;
      return tx.unsafe(scopedSql, params as unknown[]);
    })) as Record<string, unknown>[];
  } catch (err) {
    logger.warn({ err, orgId }, '[metric_series] query failed');
    throw err;
  }

  // postgres.js returns Array<Record<column, value>>. Flatten to a tabular
  // result so the frontend doesn't have to know column order.
  if (rows.length === 0) {
    return { columns: [], rows: [] };
  }
  const columns = Object.keys(rows[0]);
  const tabular = rows.map((r) => columns.map((c) => r[c]));
  return { columns, rows: tabular };
}
