/**
 * Backfill migration 20260721130000_connector_versions_org_backfill (#2045
 * step 3): shared rows carrying org-supplied content are copied to every
 * organization holding a connector_definitions row for the key, then the
 * shared custom copies are deleted; bundled pointer rows and orphan custom
 * rows (no definition anywhere) stay shared.
 *
 * Replays the migration's up section against seeded legacy-shaped rows — the
 * test database has already run it at setup, so this exercises the SQL
 * against data the prod run will actually see.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMigrationUpSection } from '../../../db/migration-loader';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';

const MIGRATION = '20260721130000_connector_versions_org_backfill.sql';

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

describe('connector_versions org backfill migration', () => {
  let orgC: string;
  let orgD: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    orgC = (await createTestOrganization({ name: 'Backfill Org C' })).id;
    orgD = (await createTestOrganization({ name: 'Backfill Org D' })).id;
  });

  it('copies custom shared rows to every definition-holder and retires the shared copies', async () => {
    const sql = getTestDb();
    const upSection = loadMigrationUpSection(resolveMigrationsDir(), MIGRATION);

    await sql.begin(async (tx: typeof sql) => {
      // Both orgs installed 'zz.bf.custom' (the prod shape: 16 keys shared by
      // >1 org). Org D's definition is archived — history must still follow it.
      for (const [org, status] of [
        [orgC, 'active'],
        [orgD, 'archived'],
      ] as const) {
        await tx`
          INSERT INTO connector_definitions
            (key, name, version, organization_id, status, created_at, updated_at)
          VALUES ('zz.bf.custom', 'BF Custom', '1.0.0', ${org}, ${status}, NOW(), NOW())
        `;
      }
      // Legacy shared custom rows (pre-rollout shape).
      await tx`
        INSERT INTO connector_versions (connector_key, version, organization_id, source_code, created_at)
        VALUES ('zz.bf.custom', '1.0.0', NULL, '// custom v1', NOW() - interval '2 days')
      `;
      // A pair org C ALREADY retains privately (dual-write era) with its own
      // bytes — the copy must not clobber them.
      await tx`
        INSERT INTO connector_versions (connector_key, version, organization_id, source_code, created_at)
        VALUES ('zz.bf.custom', '2.0.0', NULL, '// shared v2', NOW() - interval '1 day'),
               ('zz.bf.custom', '2.0.0', ${orgC}, '// org-c own v2', NOW() - interval '1 day')
      `;
      // Bundled pointer row: source_path only — must stay shared, untouched.
      await tx`
        INSERT INTO connector_definitions
          (key, name, version, organization_id, status, created_at, updated_at)
        VALUES ('zz.bf.bundled', 'BF Bundled', '1.0.0', ${orgC}, 'active', NOW(), NOW())
      `;
      await tx`
        INSERT INTO connector_versions (connector_key, version, organization_id, source_path, created_at)
        VALUES ('zz.bf.bundled', '1.0.0', NULL, 'zz_bf_bundled.ts', NOW())
      `;
      // Orphan custom row: no definition anywhere — the sole copy must survive.
      await tx`
        INSERT INTO connector_versions (connector_key, version, organization_id, source_code, created_at)
        VALUES ('zz.bf.orphan', '1.0.0', NULL, '// orphan', NOW())
      `;

      // Regression for #2067: a BUNDLED definition (organization_id IS NULL)
      // whose key also carries a shared custom row — the exact prod shape
      // (e.g. capterra, github: a NULL-org catalog definition alongside a
      // shared source_code row). The backfill must NOT treat the bundled
      // definition as an owner: copying to it re-emits a shared row that
      // collides with the source row on connector_versions_shared_key_version
      // (uncovered by the org-only ON CONFLICT), which aborted the migration.
      // Expected: the shared custom row stays put, no error.
      await tx`
        INSERT INTO connector_definitions
          (key, name, version, organization_id, status, created_at, updated_at)
        VALUES ('zz.bf.bundledcustom', 'BF Bundled Custom', '1.0.0', NULL, 'active', NOW(), NOW())
      `;
      await tx`
        INSERT INTO connector_versions (connector_key, version, organization_id, source_code, created_at)
        VALUES ('zz.bf.bundledcustom', '1.0.0', NULL, '// bundled custom v1', NOW())
      `;

      await tx.unsafe(upSection);

      const rows = (await tx`
        SELECT connector_key, version, organization_id, source_code, source_path
        FROM connector_versions
        WHERE connector_key LIKE 'zz.bf.%'
        ORDER BY connector_key, version, organization_id NULLS FIRST
      `) as unknown as Array<{
        connector_key: string;
        version: string;
        organization_id: string | null;
        source_code: string | null;
        source_path: string | null;
      }>;

      const byKey = (k: string, v: string) =>
        rows.filter((r) => r.connector_key === k && r.version === v);

      // v1 copied to BOTH orgs (including the disabled definition); shared copy gone.
      const v1 = byKey('zz.bf.custom', '1.0.0');
      expect(v1.map((r) => r.organization_id).sort()).toEqual([orgC, orgD].sort());
      expect(v1.every((r) => r.source_code === '// custom v1')).toBe(true);

      // v2: org C keeps its OWN bytes (no clobber); org D got the shared copy;
      // shared copy gone.
      const v2 = byKey('zz.bf.custom', '2.0.0');
      expect(v2.find((r) => r.organization_id === orgC)?.source_code).toBe('// org-c own v2');
      expect(v2.find((r) => r.organization_id === orgD)?.source_code).toBe('// shared v2');
      expect(v2.some((r) => r.organization_id === null)).toBe(false);

      // Bundled pointer stays exactly one shared row.
      const bundled = byKey('zz.bf.bundled', '1.0.0');
      expect(bundled).toHaveLength(1);
      expect(bundled[0]?.organization_id).toBeNull();
      expect(bundled[0]?.source_path).toBe('zz_bf_bundled.ts');

      // Orphan custom row survives as the sole copy.
      const orphan = byKey('zz.bf.orphan', '1.0.0');
      expect(orphan).toHaveLength(1);
      expect(orphan[0]?.organization_id).toBeNull();

      // #2067: bundled (NULL-org) definition is not an owner — no copy made,
      // shared custom row stays exactly one shared row, migration did not abort.
      const bundledCustom = byKey('zz.bf.bundledcustom', '1.0.0');
      expect(bundledCustom).toHaveLength(1);
      expect(bundledCustom[0]?.organization_id).toBeNull();
      expect(bundledCustom[0]?.source_code).toBe('// bundled custom v1');

      // Roll the seeds back — this test must not leak state into the suite.
      throw new Error('__rollback__');
    }).catch((err: unknown) => {
      if ((err as Error).message !== '__rollback__') throw err;
    });
  });
});
