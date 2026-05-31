/**
 * metric_series column safety.
 *
 * metric_series is read-tier (members may chart their org's operational data),
 * so its org-scoping CTEs MUST emit the safe column allowlist — never `SELECT *`.
 * Regression: it previously omitted `safeColumns`, so a member running
 * `SELECT * FROM connections` got the withheld `credentials` column (OAuth
 * tokens). This proves the allowlist is now applied.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { metricSeries } from '../../../tools/admin/metric_series';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestEvent,
  createTestOrganization,
} from '../../setup/test-fixtures';

describe('metric_series — safe column allowlist (member)', () => {
  let orgId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Metric Column Safety' });
    orgId = org.id;
    const conn = await createTestConnection({
      organization_id: orgId,
      connector_key: 'slack',
    });
    // Stash a secret in the withheld column so a leak would be unmistakable.
    const db = getTestDb();
    await db`UPDATE connections SET credentials = ${db.json({ access_token: 'SECRET-TOKEN' })} WHERE id = ${conn.id}`;
  });

  const memberCtx = (): ToolContext => ({
    organizationId: orgId,
    userId: 'metric-member',
    memberRole: 'member',
    isAuthenticated: true,
    tokenType: 'oauth',
    scopedToOrg: false,
    allowCrossOrg: false,
  });

  it('does not expose the credentials column via `SELECT * FROM connections`', async () => {
    const res = await metricSeries({ sql: 'SELECT * FROM connections' }, {}, memberCtx());
    expect(res.columns).not.toContain('credentials');
    // and the secret value never appears anywhere in the rows
    expect(JSON.stringify(res.rows)).not.toContain('SECRET-TOKEN');
    // sanity: an allowlisted column IS present (the scope worked, not just empty)
    expect(res.columns).toContain('connector_key');
  });

  it('refuses a data-modifying CTE (read-only transaction)', async () => {
    // A data-modifying WITH CTE passes the SELECT/WITH guard, so the read-only
    // transaction is what must stop it. Without it, this read-tier endpoint
    // could DELETE/UPDATE/INSERT.
    const db = getTestDb();
    const ev = await createTestEvent({ organization_id: orgId, content: 'keep-me' });
    await expect(
      metricSeries(
        { sql: 'WITH x AS (DELETE FROM events RETURNING id) SELECT count(*) AS n FROM x' },
        {},
        memberCtx()
      )
    ).rejects.toThrow(/read-only|read only|cannot execute/i);
    // the row is untouched
    const [row] = await db`SELECT id FROM events WHERE id = ${ev.id}`;
    expect(row?.id).toBeDefined();
  });
});
