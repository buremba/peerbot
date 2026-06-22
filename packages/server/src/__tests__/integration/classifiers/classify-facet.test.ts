/**
 * Classifier consolidation (P4) phase 2: classify_facet mirrors the stable classifier
 * identity/scope from event_classifiers (id = event_classifiers.id), kept in sync by a trigger
 * (INSERT/UPDATE/DELETE). Additive — the fold target; nothing reads it yet (the versioned-config
 * fold + hot-path runtime flip are staging-gated later phases).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const sql = getTestDb();

async function facet(id: number) {
  return (await sql`
    SELECT id, organization_id, slug, name, attribute_key, status FROM classify_facet WHERE id = ${id}
  `) as Array<{ organization_id: string; slug: string; name: string; status: string }>;
}

describe('classify_facet mirror (P4 phase 2)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('mirrors event_classifiers on insert, update, and delete', async () => {
    const org = await createTestOrganization({ name: 'CF Org' });
    const user = await createTestUser({ email: 'cf@test.com' });
    const [c] = (await sql`
      INSERT INTO event_classifiers (slug, name, attribute_key, created_by, organization_id, status)
      VALUES ('s1', 'N1', 'attr', ${user.id}, ${org.id}, 'active')
      RETURNING id
    `) as Array<{ id: number }>;
    const cid = Number(c.id);

    let f = await facet(cid);
    expect(f).toHaveLength(1);
    expect(f[0].slug).toBe('s1');
    expect(f[0].organization_id).toBe(org.id);
    expect(f[0].status).toBe('active');

    await sql`UPDATE event_classifiers SET name = 'N2', status = 'deprecated' WHERE id = ${cid}`;
    f = await facet(cid);
    expect(f[0].name).toBe('N2');
    expect(f[0].status).toBe('deprecated');

    await sql`DELETE FROM event_classifiers WHERE id = ${cid}`;
    expect(await facet(cid)).toHaveLength(0);
  });

  it('backfill seeds pre-existing rows and COALESCE defends NULL timestamps', async () => {
    const org = await createTestOrganization({ name: 'CF Backfill Org' });
    const user = await createTestUser({ email: 'cfb@test.com' });
    let cid = 0;
    try {
      // Trigger disabled simulates a row that predates the migration; insert NULL timestamps
      // (event_classifiers allows them) to exercise the COALESCE defense in the backfill.
      await sql`ALTER TABLE event_classifiers DISABLE TRIGGER trg_sync_classify_facet`;
      const [c] = (await sql`
        INSERT INTO event_classifiers (slug, name, attribute_key, created_by, organization_id, status, created_at, updated_at)
        VALUES ('bf', 'BF', 'attr', ${user.id}, ${org.id}, 'active', NULL, NULL)
        RETURNING id
      `) as Array<{ id: number }>;
      cid = Number(c.id);
      expect(await facet(cid)).toHaveLength(0); // trigger off → not mirrored
    } finally {
      await sql`ALTER TABLE event_classifiers ENABLE TRIGGER trg_sync_classify_facet`;
    }

    // The same backfill the migration runs.
    await sql`
      INSERT INTO classify_facet
        (id, organization_id, slug, name, description, attribute_key, status,
         entity_id, watcher_id, entity_ids, created_by, created_at, updated_at)
      SELECT id, organization_id, slug, name, description, attribute_key, status,
             entity_id, watcher_id, entity_ids, created_by,
             COALESCE(created_at, now()), COALESCE(updated_at, now())
      FROM event_classifiers WHERE id = ${cid}
      ON CONFLICT (id) DO NOTHING
    `;
    const [f] = (await sql`
      SELECT created_at, updated_at FROM classify_facet WHERE id = ${cid}
    `) as Array<{ created_at: unknown; updated_at: unknown }>;
    expect(f.created_at).not.toBeNull();
    expect(f.updated_at).not.toBeNull();
  });
});
