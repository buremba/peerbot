/**
 * Classifier collapse (P4 phase 5a) — the CENTERPIECE: repointing event_classifications uniqueness
 * from (event_id, classifier_version_id, source, watcher) to the stable
 * (event_id, classifier_id, source, watcher). The one real risk is a backfill collision — two
 * classifications for the same event under TWO versions of the same classifier (same source)
 * collapse to one stable key. This proves the dedup (scripts/dedup-classifications-for-classifier-id.sh)
 * keeps the LATEST row, loses nothing else, and makes the new unique index createable + enforcing.
 */

import { describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEvent, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const sql = getTestDb();

// The exact dedup the script runs (keep MAX(id) per stable key, delete the rest).
const DEDUP = sql`
  WITH dupes AS (
    SELECT event_id, classifier_id, source, COALESCE(watcher_id, 0) AS w, MAX(id) AS keep_id
    FROM event_classifications
    WHERE classifier_id IS NOT NULL
    GROUP BY event_id, classifier_id, source, COALESCE(watcher_id, 0)
    HAVING count(*) > 1
  )
  DELETE FROM event_classifications ec
  USING dupes d
  WHERE ec.event_id = d.event_id AND ec.classifier_id = d.classifier_id
    AND ec.source = d.source AND COALESCE(ec.watcher_id, 0) = d.w
    AND ec.id <> d.keep_id
`;

describe('classifier_id uniqueness repoint dedup (P4 phase 5a)', () => {
  it('dedup keeps the latest row per stable key, loses nothing else, and the new index then enforces', async () => {
    await cleanupTestDatabase();
    // Simulate the pre-migration state so the collision can be seeded (the new index would block it).
    await sql`DROP INDEX IF EXISTS idx_cc_unique_per_source_v2`;

    const org = await createTestOrganization({ name: 'Dedup Org' });
    const user = await createTestUser({ email: 'dedup@test.com' });
    const event = await createTestEvent({ content: 'classified', organization_id: org.id });
    const eventId = Number(event.id);

    const mkClassifier = async (slug: string) => {
      const [c] = (await sql`
        INSERT INTO event_classifiers (slug, name, attribute_key, created_by, organization_id, status)
        VALUES (${slug}, ${slug}, 'attr', ${user.id}, ${org.id}, 'active') RETURNING id
      `) as Array<{ id: number }>;
      return Number(c.id);
    };
    const mkVersion = async (classifierId: number, v: number, current: boolean) => {
      const [r] = (await sql`
        INSERT INTO event_classifier_versions (classifier_id, version, is_current, attribute_values, created_by)
        VALUES (${classifierId}, ${v}, ${current}, '[]'::jsonb, ${user.id}) RETURNING id
      `) as Array<{ id: number }>;
      return Number(r.id);
    };
    const mkClassification = async (versionId: number, val: string) => {
      const [r] = (await sql`
        INSERT INTO event_classifications (event_id, classifier_version_id, "values", source)
        VALUES (${eventId}, ${versionId}, ARRAY[${val}]::text[], 'embedding')
        RETURNING id, classifier_id
      `) as Array<{ id: number; classifier_id: number }>;
      return r;
    };

    // Classifier C with TWO versions; one classification under each (same event + source).
    const cId = await mkClassifier('sentiment');
    const v1 = await mkVersion(cId, 1, false);
    const v2 = await mkVersion(cId, 2, true);
    const cl1 = await mkClassification(v1, 'old');
    const cl2 = await mkClassification(v2, 'new');
    // Control: a DIFFERENT classifier's classification on the same event — must survive untouched.
    const dId = await mkClassifier('topic');
    const dv = await mkVersion(dId, 1, true);
    const ctrl = await mkClassification(dv, 'keep-me');

    // The phase-1 trigger maps both C-rows to the same stable classifier_id → they collide on the new key.
    expect(Number(cl1.classifier_id)).toBe(cId);
    expect(Number(cl2.classifier_id)).toBe(cId);
    const before = (await sql`
      SELECT count(*)::int AS n FROM event_classifications
      WHERE event_id = ${eventId} AND classifier_id = ${cId} AND source = 'embedding'
    `) as Array<{ n: number }>;
    expect(before[0].n).toBe(2); // RED: the collision exists

    await DEDUP;

    // GREEN: exactly one row survives for the collided key — the LATEST (higher id, cl2).
    const after = (await sql`
      SELECT id FROM event_classifications
      WHERE event_id = ${eventId} AND classifier_id = ${cId} AND source = 'embedding'
    `) as Array<{ id: number }>;
    expect(after).toHaveLength(1);
    expect(Number(after[0].id)).toBe(Number(cl2.id)); // kept the newest, not the old version's row

    // No collateral loss: the control classifier's row is untouched.
    const ctrlRows = (await sql`
      SELECT id FROM event_classifications WHERE id = ${Number(ctrl.id)}
    `) as Array<{ id: number }>;
    expect(ctrlRows).toHaveLength(1);

    // The new unique index is now createable (dedup made the data valid)...
    await sql`
      CREATE UNIQUE INDEX idx_cc_unique_per_source_v2
      ON event_classifications (event_id, classifier_id, source, COALESCE(watcher_id, (0)::bigint))
    `;
    // ...and it enforces — re-inserting a classification for the same (event, classifier, source) is rejected.
    await expect(
      sql`
        INSERT INTO event_classifications (event_id, classifier_version_id, "values", source)
        VALUES (${eventId}, ${v1}, ARRAY['dup'], 'embedding')
      `
    ).rejects.toThrow();
  });
});
