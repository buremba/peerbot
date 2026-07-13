import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { manageAuthProfiles } from '../../../tools/admin/manage_auth_profiles';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { seedOwnerContext } from '../../setup/test-fixtures';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
} as unknown as Env;

describe('create_auth_profile — auto-installs its connector (#1898)', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('installs a bundled connector on demand so an auth profile can be created before any connection', async () => {
    // Fresh org, `postgres` connector NOT installed. Before the fix this hit the
    // seed chicken/egg: create_auth_profile errored "Connector 'postgres' not
    // found or not active" because only manage_connections create auto-installed
    // the connector — and creating a connection needs the auth profile.
    const { org, ctx } = await seedOwnerContext({
      orgName: 'Auto-install Org',
      userName: 'Auto-install Owner',
    });
    const sql = getTestDb();

    const before = await sql`
      SELECT 1 FROM connector_definitions
      WHERE key = 'postgres' AND organization_id = ${org.id} AND status = 'active'
      LIMIT 1
    `;
    expect(before).toHaveLength(0);

    const res = await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'postgres',
        profile_kind: 'env',
        display_name: 'Postgres Credentials',
        slug: 'postgres-db',
        credentials: { DATABASE_URL: 'postgresql://user:pass@localhost:5432/db' },
      },
      TEST_ENV,
      ctx
    );

    // The profile is created (no connector-not-found error)…
    expect('error' in res ? res.error : undefined).toBeUndefined();
    expect('auth_profile' in res).toBe(true);
    if ('auth_profile' in res) {
      expect(res.auth_profile.connector_key).toBe('postgres');
    }

    // …because the connector was auto-installed from the bundled catalog.
    const after = await sql`
      SELECT 1 FROM connector_definitions
      WHERE key = 'postgres' AND organization_id = ${org.id} AND status = 'active'
      LIMIT 1
    `;
    expect(after).toHaveLength(1);
  });
});
