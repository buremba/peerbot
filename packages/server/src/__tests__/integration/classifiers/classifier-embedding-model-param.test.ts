/**
 * Classification under a NON-DEFAULT embedding model.
 *
 * `event_embeddings` has been keyed `(event_id, embedding_model, chunk_index)`
 * since 20260618140000, and both write paths (insert-event's `upsertEmbedding`,
 * the worker's `completeEmbeddings`) already take the model per row — two models
 * have always been able to coexist in storage. Nothing could ever *choose* one:
 * every read scoped itself to `getConfiguredEmbeddingModel()`, a process-global.
 *
 * These tests pin the property that makes the parameter worth having — that a
 * non-default model is actually honoured end to end — rather than only that the
 * default still works. A threading change like this fails silently in the
 * direction the default-path tests cannot see: miss one site and it keeps
 * reading the configured model while its neighbour reads the requested one, and
 * cosine across two 768-dim spaces returns a confident number instead of an
 * error. That is the same failure class the label-vector stamp (#2407) exists to
 * prevent, reachable a second way.
 *
 * `EMBEDDINGS_MODEL` is never touched here: the point is that a caller can work
 * in another space WITHOUT a deployment-wide swap.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { manageClassifiers } from '../../../tools/admin/manage_classifiers';
import type { ToolContext } from '../../../tools/registry';
import { executeClassificationQuery } from '../../../utils/classification-query';
import { getConfiguredEmbeddingModel } from '../../../utils/embeddings';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const DIM = 768;
/** A second model name. Never installed anywhere — it only has to be a distinct string. */
const OTHER_MODEL = 'Xenova/multilingual-e5-base';

function basisVector(slot: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[slot] = 1;
  return v;
}

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

/**
 * Seed a classifier whose label vector is stamped `labelModel`, and one event
 * whose vector is stamped `eventModel`.
 *
 * The label vector is written directly rather than through `create`, because
 * `create` hydrates via the embeddings service and this suite is about which
 * model the READ paths scope to — not about the service round-trip (covered by
 * classifier-label-vector-model-stamp.test.ts). Both vectors are basis 0, so
 * cosine is exactly 1.0 whenever the two are actually compared: any non-match
 * below is a scoping decision, never a numeric one.
 */
async function seed(opts: { slug: string; labelModel: string; eventModel: string }) {
  await cleanupTestDatabase();
  await seedSystemEntityTypes();
  const org = await createTestOrganization({ name: 'Model Param Org' });
  const user = await createTestUser({ email: `${opts.slug}@test.example.com` });
  await addUserToOrganization(user.id, org.id, 'owner');

  const sql = getTestDb();
  const attributeValues = {
    positive: {
      description: 'Positive',
      examples: ['great'],
      embedding: basisVector(0),
      embedding_model: opts.labelModel,
    },
  };
  const [facet] = (await sql`
    INSERT INTO classify_facet (
      organization_id, slug, name, attribute_key, status, created_by,
      automation_id, entity_ids, min_similarity, fallback_value, attribute_values
    ) VALUES (
      ${org.id}, ${opts.slug}, ${opts.slug}, ${opts.slug}, 'active', ${user.id},
      NULL, NULL, 0.5, NULL, ${sql.json(attributeValues as never)}
    ) RETURNING id
  `) as Array<{ id: number }>;

  const event = await createTestEvent({
    organization_id: org.id,
    content: 'great',
    embedding: basisVector(0),
    embedding_model: opts.eventModel,
  });

  return {
    org,
    ctx: ownerCtx(org.id, user.id),
    eventId: Number(event.id),
    facetId: Number(facet.id),
  };
}

