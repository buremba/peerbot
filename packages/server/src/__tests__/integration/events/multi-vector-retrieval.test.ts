/**
 * Multi-vector retrieval reproducer (the bug this change fixes).
 *
 * The embedder only encodes ~512 tokens, so a long memory's tail never enters
 * its single vector and is invisible to vector search. With multi-vector
 * embeddings, the tail gets its own chunk vector; search ranks the event by its
 * BEST chunk and returns the whole parent event ("retrieve small, return big").
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { searchContentByText } from '../../../utils/content-search';
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
const headVec = basisVec(0);
const tailVec = basisVec(1);

const FULL_CONTENT =
  'Intro paragraph about the kickoff meeting and the team. ' +
  'A lot of middle filler that the head vector represents. '.repeat(40) +
  'TAIL FACT: the renewal date was moved to November 2026.';

describe('multi-vector retrieval: long-memory tail', () => {
  let orgId: string;
  let connectionId: number;
  let eventId: number;
  let originalModel: string | undefined;

  beforeAll(async () => {
    originalModel = process.env.EMBEDDINGS_MODEL;
    process.env.EMBEDDINGS_MODEL = MODEL;

    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const org = await createTestOrganization({ name: 'Multi-Vector Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'multivec-test@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const entity = await createTestEntity({ name: 'MV Target', organization_id: org.id });

    await createTestConnectorDefinition({
      key: 'mv-connector',
      name: 'MV',
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'mv-connector',
      entity_ids: [entity.id],
    });
    connectionId = connection.id;

    const inserted = await insertEvent(
      {
        entityIds: [entity.id],
        organizationId: orgId,
        originId: `mv-${Date.now()}`,
        title: 'Long account note',
        content: FULL_CONTENT,
        occurredAt: new Date(),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'mv-connector',
        connectionId,
        embedding: headVec,
        embeddingModel: MODEL,
      },
      { onConflictUpdate: true }
    );
    eventId = inserted.id;
  });

  function tailQuery() {
    return searchContentByText('', {
      organization_id: orgId,
      query_embedding: tailVec,
      min_similarity: 0.5,
      limit: 10,
      approximate_candidate_search: true,
    });
  }

  it('RED: the tail is unreachable while only the head chunk is embedded', async () => {
    const res = await tailQuery();
    expect(res.content.map((r) => Number(r.id))).not.toContain(eventId);
  });

  it('GREEN: adding the tail chunk makes the event retrievable, returning the full parent', async () => {
    const sql = getTestDb();
    await sql.unsafe(
      `INSERT INTO event_embeddings (event_id, chunk_index, embedding, embedding_model)
       VALUES ($1, 1, $2::vector, $3)
       ON CONFLICT (event_id, embedding_model, chunk_index) DO UPDATE
         SET embedding = EXCLUDED.embedding`,
      [eventId, `[${tailVec.join(',')}]`, MODEL]
    );

    const res = await tailQuery();
    const hit = res.content.find((r) => Number(r.id) === eventId);
    expect(hit).toBeDefined();
    expect(hit!.text_content ?? (hit as { payload_text?: string }).payload_text).toContain(
      'TAIL FACT'
    );
  });

  it('cleanup restores EMBEDDINGS_MODEL', () => {
    if (originalModel === undefined) delete process.env.EMBEDDINGS_MODEL;
    else process.env.EMBEDDINGS_MODEL = originalModel;
  });
});