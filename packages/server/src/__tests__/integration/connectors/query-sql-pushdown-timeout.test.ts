/**
 * Pushdown wall-clock budget.
 *
 * `runConnectorQuery` forks a connector subprocess to run SQL live against a
 * connection's source. `SubprocessExecutor` defaults to a 600_000ms kill
 * timeout, so a gateway read path that passes none can hold a subprocess for
 * ten minutes on one request.
 *
 * Deliberately mock-free. `vitest.config.ts` sets `isolate: false` for a true
 * singleton DB pool, and a per-file `vi.mock` is unreliable once another file
 * has already loaded the real module — so recording the budget through a mocked
 * executor would pass alone and go quiet in a shared shard. A real caller
 * deadline is observable instead: the sleep below can only be cut short if the
 * resolved budget actually reaches the executor. The cap's own value is pinned
 * by the unit suite (`__tests__/unit/pushdown-timeout-budget.test.ts`), and the
 * kill mechanism is connector-worker's contract (`runtime-timeout.test.ts`).
 *
 * `pg_sleep` stands in for a slow source: the postgres connector's own
 * `statement_timeout_ms` (30s default) is connector-owned courtesy, not a
 * platform guarantee — the next connector need not self-limit at all.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { authzScopeFromToolContext } from '../../../authz/scope';
import { runConnectorQuery } from '../../../lib/connector-pushdown';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';

describe('pushdown wall-clock budget', () => {
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Pushdown Budget' });
    orgId = org.id;
    const user = await createTestUser({ email: 'pushdown-budget@test.example.com' });
    userId = user.id;
    await addUserToOrganization(user.id, org.id, 'owner');

    const db = getTestDb();
    const profile = await createAuthProfile({
      organizationId: orgId,
      connectorKey: 'postgres',
      displayName: 'slow source',
      profileKind: 'env',
      authData: { DATABASE_URL: process.env.DATABASE_URL as string },
    });
    await db`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by, created_at, updated_at)
      VALUES
        (${orgId}, 'postgres', 'slow-source', 'Slow source', 'active', ${profile.id}, 'org', ${user.id}, NOW(), NOW())
    `;
  }, 120_000);

  function query(sql: string, deadlineAt?: number) {
    return runConnectorQuery({
      scope: authzScopeFromToolContext(ownerToolContext(orgId, userId)),
      isAdmin: true,
      connectionSlug: 'slow-source',
      query: sql,
      limit: 10,
      offset: 0,
      deadlineAt,
    });
  }

  it('kills a pushdown that outlives its budget', async () => {
    const startedAt = Date.now();
    await expect(query('SELECT pg_sleep(20)', Date.now() + 1_000)).rejects.toThrow(/timed out/);
    // The point is the budget, not just the rejection: the sleep must not have
    // been waited out. Pre-fix, this waited it out (twice — the connector also
    // runs a count query for total_count) and then returned a row.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 60_000);

  it('fails an already-expired deadline without forking at all', async () => {
    const startedAt = Date.now();
    await expect(query('SELECT 1 AS one', Date.now() - 1)).rejects.toThrow(/deadline expired/);
    // No connector resolution, no credential read, no fork.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  }, 60_000);

  it('runs a normal query under the default cap', async () => {
    const result = await query('SELECT 1 AS one');
    expect(result.rows).toHaveLength(1);
    expect(Number(result.rows[0].one)).toBe(1);
  }, 60_000);
});
