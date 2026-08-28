/** The relationship-ownership cutover against real pre-feature rows. */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import {
  executeMigrationSection,
  loadMigrationUp,
} from '../../../db/migration-loader';
import { withAclEdgeWrite } from '../../../utils/relationship-validation';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  createTestEntity,
  createTestOrganization,
} from '../../setup/test-fixtures';

const MIGRATION = '20260827174500_index_live_relationship_claims.sql';

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

describe('relationship claims cutover migration', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('stamps ordinary rows and retires unattributable authorization rows', async () => {
    const sql = getDb();
    const org = await createTestOrganization({ name: 'Relationship claim cutover' });
    const from = await createTestEntity({
      organization_id: org.id,
      entity_type: 'thing',
      name: 'From',
    });
    const to = await createTestEntity({
      organization_id: org.id,
      entity_type: 'thing',
      name: 'To',
    });
    const types = await sql<{ id: number; purpose: string | null }[]>`
      INSERT INTO entity_relationship_types
        (organization_id, slug, name, is_symmetric, purpose, created_at, updated_at)
      VALUES
        (${org.id}, 'ordinary_cutover', 'Ordinary cutover', false, NULL,
         current_timestamp, current_timestamp),
        (${org.id}, 'authorization_cutover', 'Authorization cutover', false,
         'authorization', current_timestamp, current_timestamp)
      RETURNING id, purpose
    `;
    const ordinaryTypeId = Number(types.find((row) => row.purpose === null)?.id);
    const authorizationTypeId = Number(
      types.find((row) => row.purpose === 'authorization')?.id
    );

    const [ordinary] = await sql<{ id: number }[]>`
      INSERT INTO entity_relationships
        (organization_id, from_entity_id, to_entity_id, relationship_type_id,
         source, created_at, updated_at)
      VALUES (${org.id}, ${from.id}, ${to.id}, ${ordinaryTypeId}, 'api',
              current_timestamp, current_timestamp)
      RETURNING id
    `;
    const [authorization] = await withAclEdgeWrite(sql, (tx) =>
      tx<{ id: number }[]>`
        INSERT INTO entity_relationships
          (organization_id, from_entity_id, to_entity_id, relationship_type_id,
           source, created_at, updated_at)
        VALUES (${org.id}, ${to.id}, ${from.id}, ${authorizationTypeId}, 'feed',
                current_timestamp, current_timestamp)
        RETURNING id
      `
    );

    const up = loadMigrationUp(resolveMigrationsDir(), MIGRATION);
    await executeMigrationSection((statement) => sql.unsafe(statement), up);

    const [ordinaryAfter] = await sql`
      SELECT deleted_at, metadata FROM entity_relationships WHERE id = ${ordinary.id}
    `;
    expect(ordinaryAfter.deleted_at).toBeNull();
    expect(ordinaryAfter.metadata).toEqual({ _lobu_claims: { manual: {} } });

    const [authorizationAfter] = await sql`
      SELECT deleted_at, metadata FROM entity_relationships WHERE id = ${authorization.id}
    `;
    expect(authorizationAfter.deleted_at).not.toBeNull();
    expect(authorizationAfter.metadata).toBeNull();

    const [index] = await sql<{ indisvalid: boolean }[]>`
      SELECT i.indisvalid
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'idx_entity_relationships_live_claims'
    `;
    expect(index.indisvalid).toBe(true);

    await expect(sql`
      UPDATE entity_relationships
      SET updated_at = current_timestamp
      WHERE id = ${authorization.id}
    `).rejects.toMatchObject({ code: '42501' });
  });
});
