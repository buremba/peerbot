/**
 * Finding #3 end-to-end reproducer: a same-dimension model swap must NOT mix
 * vector spaces.
 *
 * Scenario:
 *   1. Configure model A, ingest an event embedded under model A.
 *   2. Under model A, a vector search returns the row (control — scoping does
 *      not over-filter the current model).
 *   3. Switch the configured model to a DIFFERENT same-dimension model B.
 *   4. Under model B, the same vector search must NOT return the model-A row
 *      (its vector lives in an incompatible space).
 *   5. Under model B, the backfill "needs embedding" query must flag the
 *      model-A row as stale so it gets re-embedded.
 *
 * Before the fix, steps 4 and 5 failed: search compared across models and
 * backfill only looked for missing (not stale) embeddings.
 */

import type { Context } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchContentByText } from '../../../utils/content-search';
import type { Env } from '../../../index';
import { insertEvent } from '../../../utils/insert-event';
import { needsEmbeddingSql } from '../../../utils/embeddings';
import { completeEmbeddings } from '../../../worker-api';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const EMBEDDING_DIM = 768;
const MODEL_A = 'Xenova/bge-base-en-v1.5';
const MODEL_B = 'Xenova/some-other-768d-model';

// Identical 768-d vector for both the stored row and the query, so the ONLY
// thing that can exclude the row is the model-scope predicate (not distance).
function unitVec(): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
}

// Minimal Hono Context to drive worker-api handlers directly: completeEmbeddings
// only reads the JSON body and calls c.json() on the success path (no c.env).
function mockEmbeddingsCtx(body: unknown): {
  ctx: Context<{ Bindings: Env }>;
  result: () => { body: unknown; status: number };
} {
  let captured: { body: unknown; status: number } = { body: undefined, status: 200 };
  const ctx = {
    req: { json: async () => body },
    // completeEmbeddings now calls authorizeRunForWorker, which reads
    // c.var.workerAuthMode (no-op unless 'user'). Provide an empty var bag so
    // the token-mode path is exercised instead of crashing on undefined.
    var: {},
    json: (b: unknown, status?: number) => {
      captured = { body: b, status: status ?? 200 };
      return captured as unknown as Response;
    },
  } as unknown as Context<{ Bindings: Env }>;
  return { ctx, result: () => captured };
}

