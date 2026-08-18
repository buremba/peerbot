/**
 * Backfill: legacy private connections (`created_by IS NULL`) must be adopted
 * before the admin-only visibility arm is removed, so the ONE connection
 * visibility predicate (`visibility = 'org' OR created_by = principal`) works
 * for every private row. This replays the migration body so its data cleanup
 * cannot drift from production SQL.
 *
 * Cases pinned here, the ones easy to get wrong:
 *  - the adopter is chosen by role priority (owner > admin > member), then
 *    oldest membership — matching `resolveEntityCreator`'s fallback;
 *  - an org with NO members keeps NULL (fail-closed: no principal exists there);
 *  - rows already owned are untouched;
 *  - idempotent on a re-run (only NULL rows match);
 *  - scope: org-visible, soft-deleted, and device-pinned rows keep NULL —
 *    org-visible rows already match `visibility = 'org'`, and device rows are
 *    adopted to the real device user by device-reconcile.ts (which guards on
 *    `created_by IS NULL`), so adopting them here would steal that ownership.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import {
  executeMigrationSection,
  loadMigrationUp,
  type MigrationSection,
} from '../../../db/migration-loader';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const BACKFILL_MIGRATION = '20260818010000_backfill_legacy_connections.sql';

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

describe('backfill legacy connections migration', () => {
  let up: MigrationSection;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    up = loadMigrationUp(resolveMigrationsDir(), BACKFILL_MIGRATION);
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  async function runBackfill(): Promise<void> {
    await executeMigrationSection((statement) => getDb().unsafe(statement), up);
  }

  async function creatorOf(connectionId: number): Promise<string | null> {
    const rows = await getDb()<{ created_by: string | null }[]>`
      SELECT created_by FROM connections WHERE id = ${connectionId}
    `;
    return rows[0]?.created_by ?? null;
  }

  it('adopts an orphan into the hands of the org owner, not a mere member', async () => {
    const org = await createTestOrganization();
    const owner = await createTestUser();
    const member = await createTestUser();
    await addUserToOrganization(owner.id, org.id, 'owner');
    await addUserToOrganization(member.id, org.id, 'member');

    const orphan = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      visibility: 'private',
    });

    await runBackfill();
    expect(await creatorOf(orphan.id)).toBe(owner.id);
  });

  it('prefers an owner over an admin with an older membership', async () => {
    const org = await createTestOrganization();
    const admin = await createTestUser();
    const owner = await createTestUser();
    // Admin joins first…
    await addUserToOrganization(admin.id, org.id, 'admin');
    const today = new Date();
    await getDb()`
      UPDATE "member" SET "createdAt" = ${
        new Date(today.getTime() - 10 * 24 * 60 * 60 * 1000)
      }
      WHERE "organizationId" = ${org.id} AND "userId" = ${admin.id}
    `;
    // …owner joins later but outranks.
    await addUserToOrganization(owner.id, org.id, 'owner');

    const orphan = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      visibility: 'private',
    });

    await runBackfill();
    expect(await creatorOf(orphan.id)).toBe(owner.id);
  });

  it('picks the oldest admin when there is no owner', async () => {
    const org = await createTestOrganization();
    const adminNew = await createTestUser();
    const adminOld = await createTestUser();
    await addUserToOrganization(adminOld.id, org.id, 'admin');
    await addUserToOrganization(adminNew.id, org.id, 'admin');

    const orphan = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      visibility: 'private',
    });

    await runBackfill();
    expect(await creatorOf(orphan.id)).toBe(adminOld.id);
  });

  it('leaves a row untouched when it already has a creator', async () => {
    const org = await createTestOrganization();
    const owner = await createTestUser();
    await addUserToOrganization(owner.id, org.id, 'owner');

    const owned = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      visibility: 'private',
      created_by: owner.id,
    });

    await runBackfill();
    expect(await creatorOf(owned.id)).toBe(owner.id);
  });

  it('does not invent a creator for a memberless org (fail-closed)', async () => {
    const org = await createTestOrganization();

    const orphan = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      visibility: 'private',
    });

    await runBackfill();
    expect(await creatorOf(orphan.id)).toBeNull();
  });

  it('is idempotent on a second run', async () => {
    const org = await createTestOrganization();
    const owner = await createTestUser();
    await addUserToOrganization(owner.id, org.id, 'owner');

    const orphan = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      visibility: 'private',
    });

    await runBackfill();
    await runBackfill();
    expect(await creatorOf(orphan.id)).toBe(owner.id);
  });

  it('leaves org-visible rows NULL (they already match `visibility = org`)', async () => {
    const org = await createTestOrganization();
    const owner = await createTestUser();
    await addUserToOrganization(owner.id, org.id, 'owner');

    const managed = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      visibility: 'org',
    });

    await runBackfill();
    expect(await creatorOf(managed.id)).toBeNull();
  });

  it('leaves soft-deleted rows NULL (fail-closed on dead rows)', async () => {
    const org = await createTestOrganization();
    const owner = await createTestUser();
    await addUserToOrganization(owner.id, org.id, 'owner');

    const deleted = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      visibility: 'private',
    });
    await getDb()`
      UPDATE connections SET deleted_at = NOW() WHERE id = ${deleted.id}
    `;

    await runBackfill();
    expect(await creatorOf(deleted.id)).toBeNull();
  });

  it('leaves device-pinned rows NULL (device-reconcile owns their creator)', async () => {
    const org = await createTestOrganization();
    const owner = await createTestUser();
    await addUserToOrganization(owner.id, org.id, 'owner');

    const orphan = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      visibility: 'private',
    });
    const [worker] = await getDb()<{ id: string }[]>`
      INSERT INTO device_workers (user_id, worker_id)
      VALUES (${owner.id}, 'dw_test')
      RETURNING id
    `;
    await getDb()`
      UPDATE connections SET device_worker_id = ${worker.id} WHERE id = ${orphan.id}
    `;

    await runBackfill();
    expect(await creatorOf(orphan.id)).toBeNull();
  });
});