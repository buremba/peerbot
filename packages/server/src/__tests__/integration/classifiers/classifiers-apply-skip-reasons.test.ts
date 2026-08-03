/**
 * Pins `manage_classifiers apply`'s skip-reason bookkeeping against a fixture
 * that puts every reason in ONE call.
 *
 * Why this file exists: the value of `apply` is not the classified count — the
 * engine already produced that. It is that an id which did NOT get classified
 * comes back with a reason that is TRUE. That reason is computed by a precheck
 * that duplicates the engine's target selection, and a duplicate drifts. Three
 * separate rounds of review on this PR each found a different drift, all with
 * the same shape: a real condition reported under the wrong name, which sends
 * the reader after a bug that does not exist.
 *   1. precheck ignored `embedding_model` → a stale-model vector counted as
 *      embedded, and its (absent) score was blamed on `below_threshold`.
 *   2. precheck omitted `behavior_id IS NULL` → a Behavior-owned classifier of
 *      the same slug counted as "found", and its zero results likewise.
 *   3. precheck read `events` while the engine reads `current_event_records` →
 *      a superseded event counted as reachable, same false blame.
 *   4. (found by writing this file) fixing 3 by selecting THROUGH the view made
 *      a superseded event indistinguishable from a foreign one, so it was
 *      reported as `not_in_organization` — a tenancy accusation about the org's
 *      own event.
 *
 * Nothing about the classified/skipped split changes under any of those, which
 * is exactly why they survived: only an assertion on the REASON catches them.
 * Each event below is engineered to sit in exactly one bucket, so a precheck
 * that collapses two conditions moves an id between buckets and fails here.
 *
 * Real pgvector, real engine, no mocks. 768-dim one-hot basis vectors, so cosine
 * is exact: identical basis → 1.0, orthogonal → 0.0.
 */

import { describe, expect, it } from 'vitest';
import { manageClassifiers } from '../../../tools/admin/manage_classifiers';
import type { ToolContext } from '../../../tools/registry';
import { getConfiguredEmbeddingModel } from '../../../utils/embeddings';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestAgent,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const DIM = 768;

/** One-hot 768-dim unit vector (1 at `slot`, 0 elsewhere). */
function basisVector(slot: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[slot] = 1;
  return v;
}

interface ApplyData {
  requested: number;
  classified: number;
  skipped: Record<string, number>;
  sample_skipped: Array<{ id: number; reason: string }>;
}

