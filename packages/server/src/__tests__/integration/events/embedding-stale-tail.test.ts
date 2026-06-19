/**
 * Stale-detection tail arm (multi-vector embeddings).
 *
 * `needsEmbeddingSql` must re-queue long content that only has a chunk-0 vector
 * (embedded before chunking, or written by the inline single-vector path) so the
 * backfill re-chunks it. The arm must be self-terminating: once any tail chunk
 * (index >= 1) exists, the event is no longer stale — otherwise long events
 * would re-queue forever.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { needsEmbeddingSql } from '../../../utils/embeddings';
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
const MODEL = 'Xenova/bge-base-en-v1.5';

function basisVec(i: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[i] = 1;
  return v;
}

// Over the 2000-char model window → the tail arm applies.
const LONG_CONTENT = 'Sentence about the renewal and the team. '.repeat(60);
// Comfortably under the window → arm never applies (chunk-0 is enough).
const SHORT_CONTENT = 'A short note.';

describe('needsEmbeddingSql: long-content tail arm', () => {
  let orgId: string;
  let connectionId: number;
  let longEventId: number;
  let shortEventId: number;
  let originalModel: string | undefined;

  async function isStale(eventId: number): Promise<boolean> {
    const sql = getTestDb();
    const rows = await sql.unsafe(
      `SELECT EXISTS (
         SELECT 1 FROM events e WHERE e.id = $1 AND ${needsEmbeddingSql('e')}
       ) AS stale`,
      [eventId]
    );
    return Boolean((rows[0] as { stale: boolean }).stale);
  }

  beforeAll(async () => {
    originalModel = process.env.EMBEDDINGS_MODEL;
    process.env.EMBEDDINGS_MODEL = MODEL;

    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const org = await createTestOrganization({ name: 'Stale Tail Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'stale-tail-test@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const entity = await createTestEntity({ name: 'Stale Target', organization_id: org.id });
    await createTestConnectorDefinition({ key: 'st-connector', name: 'ST', organization_id: org.id });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'st-connector',
      entity_ids: [entity.id],
    });
    connectionId = connection.id;

    const long = await insertEvent(
      {
        entityIds: [entity.id],
        organizationId: orgId,
        originId: `st-long-${Date.now()}`,
        title: 'Long note',
        content: LONG_CONTENT,
        occurredAt: new Date(),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'st-connector',
        connectionId,
        embedding: basisVec(0),
        embeddingModel: MODEL,
      },
      { onConflictUpdate: true }
    );
    longEventId = long.id;

    const short = await insertEvent(
      {
        entityIds: [entity.id],
        organizationId: orgId,
        originId: `st-short-${Date.now()}`,
        title: 'Short note',
        content: SHORT_CONTENT,
        occurredAt: new Date(),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'st-connector',
        connectionId,
        embedding: basisVec(1),
        embeddingModel: MODEL,
      },
      { onConflictUpdate: true }
    );
    shortEventId = short.id;
  });

  it('flags long content that only has a chunk-0 vector as stale', async () => {
    expect(await isStale(longEventId)).toBe(true);
  });

  it('does not flag short content with a chunk-0 vector', async () => {
    expect(await isStale(shortEventId)).toBe(false);
  });

  it('stops flagging the long event once a tail chunk (index >= 1) exists', async () => {
    const sql = getTestDb();
    await sql.unsafe(
      `INSERT INTO event_embeddings (event_id, chunk_index, embedding, embedding_model)
       VALUES ($1, 1, $2::vector, $3)
       ON CONFLICT (event_id, embedding_model, chunk_index) DO UPDATE
         SET embedding = EXCLUDED.embedding`,
      [longEventId, `[${basisVec(2).join(',')}]`, MODEL]
    );
    expect(await isStale(longEventId)).toBe(false);
  });
});
