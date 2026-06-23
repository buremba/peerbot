/**
 * P4 FINAL steady state: classify_facet is the ONE classifier table — event_classifiers and
 * event_classifier_versions are dropped. Proves the inverted table stands on its own: it
 * self-generates ids, backs event_classifications via the repointed FK, and enforces the
 * (entity_id, watcher_id, slug) uniqueness the watcher-extraction upsert relies on.
 */

import { describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEvent, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const sql = getTestDb();

describe('classify_facet is the sole classifier table (P4 final)', () => {
  it('both source tables are gone; classify_facet self-generates ids, backs + cascades classifications, enforces uniqueness', async () => {
    await cleanupTestDatabase();

    const [reg] = (await sql`
      SELECT to_regclass('public.event_classifiers') AS ec,
             to_regclass('public.event_classifier_versions') AS ecv
    `) as Array<{ ec: string | null; ecv: string | null }>;
    expect(reg.ec).toBeNull();
    expect(reg.ecv).toBeNull();

    const org = await createTestOrganization({ name: 'Sole Org' });
    const user = await createTestUser({ email: 'sole@test.com' });
    const event = await createTestEvent({ content: 'classified', organization_id: org.id });

    // Insert WITHOUT an id → the new classify_facet_id_seq assigns one (was set = event_classifiers.id).
    const [c] = (await sql`
      INSERT INTO classify_facet (organization_id, slug, name, attribute_key, status, created_by, attribute_values, min_similarity)
      VALUES (${org.id}, 'sentiment', 'Sentiment', 'attr', 'active', ${user.id}, '{}'::jsonb, 0.7)
      RETURNING id
    `) as Array<{ id: number }>;
    expect(Number(c.id)).toBeGreaterThan(0);

    // event_classifications.classifier_id FK now points at classify_facet(id).
    await sql`
      INSERT INTO event_classifications (event_id, classifier_id, "values", source)
      VALUES (${Number(event.id)}, ${Number(c.id)}, ARRAY['positive']::text[], 'embedding')
    `;
    const rows = (await sql`
      SELECT classifier_id FROM event_classifications WHERE event_id = ${Number(event.id)}
    `) as Array<{ classifier_id: number }>;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].classifier_id)).toBe(Number(c.id));

    // The (entity_id, watcher_id, slug) NULLS NOT DISTINCT unique (extraction upsert target) is enforced.
    await expect(
      sql`
        INSERT INTO classify_facet (organization_id, slug, name, attribute_key, status, created_by)
        VALUES (${org.id}, 'sentiment', 'Dup', 'attr', 'active', ${user.id})
      `
    ).rejects.toThrow();

    // Deleting the classifier cascades its classifications (the repointed FK is ON DELETE CASCADE).
    await sql`DELETE FROM classify_facet WHERE id = ${Number(c.id)}`;
    const after = (await sql`
      SELECT count(*)::int AS n FROM event_classifications WHERE event_id = ${Number(event.id)}
    `) as Array<{ n: number }>;
    expect(after[0].n).toBe(0);
  });
});
