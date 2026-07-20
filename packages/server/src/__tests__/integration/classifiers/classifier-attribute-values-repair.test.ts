/**
 * #2033 item 4 — classifier `attribute_values` corruption.
 *
 * Covers:
 *  1. Read guard round-trip: rich object-map values survive list() exactly
 *     (description/examples preserved, embedding stripped) and a seeded
 *     ARRAY-shaped row NEVER surfaces the corrupted `{"0":{}}` numeric-key shape.
 *  2. Repair migration: converts array-shaped rows to a keyed map (or `{}` when
 *     unrecoverable), is idempotent, and NEVER touches valid object-map rows —
 *     for both classify_facet.attribute_values and watcher_versions.classifiers.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { loadMigrationUpSection, splitSqlStatements } from '../../../db/migration-loader';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

const REPAIR_MIGRATION = '20260720120000_repair_array_shaped_attribute_values.sql';

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

async function runRepairMigration(): Promise<void> {
  const migrationsDir = resolveMigrationsDir();
  const up = loadMigrationUpSection(migrationsDir, REPAIR_MIGRATION);
  const sql = getDb();
  for (const statement of splitSqlStatements(up)) {
    await sql.unsafe(statement);
  }
}

describe('classifier attribute_values corruption (item 4)', () => {
  let owner: TestApiClient;
  let orgId: string;
  let userId: string;
  let entityId: number;
  let watcherId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Attr Repair Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'attr-repair@test.com' });
    userId = user.id;
    await addUserToOrganization(user.id, org.id, 'owner');
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });

    await owner.entity_schema.createType({ slug: 'company', name: 'Company' });
    const entity = (await owner.entities.create({
      type: 'company',
      name: 'Attr Target',
    })) as { entity: { id: number } };
    entityId = entity.entity.id;

    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    const w = (await owner.behaviors.create({
      entity_id: entityId,
      slug: 'attr-watcher',
      name: 'Attr Watcher',
      prompt: 'gather signals.',
      agent_id: agent.agentId,
    })) as { behavior_id: string };
    watcherId = w.behavior_id;
  });

  it('round-trips rich object-map values through list() exactly (embedding stripped)', async () => {
    const stubEmbedding = Array.from({ length: 768 }, () => 0.1);
    const created = (await owner.classifiers.create({
      slug: 'quality',
      name: 'Quality',
      attribute_key: 'quality',
      watcher_id: watcherId,
      attribute_values: {
        high: { description: 'high quality', examples: ['excellent', 'superb'], embedding: stubEmbedding },
        low: { description: 'low quality', examples: ['poor'], embedding: stubEmbedding },
      },
    })) as { data?: { classifier_id: number } };
    const classifierId = created.data!.classifier_id;

    const list = (await owner.classifiers.list({})) as {
      data?: { classifiers?: Array<{ id: number; attribute_values: Record<string, unknown> }> };
    };
    const row = list.data?.classifiers?.find((c) => c.id === classifierId);
    expect(row).toBeDefined();
    const av = row!.attribute_values as Record<string, { description: string; examples: string[]; embedding?: unknown }>;

    // Keys are the value strings — NOT numeric indices.
    expect(Object.keys(av).sort()).toEqual(['high', 'low']);
    expect(av.high.description).toBe('high quality');
    expect(av.high.examples).toEqual(['excellent', 'superb']);
    expect(av.low.description).toBe('low quality');
    // Embedding dropped on the wire.
    expect(av.high.embedding).toBeUndefined();
    expect(av.low.embedding).toBeUndefined();
  });

  it('never emits {"0":{}} for a seeded ARRAY-shaped row', async () => {
    const sql = getTestDb();
    // Seed a legacy corrupt row directly: attribute_values is a jsonb ARRAY.
    const inserted = await sql`
      INSERT INTO classify_facet (
        organization_id, slug, name, attribute_key, status, created_by,
        entity_id, entity_ids, watcher_id, attribute_values, min_similarity
      ) VALUES (
        ${orgId}, 'legacy-array', 'Legacy Array', 'legacy', 'active', ${userId},
        ${entityId}, ARRAY[${entityId}]::bigint[], ${Number(watcherId)},
        ${sql.json([{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }])},
        0.7
      )
      RETURNING id
    `;
    const legacyId = Number(inserted[0].id);

    const list = (await owner.classifiers.list({})) as {
      data?: { classifiers?: Array<{ id: number; attribute_values: unknown }> };
    };
    const row = list.data?.classifiers?.find((c) => c.id === legacyId);
    expect(row).toBeDefined();
    // The read guard rejects the array root → null, NEVER the numeric-keyed
    // `{"0":{},"1":{}}` corruption the old code emitted.
    expect(row!.attribute_values).toBeNull();
    if (row!.attribute_values !== null) {
      expect(Object.keys(row!.attribute_values as object)).not.toContain('0');
    }
  });

  it('repair migration converts array rows, is idempotent, and skips valid rows', async () => {
    const sql = getTestDb();

    // (a) Recoverable array: elements carry `value` → rebuild keyed map.
    const recoverable = await sql`
      INSERT INTO classify_facet (
        organization_id, slug, name, attribute_key, status, created_by,
        entity_id, entity_ids, watcher_id, attribute_values, min_similarity
      ) VALUES (
        ${orgId}, 'recoverable-array', 'Recoverable', 'rec', 'active', ${userId},
        ${entityId}, ARRAY[${entityId}]::bigint[], ${Number(watcherId)},
        ${sql.json([
          { value: 'alpha', description: 'A', examples: ['a'], embedding: [0.1] },
          { value: 'beta', description: 'B', examples: ['b'], embedding: [0.2] },
        ])},
        0.7
      )
      RETURNING id
    `;
    const recoverableId = Number(recoverable[0].id);

    // (b) Unrecoverable array: elements only carry embedding → collapse to {}.
    const unrecoverable = await sql`
      INSERT INTO classify_facet (
        organization_id, slug, name, attribute_key, status, created_by,
        entity_id, entity_ids, watcher_id, attribute_values, min_similarity
      ) VALUES (
        ${orgId}, 'unrecoverable-array', 'Unrecoverable', 'unrec', 'active', ${userId},
        ${entityId}, ARRAY[${entityId}]::bigint[], ${Number(watcherId)},
        ${sql.json([{ embedding: [0.1] }, { embedding: [0.2] }])},
        0.7
      )
      RETURNING id
    `;
    const unrecoverableId = Number(unrecoverable[0].id);

    // (c) A VALID object-map row that must NOT be touched.
    const validMap = { good: { description: 'g', examples: ['g'] } };
    const valid = await sql`
      INSERT INTO classify_facet (
        organization_id, slug, name, attribute_key, status, created_by,
        entity_id, entity_ids, watcher_id, attribute_values, min_similarity
      ) VALUES (
        ${orgId}, 'valid-map', 'Valid', 'valid', 'active', ${userId},
        ${entityId}, ARRAY[${entityId}]::bigint[], ${Number(watcherId)},
        ${sql.json(validMap)}, 0.7
      )
      RETURNING id
    `;
    const validId = Number(valid[0].id);

    // (d) Seed an array-shaped classifier into the behavior version created by
    // behaviors.create above (UPDATE avoids hand-crafting the version row's
    // NOT NULL columns, which drift across migrations).
    const versionRow = await sql`
      UPDATE watcher_versions
      SET classifiers = ${sql.json([
        {
          slug: 'vclass',
          attribute_values: [
            { value: 'x', description: 'X', embedding: [0.1] },
            { value: 'y', description: 'Y' },
          ],
        },
      ])}
      WHERE watcher_id = ${Number(watcherId)}
      RETURNING id
    `;
    const versionId = Number(versionRow[0].id);

    await runRepairMigration();

    const afterFirst = await sql`
      SELECT id, attribute_values FROM classify_facet
      WHERE id IN (${recoverableId}, ${unrecoverableId}, ${validId})
      ORDER BY id
    `;
    const byId = new Map(afterFirst.map((r) => [Number(r.id), r.attribute_values]));

    // Recoverable → keyed map, embedding + value dropped from bodies.
    expect(byId.get(recoverableId)).toEqual({
      alpha: { description: 'A', examples: ['a'] },
      beta: { description: 'B', examples: ['b'] },
    });
    // Unrecoverable → {} (flagged for regeneration).
    expect(byId.get(unrecoverableId)).toEqual({});
    // Valid row untouched.
    expect(byId.get(validId)).toEqual(validMap);

    // Behavior-version classifier repaired in place, def fields preserved.
    const versionAfter = await sql`
      SELECT classifiers FROM watcher_versions WHERE id = ${versionId}
    `;
    const classifiers = versionAfter[0].classifiers as Array<Record<string, unknown>>;
    expect(classifiers[0].slug).toBe('vclass');
    expect(classifiers[0].attribute_values).toEqual({
      x: { description: 'X' },
      y: { description: 'Y' },
    });

    // Idempotency: a second run changes nothing (predicate no longer matches).
    await runRepairMigration();
    const afterSecond = await sql`
      SELECT id, attribute_values FROM classify_facet
      WHERE id IN (${recoverableId}, ${unrecoverableId}, ${validId})
      ORDER BY id
    `;
    const byId2 = new Map(afterSecond.map((r) => [Number(r.id), r.attribute_values]));
    expect(byId2.get(recoverableId)).toEqual(byId.get(recoverableId));
    expect(byId2.get(unrecoverableId)).toEqual({});
    expect(byId2.get(validId)).toEqual(validMap);
  });
});