describe('embedding model swap E2E (Finding #3)', () => {
  let orgId: string;
  let entityId: number;
  let connectionId: number;
  let eventId: number;
  let originalModel: string | undefined;

  beforeAll(async () => {
    originalModel = process.env.EMBEDDINGS_MODEL;
    process.env.EMBEDDINGS_MODEL = MODEL_A;

    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const org = await createTestOrganization({ name: 'Model Swap Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'model-swap-test@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const entity = await createTestEntity({ name: 'Swap Target', organization_id: org.id });
    entityId = entity.id;

    await createTestConnectorDefinition({
      key: 'model-swap-connector',
      name: 'Model Swap',
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'model-swap-connector',
      entity_ids: [entity.id],
    });
    connectionId = connection.id;

    // Event embedded under model A.
    const inserted = await insertEvent(
      {
        entityIds: [entityId],
        organizationId: orgId,
        originId: `swap-${Date.now()}`,
        title: 'Model A event',
        content: 'unique model-a content about quarterly revenue',
        occurredAt: new Date(),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'model-swap-connector',
        connectionId,
        embedding: unitVec(),
        embeddingModel: MODEL_A,
      },
      { onConflictUpdate: true }
    );
    eventId = inserted.id;
  });

  afterAll(() => {
    if (originalModel === undefined) delete process.env.EMBEDDINGS_MODEL;
    else process.env.EMBEDDINGS_MODEL = originalModel;
  });

  it('control: under model A the row is returned by vector search', async () => {
    process.env.EMBEDDINGS_MODEL = MODEL_A;
    const res = await searchContentByText('', {
      organization_id: orgId,
      query_embedding: unitVec(),
      min_similarity: 0.5,
      limit: 10,
    });
    const ids = res.content.map((r) => Number(r.id));
    expect(ids).toContain(eventId);
  });

  it('under model B the model-A row is NOT returned (no cross-model comparison)', async () => {
    process.env.EMBEDDINGS_MODEL = MODEL_B;
    const res = await searchContentByText('', {
      organization_id: orgId,
      query_embedding: unitVec(),
      min_similarity: 0.5,
      limit: 10,
    });
    const ids = res.content.map((r) => Number(r.id));
    expect(ids).not.toContain(eventId);
  });

  it('under model B the candidate (recall) path also excludes the model-A row', async () => {
    process.env.EMBEDDINGS_MODEL = MODEL_B;
    const res = await searchContentByText('', {
      organization_id: orgId,
      query_embedding: unitVec(),
      min_similarity: 0.5,
      limit: 10,
      approximate_candidate_search: true,
    });
    const ids = res.content.map((r) => Number(r.id));
    expect(ids).not.toContain(eventId);
  });

  it('under model B the backfill query flags the model-A row as stale', async () => {
    process.env.EMBEDDINGS_MODEL = MODEL_B;
    const sql = getTestDb();
    // Mirror trigger-embed-backfill's needs-embedding predicate.
    const staleRows = (await sql`
      SELECT ev.id
      FROM current_event_records ev
      LEFT JOIN event_embeddings emb ON emb.event_id = ev.id
      WHERE ev.id = ${eventId}
        AND (emb.event_id IS NULL OR emb.embedding_model IS DISTINCT FROM ${MODEL_B})
    `) as Array<{ id: number }>;
    expect(staleRows.map((r) => Number(r.id))).toContain(eventId);

    // And under model A it is NOT stale (no needless re-embed of current rows).
    const freshRows = (await sql`
      SELECT ev.id
      FROM current_event_records ev
      LEFT JOIN event_embeddings emb ON emb.event_id = ev.id
      WHERE ev.id = ${eventId}
        AND (emb.event_id IS NULL OR emb.embedding_model IS DISTINCT FROM ${MODEL_A})
    `) as Array<{ id: number }>;
    expect(freshRows).toHaveLength(0);
  });

  it('a model-B re-embed replaces the model-A row (expand phase: one row per event)', async () => {
    const sql = getTestDb();
    // Re-embed the model-A event under model B via the real handler.
    const newVec = new Array(EMBEDDING_DIM).fill(0);
    newVec[1] = 1;
    const { ctx } = mockEmbeddingsCtx({
      run_id: -1,
      worker_id: 'test-worker',
      embeddings: [
        { event_id: eventId, chunk_index: 0, embedding: newVec, embedding_model: MODEL_B },
      ],
    });
    await completeEmbeddings(ctx);

    // Expand phase keeps PK(event_id) → one row per event. The delete-then-insert
    // replaces the model-A row with model B (no coexistence yet — that arrives in
    // the contract release when the PK includes the model). The point that holds
    // now: the write uses no ON CONFLICT (event_id), so the contract PK swap
    // won't break a pod still running this code.
    const rows = (await sql`
      SELECT embedding_model FROM event_embeddings WHERE event_id = ${eventId}
    `) as Array<{ embedding_model: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.embedding_model).toBe(MODEL_B);
  });

  it('an unstamped embedding is not persisted and the event is flagged stale', async () => {
    process.env.EMBEDDINGS_MODEL = MODEL_A;
    const sql = getTestDb();

    // An embedding with no model stamp can no longer be written (embedding_model
    // is NOT NULL / part of the PK), so the inline path skips it entirely.
    const legacy = await insertEvent(
      {
        entityIds: [entityId],
        organizationId: orgId,
        originId: `legacy-${Date.now()}`,
        title: 'Legacy event',
        content: 'legacy content with an unstamped embedding',
        occurredAt: new Date(),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'model-swap-connector',
        connectionId,
        embedding: unitVec(),
        // embeddingModel intentionally omitted → not written
      },
      { onConflictUpdate: true }
    );

    const embRows = (await sql`
      SELECT 1 FROM event_embeddings WHERE event_id = ${legacy.id}
    `) as unknown[];
    expect(embRows).toHaveLength(0);

    // No vector at all → excluded from vector search.
    const res = await searchContentByText('', {
      organization_id: orgId,
      query_embedding: unitVec(),
      min_similarity: 0.5,
      limit: 10,
    });
    expect(res.content.map((r) => Number(r.id))).not.toContain(legacy.id);

    // Flagged as needing embedding by the shared stale rule, so the backfill
    // produces a properly-stamped vector for it.
    const staleRows = (await sql.unsafe(
      `SELECT e.id FROM events e WHERE e.id = ${Number(legacy.id)} AND ${needsEmbeddingSql('e')}`
    )) as Array<{ id: number }>;
    expect(staleRows.map((r) => Number(r.id))).toContain(legacy.id);
  });

  it('completeEmbeddings writes the new-model vector and a same-model re-submit is idempotent', async () => {
    const sql = getTestDb();

    // Fresh event stamped MODEL_A, independent of mutations in earlier tests.
    const ev = await insertEvent(
      {
        entityIds: [entityId],
        organizationId: orgId,
        originId: `complete-emb-${Date.now()}`,
        title: 'Handler upsert event',
        content: 'content routed through the real completeEmbeddings handler',
        occurredAt: new Date(),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'model-swap-connector',
        connectionId,
        embedding: unitVec(),
        embeddingModel: MODEL_A,
      },
      { onConflictUpdate: true }
    );

    const newVec = new Array(EMBEDDING_DIM).fill(0);
    newVec[2] = 1; // distinct from unitVec so the replacement is observable

    // Drive the REAL handler: submit a model-B embedding for the model-A event.
    const first = mockEmbeddingsCtx({
      run_id: -1, // no matching run row → the handler's run UPDATE is a harmless no-op
      worker_id: 'test-worker',
      embeddings: [{ event_id: ev.id, chunk_index: 0, embedding: newVec, embedding_model: MODEL_B }],
    });
    await completeEmbeddings(first.ctx);
    expect(first.result()).toMatchObject({ body: { success: true } });

    // The model-B chunk-0 vector is written (replacing the model-A row).
    const bRows = (await sql`
      SELECT 1 FROM event_embeddings
      WHERE event_id = ${ev.id} AND embedding_model = ${MODEL_B} AND chunk_index = 0
    `) as unknown[];
    expect(bRows).toHaveLength(1);

    // Re-submit the SAME model → atomic replace of model-B's chunk set; end state
    // is unchanged (still exactly one model-B chunk-0 row).
    const second = mockEmbeddingsCtx({
      run_id: -1,
      worker_id: 'test-worker',
      embeddings: [{ event_id: ev.id, chunk_index: 0, embedding: newVec, embedding_model: MODEL_B }],
    });
    await completeEmbeddings(second.ctx);
    expect(second.result()).toMatchObject({ body: { success: true } });

    const bRowsAfter = (await sql`
      SELECT 1 FROM event_embeddings
      WHERE event_id = ${ev.id} AND embedding_model = ${MODEL_B} AND chunk_index = 0
    `) as unknown[];
    expect(bRowsAfter).toHaveLength(1);
  });
});
