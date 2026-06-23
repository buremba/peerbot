/**
 * End-to-end coverage for executeClassificationQuery — the FULL embedding-classification
 * pipeline that the upsert-batch test did NOT exercise:
 *   fetchTargetContent (reads the event_embeddings vector) → fetchClassifierTemplates
 *   (reads classify_facet.attribute_values) → computeSimilarities (TS cosine)
 *   → determineBestMatches → upsertClassifications.
 *
 * This is the half where the pgvector-read bug lived: under the prod client
 * (fetch_types:false, which getTestDb shares) a `vector` column reads back as the TEXT
 * string "[1,2,3]", NOT a JS array. The old `row.embedding as number[]` cast made
 * cosineSimilarity iterate over characters → NaN → the embedding path silently classified
 * NOTHING (its only caller, the reconciliation cron, swallows the result). parsePgVector()
 * fixes it. No mocks — this runs the real path against real pgvector under the prod config.
 *
 * Vectors are 768-dim (event_embeddings is vector(768)) one-hot basis vectors, so the
 * cosine winner is exact and deterministic: identical basis → 1.0, orthogonal → 0.0.
 */

import { describe, expect, it } from 'vitest';
import { executeClassificationQuery } from '../../../utils/classification-query';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEvent, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const DIM = 768;

/** One-hot 768-dim unit vector (1 at `slot`, 0 elsewhere). */
function basisVector(slot: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[slot] = 1;
  return v;
}

/** Seed a global (no-watcher, no-entity) classify_facet with two basis-vector attributes. */
async function seedFacet(opts: {
  orgId: string;
  createdBy: string;
  slug: string;
  positiveSlot: number;
  negativeSlot: number;
  minSimilarity: number;
  fallbackValue: string | null;
}): Promise<number> {
  const sql = getTestDb();
  const attributeValues = {
    positive: { embedding: basisVector(opts.positiveSlot) },
    negative: { embedding: basisVector(opts.negativeSlot) },
  };
  const [row] = (await sql`
    INSERT INTO classify_facet (
      organization_id, slug, name, attribute_key, status, created_by,
      watcher_id, entity_ids, min_similarity, fallback_value, attribute_values
    ) VALUES (
      ${opts.orgId}, ${opts.slug}, ${`${opts.slug} classifier`}, ${opts.slug}, 'active', ${opts.createdBy},
      NULL, NULL, ${opts.minSimilarity}, ${opts.fallbackValue}, ${JSON.stringify(attributeValues)}::jsonb
    )
    RETURNING id
  `) as Array<{ id: number }>;
  return Number(row.id);
}

describe('executeClassificationQuery (full embedding pipeline)', () => {
  it('matches the closest attribute by cosine and writes the classification (met_threshold)', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'CQ Org' });
    const user = await createTestUser({ email: 'cq@test.com' });

    // event embedding == positive's embedding (basis 0) → cosine 1.0 vs positive, 0.0 vs negative
    const facetId = await seedFacet({
      orgId: org.id,
      createdBy: user.id,
      slug: 'cq-sentiment',
      positiveSlot: 0,
      negativeSlot: 1,
      minSimilarity: 0.5,
      fallbackValue: 'unknown',
    });
    const event = await createTestEvent({
      organization_id: org.id,
      content: 'excellent and amazing',
      embedding: basisVector(0),
    });

    const results = await executeClassificationQuery({
      mode: 'content_ids',
      enabledClassifiers: ['cq-sentiment'],
      content_ids: [Number(event.id)],
    });
    expect(results).toEqual([{ content_id: Number(event.id) }]);

    const sql = getTestDb();
    const rows = (await sql`
      SELECT source, met_threshold::text AS met, best_match_attribute,
             "values"::text AS vals, embedding_confidence::text AS conf
      FROM event_classifications
      WHERE event_id = ${Number(event.id)} AND classifier_id = ${facetId} AND source = 'embedding'
    `) as Array<{
      source: string;
      met: string;
      best_match_attribute: string;
      vals: string;
      conf: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('embedding');
    expect(rows[0].met).toBe('true');
    expect(rows[0].best_match_attribute).toBe('positive');
    expect(rows[0].vals).toBe('{positive}');
    // identical 768-dim basis vectors → cosine exactly 1.0
    expect(Number(rows[0].conf)).toBeCloseTo(1.0, 3);
  });

  it('falls back when the best cosine is below min_similarity', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'CQ Org 2' });
    const user = await createTestUser({ email: 'cq2@test.com' });

    // event embedding (basis 3) is orthogonal to both attributes → best cosine 0.0 < 0.99
    const facetId = await seedFacet({
      orgId: org.id,
      createdBy: user.id,
      slug: 'cq-fallback',
      positiveSlot: 2,
      negativeSlot: 4,
      minSimilarity: 0.99,
      fallbackValue: 'unknown',
    });
    const event = await createTestEvent({
      organization_id: org.id,
      content: 'neutral content matching nothing',
      embedding: basisVector(3),
    });

    const results = await executeClassificationQuery({
      mode: 'content_ids',
      enabledClassifiers: ['cq-fallback'],
      content_ids: [Number(event.id)],
    });
    expect(results).toEqual([{ content_id: Number(event.id) }]);

    const sql = getTestDb();
    const rows = (await sql`
      SELECT met_threshold::text AS met, best_match_attribute, "values"::text AS vals
      FROM event_classifications
      WHERE event_id = ${Number(event.id)} AND classifier_id = ${facetId} AND source = 'embedding'
    `) as Array<{ met: string; best_match_attribute: string; vals: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].met).toBe('false');
    expect(rows[0].best_match_attribute).toBe('positive'); // closest, even if below threshold
    expect(rows[0].vals).toBe('{unknown}'); // fallback_value
  });
});
