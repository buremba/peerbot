/**
 * The 20260731150000 backfill, executed against rows that actually need it.
 *
 * This migration is load-bearing in a way the guard it supports is not: the
 * classification engine now drops label vectors whose stamp is not the
 * configured model, so if the backfill does nothing, all 208 existing prod
 * vectors (28 classifiers) read as unknown-provenance and every classifier
 * stops classifying the moment this deploys. The guard is the safety net; the
 * backfill is what keeps it a no-op for data that is in fact fine.
 *
 * The suite's own migration run happens before any test data exists, so it
 * proves only that the SQL parses. These tests seed the pre-migration shape and
 * run the real statement out of the migration file — no second copy of the
 * transform to drift from it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEvent, createTestOrganization } from '../../setup/test-fixtures';

const MIGRATION = '20260731150000_classify_facet_label_vector_model_stamp.sql';

/**
 * The `migrate:up` half of the real migration file. Resolved by walking up to
 * the repo root rather than a fixed `../../../../../..` so the test does not
 * silently read nothing if the file ever moves.
 */
function migrationUpSql(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    try {
      const candidates = readdirSync(join(dir, 'db', 'migrations'));
      if (candidates.includes(MIGRATION)) {
        const raw = readFileSync(join(dir, 'db', 'migrations', MIGRATION), 'utf8');
        const up = raw.split('-- migrate:down')[0].replace('-- migrate:up', '');
        expect(up).toContain('classify_facet');
        return up;
      }
    } catch {
      // not this level — keep walking
    }
    dir = join(dir, '..');
  }
  throw new Error(`could not locate db/migrations/${MIGRATION}`);
}

const DIM = 768;
function basisVector(slot: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[slot] = 1;
  return v;
}

/**
 * The pre-migration shape: a vector, no stamp.
 *
 * `sql.json(...)`, NOT `JSON.stringify(...)::jsonb` — the latter binds the text
 * as a parameter that lands as a jsonb STRING (`jsonb_typeof` = 'string'), i.e.
 * double-encoded. The read paths JSON-parse twice and hide it, but the migration
 * works in SQL, where its `jsonb_typeof(attribute_values) = 'object'` guard
 * correctly skips such a row — so a stringify-seeded fixture tests nothing and
 * reports it as the migration failing. Production writes through `sql.json`.
 */
async function seedUnstamped(
  organizationId: string,
  slug: string,
  values: Record<string, unknown>
): Promise<number> {
  const sql = getTestDb();
  const [row] = (await sql`
    INSERT INTO classify_facet (organization_id, slug, name, attribute_key, status, created_by, attribute_values)
    VALUES (${organizationId}, ${slug}, ${slug}, ${slug}, 'active', 'system', ${sql.json(values as never)})
    RETURNING id
  `) as unknown as Array<{ id: number }>;

  // Fail loud if the fixture is not the shape production stores, rather than
  // letting a mis-seeded row masquerade as a migration bug.
  const [check] = (await sql`
    SELECT jsonb_typeof(attribute_values) AS t FROM classify_facet WHERE id = ${Number(row.id)}
  `) as unknown as Array<{ t: string }>;
  expect(check.t).toBe('object');

  return Number(row.id);
}

async function attributeValues(id: number): Promise<Record<string, Record<string, unknown>>> {
  const sql = getTestDb();
  const [row] = (await sql`
    SELECT attribute_values FROM classify_facet WHERE id = ${id}
  `) as unknown as Array<{ attribute_values: Record<string, Record<string, unknown>> }>;
  return row.attribute_values;
}

describe('classifier label-vector backfill migration', () => {
  it('stamps unstamped vectors with the model the install actually runs', async () => {
    await cleanupTestDatabase();
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Backfill Org' });

    // The stamp is DERIVED from event_embeddings, not hardcoded — so an install
    // running a non-default model gets its own value. Prove that by making the
    // prevailing model something other than the code default.
    const installModel = 'Xenova/some-other-model';
    await createTestEvent({
      organization_id: org.id,
      content: 'anything',
      embedding: basisVector(0),
    });
    await sql`UPDATE event_embeddings SET embedding_model = ${installModel}`;

    const id = await seedUnstamped(org.id, 'legacy', {
      positive: { description: 'Positive', examples: ['great'], embedding: basisVector(0) },
      negative: { description: 'Negative', examples: ['awful'], embedding: basisVector(1) },
    });

    await sql.unsafe(migrationUpSql());

    const after = await attributeValues(id);
    expect(after.positive.embedding_model).toBe(installModel);
    expect(after.negative.embedding_model).toBe(installModel);
    // Annotated, not rewritten — the vectors themselves must survive intact.
    expect(after.positive.embedding).toHaveLength(DIM);
    expect((after.positive.embedding as number[])[0]).toBe(1);
    expect(after.positive.description).toBe('Positive');
    expect(after.positive.examples).toEqual(['great']);
  });

  it('leaves vector-less entries unstamped and empty maps intact', async () => {
    await cleanupTestDatabase();
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Backfill Edge Org' });

    const noVector = await seedUnstamped(org.id, 'no-vector', {
      positive: { description: 'Positive', examples: ['great'] },
    });
    // `jsonb_object_agg` over zero rows returns NULL. Without the EXISTS guard
    // in the WHERE clause this row's column would be blanked outright, which is
    // considerably worse than the bug being fixed.
    const empty = await seedUnstamped(org.id, 'empty', {});

    await sql.unsafe(migrationUpSql());

    // A stamp must never describe a vector that is not there.
    expect(await attributeValues(noVector)).toEqual({
      positive: { description: 'Positive', examples: ['great'] },
    });
    expect(await attributeValues(empty)).toEqual({});
  });

  it('is idempotent and never overwrites an existing stamp', async () => {
    await cleanupTestDatabase();
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Backfill Idempotent Org' });

    await createTestEvent({
      organization_id: org.id,
      content: 'anything',
      embedding: basisVector(0),
    });
    await sql`UPDATE event_embeddings SET embedding_model = 'model-A'`;

    // A row already stamped by a DIFFERENT model is genuinely stale and must
    // stay that way — re-blessing it as current would resurrect exactly the
    // silent cross-space comparison this whole change exists to stop.
    const id = await seedUnstamped(org.id, 'mixed', {
      fresh: { embedding: basisVector(0), embedding_model: 'model-B' },
      legacy: { embedding: basisVector(1) },
    });

    await sql.unsafe(migrationUpSql());
    const once = await attributeValues(id);
    expect(once.fresh.embedding_model).toBe('model-B');
    expect(once.legacy.embedding_model).toBe('model-A');

    await sql.unsafe(migrationUpSql());
    expect(await attributeValues(id)).toEqual(once);
  });
});
