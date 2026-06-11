/**
 * Integration test for `local-bootstrap.ts` — the shared `lobu run`
 * provisioning hooks (issue #1180).
 *
 * Pins two contracts against a real Postgres:
 *
 *   1. With LOBU_RUN_OWNS_DB=1 (the CLI-set local-install marker), running
 *      the external-DB bootstrap hooks on a fresh, migrated database
 *      provisions the install operator, its personal org, and the default
 *      agent — i.e. `/api/local-init` has a first user to mint a session
 *      for.
 *   2. WITHOUT the flag (every cloud/prod deployment), the external-DB
 *      branch gets ZERO hooks and the database stays empty — prod must
 *      never auto-provision users/orgs.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_ID } from '../../auth/default-provisioning';
import { INSTALL_OPERATOR_KIND } from '../../auth/install-operator';
import { externalDbBootstrapHooks } from '../../local-bootstrap';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';

function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set by the test harness');
  return url;
}

async function countRows(table: 'user' | 'organization'): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT count(*)::int AS count FROM ${sql(table)}
  `) as unknown as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

describe('externalDbBootstrapHooks', () => {
  // Canonical 32-byte hex key so ensureInstallOperator's assertEncryptionKey
  // passes (same convention as install-operator.test.ts).
  const VALID_KEY = 'a'.repeat(64);

  beforeEach(async () => {
    // Truncates every table — the suite starts from the exact fresh-install
    // state the bug report describes (SELECT count(*) FROM "user" → 0).
    await cleanupTestDatabase();
    process.env.ENCRYPTION_KEY = VALID_KEY;
  });

  it('with LOBU_RUN_OWNS_DB=1: provisions operator + personal org + default agent on an empty DB', async () => {
    expect(await countRows('user')).toBe(0);
    expect(await countRows('organization')).toBe(0);

    const hooks = externalDbBootstrapHooks(testDatabaseUrl(), {
      LOBU_RUN_OWNS_DB: '1',
    });
    expect(hooks.length).toBeGreaterThan(0);
    for (const hook of hooks) await hook();

    const sql = getTestDb();
    const operators = (await sql`
      SELECT id FROM "user" WHERE principal_kind = ${INSTALL_OPERATOR_KIND}
    `) as unknown as Array<{ id: string }>;
    expect(operators).toHaveLength(1);

    const orgs = (await sql`
      SELECT id FROM "organization"
      WHERE (metadata::jsonb)->>'personal_org_for_user_id' = ${operators[0]!.id}
    `) as unknown as Array<{ id: string }>;
    expect(orgs).toHaveLength(1);

    const agents = (await sql`
      SELECT id FROM agents
      WHERE organization_id = ${orgs[0]!.id} AND id = ${DEFAULT_AGENT_ID}
    `) as unknown as Array<unknown>;
    expect(agents).toHaveLength(1);
  });

  it('with LOBU_RUN_OWNS_DB=1: re-running the hooks is idempotent', async () => {
    const hooks = externalDbBootstrapHooks(testDatabaseUrl(), {
      LOBU_RUN_OWNS_DB: '1',
    });
    for (const hook of hooks) await hook();
    for (const hook of hooks) await hook();

    expect(await countRows('user')).toBe(1);
    expect(await countRows('organization')).toBe(1);
  });

  it('WITHOUT the flag: returns no hooks and the DB stays empty (prod safety)', async () => {
    for (const env of [{}, { LOBU_RUN_OWNS_DB: '0' }, { LOBU_RUN_OWNS_DB: 'true' }]) {
      const hooks = externalDbBootstrapHooks(testDatabaseUrl(), env);
      expect(hooks).toHaveLength(0);
    }

    expect(await countRows('user')).toBe(0);
    expect(await countRows('organization')).toBe(0);
  });
});
