/**
 * A classifier slug is a tenant-scoped name, not a global one.
 *
 * `classify_facet_unique_per_insight` was UNIQUE NULLS NOT DISTINCT
 * (entity_id, watcher_id, slug) — no organization_id. Org-level classifiers are
 * exactly (entity_id NULL, watcher_id NULL, slug), which is what
 * `manage_classifiers create` produces and the only kind `apply` and the
 * reconciliation job can match. So the FIRST tenant to create `sentiment` took
 * the name away from every other tenant in the install, and the second one's
 * create died on a unique violation naming a row it cannot see.
 *
 * Measured on prod 2026-07-31: 29 classifiers, 3 of them in that globally
 * unique bucket across 2 orgs. They coexist only because the slugs happen to
 * differ — the bug is latent, not dormant.
 *
 * These tests go through `manageClassifiers` rather than raw SQL: the tool is
 * the surface a tenant actually collides on.
 */

import { describe, expect, it } from 'vitest';
import { manageClassifiers } from '../../../tools/admin/manage_classifiers';
import { createClassifiersForWatcher } from '../../../watchers/classifier-extraction';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const DIM = 768;
function basisVector(slot: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[slot] = 1;
  return v;
}

const ATTRIBUTE_VALUES = {
  positive: { description: 'Positive', examples: ['great'], embedding: basisVector(0) },
  negative: { description: 'Negative', examples: ['awful'], embedding: basisVector(1) },
};

function ownerCtx(organizationId: string, userId: string): ToolContext {
  return {
    organizationId,
    userId,
    memberRole: 'owner',
    isAuthenticated: true,
    tokenType: 'oauth',
    scopedToOrg: false,
    allowCrossOrg: false,
    scopes: ['mcp:admin'],
  } as ToolContext;
}

async function orgWithOwner(name: string, email: string) {
  const org = await createTestOrganization({ name });
  const user = await createTestUser({ email });
  await addUserToOrganization(user.id, org.id, 'owner');
  return { org, ctx: ownerCtx(org.id, user.id) };
}

function createSentiment(ctx: ToolContext) {
  return manageClassifiers(
    {
      action: 'create',
      slug: 'sentiment',
      name: 'Sentiment',
      attribute_key: 'sentiment',
      attribute_values: ATTRIBUTE_VALUES,
    } as never,
    {} as never,
    ctx
  );
}

describe('classifier slugs are scoped per organization', () => {
  it('lets two tenants each hold an org-level `sentiment`', async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const a = await orgWithOwner('Tenant A', 'tenant-a@test.example.com');
    const b = await orgWithOwner('Tenant B', 'tenant-b@test.example.com');
    const sql = getTestDb();

    // Before the org-scoped key this pair was the whole bug: the first create
    // succeeded and the second raised 23505 on classify_facet_unique_per_insight.
    expect((await createSentiment(a.ctx)).success).toBe(true);
    expect((await createSentiment(b.ctx)).success).toBe(true);

    const rows = (await sql`
      SELECT organization_id, id FROM classify_facet WHERE slug = 'sentiment'
      ORDER BY id
    `) as unknown as Array<{ organization_id: string; id: number }>;

    // Two distinct rows, one per tenant — not one row silently shared.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.organization_id))).toEqual(new Set([a.org.id, b.org.id]));
    expect(rows[0].id).not.toBe(rows[1].id);
  });

  it('still refuses a duplicate org-level slug inside one tenant', async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const a = await orgWithOwner('Tenant Solo', 'solo@test.example.com');
    const sql = getTestDb();

    // Widening to per-org must not degrade into "no uniqueness at all" —
    // `apply` resolves a classifier BY SLUG, so a tenant holding two rows for
    // one slug makes which-one-wins arbitrary.
    expect((await createSentiment(a.ctx)).success).toBe(true);
    const second = await createSentiment(a.ctx);
    expect(second.success).toBe(false);

    const [{ n }] = (await sql`
      SELECT count(*)::int AS n FROM classify_facet
      WHERE slug = 'sentiment' AND organization_id = ${a.org.id}
    `) as unknown as Array<{ n: number }>;
    expect(n).toBe(1);
  });

  it('keeps entity-scoped slugs independent per tenant too', async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const a = await orgWithOwner('Entity Tenant A', 'ent-a@test.example.com');
    const b = await orgWithOwner('Entity Tenant B', 'ent-b@test.example.com');
    const sql = getTestDb();

    // The NULLS NOT DISTINCT arms still have to work: entity_id/watcher_id are
    // nullable and their NULLs must keep colliding WITHIN a tenant. Here both
    // rows carry the same non-null entity_id, so only organization_id separates
    // them — the exact case the old 3-column key conflated.
    const sharedEntityId = 4242;
    for (const t of [a, b]) {
      await sql`
        INSERT INTO classify_facet (organization_id, slug, name, attribute_key, status, created_by, entity_id)
        VALUES (${t.org.id}, 'shared-entity-slug', 'Shared', 'shared', 'active', 'system', ${sharedEntityId})
      `;
    }

    const [{ n }] = (await sql`
      SELECT count(*)::int AS n FROM classify_facet WHERE slug = 'shared-entity-slug'
    `) as unknown as Array<{ n: number }>;
    expect(n).toBe(2);
  });

  it('the extraction upsert resolves the new 4-column conflict target', async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const a = await orgWithOwner('Upsert Tenant A', 'ups-a@test.example.com');
    const b = await orgWithOwner('Upsert Tenant B', 'ups-b@test.example.com');

    // An ON CONFLICT column list must resolve to a live unique index at
    // execution time, not at parse time — so retargeting the upsert without
    // running it would leave "no unique or exclusion constraint matching the
    // ON CONFLICT specification" to fire in prod. This is the only test that
    // executes it. classify_facet has no FKs, so the ids are arbitrary.
    const def = {
      slug: 'extracted',
      name: 'Extracted v1',
      source_path: '$.items[*]',
      value_field: 'value',
    };
    const sql = getTestDb();
    const watcherId = 9001;
    const entityId = 9002;

    const [firstId] = await createClassifiersForWatcher(sql, watcherId, entityId, [def], {
      createdBy: 'system',
      organizationId: a.org.id,
    });

    // Re-apply in the same tenant: the conflict arm fires — same row, name refreshed.
    const [againId] = await createClassifiersForWatcher(
      sql,
      watcherId,
      entityId,
      [{ ...def, name: 'Extracted v2' }],
      { createdBy: 'system', organizationId: a.org.id }
    );
    expect(againId).toBe(firstId);

    // Same (entity, watcher, slug) in ANOTHER tenant: a new row, not an update
    // of tenant A's — the exact pair the old 3-column key conflated.
    const [otherId] = await createClassifiersForWatcher(sql, watcherId, entityId, [def], {
      createdBy: 'system',
      organizationId: b.org.id,
    });
    expect(otherId).not.toBe(firstId);

    const rows = (await sql`
      SELECT organization_id, name FROM classify_facet WHERE slug = 'extracted' ORDER BY id
    `) as unknown as Array<{ organization_id: string; name: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ organization_id: a.org.id, name: 'Extracted v2' });
    expect(rows[1]).toEqual({ organization_id: b.org.id, name: 'Extracted v1' });
  });
});
