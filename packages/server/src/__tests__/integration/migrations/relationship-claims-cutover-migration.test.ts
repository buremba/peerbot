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
  createTestConnection,
  createTestEntity,
  createTestOrganization,
} from '../../setup/test-fixtures';

const MIGRATION = '20260827174500_index_live_relationship_claims.sql';
const TOMBSTONED_ABOUT_BACKFILL =
  '20260829090000_backfill_tombstoned_about_claims.sql';

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

  it('preserves attributable ownership and retires unsafe legacy rows', async () => {
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
    const types = await sql<{ id: number; slug: string; purpose: string | null }[]>`
      INSERT INTO entity_relationship_types
        (organization_id, slug, name, is_symmetric, purpose, created_at, updated_at)
      VALUES
        (${org.id}, 'ordinary_cutover', 'Ordinary cutover', false, NULL,
         current_timestamp, current_timestamp),
        (${org.id}, 'about', 'About', false, NULL,
         current_timestamp, current_timestamp),
        (${org.id}, 'member_of', 'Member of', false, NULL,
         current_timestamp, current_timestamp),
        (${org.id}, 'authorization_cutover', 'Authorization cutover', false,
         'authorization', current_timestamp, current_timestamp)
      RETURNING id, slug, purpose
    `;
    const ordinaryTypeId = Number(types.find((row) => row.slug === 'ordinary_cutover')?.id);
    const aboutTypeId = Number(types.find((row) => row.slug === 'about')?.id);
    const memberOfTypeId = Number(types.find((row) => row.slug === 'member_of')?.id);
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
    // `applyUnmerge` can restore this row, so it must carry a claim too.
    const [tombstonedOrdinary] = await sql<{ id: number }[]>`
      INSERT INTO entity_relationships
        (organization_id, from_entity_id, to_entity_id, relationship_type_id,
         source, deleted_at, created_at, updated_at)
      VALUES (${org.id}, ${to.id}, ${from.id}, ${ordinaryTypeId}, 'api',
              current_timestamp, current_timestamp, current_timestamp)
      RETURNING id
    `;
    const authorizationRows = await withAclEdgeWrite(sql, (tx) =>
      tx<{ id: number; relationship_type_id: number }[]>`
        INSERT INTO entity_relationships
          (organization_id, from_entity_id, to_entity_id, relationship_type_id,
           source, created_at, updated_at)
        VALUES
          (${org.id}, ${to.id}, ${from.id}, ${authorizationTypeId}, 'feed',
           current_timestamp, current_timestamp),
          (${org.id}, ${from.id}, ${to.id}, ${memberOfTypeId}, 'feed',
           current_timestamp, current_timestamp)
        RETURNING id, relationship_type_id
      `
    );
    const authorization = authorizationRows.find(
      (row) => Number(row.relationship_type_id) === authorizationTypeId
    )!;
    const unclassifiedMemberOf = authorizationRows.find(
      (row) => Number(row.relationship_type_id) === memberOfTypeId
    )!;
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'slack',
      createDefaultFeed: false,
    });
    const [ownedAbout, orphanedAbout] = await sql<{ id: number }[]>`
      INSERT INTO entity_relationships
        (organization_id, from_entity_id, to_entity_id, relationship_type_id,
         metadata, source, created_at, updated_at)
      VALUES
        (${org.id}, ${from.id}, ${to.id}, ${aboutTypeId},
         ${sql.json({ connection_id: String(connection.id), channel_key: 'T01:C01', visible: true })},
         'manual', current_timestamp, current_timestamp),
        (${org.id}, ${to.id}, ${from.id}, ${aboutTypeId},
         ${sql.json({ connection_id: '999999999', channel_key: 'T01:C02' })},
         'manual', current_timestamp, current_timestamp)
      RETURNING id
    `;
    const [tombstonedOrphanAbout] = await sql<{ id: number }[]>`
      INSERT INTO entity_relationships
        (organization_id, from_entity_id, to_entity_id, relationship_type_id,
         metadata, source, deleted_at, created_at, updated_at)
      VALUES (
        ${org.id}, ${from.id}, ${to.id}, ${aboutTypeId},
        ${sql.json({ connection_id: '999999998', channel_key: 'T01:C03' })},
        'manual', current_timestamp, current_timestamp, current_timestamp
      )
      RETURNING id
    `;

    const up = loadMigrationUp(resolveMigrationsDir(), MIGRATION);
    await executeMigrationSection((statement) => sql.unsafe(statement), up);
    await executeMigrationSection((statement) => sql.unsafe(statement), up);
    const tombstonedAboutBackfill = loadMigrationUp(
      resolveMigrationsDir(),
      TOMBSTONED_ABOUT_BACKFILL
    );
    await executeMigrationSection(
      (statement) => sql.unsafe(statement),
      tombstonedAboutBackfill
    );
    await executeMigrationSection(
      (statement) => sql.unsafe(statement),
      tombstonedAboutBackfill
    );

    const [ordinaryAfter] = await sql`
      SELECT deleted_at, metadata FROM entity_relationships WHERE id = ${ordinary.id}
    `;
    expect(ordinaryAfter.deleted_at).toBeNull();
    expect(ordinaryAfter.metadata).toEqual({ _lobu_claims: { manual: {} } });

    const [tombstonedOrdinaryAfter] = await sql`
      SELECT metadata FROM entity_relationships WHERE id = ${tombstonedOrdinary.id}
    `;
    expect(tombstonedOrdinaryAfter.metadata).toEqual({ _lobu_claims: { manual: {} } });

    const [authorizationAfter] = await sql`
      SELECT deleted_at, metadata FROM entity_relationships WHERE id = ${authorization.id}
    `;
    expect(authorizationAfter.deleted_at).not.toBeNull();
    expect(authorizationAfter.metadata).toBeNull();

    const [unclassifiedMemberOfAfter] = await sql`
      SELECT deleted_at, metadata
      FROM entity_relationships
      WHERE id = ${unclassifiedMemberOf.id}
    `;
    expect(unclassifiedMemberOfAfter.deleted_at).not.toBeNull();
    expect(unclassifiedMemberOfAfter.metadata).toBeNull();

    const [ownedAboutAfter] = await sql`
      SELECT deleted_at, metadata FROM entity_relationships WHERE id = ${ownedAbout.id}
    `;
    expect(ownedAboutAfter.deleted_at).toBeNull();
    expect(ownedAboutAfter.metadata).toEqual({
      visible: true,
      _lobu_claims: {
        [`connection:${connection.id}:config:channel-about:T01:C01`]: {
          connection_id: String(connection.id),
          channel_key: 'T01:C01',
        },
      },
    });

    const [orphanedAboutAfter] = await sql`
      SELECT deleted_at, metadata FROM entity_relationships WHERE id = ${orphanedAbout.id}
    `;
    expect(orphanedAboutAfter.deleted_at).not.toBeNull();
    expect(orphanedAboutAfter.metadata).toEqual({
      connection_id: '999999999',
      channel_key: 'T01:C02',
      _lobu_claims: { manual: {} },
    });

    const [tombstonedOrphanAboutAfter] = await sql`
      SELECT deleted_at, metadata
      FROM entity_relationships
      WHERE id = ${tombstonedOrphanAbout.id}
    `;
    expect(tombstonedOrphanAboutAfter.deleted_at).not.toBeNull();
    expect(tombstonedOrphanAboutAfter.metadata).toEqual({
      connection_id: '999999998',
      channel_key: 'T01:C03',
      _lobu_claims: { manual: {} },
    });

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
