/**
 * Issue #3066 reproducer: superseding an event must reclaim its vectors.
 *
 * Nothing used to remove a superseded event's `event_embeddings` rows — both
 * DELETE sites key on the row's OWN `event_id` before rewriting its vector, so
 * the predecessor's vector survived forever. Vector retrieval excludes
 * superseded events, yet `idx_events_embedding` is a plain ivfflat over the
 * whole table with no partial predicate, so the unreachable vectors can consume
 * ANN scan budget.
 *
 * The cases cover both supersede entry points, late worker completion, and the
 * transaction interleaving between completion and supersede.
 */

import type { Context } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
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
const MODEL = 'Xenova/bge-base-en-v1.5';
const OTHER_MODEL = 'test/replacement-768d';

function unitVec(seed: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[seed % EMBEDDING_DIM] = 1;
  return v;
}

// Minimal Hono Context: completeEmbeddings only reads the JSON body, calls
// c.json(), and consults c.var.workerAuthMode (no-op unless 'user').
function mockEmbeddingsCtx(body: unknown): Context<{ Bindings: Env }> {
  return {
    req: { json: async () => body },
    var: {},
    json: (b: unknown, status?: number) => ({ b, status }) as unknown as Response,
  } as unknown as Context<{ Bindings: Env }>;
}

async function vectorRowsFor(eventId: number) {
  const sql = getTestDb();
  return (await sql`
    SELECT embedding_model, chunk_index
    FROM event_embeddings
    WHERE event_id = ${eventId}
    ORDER BY embedding_model, chunk_index
  `) as Array<{ embedding_model: string; chunk_index: number }>;
}

// Both embedding writers lock liveness before touching event_embeddings:
// completion uses FOR SHARE, while insertEvent uses FOR NO KEY UPDATE because
// it may later update volatile event state. Either SELECT or — if the lock were
// dropped — the DELETE behind it must be waiting on `blockingPid`. Accept all
// three forms so a regression reaches the row assertion instead of dying here
// with a misleading timeout.
async function waitForBlockedEmbeddingWriter(
  sql: ReturnType<typeof getTestDb>,
  blockingPid: number,
  writer: string,
  isSettled: () => boolean,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isSettled()) {
      throw new Error(`embedding ${writer} passed an in-flight supersede`);
    }
    const [row] = await sql<{ count: number }>`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND (
          query ILIKE '%DELETE FROM event_embeddings%'
          OR (
            query ILIKE '%FROM events%'
            AND query ILIKE '%superseded_by IS NULL%'
            AND (
              query ILIKE '%FOR SHARE%'
              OR query ILIKE '%FOR NO KEY UPDATE%'
            )
          )
        )
        AND ${blockingPid} = ANY(pg_blocking_pids(pid))
    `;
    if ((row?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`embedding ${writer} never blocked behind the supersede`);
}

