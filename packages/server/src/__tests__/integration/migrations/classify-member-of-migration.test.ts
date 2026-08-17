/**
 * The backfill half of the ACL classification rollout.
 *
 * lobu#2825 added `purpose` and the authorization-edge trigger but deliberately
 * classified nothing, so the trigger shipped inert. This migration arms it. The
 * cases below pin the choices that are easy to get wrong when re-reading it: it
 * classifies EVERY `member_of` row regardless of author or lifecycle state,
 * leaves every other slug alone, and does not churn rows on a re-run.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import {
  executeMigrationSection,
  loadMigrationDown,
  loadMigrationUp,
  type MigrationSection,
} from '../../../db/migration-loader';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const CLASSIFY_MIGRATION = '20260817020000_classify_member_of_authorization.sql';

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

async function executeSection(section: MigrationSection): Promise<void> {
  await executeMigrationSection((statement) => getDb().unsafe(statement), section);
}

async function purposeOf(orgId: string, slug: string): Promise<string | null> {
  const sql = getDb();
  const rows = await sql<{ purpose: string | null }[]>`
    SELECT purpose FROM entity_relationship_types
    WHERE organization_id = ${orgId} AND slug = ${slug}
    LIMIT 1
  `;
  return rows.length > 0 ? rows[0].purpose : null;
}

async function rowVersionOf(orgId: string, slug: string): Promise<string> {
  const sql = getDb();
  const rows = await sql<{ row_version: string }[]>`
    SELECT xmin::text AS row_version FROM entity_relationship_types
    WHERE organization_id = ${orgId} AND slug = ${slug}
    LIMIT 1
  `;
  return rows[0].row_version;
}

async function seedType(
  orgId: string,
  slug: string,
  createdBy: string | null
): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO entity_relationship_types
      (slug, name, description, organization_id, is_symmetric, created_by, created_at, updated_at, purpose)
    VALUES (${slug}, ${slug}, 'seeded by migration test', ${orgId}, false, ${createdBy},
            current_timestamp, current_timestamp, NULL)
  `;
}

describe('classify member_of migration', () => {
  let up: MigrationSection;
  let down: MigrationSection;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    const dir = resolveMigrationsDir();
    up = loadMigrationUp(dir, CLASSIFY_MIGRATION);
    down = loadMigrationDown(dir, CLASSIFY_MIGRATION);
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('classifies a platform-created member_of', async () => {
    const org = await createTestOrganization({ name: 'Backfill platform' });
    await seedType(org.id, 'member_of', null);
    expect(await purposeOf(org.id, 'member_of')).toBeNull();

    await executeSection(up);

    expect(await purposeOf(org.id, 'member_of')).toBe('authorization');
  });

  it('classifies an ORG-AUTHORED member_of too', async () => {
    // The load-bearing case. `ensureMemberOfType` upserts on
    // (organization_id, slug), so it adopts a row a config authored — and that
    // row keeps its non-NULL `created_by`. Filtering the backfill on
    // `created_by IS NULL` would leave that live ACL type unclassified, i.e. the
    // trigger inert for precisely the org that wrote its own row.
    const org = await createTestOrganization({ name: 'Backfill org-authored' });
    const author = await createTestUser();
    await seedType(org.id, 'member_of', author.id);

    await executeSection(up);

    expect(await purposeOf(org.id, 'member_of')).toBe('authorization');
  });

  it('classifies an archived member_of', async () => {
    const org = await createTestOrganization({ name: 'Backfill archived' });
    await seedType(org.id, 'member_of', null);
    const sql = getDb();
    await sql`
      UPDATE entity_relationship_types
      SET status = 'archived', deleted_at = current_timestamp
      WHERE organization_id = ${org.id} AND slug = 'member_of'
    `;

    await executeSection(up);

    expect(await purposeOf(org.id, 'member_of')).toBe('authorization');
  });

  it('leaves ordinary domain vocabulary alone', async () => {
    const org = await createTestOrganization({ name: 'Backfill domain' });
    const author = await createTestUser();
    await seedType(org.id, 'billed_to', author.id);

    await executeSection(up);

    expect(await purposeOf(org.id, 'billed_to')).toBeNull();
  });

  it('is idempotent', async () => {
    const org = await createTestOrganization({ name: 'Backfill idempotent' });
    await seedType(org.id, 'member_of', null);

    await executeSection(up);
    const firstVersion = await rowVersionOf(org.id, 'member_of');
    await executeSection(up);

    expect(await purposeOf(org.id, 'member_of')).toBe('authorization');
    expect(await rowVersionOf(org.id, 'member_of')).toBe(firstVersion);
  });

  it('declassifies on down, disarming the trigger rather than blocking reads', async () => {
    const org = await createTestOrganization({ name: 'Backfill rollback' });
    await seedType(org.id, 'member_of', null);

    await executeSection(up);
    expect(await purposeOf(org.id, 'member_of')).toBe('authorization');

    await executeSection(down);
    expect(await purposeOf(org.id, 'member_of')).toBeNull();

    // Re-applying up after down must classify again — a down that left the row
    // in a state up could not re-stamp would strand a rolled-back deploy. No
    // cleanup depends on this: afterAll only truncates.
    await executeSection(up);
    expect(await purposeOf(org.id, 'member_of')).toBe('authorization');
  });
});
