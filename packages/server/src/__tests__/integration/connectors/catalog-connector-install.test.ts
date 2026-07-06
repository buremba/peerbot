import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { initWorkspaceProvider } from '../../../workspace';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { seedOwnerContext } from '../../setup/test-fixtures';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
} as unknown as Env;

describe('manage_connections install_connector — catalog connector_id', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('enables a reviewed catalog connector by id and is idempotent', async () => {
    const { org, ctx } = await seedOwnerContext({
      orgName: 'Catalog Connector Org',
      userName: 'Catalog Connector User',
    });

    const first = await manageConnections(
      { action: 'install_connector', connector_id: 'hackernews' },
      TEST_ENV,
      ctx
    );

    expect('error' in first ? first.error : undefined).toBeUndefined();
    expect('connector_key' in first ? first.connector_key : undefined).toBe('hackernews');
    expect('installed' in first ? first.installed : undefined).toBe(true);

    const second = await manageConnections(
      { action: 'install_connector', connector_id: 'hackernews' },
      TEST_ENV,
      ctx
    );

    expect('error' in second ? second.error : undefined).toBeUndefined();
    expect('connector_key' in second ? second.connector_key : undefined).toBe('hackernews');
    expect('updated' in second ? second.updated : undefined).toBe(true);

    const sql = getTestDb();
    const rows = (await sql`
      SELECT key, COUNT(*)::int AS count
      FROM connector_definitions
      WHERE organization_id = ${org.id} AND key = 'hackernews' AND status = 'active'
      GROUP BY key
    `) as unknown as Array<{ key: string; count: number }>;

    expect(rows).toEqual([{ key: 'hackernews', count: 1 }]);
  });
});
