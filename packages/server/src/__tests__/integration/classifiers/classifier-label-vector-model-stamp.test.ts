/**
 * Classifier label vectors must carry the model that produced them.
 *
 * `classify_facet.attribute_values[value].embedding` is cosine-compared against
 * `event_embeddings.embedding`. The EVENT side is model-scoped everywhere —
 * content search, this engine's own target fetch, and the backfill's staleness
 * predicate all pin `embedding_model` — because vectors from different models
 * are not comparable even at equal dimensionality. The LABEL side had no stamp,
 * so an `EMBEDDINGS_MODEL` swap left it behind entirely.
 *
 * The failure is silent, which is what makes it worth a test: cosine between two
 * unrelated 768-dim spaces returns a confident-looking number instead of
 * throwing, so classification keeps producing labels and they are simply wrong.
 * Nothing in the pipeline reports an error.
 *
 * Measured on prod 2026-07-31: 28 classifiers, 208 label vectors, 0 stamped —
 * against 2,060,864 event vectors that are 100% stamped.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { manageClassifiers } from '../../../tools/admin/manage_classifiers';
import type { ToolContext } from '../../../tools/registry';
import { executeClassificationQuery } from '../../../utils/classification-query';
import { DEFAULT_EMBEDDING_MODEL } from '../../../utils/embeddings';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const DIM = 768;
function basisVector(slot: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[slot] = 1;
  return v;
}

/** Identical to the event vector below, so similarity is 1.0 when it is used. */
const ATTRIBUTE_VALUES = {
  positive: { description: 'Positive', examples: ['great'], embedding: basisVector(0) },
};

function ownerCtx(organizationId: string, userId: string): ToolContext {
  return {
    organizationId,
    userId,
    memberRole: 'owner',
    isAuthenticated: true,
    tokenType: 'oauth',
    scopedToOrg: false,
    allowCrossOrg: false,
    scopes: ['mcp:admin'],
  } as ToolContext;
}

async function seedOrgWithClassifier(slug: string) {
  await cleanupTestDatabase();
  await seedSystemEntityTypes();
  const org = await createTestOrganization({ name: 'Stamp Org' });
  const user = await createTestUser({ email: `${slug}@test.example.com` });
  await addUserToOrganization(user.id, org.id, 'owner');
  const ctx = ownerCtx(org.id, user.id);

  const created = await manageClassifiers(
    {
      action: 'create',
      slug,
      name: slug,
      attribute_key: slug,
      attribute_values: ATTRIBUTE_VALUES,
      min_similarity: 0.5,
    } as never,
    {} as never,
    ctx
  );
  expect(created.success).toBe(true);

  const event = await createTestEvent({
    organization_id: org.id,
    content: 'great',
    embedding: basisVector(0),
  });

  return { org, ctx, eventId: Number(event.id), slug };
}

function classify(orgId: string, slug: string, eventId: number) {
  return executeClassificationQuery({
    mode: 'content_ids',
    organizationId: orgId,
    content_ids: [eventId],
    enabledClassifiers: [slug],
  } as never);
}

/**
 * The durable evidence: what the engine actually persisted for this event.
 *
 * `unnest` rather than reading the column directly — the pool runs with
 * `fetch_types: false`, so a text[] arrives as the raw literal `{positive}`
 * (one string), which compares unequal to `['positive']` in a way that looks
 * like a logic failure.
 */
