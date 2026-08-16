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
import { getConfiguredEmbeddingModel } from '../../../utils/embeddings';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEvent, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const DIM = 768;

/** One-hot 768-dim unit vector (1 at `slot`, 0 elsewhere). */
function basisVector(slot: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[slot] = 1;
  return v;
}

/** Seed a global (no-automation, no-entity) classify_facet with two basis-vector attributes. */
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
  // Stamped, because the engine drops label vectors whose model is not the
  // configured one — an unstamped fixture models a row that cannot exist after
  // the 20260731150000 backfill, and would silently test nothing.
  const embedding_model = getConfiguredEmbeddingModel();
  const attributeValues = {
    positive: { embedding: basisVector(opts.positiveSlot), embedding_model },
    negative: { embedding: basisVector(opts.negativeSlot), embedding_model },
  };
  const [row] = (await sql`
    INSERT INTO classify_facet (
      organization_id, slug, name, attribute_key, status, created_by,
      automation_id, entity_ids, min_similarity, fallback_value, attribute_values
    ) VALUES (
      ${opts.orgId}, ${opts.slug}, ${`${opts.slug} classifier`}, ${opts.slug}, 'active', ${opts.createdBy},
      NULL, NULL, ${opts.minSimilarity}, ${opts.fallbackValue}, ${sql.json(attributeValues as never)}
    )
    RETURNING id
  `) as Array<{ id: number }>;

  // `sql.json`, not `JSON.stringify(...)::jsonb` — the latter binds the text as
  // a parameter that lands as a jsonb STRING (`jsonb_typeof` = 'string'), i.e.
  // double-encoded. This same mistake in RunsQueue shipped to prod: it broke
  // every `action_input ->> 'field'` reader and 403'd workers via the snapshot
  // ownership verifier. Assert the shape so a fixture can never again store
  // something production does not.
  const [shape] = (await sql`
    SELECT jsonb_typeof(attribute_values) AS t FROM classify_facet WHERE id = ${Number(row.id)}
  `) as Array<{ t: string }>;
  expect(shape.t).toBe('object');

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
      organizationId: org.id,
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

    // Leans toward `positive` (0.949) over `negative` (0.316), and BOTH are
    // below the 0.99 threshold — so `best_match_attribute` below is a real
    // winner rather than a coin flip.
    //
    // This previously used basis 3, orthogonal to both attributes: cosine
    // exactly 0.0 each, so "closest" was a tie and the assertion only held
    // because of the order attributes happened to come back in. Under jsonb
    // that order is jsonb's own (key length, then bytewise — so `negative`
    // sorts before `positive`), not authoring order, and the tie flipped. The
    // old fixture stored a double-encoded jsonb *string*, which preserved
    // authoring order and hid it.
    const facetId = await seedFacet({
      orgId: org.id,
      createdBy: user.id,
      slug: 'cq-fallback',
      positiveSlot: 2,
      negativeSlot: 4,
      minSimilarity: 0.99,
      fallbackValue: 'unknown',
    });
    const leaningPositive = new Array<number>(DIM).fill(0);
    leaningPositive[2] = 0.3;
    leaningPositive[4] = 0.1;
    const event = await createTestEvent({
      organization_id: org.id,
      content: 'neutral content matching nothing',
      embedding: leaningPositive,
    });

    const results = await executeClassificationQuery({
      mode: 'content_ids',
      organizationId: org.id,
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

  // Org isolation. `content_ids` mode selected purely on `f.id IN (...)`, so a caller
  // could classify another organization's events just by naming their ids. Unreachable
  // while the reconciliation cron (which derives ids from one org's own entity) was the
  // only caller; reachable as soon as an agent-facing action passes ids directly.
  it('refuses to classify an event belonging to another organization', async () => {
    await cleanupTestDatabase();
    const callerOrg = await createTestOrganization({ name: 'CQ Caller Org' });
    const victimOrg = await createTestOrganization({ name: 'CQ Victim Org' });
    const user = await createTestUser({ email: 'cq-iso@test.com' });

    const facetId = await seedFacet({
      orgId: callerOrg.id,
      createdBy: user.id,
      slug: 'cq-isolation',
      positiveSlot: 0,
      negativeSlot: 1,
      minSimilarity: 0.5,
      fallbackValue: null,
    });

    // Would match `positive` at cosine 1.0 if it were ever reached.
    const victimEvent = await createTestEvent({
      organization_id: victimOrg.id,
      content: 'excellent and amazing',
      embedding: basisVector(0),
    });

    const results = await executeClassificationQuery({
      mode: 'content_ids',
      organizationId: callerOrg.id,
      enabledClassifiers: ['cq-isolation'],
      content_ids: [Number(victimEvent.id)],
    });

    expect(results).toEqual([]);

    const sql = getTestDb();
    const rows = (await sql`
      SELECT 1 FROM event_classifications
      WHERE event_id = ${Number(victimEvent.id)} AND classifier_id = ${facetId}
    `) as Array<unknown>;
    expect(rows).toHaveLength(0);
  });

  // Classifier-template isolation: same slug in two orgs must not cross over. The
  // template lookup matched on slug alone, so the caller could match against another
  // org's attribute definitions.
  it('does not match against another organization’s classifier of the same slug', async () => {
    await cleanupTestDatabase();
    const callerOrg = await createTestOrganization({ name: 'CQ Slug Caller' });
    const otherOrg = await createTestOrganization({ name: 'CQ Slug Other' });
    const user = await createTestUser({ email: 'cq-slug@test.com' });

    // Only the OTHER org defines this slug. The caller org has no such classifier.
    await seedFacet({
      orgId: otherOrg.id,
      createdBy: user.id,
      slug: 'cq-shared-slug',
      positiveSlot: 0,
      negativeSlot: 1,
      minSimilarity: 0.5,
      fallbackValue: null,
    });

    const callerEvent = await createTestEvent({
      organization_id: callerOrg.id,
      content: 'excellent and amazing',
      embedding: basisVector(0),
    });

    const results = await executeClassificationQuery({
      mode: 'content_ids',
      organizationId: callerOrg.id,
      enabledClassifiers: ['cq-shared-slug'],
      content_ids: [Number(callerEvent.id)],
    });

    expect(results).toEqual([]);

    const sql = getTestDb();
    const rows = (await sql`
      SELECT 1 FROM event_classifications WHERE event_id = ${Number(callerEvent.id)}
    `) as Array<unknown>;
    expect(rows).toHaveLength(0);
  });
});
