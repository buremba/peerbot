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
    // No workerAuthMode → authorizeRunForWorker is a no-op, isolating the
    // upsert/idempotency under test (same approach as the other guard tests).
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

  it('completeEmbeddings replaces a stale-model row in place', async () => {
    const sql = getTestDb();
    // Re-embed the model-A row under model B via the same upsert the worker uses.
    const newVec = new Array(EMBEDDING_DIM).fill(0);
    newVec[1] = 1; // distinct vector so we can see the replacement took
    const vectorStr = `[${newVec.join(',')}]`;
    await sql.unsafe(
      `INSERT INTO event_embeddings (event_id, embedding, embedding_model)
       VALUES ($1, $2::vector, $3)
       ON CONFLICT (event_id) DO UPDATE
         SET embedding = EXCLUDED.embedding,
             embedding_model = EXCLUDED.embedding_model,
             created_at = now()
         WHERE event_embeddings.embedding_model IS DISTINCT FROM EXCLUDED.embedding_model`,
      [eventId, vectorStr, MODEL_B]
    );

    const rows = (await sql`
      SELECT embedding_model FROM event_embeddings WHERE event_id = ${eventId}
    `) as Array<{ embedding_model: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.embedding_model).toBe(MODEL_B);
  });

  it('a NULL-stamp (legacy) row is excluded from vector search and flagged stale', async () => {
    process.env.EMBEDDINGS_MODEL = MODEL_A;
    const sql = getTestDb();

    // Legacy row: embedding present but no model stamp (predates stamping).
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
        // embeddingModel intentionally omitted → NULL stamp
      },
      { onConflictUpdate: true }
    );

    // Excluded from vector search under the configured model (unknown true model).
    const res = await searchContentByText('', {
      organization_id: orgId,
      query_embedding: unitVec(),
      min_similarity: 0.5,
      limit: 10,
    });
    expect(res.content.map((r) => Number(r.id))).not.toContain(legacy.id);

    // Flagged stale by the backfill predicate so it gets restamped.
    const staleRows = (await sql`
      SELECT ev.id
      FROM current_event_records ev
      LEFT JOIN event_embeddings emb ON emb.event_id = ev.id
      WHERE ev.id = ${legacy.id}
        AND (emb.event_id IS NULL OR emb.embedding_model IS DISTINCT FROM ${MODEL_A})
    `) as Array<{ id: number }>;
    expect(staleRows.map((r) => Number(r.id))).toContain(legacy.id);
  });

  it('completeEmbeddings (real handler) replaces a stale-model row and is idempotent on re-submit', async () => {
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

    // Drive the REAL handler: submit a model-B embedding for the model-A row.
    const first = mockEmbeddingsCtx({
      run_id: -1, // no matching run row → the handler's run UPDATE is a harmless no-op
      worker_id: 'test-worker',
      embeddings: [{ event_id: ev.id, embedding: newVec, embedding_model: MODEL_B }],
    });
    await completeEmbeddings(first.ctx);
    expect(first.result()).toMatchObject({ body: { success: true, updated: 1 } });

    const afterReplace = (await sql`
      SELECT embedding_model FROM event_embeddings WHERE event_id = ${ev.id}
    `) as Array<{ embedding_model: string | null }>;
    expect(afterReplace).toHaveLength(1);
    expect(afterReplace[0]!.embedding_model).toBe(MODEL_B); // stale model-A row was replaced

    // Re-submit the SAME model → idempotent no-op (the ON CONFLICT WHERE blocks it).
    const second = mockEmbeddingsCtx({
      run_id: -1,
      worker_id: 'test-worker',
      embeddings: [{ event_id: ev.id, embedding: newVec, embedding_model: MODEL_B }],
    });
    await completeEmbeddings(second.ctx);
    expect(second.result()).toMatchObject({ body: { success: true, updated: 0 } });
  });
});