async function storedLabels(eventId: number): Promise<string[]> {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT unnest("values") AS v FROM event_classifications WHERE event_id = ${eventId}
  `) as unknown as Array<{ v: string }>;
  return rows.map((r) => r.v);
}

/**
 * Minimal stand-in for the embeddings service. `generate_embeddings` is a
 * network call by design (vectors come from a dedicated service), and the
 * regeneration path is exactly what makes a model swap self-repairing — so it
 * is worth exercising for real rather than asserting around.
 *
 * Echoes `model` back as whatever the deployment is configured for, because
 * `generateEmbeddings` refuses a response whose model disagrees.
 */
async function withStubEmbeddingsService<T>(run: () => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const { texts } = JSON.parse(body || '{}') as { texts: string[] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          embeddings: texts.map(() => basisVector(0)),
          dimensions: DIM,
          model: process.env.EMBEDDINGS_MODEL || DEFAULT_EMBEDDING_MODEL,
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env.EMBEDDINGS_SERVICE_URL = `http://127.0.0.1:${port}`;
  try {
    return await run();
  } finally {
    delete process.env.EMBEDDINGS_SERVICE_URL;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterEach(() => {
  delete process.env.EMBEDDINGS_MODEL;
});

describe('classifier label vectors are model-stamped', () => {
  it('stamps the configured model when create generates the vectors', async () => {
    const { org, slug } = await seedOrgWithClassifier('stamped-on-create');
    const sql = getTestDb();

    const [row] = (await sql`
      SELECT attribute_values FROM classify_facet
      WHERE slug = ${slug} AND organization_id = ${org.id}
    `) as unknown as Array<{ attribute_values: Record<string, { embedding_model?: string }> }>;

    // The vector and its provenance are stored together, mirroring the
    // event_embeddings row shape.
    expect(row.attribute_values.positive.embedding_model).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  it('classifies normally while the stamp matches the configured model', async () => {
    const { org, slug, eventId } = await seedOrgWithClassifier('matching-stamp');

    // Control for the test below: this exact setup DOES produce a label, so a
    // zero result there is attributable to the stamp and nothing else.
    await classify(org.id, slug, eventId);
    expect(await storedLabels(eventId)).toEqual(['positive']);
  });

  it('drops label vectors from a different model instead of comparing across spaces', async () => {
    const { org, slug, eventId } = await seedOrgWithClassifier('foreign-stamp');
    const sql = getTestDb();
    const newModel = 'Xenova/multilingual-e5-base';

    // The state that actually makes this dangerous is POST-backfill, and getting
    // there matters: simply flipping EMBEDDINGS_MODEL is not enough to reproduce
    // it, because `fetchTargetContent` scopes event_embeddings by model too, so
    // the EVENT vector disappears along with the label vector and nothing is
    // compared at all. A first draft of this test passed against unfixed code
    // for exactly that reason — vacuously, having proven nothing.
    //
    // So: re-embed the event under the new model, as the documented swap
    // procedure does. Now the event vector IS found, the label vector is still
    // bge, and they are the two halves of a cross-space cosine. Unfixed, this
    // returns 1.0 and writes a confident 'positive'.
    await sql`
      INSERT INTO event_embeddings (event_id, embedding_model, chunk_index, embedding)
      VALUES (${eventId}, ${newModel}, 0, ${JSON.stringify(basisVector(0))}::vector)
    `;
    process.env.EMBEDDINGS_MODEL = newModel;

    await classify(org.id, slug, eventId);
    expect(await storedLabels(eventId)).toEqual([]);

    // And the stored vector is left intact for `generate_embeddings` to replace,
    // not destroyed by the read path.
    const [row] = (await sql`
      SELECT attribute_values FROM classify_facet
      WHERE slug = ${slug} AND organization_id = ${org.id}
    `) as unknown as Array<{
      attribute_values: Record<string, { embedding?: number[]; embedding_model?: string }>;
    }>;
    expect(row.attribute_values.positive.embedding).toHaveLength(DIM);
    expect(row.attribute_values.positive.embedding_model).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  it('treats a stale stamp as missing so generate_embeddings re-embeds it', async () => {
    const { org, ctx, slug } = await seedOrgWithClassifier('regenerates-stale');
    const sql = getTestDb();

    const [before] = (await sql`
      SELECT id FROM classify_facet WHERE slug = ${slug} AND organization_id = ${org.id}
    `) as unknown as Array<{ id: number }>;

    // A swap must be repairable by the documented procedure alone. Without
    // stale-means-regenerate, generate_embeddings reports "all values already
    // have embeddings" and the classifier stays dead until someone thinks to
    // pass force_regenerate.
    process.env.EMBEDDINGS_MODEL = 'Xenova/multilingual-e5-base';

    const regenerated = await withStubEmbeddingsService(() =>
      manageClassifiers(
        { action: 'generate_embeddings', classifier_id: Number(before.id) } as never,
        { EMBEDDINGS_SERVICE_URL: process.env.EMBEDDINGS_SERVICE_URL } as never,
        ctx
      )
    );
    expect(regenerated.success).toBe(true);
    expect((regenerated.data as { generated_embeddings: number }).generated_embeddings).toBe(1);

    const [after] = (await sql`
      SELECT attribute_values FROM classify_facet WHERE id = ${Number(before.id)}
    `) as unknown as Array<{ attribute_values: Record<string, { embedding_model?: string }> }>;
    expect(after.attribute_values.positive.embedding_model).toBe('Xenova/multilingual-e5-base');
  });
});
