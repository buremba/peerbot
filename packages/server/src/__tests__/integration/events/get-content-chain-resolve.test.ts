/**
 * Integration test: `content_ids` permalinks resolve the full supersede chain.
 *
 * An approval permalink is minted at pending-approval time and carries THAT
 * event id. When the user approves and the device completes, each transition
 * INSERTs a new row and stamps `superseded_by` on the prior one, so the pending
 * id is no longer live and drops out of `current_event_records`. Before the fix
 * `fetchByContentIds` read the masked view directly, so the frozen permalink id
 * returned zero rows → the UI's "not found".
 *
 * Pinned contract after the fix (get_content/query.ts):
 *   - Requesting a superseded id returns its WHOLE lineage (pending → executing
 *     → completed), not a 404 and not just the head — the caller sees what
 *     happened.
 *   - Run/operation chains resolve via the shared `run_id` (the run arm).
 *   - run_id-less chains (e.g. an edited note) resolve by walking
 *     `superseded_by` / `supersedes_event_id` (the walk arm).
 *   - Requesting two ids from the same chain does not double-return it.
 *
 * Vitest CI gap note (mirrors neighbors): runs locally / in the CI integration
 * job against the pgvector DB via DATABASE_URL.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getTestDb } from '../../setup/test-db';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

/**
 * Insert one event row directly and (when `supersedesId` is given) stamp the
 * inverse `superseded_by` edge on the prior row in the SAME lineage — exactly
 * what insert-event.ts does on a real supersede. Returns the new row id.
 */
async function insertChainRow(opts: {
  organizationId: string;
  title: string;
  content: string;
  runId?: number | null;
  occurredAt: Date;
  supersedesId?: number | null;
}): Promise<number> {
  const sql = getTestDb();
  const [row] = await sql`
    INSERT INTO events (
      organization_id, origin_id, title, payload_type, payload_text,
      semantic_type, occurred_at, created_at, run_id, supersedes_event_id
    ) VALUES (
      ${opts.organizationId},
      ${`chain-test-${opts.title}-${opts.occurredAt.getTime()}`},
      ${opts.title}, 'text', ${opts.content},
      'content', ${opts.occurredAt}, NOW(),
      ${opts.runId ?? null},
      ${opts.supersedesId ?? null}
    )
    RETURNING id
  `;
  const id = Number((row as { id: unknown }).id);
  // Stamp the forward edge on the row we just superseded so the masking view
  // (WHERE superseded_by IS NULL) hides it — reproducing the stale permalink.
  if (opts.supersedesId != null) {
    await sql`UPDATE events SET superseded_by = ${id} WHERE id = ${opts.supersedesId}`;
  }
  return id;
}