/** What the engine actually persisted. `unnest` because fetch_types:false returns text[] raw. */
async function storedLabels(eventId: number): Promise<string[]> {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT unnest("values") AS v FROM event_classifications WHERE event_id = ${eventId}
  `) as unknown as Array<{ v: string }>;
  return rows.map((r) => r.v);
}

describe('classification under a caller-supplied embedding model', () => {
  afterEach(async () => {
    await cleanupTestDatabase();
  });

  it('classifies when BOTH sides live in the requested non-default model', async () => {
    const { org, eventId } = await seed({
      slug: 'mp-both-other',
      labelModel: OTHER_MODEL,
      eventModel: OTHER_MODEL,
    });

    const results = await executeClassificationQuery({
      mode: 'content_ids',
      organizationId: org.id,
      content_ids: [eventId],
      enabledClassifiers: ['mp-both-other'],
      embeddingModel: OTHER_MODEL,
    });

    expect(results).toEqual([{ content_id: eventId }]);
    expect(await storedLabels(eventId)).toEqual(['positive']);
  });

  // The inverse of the test above, and the one that actually catches a missed
  // call site: identical data, only the requested model differs. If either side
  // still resolved the model from the global, this would classify.
  it('classifies NOTHING when the same data is requested under the configured model', async () => {
    const { org, eventId } = await seed({
      slug: 'mp-both-other-default-read',
      labelModel: OTHER_MODEL,
      eventModel: OTHER_MODEL,
    });

    const results = await executeClassificationQuery({
      mode: 'content_ids',
      organizationId: org.id,
      content_ids: [eventId],
      enabledClassifiers: ['mp-both-other-default-read'],
    });

    expect(results).toEqual([]);
    expect(await storedLabels(eventId)).toEqual([]);
  });

  // Half-migrated corpus: labels re-embedded under the new model, events not yet.
  // Must produce nothing rather than a cross-space cosine.
  it('refuses to compare a requested-model label against a configured-model event', async () => {
    const { org, eventId } = await seed({
      slug: 'mp-split',
      labelModel: OTHER_MODEL,
      eventModel: getConfiguredEmbeddingModel(),
    });

    const results = await executeClassificationQuery({
      mode: 'content_ids',
      organizationId: org.id,
      content_ids: [eventId],
      enabledClassifiers: ['mp-split'],
      embeddingModel: OTHER_MODEL,
    });

    expect(results).toEqual([]);
    expect(await storedLabels(eventId)).toEqual([]);
  });

  it('still uses the configured model when no override is passed', async () => {
    const configured = getConfiguredEmbeddingModel();
    const { org, eventId } = await seed({
      slug: 'mp-default',
      labelModel: configured,
      eventModel: configured,
    });

    const results = await executeClassificationQuery({
      mode: 'content_ids',
      organizationId: org.id,
      content_ids: [eventId],
      enabledClassifiers: ['mp-default'],
    });

    expect(results).toEqual([{ content_id: eventId }]);
    expect(await storedLabels(eventId)).toEqual(['positive']);
  });

  // `apply`'s skip reasons are the agent-visible surface, and the probe that
  // produces them is a SEPARATE query from the engine's join. If the two resolve
  // the model independently the event passes the probe, gets dropped by the
  // engine, and is reported `below_threshold` — a claim that it was scored and
  // lost, about a row that was never scored at all.
  it('reports not_embedded (never below_threshold) for an event absent from the requested model', async () => {
    const { ctx, eventId } = await seed({
      slug: 'mp-apply-skip',
      labelModel: OTHER_MODEL,
      eventModel: getConfiguredEmbeddingModel(),
    });

    const result = (await manageClassifiers(
      {
        action: 'apply',
        classifier_slug: 'mp-apply-skip',
        content_ids: [eventId],
        embedding_model: OTHER_MODEL,
      } as never,
      {} as never,
      ctx
    )) as {
      success: boolean;
      data?: { classified: number; skipped: Record<string, number> };
    };

    expect(result.success).toBe(true);
    expect(result.data?.classified).toBe(0);
    expect(result.data?.skipped.not_embedded).toBe(1);
    expect(result.data?.skipped.below_threshold).toBe(0);
  });

  it('rejects a model identifier that would be inlined into SQL', async () => {
    const { org, eventId } = await seed({
      slug: 'mp-injection',
      labelModel: OTHER_MODEL,
      eventModel: OTHER_MODEL,
    });

    await expect(
      executeClassificationQuery({
        mode: 'content_ids',
        organizationId: org.id,
        content_ids: [eventId],
        enabledClassifiers: ['mp-injection'],
        embeddingModel: "x' OR '1'='1",
      })
    ).rejects.toThrow(/not a valid model identifier/);
  });
});
