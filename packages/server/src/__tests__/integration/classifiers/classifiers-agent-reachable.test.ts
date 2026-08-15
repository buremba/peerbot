/**
 * The classification engine was reachable in principle and unreachable in
 * practice. Two independent gaps, both pinned here.
 *
 * 1. `create` REQUIRED `automation_id` and inserted it as `classify_facet.automation_id`.
 *    Every engine template lookup in `classification-query.ts` filters
 *    `cf.automation_id IS NULL`. So every classifier creatable
 *    through the tool or the ClientSDK was invisible to the engine forever —
 *    `apply` and the reconciliation cron would both report a clean, successful,
 *    zero-result run. Measured in prod 2026-07-31: the `buremba` org held 5
 *    classifiers, all Automation-owned, and 0 classifications; the org with
 *    working classifications held 23, all `automation_id IS NULL` and predating the
 *    required-`automation_id` rule.
 *
 * 2. `apply` existed on the MCP tool but not in the agent-facing SDK, so no
 *    agent could call the one verb that classifies without an entity link.
 *
 * An Automation-owned classifier is still a legitimate thing (Automation-scoped
 * extraction config); it is simply not what the embedding engine matches. That
 * distinction is asserted rather than assumed, so nobody "fixes" this later by
 * loosening the engine's filter.
 */

import { describe, expect, it } from 'vitest';
import { parsePgTextArray } from '../../../db/client';
import { METHOD_METADATA } from '../../../sandbox/method-metadata';
import { buildClassifiersNamespace } from '../../../sandbox/namespaces/classifiers';
import { manageClassifiers } from '../../../tools/admin/manage_classifiers';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestAgent,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const DIM = 768;

function basisVector(slot: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[slot] = 1;
  return v;
}

/** Supplying embeddings inline keeps `create` off the embedding service. */
const ATTRIBUTE_VALUES = {
  positive: { description: 'Positive', examples: ['great'], embedding: basisVector(0) },
  negative: { description: 'Negative', examples: ['awful'], embedding: basisVector(1) },
};

function adminCtx(organizationId: string, userId: string): ToolContext {
  return {
    organizationId,
    userId,
    memberRole: 'owner',
    isAuthenticated: true,
    tokenType: 'oauth',
    scopedToOrg: false,
    scopes: ['mcp:admin'],
  } as ToolContext;
}

describe('classifiers reachable by agents', () => {
  it('creates an engine-matchable classifier when no Automation owns it, and applies it', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Reachable Org' });
    const user = await createTestUser({ email: 'reachable@test.com' });
    const ctx = adminCtx(org.id, user.id);
    const sql = getTestDb();

    const created = await manageClassifiers(
      {
        action: 'create',
        slug: 'agent-made',
        name: 'Agent made',
        attribute_key: 'agent-made',
        attribute_values: ATTRIBUTE_VALUES,
        min_similarity: 0.5,
      } as never,
      {} as never,
      ctx
    );
    expect(created.success).toBe(true);

    // The whole point: no owning Automation means the engine can see it.
    const rows = (await sql`
      SELECT automation_id, status FROM classify_facet
      WHERE slug = 'agent-made' AND organization_id = ${org.id}
    `) as unknown as Array<{ automation_id: number | null; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].automation_id).toBeNull();
    expect(rows[0].status).toBe('active');

    // And `list` must show it back to the agent that created it — the old
    // `fc.automation_id IS NOT NULL` list filter hid every org-level classifier.
    const listed = await manageClassifiers(
      { action: 'list' } as never,
      {} as never,
      ctx
    );
    expect(listed.success).toBe(true);
    const listedSlugs = (
      (listed.data as { classifiers: Array<{ slug: string }> }).classifiers
    ).map((c) => c.slug);
    expect(listedSlugs).toContain('agent-made');

    const event = await createTestEvent({
      organization_id: org.id,
      content: 'great',
      embedding: basisVector(0),
    });

    const applied = await manageClassifiers(
      {
        action: 'apply',
        classifier_slug: 'agent-made',
        content_ids: [Number(event.id)],
      } as never,
      {} as never,
      ctx
    );
    expect(applied.success).toBe(true);
    expect((applied.data as { classified: number }).classified).toBe(1);

    const written = (await sql`
      SELECT "values", source FROM event_classifications WHERE event_id = ${event.id}
    `) as unknown as Array<{ values: unknown; source: string }>;
    expect(written).toHaveLength(1);
    expect(written[0].source).toBe('embedding');
    // `values` is text[]; under fetch_types:false it reads back as "{positive}".
    expect(parsePgTextArray(written[0].values)).toEqual(['positive']);
  });

  it('still accepts an owning Automation, and that classifier stays outside the engine', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Automation Owned Org' });
    const user = await createTestUser({ email: 'automation-owned@test.com' });
    const ctx = adminCtx(org.id, user.id);
    const sql = getTestDb();

    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    const [automation] = (await sql`
      INSERT INTO automations (organization_id, agent_id, automation_group_id, name, created_by, status)
      VALUES (${org.id}, ${agent.agentId}, 0, 'owner', ${user.id}, 'active')
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    const created = await manageClassifiers(
      {
        action: 'create',
        slug: 'automation-made',
        name: 'Automation made',
        attribute_key: 'automation-made',
        attribute_values: ATTRIBUTE_VALUES,
        automation_id: String(automation.id),
        min_similarity: 0.5,
      } as never,
      {} as never,
      ctx
    );
    expect(created.success).toBe(true);

    const rows = (await sql`
      SELECT automation_id FROM classify_facet
      WHERE slug = 'automation-made' AND organization_id = ${org.id}
    `) as unknown as Array<{ automation_id: number | null }>;
    expect(Number(rows[0].automation_id)).toBe(Number(automation.id));

    // Deliberate, not a bug: the embedding engine matches org-level classifiers
    // only. `apply` must say so instead of reporting a successful empty run.
    const event = await createTestEvent({
      organization_id: org.id,
      content: 'great',
      embedding: basisVector(0),
    });
    const applied = await manageClassifiers(
      {
        action: 'apply',
        classifier_slug: 'automation-made',
        content_ids: [Number(event.id)],
      } as never,
      {} as never,
      ctx
    );
    expect(applied.success).toBe(false);
    expect(applied.message).toContain('automation-made');
  });

  it('exposes apply on the agent SDK surface', () => {
    const namespace = buildClassifiersNamespace(
      adminCtx('org', 'user'),
      {} as never
    );
    // Without this an agent cannot classify anything that has no entity link,
    // which is the only reason the verb exists.
    expect(typeof namespace.apply).toBe('function');
    expect(METHOD_METADATA['classifiers.apply']).toBeDefined();
    expect(METHOD_METADATA['classifiers.apply'].access).toBe('admin');
  });
});
