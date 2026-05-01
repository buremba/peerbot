/**
 * Integration test: searchContentByText supports embedding-only queries.
 *
 * Before the fix, searchContentByText bailed to listContentInternal (which
 * ignores ranking) whenever queryText was missing or too short. That meant
 * callers that had a pre-computed embedding but no text query — notably
 * search_knowledge forwarding args.query_embedding — got unranked recent
 * content instead of cosine-distance semantic matches.
 *
 * Two guarantees under test:
 *   1. With no text + embedding, we get results ranked by cosine distance
 *      and the match target outranks decoys.
 *   2. The SQL does NOT degenerate to `ILIKE '%%'` (match-all): the
 *      LENGTH($1) > 0 guards in textMatchExpr / textRankExpr must fire so
 *      rows without a vector near the query don't slip through.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { searchContentByText } from '../../../utils/content-search';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const EMBEDDING_DIM = 768;

// Three orthogonal unit vectors in 768d — enough separation that cosine
// distance cleanly orders them.
function axisVec(axis: 0 | 1 | 2): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[axis] = 1;
  return v;
}

describe('searchContentByText > embedding-only path', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let matchId: number;
  let farId: number;
  let orthogonalId: number;
  const queryEmbedding = axisVec(0);

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Embedding Search Org' });
    const user = await createTestUser({ email: 'embed-search-test@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    entity = await createTestEntity({ name: 'Target', organization_id: org.id });

    await createTestConnectorDefinition({
      key: 'embed-test-connector',
      name: 'Embed Test',
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'embed-test-connector',
      entity_ids: [entity.id],
    });

    // Exact match — embedding identical to query.
    matchId = (
      await createTestEvent({
        entity_id: entity.id,
        connection_id: connection.id,
        content: 'Quarterly revenue review and forecasts',
        occurred_at: new Date('2025-03-01T10:00:00Z'),
        organization_id: org.id,
        embedding: axisVec(0),
      })
    ).id;

    // Orthogonal embedding — cosine = 0, well below the 0.3 min_similarity.
    orthogonalId = (
      await createTestEvent({
        entity_id: entity.id,
        connection_id: connection.id,
        content: 'Totally unrelated topic about weather',
        occurred_at: new Date('2025-03-02T10:00:00Z'),
        organization_id: org.id,
        embedding: axisVec(1),
      })
    ).id;

    // Another orthogonal decoy on the third axis.
    farId = (
      await createTestEvent({
        entity_id: entity.id,
        connection_id: connection.id,
        content: 'Another unrelated message',
        occurred_at: new Date('2025-03-03T10:00:00Z'),
        organization_id: org.id,
        embedding: axisVec(2),
      })
    ).id;
  });

  it('returns cosine-ranked results when only query_embedding is supplied', async () => {
    const result = await searchContentByText(null, {
      organization_id: org.id,
      limit: 10,
      min_similarity: 0.3,
      query_embedding: queryEmbedding,
      sort_by: 'score',
    });

    // The matching event must be present; the orthogonal decoys must be
    // excluded by the 0.3 similarity floor (cosine = 0 for orthogonal vectors).
    const ids = result.content.map((c) => c.id);
    expect(ids).toContain(matchId);
    expect(ids).not.toContain(orthogonalId);
    expect(ids).not.toContain(farId);

    const match = result.content.find((c) => c.id === matchId);
    expect(match?.similarity).toBeCloseTo(1, 5);
  });

  it('does not degenerate to match-all when text is empty', async () => {
    // Sanity: if the LENGTH($1) > 0 guard were missing, ILIKE '%%' would
    // match all three events regardless of vector similarity. Asserting
    // exactly one result (the true match) proves the guard is firing.
    const result = await searchContentByText(null, {
      organization_id: org.id,
      limit: 10,
      min_similarity: 0.3,
      query_embedding: queryEmbedding,
      sort_by: 'score',
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].id).toBe(matchId);
  });

  it('falls back to listContentInternal when neither text nor embedding given', async () => {
    // No embedding + no text → listContentInternal (unranked listing).
    // All three events should come back because there's no filter.
    const sql = getTestDb();
    await sql`SELECT 1`; // warm the pool; ensures fixture state is committed

    const result = await searchContentByText(null, {
      organization_id: org.id,
      limit: 10,
    });

    const ids = result.content.map((c) => c.id).sort();
    expect(ids).toEqual([matchId, orthogonalId, farId].sort());
  });
});
