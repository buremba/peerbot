/**
 * Finding #3 reproducer (part b): the embedding model/version stamp is
 * persisted on event_embeddings.
 *
 * Before the fix, event_embeddings had no model column and insertEvent
 * discarded any stamp, so swapping EMBEDDINGS_MODEL to a different
 * same-dimension model silently mixed incompatible vector spaces with no
 * record of which model produced which row. This drives the production
 * insertEvent path with an embeddingModel and asserts it round-trips into
 * event_embeddings.embedding_model.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { insertEvent } from '../../../utils/insert-event';
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

function unitVec(): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
}

describe('event_embeddings model stamp (Finding #3)', () => {
  let orgId: string;
  let entityId: number;
  let connectionId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const org = await createTestOrganization({ name: 'Embedding Stamp Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'embed-stamp-test@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const entity = await createTestEntity({ name: 'Stamp Target', organization_id: org.id });
    entityId = entity.id;

    await createTestConnectorDefinition({
      key: 'embed-stamp-connector',
      name: 'Embed Stamp',
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'embed-stamp-connector',
      entity_ids: [entity.id],
    });
    connectionId = connection.id;
  });

  it('persists embedding_model alongside the vector', async () => {
    const inserted = await insertEvent(
      {
        entityIds: [entityId],
        organizationId: orgId,
        originId: `stamp-${Date.now()}`,
        title: 'Stamped event',
        content: 'content with an embedding',
        occurredAt: new Date(),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'embed-stamp-connector',
        connectionId,
        embedding: unitVec(),
        embeddingModel: 'Xenova/bge-base-en-v1.5',
      },
      { onConflictUpdate: true }
    );

    const sql = getTestDb();
    const rows = (await sql`
      SELECT embedding_model FROM event_embeddings WHERE event_id = ${inserted.id}
    `) as Array<{ embedding_model: string | null }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.embedding_model).toBe('Xenova/bge-base-en-v1.5');
  });

  it('does NOT persist an embedding when no model stamp is supplied', async () => {
    // Multi-vector: embedding_model is part of the PK (NOT NULL), so an unstamped
    // vector can no longer be written. An unstamped vector is unusable anyway —
    // vector search scopes comparison to the configured model — so the inline
    // path skips it and the embed backfill produces a properly-stamped (and, for
    // long content, chunked) set instead. This replaces the old "NULL stamp
    // legacy row" behaviour.
    const inserted = await insertEvent(
      {
        entityIds: [entityId],
        organizationId: orgId,
        originId: `nostamp-${Date.now()}`,
        title: 'Unstamped event',
        content: 'content with an embedding but no model',
        occurredAt: new Date(),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'embed-stamp-connector',
        connectionId,
        embedding: unitVec(),
      },
      { onConflictUpdate: true }
    );

    const sql = getTestDb();
    const rows = (await sql`
      SELECT embedding_model FROM event_embeddings WHERE event_id = ${inserted.id}
    `) as Array<{ embedding_model: string | null }>;

    expect(rows).toHaveLength(0);
  });
});
