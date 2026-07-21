/**
 * Regression: connections.test must NOT warn "No auth profile configured" for a
 * connector whose auth schema is `{ methods: [{ type: 'none' }] }` (#2051).
 *
 * An auth-free connector (RSS/Atom is the production case) legitimately has no
 * auth profile. Before the fix, handleTest fell through to a hardcoded
 * `status: 'warning', message: 'No auth profile configured'` — a misleading
 * warning on a perfectly valid active connection. The fix consults the
 * connector's stored `auth_schema`: when the `none` method is offered, an absent
 * profile is expected, so the test reports `status: 'ok'`.
 *
 * A connector that genuinely REQUIRES auth (env_keys) with no profile must still
 * warn — the fix must not blanket-suppress the warning.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { pgTextArray } from '../../../db/client';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnectorDefinition,
  seedOwnerContext,
} from '../../setup/test-fixtures';

const TEST_ENV = {} as Env;

const CONNECTORS = {
  none: 'demo.authfree.none',
  env: 'demo.authfree.env',
} as const;

async function purge(organizationId: string): Promise<void> {
  const sql = getTestDb();
  const keys = Object.values(CONNECTORS);
  await sql`DELETE FROM connections WHERE connector_key = ANY(${pgTextArray(keys)}::text[]) AND organization_id = ${organizationId}`;
  await sql`DELETE FROM connector_definitions WHERE key = ANY(${pgTextArray(keys)}::text[]) AND organization_id = ${organizationId}`;
}

async function seedConnection(
  organizationId: string,
  createdBy: string,
  connectorKey: string,
  slug: string
): Promise<number> {
  const sql = getTestDb();
  const [row] = await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status, config, created_by
    ) VALUES (
      ${organizationId}, ${connectorKey}, ${slug}, ${slug},
      'active', ${sql.json({})}, ${createdBy}
    )
    RETURNING id
  `;
  return Number(row.id);
}

describe('connections.test — auth-free connectors', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    await initWorkspaceProvider();
  });

  afterEach(async () => {
    const sql = getTestDb();
    const orgs = await sql`SELECT id FROM "organization"`;
    for (const org of orgs) await purge(org.id as string);
  });

  it('reports ok (not a warning) for a connector that supports the "none" auth method', async () => {
    const { org, user, ctx } = await seedOwnerContext({ orgName: 'Auth-Free OK Org' });
    await createTestConnectorDefinition({
      key: CONNECTORS.none,
      name: 'Auth-free connector',
      organization_id: org.id,
      auth_schema: { methods: [{ type: 'none' }] },
    });
    const connectionId = await seedConnection(org.id, user.id, CONNECTORS.none, 'rss-like');

    const res = (await manageConnections(
      { action: 'test', connection_id: connectionId },
      TEST_ENV,
      ctx
    )) as Record<string, unknown>;

    expect(res.action).toBe('test');
    expect(res.status).toBe('ok');
    expect(String(res.message)).not.toMatch(/No auth profile configured/i);
  });

  it('still warns for a connector that REQUIRES auth but has no profile', async () => {
    const { org, user, ctx } = await seedOwnerContext({ orgName: 'Auth-Required Warn Org' });
    await createTestConnectorDefinition({
      key: CONNECTORS.env,
      name: 'Env-keys connector',
      organization_id: org.id,
      auth_schema: { methods: [{ type: 'env_keys', fields: [{ key: 'API_KEY' }] }] },
    });
    const connectionId = await seedConnection(org.id, user.id, CONNECTORS.env, 'needs-key');

    const res = (await manageConnections(
      { action: 'test', connection_id: connectionId },
      TEST_ENV,
      ctx
    )) as Record<string, unknown>;

    expect(res.action).toBe('test');
    expect(res.status).toBe('warning');
    expect(String(res.message)).toMatch(/No auth profile configured/i);
  });
});
