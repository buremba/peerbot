/**
 * Tenancy scoping for the parent-context join in fetchTargetContent.
 *
 * `classification-query.ts` blends a parent event's vector into the child's at
 * PARENT_EMBEDDING_WEIGHT (0.3) before classifying. The parent was resolved as
 *
 *   LEFT JOIN current_event_records parent ON parent.origin_id = f.origin_parent_id
 *
 * with no tenancy predicate at all — while `f` itself is org-scoped. `origin_id`
 * is the connector's own identifier and is NOT unique across tenants: a GitHub
 * node id or Hacker News item id is the same string in every organization that
 * syncs it. Prod carried 1,118 live cross-ORG parent matches (942 of them GitHub,
 * every one with a chunk-0 vector) and 25,099 same-org cross-CONNECTION matches,
 * so this join really did feed another tenant's vector into a classification.
 *
 * Vectors are 768-dim one-hot basis vectors, so every cosine here is exact:
 *   unblended child basis(0)          → cosine 1.0 vs `positive`
 *   blended 0.7*basis(0)+0.3*basis(1) → 0.7/sqrt(0.58) = 0.9191
 * The two are distinguishable to 4dp, which is what `embedding_confidence` stores.
 *
 * The "still blends" case is load-bearing: scoping the join by connection alone
 * would silently drop parent context for the 38,764 prod rows (17% of all
 * parent-referencing rows) whose connection_id is NULL, so NULL must still match
 * NULL within one organization.
 */

import { describe, expect, it } from 'vitest';
import { executeClassificationQuery } from '../../../utils/classification-query';
import { getConfiguredEmbeddingModel } from '../../../utils/embeddings';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const DIM = 768;
/** Cosine of 0.7*basis(0)+0.3*basis(1) against basis(0) — i.e. a blended parent. */
const BLENDED_CONFIDENCE = 0.9191;

function basisVector(slot: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[slot] = 1;
  return v;
}

async function seedFacet(opts: { orgId: string; createdBy: string; slug: string }): Promise<number> {
  const sql = getTestDb();
  const embedding_model = getConfiguredEmbeddingModel();
  const attributeValues = {
    positive: { embedding: basisVector(0), embedding_model },
    negative: { embedding: basisVector(1), embedding_model },
  };
  const [row] = (await sql`
    INSERT INTO classify_facet (
      organization_id, slug, name, attribute_key, status, created_by,
      automation_id, entity_ids, min_similarity, fallback_value, attribute_values
    ) VALUES (
      ${opts.orgId}, ${opts.slug}, ${`${opts.slug} classifier`}, ${opts.slug}, 'active', ${opts.createdBy},
      NULL, NULL, 0.5, 'unknown', ${sql.json(attributeValues as never)}
    )
    RETURNING id
  `) as Array<{ id: number }>;
  return Number(row.id);
}

/** `createTestEvent` has no origin_parent_id parameter; set it directly. */
async function setParent(eventId: number, parentOriginId: string): Promise<void> {
  const sql = getTestDb();
  await sql`UPDATE events SET origin_parent_id = ${parentOriginId} WHERE id = ${eventId}`;
}

async function confidenceFor(eventId: number, facetId: number): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT embedding_confidence::text AS conf
    FROM event_classifications
    WHERE event_id = ${eventId} AND classifier_id = ${facetId} AND source = 'embedding'
  `) as Array<{ conf: string }>;
  expect(rows).toHaveLength(1);
  return Number(rows[0].conf);
}

describe('classification parent-context join is tenancy-scoped', () => {
  it('does not blend a parent belonging to another organization', async () => {
    await cleanupTestDatabase();
    const orgA = await createTestOrganization({ name: 'Parent Scope A' });
    const orgB = await createTestOrganization({ name: 'Parent Scope B' });
    const user = await createTestUser({ email: 'parent-scope@test.com' });
    const facetId = await seedFacet({ orgId: orgA.id, createdBy: user.id, slug: 'ps-cross-org' });

    // The colliding id — the same string both tenants would see from GitHub.
    const sharedOriginId = 'gh-node-shared-1';

    // Org B owns the only event carrying that origin_id, and it leans `negative`.
    await createTestEvent({
      organization_id: orgB.id,
      origin_id: sharedOriginId,
      content: 'other tenant parent',
      embedding: basisVector(1),
    });

    // Org A's child points at it by origin id but owns no such parent itself.
    const child = await createTestEvent({
      organization_id: orgA.id,
      content: 'excellent and amazing',
      embedding: basisVector(0),
    });
    await setParent(Number(child.id), sharedOriginId);

    await executeClassificationQuery({
      mode: 'content_ids',
      organizationId: orgA.id,
      enabledClassifiers: ['ps-cross-org'],
      content_ids: [Number(child.id)],
    });

    // Org A has no parent of its own, so the child vector must be used as-is.
    // Before the fix this read 0.9191 — org B's vector blended in at 0.3.
    expect(await confidenceFor(Number(child.id), facetId)).toBeCloseTo(1.0, 3);
  });

  it('does not blend a parent from a different connection in the same organization', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Parent Scope Conn' });
    const user = await createTestUser({ email: 'parent-scope-conn@test.com' });
    const facetId = await seedFacet({ orgId: org.id, createdBy: user.id, slug: 'ps-cross-conn' });

    const connA = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      created_by: user.id,
    });
    const connB = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      created_by: user.id,
    });

    const sharedOriginId = 'gh-node-shared-2';
    await createTestEvent({
      organization_id: org.id,
      connection_id: Number(connB.id),
      origin_id: sharedOriginId,
      content: 'other connection parent',
      embedding: basisVector(1),
    });

    const child = await createTestEvent({
      organization_id: org.id,
      connection_id: Number(connA.id),
      content: 'excellent and amazing',
      embedding: basisVector(0),
    });
    await setParent(Number(child.id), sharedOriginId);

    await executeClassificationQuery({
      mode: 'content_ids',
      organizationId: org.id,
      enabledClassifiers: ['ps-cross-conn'],
      content_ids: [Number(child.id)],
    });

    expect(await confidenceFor(Number(child.id), facetId)).toBeCloseTo(1.0, 3);
  });

  it('still blends a parent in the same organization and connection', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Parent Scope Same' });
    const user = await createTestUser({ email: 'parent-scope-same@test.com' });
    const facetId = await seedFacet({ orgId: org.id, createdBy: user.id, slug: 'ps-same' });

    // Both rows leave connection_id NULL — the 17% of prod parent-referencing
    // rows that a connection-equality join would strand without parent context.
    const sharedOriginId = 'gh-node-shared-3';
    await createTestEvent({
      organization_id: org.id,
      origin_id: sharedOriginId,
      content: 'own parent',
      embedding: basisVector(1),
    });

    const child = await createTestEvent({
      organization_id: org.id,
      content: 'excellent and amazing',
      embedding: basisVector(0),
    });
    await setParent(Number(child.id), sharedOriginId);

    await executeClassificationQuery({
      mode: 'content_ids',
      organizationId: org.id,
      enabledClassifiers: ['ps-same'],
      content_ids: [Number(child.id)],
    });

    // Genuinely this org's own parent → the 0.3 blend must still happen.
    expect(await confidenceFor(Number(child.id), facetId)).toBeCloseTo(BLENDED_CONFIDENCE, 3);
  });
});