describe('getContent > content_ids resolves the full supersede chain', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let ctx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Chain Resolve Org' });
    user = await createTestUser({ email: 'chain-resolve@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    } as ToolContext;
  });

  it('run arm: a superseded permalink id returns the whole run chain (pending→executing→completed)', async () => {
    const sql = getTestDb();
    const [run] = await sql<{ id: number }[]>`
      INSERT INTO runs (run_type, status, organization_id)
      VALUES ('action', 'completed', ${org.id}) RETURNING id`;
    const runId = Number(run.id);

    const t0 = new Date('2026-07-01T00:00:00Z');
    const pending = await insertChainRow({
      organizationId: org.id,
      title: 'screenshot — pending approval',
      content: 'pending',
      runId,
      occurredAt: t0,
    });
    const executing = await insertChainRow({
      organizationId: org.id,
      title: 'screenshot — executing',
      content: 'executing',
      runId,
      occurredAt: new Date(t0.getTime() + 1000),
      supersedesId: pending,
    });
    const completed = await insertChainRow({
      organizationId: org.id,
      title: 'screenshot — completed',
      content: 'completed with image',
      runId,
      occurredAt: new Date(t0.getTime() + 2000),
      supersedesId: executing,
    });

    // The permalink carries the PENDING id, which is now superseded/hidden.
    const result = await getContent(
      { content_ids: [pending], limit: 100 } as never,
      {} as never,
      ctx
    );
    const ids = result.content.map((c) => c.id);

    // Whole lineage comes back, chronological, not a 404.
    expect(ids).toEqual([pending, executing, completed]);
    // total is now ROW-accurate: three rows returned -> total 3 (the old
    // chain-count `total:1` lied about how many rows the caller got).
    expect(result.total).toBe(3);
    // chain_total still reports the atomic-unit (one lineage) count.
    expect(result.chain_total).toBe(1);
    // The superseded history is flagged so callers can find the live head.
    const byId = new Map(result.content.map((c) => [c.id, c]));
    expect(byId.get(pending)?.is_superseded).toBe(true);
    expect(byId.get(executing)?.is_superseded).toBe(true);
    expect(byId.get(completed)?.is_superseded).toBe(false);
  });

  it('walk arm: a run_id-less superseded id resolves via superseded_by/supersedes_event_id', async () => {
    const t0 = new Date('2026-07-02T00:00:00Z');
    const v1 = await insertChainRow({
      organizationId: org.id,
      title: 'note v1',
      content: 'first',
      runId: null,
      occurredAt: t0,
    });
    const v2 = await insertChainRow({
      organizationId: org.id,
      title: 'note v2',
      content: 'second',
      runId: null,
      occurredAt: new Date(t0.getTime() + 1000),
      supersedesId: v1,
    });

    // Request the OLD (superseded) id; expect both rows of the walked chain.
    const result = await getContent(
      { content_ids: [v1], limit: 100 } as never,
      {} as never,
      ctx
    );
    const ids = result.content.map((c) => c.id).sort((a, b) => a - b);
    expect(ids).toEqual([v1, v2].sort((a, b) => a - b));
    expect(result.total).toBe(2);
    expect(result.chain_total).toBe(1);
    const walkById = new Map(result.content.map((c) => [c.id, c]));
    expect(walkById.get(v1)?.is_superseded).toBe(true);
    expect(walkById.get(v2)?.is_superseded).toBe(false);
  });

  it('walk arm: entering from the HEAD id still returns the full history (backward walk)', async () => {
    const t0 = new Date('2026-07-04T00:00:00Z');
    const v1 = await insertChainRow({
      organizationId: org.id,
      title: 'doc v1',
      content: 'first',
      runId: null,
      occurredAt: t0,
    });
    const v2 = await insertChainRow({
      organizationId: org.id,
      title: 'doc v2',
      content: 'second',
      runId: null,
      occurredAt: new Date(t0.getTime() + 1000),
      supersedesId: v1,
    });
    const v3 = await insertChainRow({
      organizationId: org.id,
      title: 'doc v3',
      content: 'third',
      runId: null,
      occurredAt: new Date(t0.getTime() + 2000),
      supersedesId: v2,
    });

    // Enter from the live HEAD (v3): the caller should still see the superseded
    // history (v1, v2) via the backward supersedes_event_id walk.
    const result = await getContent(
      { content_ids: [v3], limit: 100 } as never,
      {} as never,
      ctx
    );
    const ids = result.content.map((c) => c.id).sort((a, b) => a - b);
    expect(ids).toEqual([v1, v2, v3].sort((a, b) => a - b));
    expect(result.total).toBe(3);
    expect(result.chain_total).toBe(1);
  });

  it('two ids from the same chain do not double-return the lineage', async () => {
    const sql = getTestDb();
    const [run] = await sql<{ id: number }[]>`
      INSERT INTO runs (run_type, status, organization_id)
      VALUES ('action', 'completed', ${org.id}) RETURNING id`;
    const runId = Number(run.id);

    const t0 = new Date('2026-07-03T00:00:00Z');
    const a = await insertChainRow({
      organizationId: org.id,
      title: 'op a',
      content: 'a',
      runId,
      occurredAt: t0,
    });
    const b = await insertChainRow({
      organizationId: org.id,
      title: 'op b',
      content: 'b',
      runId,
      occurredAt: new Date(t0.getTime() + 1000),
      supersedesId: a,
    });

    const result = await getContent(
      { content_ids: [a, b], limit: 100 } as never,
      {} as never,
      ctx
    );
    const ids = result.content.map((c) => c.id);
    // Each chain row appears exactly once even though both its ids were asked for.
    expect(ids.sort((x, y) => x - y)).toEqual([a, b].sort((x, y) => x - y));
    // Two rows, still one lineage — the dedup keeps rows unique.
    expect(result.total).toBe(2);
    expect(result.chain_total).toBe(1);
  });

  // #2050: a manual `classifiers.classify` writes to event_classifications, but
  // the exact content_ids read hard-coded `'{}'::jsonb as classifications`, so
  // the applied classification was invisible on read-back. It must now surface.
  it('content_ids exact read surfaces the applied classification', async () => {
    const sql = getTestDb();
    const t0 = new Date('2026-07-05T00:00:00Z');
    const eventId = await insertChainRow({
      organizationId: org.id,
      title: 'note to classify',
      content: 'a disposable note with a classifiable value',
      runId: null,
      occurredAt: t0,
    });

    // Seed a classifier + a manual (source='user') classification, mirroring
    // what classifiers.classify commits.
    const [facet] = await sql<{ id: number }[]>`
      INSERT INTO classify_facet (
        organization_id, slug, name, attribute_key, status, created_by,
        entity_ids, attribute_values, min_similarity
      ) VALUES (
        ${org.id}, 'sentiment-2050', 'Sentiment 2050', 'sentiment', 'active', ${user.id},
        ARRAY[]::bigint[], ${sql.json({ positive: { description: 'p', examples: ['great'] } })}, 0.7
      ) RETURNING id`;
    const classifierId = Number(facet.id);

    await sql`
      INSERT INTO event_classifications (
        event_id, classifier_id, automation_id, run_id, "values", confidences,
        source, is_manual, reasoning
      ) VALUES (
        ${eventId}, ${classifierId}, NULL, NULL, ${'{positive}'}::text[],
        ${sql.json({ positive: 1.0 })}, 'user', true, 'looks positive'
      )`;

    const result = await getContent(
      { content_ids: [eventId], limit: 10 } as never,
      {} as never,
      ctx
    );

    const item = result.content.find((c) => c.id === eventId);
    expect(item).toBeDefined();
    const classifications = item?.classifications as Record<
      string,
      { values: string[]; source: string; is_manual: boolean }
    > | null;
    expect(classifications).toBeTruthy();
    // Keyed by the classifier's attribute_key, carrying the applied value + provenance.
    expect(classifications?.sentiment).toBeDefined();
    expect(classifications?.sentiment.values).toEqual(['positive']);
    expect(classifications?.sentiment.source).toBe('user');
    expect(classifications?.sentiment.is_manual).toBe(true);
  });
});
