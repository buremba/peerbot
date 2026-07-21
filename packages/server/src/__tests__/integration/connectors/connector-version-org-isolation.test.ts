/**
 * Org-preferring connector_versions resolution + the #2045 cross-org fence
 * (PR 2 of the isolation rollout).
 *
 * The regression this locks in: two orgs installing DIFFERENT code under the
 * same custom (connector_key, version) used to last-writer-win on one global
 * row — org A would silently EXECUTE org B's code. With org-preferring
 * resolution each org's own row shadows the shared row for that org only.
 *
 * Transitional note (dual-write phase): custom installs still ALSO write the
 * legacy shared row, so a shared-row copy of custom code remains visible as a
 * fallback until step 3 (backfill + stop legacy writes) retires it — identical
 * exposure to the pre-rollout behavior, no worse. The tests below assert the
 * guarantees PR 2 owns; where the end state differs from the transitional
 * state they simulate step 3 with direct SQL.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { initWorkspaceProvider } from '../../../workspace';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { seedOwnerContext } from '../../setup/test-fixtures';
import type { ToolContext } from '../../../tools/registry';
import {
  ensureConnectorInstalled,
  resolveConnectorCodeForKey,
} from '../../../utils/ensure-connector-installed';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
} as unknown as Env;

function sourceFor(key: string, version: string, marker: string): string {
  return `
export default class IsolationProbeConnector {
  definition = {
    key: '${key}',
    name: 'Isolation Probe',
    description: '${marker}',
    version: '${version}',
  };
  async sync() { return { events: [], checkpoint: null }; }
  async execute() { return { marker: '${marker}' }; }
}
`;
}

describe('connector_versions org isolation (#2045 read cutover)', () => {
  let ctxA: ToolContext;
  let ctxB: ToolContext;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    const a = await seedOwnerContext({ orgName: 'Isolation Org A', userName: 'Iso User A' });
    const b = await seedOwnerContext({ orgName: 'Isolation Org B', userName: 'Iso User B' });
    ctxA = a.ctx;
    ctxB = b.ctx;
    orgA = a.org.id;
    orgB = b.org.id;
  });

  it('resolves each org its OWN code when two orgs collide on (key, version)', async () => {
    const KEY = 'zz.isocollide';
    for (const [ctx, marker] of [
      [ctxA, 'CODE-A'],
      [ctxB, 'CODE-B'],
    ] as const) {
      const res = await manageConnections(
        { action: 'install_connector', source_code: sourceFor(KEY, '1.0.0', marker) },
        TEST_ENV,
        ctx
      );
      expect('error' in res ? res.error : undefined).toBeUndefined();
    }

    // Pre-cutover this returned CODE-B for BOTH orgs (B's install clobbered
    // the single global row). Each org now executes its own bytes.
    const codeA = await resolveConnectorCodeForKey(KEY, orgA, '1.0.0');
    const codeB = await resolveConnectorCodeForKey(KEY, orgB, '1.0.0');
    expect(codeA).toContain('CODE-A');
    expect(codeA).not.toContain('CODE-B');
    expect(codeB).toContain('CODE-B');
    expect(codeB).not.toContain('CODE-A');

    // Read isolation through the tool surface: each org reads back its own
    // source from get_connector_source.
    const gotA = await manageConnections(
      { action: 'get_connector_source', connector_key: KEY },
      TEST_ENV,
      ctxA
    );
    const gotB = await manageConnections(
      { action: 'get_connector_source', connector_key: KEY },
      TEST_ENV,
      ctxB
    );
    expect('source_code' in gotA ? gotA.source_code : '').toContain('CODE-A');
    expect('source_code' in gotA ? gotA.source_code : '').not.toContain('CODE-B');
    expect('source_code' in gotB ? gotB.source_code : '').toContain('CODE-B');
  });

  it("cannot read or roll back to a version that exists only as another org's private row", async () => {
    const KEY = 'zz.isofence';
    const install = await manageConnections(
      { action: 'install_connector', source_code: sourceFor(KEY, '1.0.0', 'FENCE-BASE') },
      TEST_ENV,
      ctxB
    );
    expect('error' in install ? install.error : undefined).toBeUndefined();

    // Simulate the post-rollout end state: org A retains a PRIVATE 3.0.0 row
    // (no shared copy — as after step 3 stops legacy writes).
    const sql = getTestDb();
    await sql`
      INSERT INTO connector_versions (
        connector_key, version, organization_id, compiled_code, compiled_code_hash,
        compile_config_hash, source_code, source_path
      ) VALUES (${KEY}, '3.0.0', ${orgA}, '// private A', 'hash-a3', NULL, '// private A', NULL)
    `;

    // Org B must not see 3.0.0 in history…
    const gotB = await manageConnections(
      { action: 'get_connector_source', connector_key: KEY },
      TEST_ENV,
      ctxB
    );
    expect('error' in gotB ? gotB.error : undefined).toBeUndefined();
    const versions = 'versions' in gotB ? gotB.versions : [];
    const versionStrings = versions.map((v: { version: string }) => v.version);
    expect(versionStrings).toContain('1.0.0');
    expect(versionStrings).not.toContain('3.0.0');

    // …nor activate it.
    const rolled = await manageConnections(
      { action: 'rollback_connector_version', connector_key: KEY, version: '3.0.0' },
      TEST_ENV,
      ctxB
    );
    expect('error' in rolled ? rolled.error : '').toContain("No retained version '3.0.0'");
  });

  it('branching a bundled connector shadows it for the branching org only', async () => {
    // Org B runs the stock bundled connector.
    const installed = await ensureConnectorInstalled({
      organizationId: orgB,
      connectorKey: 'hackernews',
    });
    expect(installed).toBe(true);

    // Org A branches it: same key, custom code under its own version.
    const branch = await manageConnections(
      {
        action: 'install_connector',
        source_code: sourceFor('hackernews', '99.0.0-acme', 'ACME-BRANCH'),
      },
      TEST_ENV,
      ctxA
    );
    expect('error' in branch ? branch.error : undefined).toBeUndefined();

    // Simulate step 3 (no legacy shared copy of the branch).
    const sql = getTestDb();
    await sql`
      DELETE FROM connector_versions
      WHERE connector_key = 'hackernews' AND version = '99.0.0-acme' AND organization_id IS NULL
    `;

    // Org A resolves its branch (org row shadows the bundled row)…
    const codeA = await resolveConnectorCodeForKey('hackernews', orgA);
    expect(codeA).toContain('ACME-BRANCH');

    // …while org B still resolves the stock bundled connector.
    const codeB = await resolveConnectorCodeForKey('hackernews', orgB);
    expect(codeB).not.toContain('ACME-BRANCH');
    expect(codeB.length).toBeGreaterThan(0);
  });
});