describe('supersede reclaims event_embeddings (issue #3066)', () => {
  let orgId: string;
  let entityId: number;
  let connectionId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const org = await createTestOrganization({ name: 'Vector Reclaim Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'vector-reclaim-test@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const entity = await createTestEntity({ name: 'Reclaim Target', organization_id: org.id });
    entityId = entity.id;

    await createTestConnectorDefinition({
      key: 'vector-reclaim-connector',
      name: 'Vector Reclaim',
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'vector-reclaim-connector',
      entity_ids: [entity.id],
    });
    connectionId = connection.id;
  });

  it('drops every model and every chunk of the predecessor on the dedup supersede path', async () => {
    const sql = getTestDb();
    const originId = `reclaim-dedup-${Date.now()}`;

    const first = await insertEvent(
      {
        entityIds: [entityId],
        organizationId: orgId,
        originId,
        title: 'v1',
        content: 'first version of the content',
        occurredAt: new Date(),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'vector-reclaim-connector',
        connectionId,
        embedding: unitVec(1),
        embeddingModel: MODEL,
      },
      { onConflictUpdate: true }
    );

    // A real backfill writes N chunks per (event, model) and old/new models
    // coexist during a swap. The reclaim must take all of them, not just the
    // configured model's chunk 0.
    await sql`
      INSERT INTO event_embeddings (event_id, chunk_index, embedding, embedding_model)
      VALUES
        (${first.id}, 1, ${`[${unitVec(2).join(',')}]`}::vector, ${MODEL}),
        (${first.id}, 0, ${`[${unitVec(3).join(',')}]`}::vector, ${OTHER_MODEL})
    `;
    expect(await vectorRowsFor(first.id)).toHaveLength(3);

    const second = await insertEvent(
      {
        entityIds: [entityId],
        organizationId: orgId,
        originId,
        title: 'v2',
        content: 'second version of the content',
        occurredAt: new Date(),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'vector-reclaim-connector',
        connectionId,
        embedding: unitVec(4),
        embeddingModel: MODEL,
      },
      { onConflictUpdate: true }
    );

    expect(second.change).toBe('superseded');
    expect(second.id).not.toBe(first.id);

    expect(await vectorRowsFor(first.id)).toEqual([]);
    expect(await vectorRowsFor(second.id)).toEqual([{ embedding_model: MODEL, chunk_index: 0 }]);

    // The ledger itself is untouched: the predecessor row still exists, stamped.
    const [ledger] = (await sql`
      SELECT id, payload_text, superseded_by FROM events WHERE id = ${first.id}
    `) as Array<{
      id: string | number;
      payload_text: string | null;
      superseded_by: string | number | null;
    }>;
    expect(ledger).toBeDefined();
    expect(ledger!.payload_text).toBe('first version of the content');
    expect(Number(ledger!.superseded_by)).toBe(Number(second.id));
    const [successor] = (await sql`
      SELECT supersedes_event_id FROM events WHERE id = ${second.id}
    `) as Array<{ supersedes_event_id: string | number | null }>;
    expect(Number(successor!.supersedes_event_id)).toBe(Number(first.id));
  });

  it('drops the predecessor on the explicit supersedesEventId path', async () => {
    const first = await insertEvent({
      entityIds: [entityId],
      organizationId: orgId,
      originId: `reclaim-explicit-${Date.now()}`,
      title: 'explicit v1',
      content: 'explicit first version',
      occurredAt: new Date(),
      semanticType: 'content',
      originType: 'content',
      connectorKey: 'vector-reclaim-connector',
      connectionId,
      embedding: unitVec(5),
      embeddingModel: MODEL,
    });
    expect(await vectorRowsFor(first.id)).toHaveLength(1);

    const second = await insertEvent({
      entityIds: [entityId],
      organizationId: orgId,
      originId: `reclaim-explicit-v2-${Date.now()}`,
      title: 'explicit v2',
      content: 'explicit second version',
      occurredAt: new Date(),
      semanticType: 'content',
      originType: 'content',
      connectorKey: 'vector-reclaim-connector',
      connectionId,
      embedding: unitVec(6),
      embeddingModel: MODEL,
      supersedesEventId: first.id,
    });

    expect(second.change).toBe('superseded');
    expect(await vectorRowsFor(first.id)).toEqual([]);
    expect(await vectorRowsFor(second.id)).toEqual([{ embedding_model: MODEL, chunk_index: 0 }]);
  });

  it('does not let a raced embed job re-create a superseded event\'s vector', async () => {
    // The backfill selects live events, but the event can be superseded between
    // selection and the worker reporting its vector. Without a completion-time
    // liveness guard the dead row comes straight back.
    const originId = `reclaim-race-${Date.now()}`;
    const first = await insertEvent(
      {
        entityIds: [entityId],
        organizationId: orgId,
        originId,
        title: 'race v1',
        content: 'race first version',
        occurredAt: new Date(),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'vector-reclaim-connector',
        connectionId,
      },
      { onConflictUpdate: true }
    );
    const second = await insertEvent(
      {
        entityIds: [entityId],
        organizationId: orgId,
        originId,
        title: 'race v2',
        content: 'race second version',
        occurredAt: new Date(),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'vector-reclaim-connector',
        connectionId,
      },
      { onConflictUpdate: true }
    );
    expect(second.change).toBe('superseded');

    await completeEmbeddings(
      mockEmbeddingsCtx({
        run_id: -1,
        worker_id: 'test-worker',
        embeddings: [
          { event_id: first.id, chunk_index: 0, embedding: unitVec(8), embedding_model: MODEL },
          { event_id: second.id, chunk_index: 0, embedding: unitVec(9), embedding_model: MODEL },
        ],
      })
    );

    expect(await vectorRowsFor(first.id)).toEqual([]);
    expect(await vectorRowsFor(second.id)).toEqual([{ embedding_model: MODEL, chunk_index: 0 }]);
  });

  it('serializes embedding completion with an in-flight supersede', async () => {
    const sql = getTestDb();
    const first = await insertEvent({
      entityIds: [entityId],
      organizationId: orgId,
      originId: `reclaim-concurrent-v1-${Date.now()}`,
      title: 'concurrent v1',
      content: 'concurrent first version',
      occurredAt: new Date(),
      semanticType: 'content',
      originType: 'content',
      connectorKey: 'vector-reclaim-connector',
      connectionId,
    });

    let supersedeStarted!: () => void;
    const supersedeHasRowLock = new Promise<void>((resolve) => {
      supersedeStarted = resolve;
    });
    let releaseSupersede!: () => void;
    const supersedeMayCommit = new Promise<void>((resolve) => {
      releaseSupersede = resolve;
    });
    let supersederPid = 0;
    const superseding = insertEvent(
      {
        entityIds: [entityId],
        organizationId: orgId,
        originId: `reclaim-concurrent-v2-${Date.now()}`,
        title: 'concurrent v2',
        content: 'concurrent second version',
        occurredAt: new Date(),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'vector-reclaim-connector',
        connectionId,
        supersedesEventId: first.id,
      },
      {
        afterPersist: async (_event, tx) => {
          const [backend] = await tx<{ pid: number | string }>`SELECT pg_backend_pid()::int AS pid`;
          supersederPid = Number(backend!.pid);
          supersedeStarted();
          await supersedeMayCommit;
        },
      }
    );
    await supersedeHasRowLock;

    const completing = completeEmbeddings(
      mockEmbeddingsCtx({
        run_id: -1,
        worker_id: 'test-worker',
        embeddings: [
          { event_id: first.id, chunk_index: 0, embedding: unitVec(10), embedding_model: MODEL },
        ],
      })
    );
    let completionSettled = false;
    void completing.then(
      () => {
        completionSettled = true;
      },
      () => {
        completionSettled = true;
      }
    );
    try {
      await waitForBlockedEmbeddingWriter(
        sql,
        supersederPid,
        'completion',
        () => completionSettled
      );
    } finally {
      releaseSupersede();
      await Promise.allSettled([superseding, completing]);
    }
    await Promise.all([superseding, completing]);

    expect(await vectorRowsFor(first.id)).toEqual([]);
  });

  it('does not let an unchanged-content refresh re-create a superseded event\'s vector', async () => {
    const sql = getTestDb();
    const originId = `reclaim-refresh-race-${Date.now()}`;
    const occurredAt = new Date();
    const firstParams = {
      entityIds: [entityId],
      organizationId: orgId,
      originId,
      title: 'refresh race v1',
      content: 'unchanged content whose embedding is refreshed',
      occurredAt,
      semanticType: 'content' as const,
      originType: 'content',
      connectorKey: 'vector-reclaim-connector',
      connectionId,
      embedding: unitVec(11),
      embeddingModel: MODEL,
    };
    const first = await insertEvent(firstParams, { onConflictUpdate: true });

    let supersedeStarted!: () => void;
    const supersedeHasDeletedVector = new Promise<void>((resolve) => {
      supersedeStarted = resolve;
    });
    let releaseSupersede!: () => void;
    const supersedeMayCommit = new Promise<void>((resolve) => {
      releaseSupersede = resolve;
    });
    let supersederPid = 0;
    const superseding = insertEvent(
      {
        entityIds: [entityId],
        organizationId: orgId,
        originId: `${originId}-v2`,
        title: 'refresh race v2',
        content: 'new content',
        occurredAt: new Date(),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'vector-reclaim-connector',
        connectionId,
        supersedesEventId: first.id,
      },
      {
        afterPersist: async (_event, tx) => {
          const [backend] = await tx<{ pid: number | string }>`SELECT pg_backend_pid()::int AS pid`;
          supersederPid = Number(backend!.pid);
          supersedeStarted();
          await supersedeMayCommit;
        },
      }
    );
    await supersedeHasDeletedVector;

    const refreshing = insertEvent(
      { ...firstParams, embedding: unitVec(12) },
      { onConflictUpdate: true }
    );
    let refreshSettled = false;
    void refreshing.then(
      () => {
        refreshSettled = true;
      },
      () => {
        refreshSettled = true;
      }
    );
    try {
      await waitForBlockedEmbeddingWriter(sql, supersederPid, 'refresh', () => refreshSettled);
    } finally {
      releaseSupersede();
      await Promise.allSettled([superseding, refreshing]);
    }
    await Promise.all([superseding, refreshing]);

    expect(await vectorRowsFor(first.id)).toEqual([]);
  });

  it('does not deadlock a volatile refresh with embedding completion', async () => {
    const sql = getTestDb();
    const originId = `reclaim-writer-deadlock-${Date.now()}`;
    const occurredAt = new Date();
    const firstParams = {
      entityIds: [entityId],
      organizationId: orgId,
      originId,
      title: 'writer deadlock',
      content: 'unchanged content with volatile state',
      occurredAt,
      semanticType: 'content' as const,
      originType: 'content',
      connectorKey: 'vector-reclaim-connector',
      connectionId,
      embedding: unitVec(13),
      embeddingModel: MODEL,
    };
    const first = await insertEvent(firstParams, { onConflictUpdate: true });

    let blockerReady!: () => void;
    const blockerHasVectorLock = new Promise<void>((resolve) => {
      blockerReady = resolve;
    });
    let releaseBlocker!: () => void;
    const blockerMayCommit = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let blockerPid = 0;
    const blocking = sql.begin(async (tx) => {
      const [backend] = await tx<{ pid: number | string }>`SELECT pg_backend_pid()::int AS pid`;
      blockerPid = Number(backend!.pid);
      await tx`
        SELECT event_id
        FROM event_embeddings
        WHERE event_id = ${first.id}
          AND embedding_model = ${MODEL}
        FOR UPDATE
      `;
      blockerReady();
      await blockerMayCommit;
    });
    await blockerHasVectorLock;

    // Queue the refresh first. It holds the event liveness lock while waiting
    // for the vector row, then updates volatile event state after replacing the
    // vector. Completion queues second and must not retain a compatible event
    // lock that turns the refresh's later UPDATE into a lock cycle.
    const refreshing = insertEvent(
      { ...firstParams, score: 1, embedding: unitVec(14) },
      { onConflictUpdate: true }
    );
    let refreshSettled = false;
    void refreshing.then(
      () => {
        refreshSettled = true;
      },
      () => {
        refreshSettled = true;
      }
    );
    await waitForBlockedEmbeddingWriter(sql, blockerPid, 'refresh', () => refreshSettled);

    const completing = completeEmbeddings(
      mockEmbeddingsCtx({
        run_id: -1,
        worker_id: 'test-worker',
        embeddings: [
          { event_id: first.id, chunk_index: 0, embedding: unitVec(15), embedding_model: MODEL },
        ],
      })
    );
    let completionSettled = false;
    void completing.then(
      () => {
        completionSettled = true;
      },
      () => {
        completionSettled = true;
      }
    );
    try {
      await waitForBlockedEmbeddingWriter(
        sql,
        blockerPid,
        'completion',
        () => completionSettled
      );
    } finally {
      releaseBlocker();
      await Promise.allSettled([blocking, refreshing, completing]);
    }

    const [refreshed, completion] = await Promise.all([refreshing, completing]);
    expect(refreshed.change).toBe('state_updated');
    expect(
      (completion as unknown as { b: { success: boolean; updated: number; failed: number } }).b
    ).toMatchObject({ success: true, updated: 1, failed: 0 });
    expect(await vectorRowsFor(first.id)).toEqual([
      { embedding_model: MODEL, chunk_index: 0 },
    ]);
  });

  it('leaves an ordinary insert with no predecessor alone', async () => {
    const inserted = await insertEvent(
      {
        entityIds: [entityId],
        organizationId: orgId,
        originId: `reclaim-plain-${Date.now()}`,
        title: 'plain',
        content: 'a plain insert that supersedes nothing',
        occurredAt: new Date(),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'vector-reclaim-connector',
        connectionId,
        embedding: unitVec(7),
        embeddingModel: MODEL,
      },
      { onConflictUpdate: true }
    );

    expect(inserted.change).toBe('inserted');
    expect(await vectorRowsFor(inserted.id)).toEqual([
      { embedding_model: MODEL, chunk_index: 0 },
    ]);
  });
});
