/**
 * Classifier consolidation (P4) phase 1: event_classifications gains a stable classifier_id
 * (denormalized from the version → classifier mapping). A BEFORE trigger keeps it populated
 * on every write; a backfill seeds existing rows. Additive — nothing reads it yet; this is
 * the stable-id foundation for repointing classifier OUTPUT off the per-version id.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEvent, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const sql = getTestDb();

async function makeClassifier(orgId: string, userId: string, slug: string) {
  const [c] = (await sql`
    INSERT INTO event_classifiers (slug, name, attribute_key, created_by, organization_id)
    VALUES (${slug}, ${slug}, 'attr', ${userId}, ${orgId})
    RETURNING id
  `) as Array<{ id: number }>;
  const [v] = (await sql`
    INSERT INTO event_classifier_versions (classifier_id, version, attribute_values, created_by)
    VALUES (${c.id}, 1, '[]'::jsonb, ${userId})
    RETURNING id
  `) as Array<{ id: number }>;
  return { classifierId: Number(c.id), versionId: Number(v.id) };
}

describe('event_classifications stable classifier_id (P4 phase 1)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('trigger populates classifier_id from the version on insert', async () => {
    const org = await createTestOrganization({ name: 'Cls Org' });
    const user = await createTestUser({ email: 'cls@test.com' });
    const event = await createTestEvent({ content: 'x', organization_id: org.id });
    const { classifierId, versionId } = await makeClassifier(org.id, user.id, 'c1');

    const [ec] = (await sql`
      INSERT INTO event_classifications (event_id, classifier_version_id, values, source)
      VALUES (${event.id}, ${versionId}, ARRAY['v']::text[], 'llm')
      RETURNING classifier_id
    `) as Array<{ classifier_id: number }>;
    expect(Number(ec.classifier_id)).toBe(classifierId);
  });

  it('backfill populates classifier_id for rows written with the trigger disabled', async () => {
    const org = await createTestOrganization({ name: 'Cls Org 2' });
    const user = await createTestUser({ email: 'cls2@test.com' });
    const event = await createTestEvent({ content: 'y', organization_id: org.id });
    const { classifierId, versionId } = await makeClassifier(org.id, user.id, 'c2');

    let ecId = 0;
    try {
      await sql`ALTER TABLE event_classifications DISABLE TRIGGER trg_set_event_classification_classifier_id`;
      const [ec] = (await sql`
        INSERT INTO event_classifications (event_id, classifier_version_id, values, source)
        VALUES (${event.id}, ${versionId}, ARRAY['v']::text[], 'llm')
        RETURNING id, classifier_id
      `) as Array<{ id: number; classifier_id: number | null }>;
      expect(ec.classifier_id).toBeNull(); // trigger off → unpopulated
      ecId = Number(ec.id);
    } finally {
      await sql`ALTER TABLE event_classifications ENABLE TRIGGER trg_set_event_classification_classifier_id`;
    }

    // Same backfill as the migration.
    await sql`
      UPDATE event_classifications ec
      SET classifier_id = ecv.classifier_id
      FROM event_classifier_versions ecv
      WHERE ecv.id = ec.classifier_version_id AND ec.classifier_id IS NULL
    `;
    const [r] = (await sql`
      SELECT classifier_id FROM event_classifications WHERE id = ${ecId}
    `) as Array<{ classifier_id: number }>;
    expect(Number(r.classifier_id)).toBe(classifierId);
  });
});