describe('manage_classifiers apply — skip reasons', () => {
  it('reports every id under the one reason that is actually true', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Apply Reasons Org' });
    const other = await createTestOrganization({ name: 'Apply Reasons Other Org' });
    const user = await createTestUser({ email: 'apply-reasons@test.com' });

    // positive == basis 0, negative == basis 1, threshold 0.5, NO fallback — so
    // an event on basis 7 is orthogonal to both and genuinely scores below.
    // Stamped: the engine drops label vectors whose model is not the configured
    // one, so an unstamped fixture would make this suite pass vacuously.
    const labelModel = getConfiguredEmbeddingModel();
    const attributeValues = {
      positive: { embedding: basisVector(0), embedding_model: labelModel },
      negative: { embedding: basisVector(1), embedding_model: labelModel },
    };
    // Seeded in the CALLER's org only. The other org deliberately has no
    // classifier: its event must be excluded by the org filter, not by failing
    // to find a template. (Slugs are org-scoped, so the other org COULD hold
    // its own 'apply-reasons' — leaving it out keeps the exclusion attributable
    // to the org filter alone.)
    const sql = getTestDb();
    await sql`
      INSERT INTO classify_facet (
        organization_id, slug, name, attribute_key, status, created_by,
        behavior_id, entity_ids, min_similarity, fallback_value, attribute_values
      ) VALUES (
        ${org.id}, 'apply-reasons', 'apply reasons classifier', 'apply-reasons', 'active', ${user.id},
        NULL, NULL, 0.5, NULL, ${sql.json(attributeValues as never)}
      )
    `;

    // One event per bucket. Every one of these WOULD classify if the condition
    // under test were not present — that is what makes the reason load-bearing.
    const classifiable = await createTestEvent({
      organization_id: org.id,
      content: 'in org, live, embedded with the configured model',
      embedding: basisVector(0),
    });
    const orthogonal = await createTestEvent({
      organization_id: org.id,
      content: 'in org, live, embedded, but similar to neither attribute',
      embedding: basisVector(7),
    });
    const unembedded = await createTestEvent({
      organization_id: org.id,
      content: 'in org, live, never embedded',
    });
    const staleModel = await createTestEvent({
      organization_id: org.id,
      content: 'in org, live, embedded under a model the engine no longer reads',
      // A REAL vector, deliberately stamped with the wrong model — that is the
      // whole point of this row. `event_embeddings.embedding_model` is NOT NULL,
      // so a stale stamp is the only way a vector can exist and still be
      // invisible to the engine, which is the production case (model rotated,
      // backfill not yet run). Drop the `embedding` line and this row silently
      // degrades into a duplicate of `unembedded`.
      embedding: basisVector(0),
      embedding_model: 'legacy-embedding-model-v0',
    });
    const superseded = await createTestEvent({
      organization_id: org.id,
      content: 'in org, embedded, would match — but a newer revision replaced it',
      embedding: basisVector(0),
    });
    const foreign = await createTestEvent({
      organization_id: other.id,
      content: 'another org, live, embedded, would match',
      embedding: basisVector(0),
    });
    const unknownId = 999_999_999;

    // Supersede as production does: the newer row claims the older, and the
    // older carries the denormalized back-edge that the view filters on.
    const replacement = await createTestEvent({
      organization_id: org.id,
      content: 'the newer revision',
      embedding: basisVector(0),
    });
    await sql`UPDATE events SET supersedes_event_id = ${superseded.id} WHERE id = ${replacement.id}`;
    await sql`UPDATE events SET superseded_by = ${replacement.id} WHERE id = ${superseded.id}`;

    // Fixture guard: `staleModel` must actually HAVE a vector, or it collapses
    // into `unembedded` and the not_embedded count still reads 2 for the wrong
    // reason. This exact collapse happened once while writing this file.
    const staleRows = (await sql`
      SELECT embedding_model FROM event_embeddings
      WHERE event_id = ${staleModel.id} AND chunk_index = 0
    `) as unknown as Array<{ embedding_model: string }>;
    expect(staleRows.map((r) => r.embedding_model)).toEqual(['legacy-embedding-model-v0']);

    const ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      // `apply` is owner-admin tier, so the role AND the MCP scope both have to
      // clear — reaching the handler at all is part of what this pins.
      scopes: ['mcp:admin'],
    } as ToolContext;

    const requested = [
      Number(classifiable.id),
      Number(orthogonal.id),
      Number(unembedded.id),
      Number(staleModel.id),
      Number(superseded.id),
      Number(foreign.id),
      unknownId,
    ];

    const result = await manageClassifiers(
      { action: 'apply', classifier_slug: 'apply-reasons', content_ids: requested } as never,
      {} as never,
      ctx
    );

    expect(result.success).toBe(true);
    const data = result.data as ApplyData;

    expect(data.requested).toBe(7);
    expect(data.classified).toBe(1);
    expect(data.skipped).toEqual({
      not_embedded: 2, // never embedded + stale model stamp
      not_in_organization: 2, // another org's event + an id that does not exist
      superseded: 1,
      below_threshold: 1,
    });

    // Counts alone would survive two ids swapping buckets, so pin the exact
    // id→reason pairing. This is the assertion the four drifts would have failed.
    expect(
      [...data.sample_skipped]
        .map((s) => ({ id: Number(s.id), reason: s.reason }))
        .sort((a, b) => a.id - b.id)
    ).toEqual(
      [
        { id: Number(orthogonal.id), reason: 'below_threshold' },
        { id: Number(unembedded.id), reason: 'not_embedded' },
        { id: Number(staleModel.id), reason: 'not_embedded' },
        { id: Number(superseded.id), reason: 'superseded' },
        { id: Number(foreign.id), reason: 'not_in_organization' },
        { id: unknownId, reason: 'not_in_organization' },
      ].sort((a, b) => a.id - b.id)
    );

    // The reasons must describe what the engine actually did: only the one
    // classifiable event has a row, and the foreign event was never touched.
    const written = (await sql`
      SELECT event_id FROM event_classifications ORDER BY event_id
    `) as unknown as Array<{ event_id: number }>;
    expect(written.map((r) => Number(r.event_id))).toEqual([Number(classifiable.id)]);
  });

  it('does not count a Behavior-owned classifier of the same slug as the one to apply', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Apply Behavior-Owned Org' });
    const user = await createTestUser({ email: 'apply-behavior@test.com' });
    const sql = getTestDb();

    // Only a Behavior-scoped classifier carries this slug. The engine ignores it
    // (it selects `behavior_id IS NULL`), so `apply` must fail loudly rather than
    // report a successful run that classified nothing.
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    const [behavior] = (await sql`
      INSERT INTO behaviors (organization_id, agent_id, behavior_group_id, name, created_by, status)
      VALUES (${org.id}, ${agent.agentId}, 0, 'owning behavior', ${user.id}, 'active')
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    await sql`
      INSERT INTO classify_facet (
        organization_id, slug, name, attribute_key, status, created_by,
        behavior_id, entity_ids, min_similarity, fallback_value, attribute_values
      ) VALUES (
        ${org.id}, 'behavior-owned', 'behavior owned', 'behavior-owned', 'active', ${user.id},
        ${behavior.id}, NULL, 0.5, NULL,
        ${sql.json({ positive: { embedding: basisVector(0), embedding_model: getConfiguredEmbeddingModel() } } as never)}
      )
    `;

    const event = await createTestEvent({
      organization_id: org.id,
      content: 'would match the behavior-owned classifier exactly',
      embedding: basisVector(0),
    });

    const result = await manageClassifiers(
      {
        action: 'apply',
        classifier_slug: 'behavior-owned',
        content_ids: [Number(event.id)],
      } as never,
      {} as never,
      {
        organizationId: org.id,
        userId: user.id,
        memberRole: 'owner',
        isAuthenticated: true,
        tokenType: 'oauth',
        scopedToOrg: false,
        scopes: ['mcp:admin'],
      } as ToolContext
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('behavior-owned');
  });

  it('stamps the configured embedding model on fixtures, so the stale-model bucket means what it says', async () => {
    // Guards the fixture itself: if createTestEvent stopped stamping the
    // configured model, EVERY event would land in not_embedded and the first
    // test would still pass its `not_embedded: 2` assertion for the wrong reason.
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Apply Fixture Guard Org' });
    const event = await createTestEvent({
      organization_id: org.id,
      content: 'stamped',
      embedding: basisVector(0),
    });
    const sql = getTestDb();
    const rows = (await sql`
      SELECT embedding_model FROM event_embeddings
      WHERE event_id = ${event.id} AND chunk_index = 0
    `) as unknown as Array<{ embedding_model: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].embedding_model).toBe(getConfiguredEmbeddingModel());
  });
});
