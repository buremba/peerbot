/**
 * Classifier collapse (P4 phase 5d, CONTRACT): event_classifications.classifier_version_id is
 * DROPPED — the output is keyed solely on the stable classifier_id, and the phase-1 derive trigger
 * is gone. This is the steady-state proof that the classification RUNTIME works with the column +
 * trigger actually removed (the test harness applies migration 20260622310000 to the test DB).
 *
 * It drives the real manual-classify write path (manage_classifiers -> updateSingleClassification,
 * the INSERT flipped in 5d) through the tool surface and asserts:
 *   1. the column classifier_version_id no longer exists on event_classifications;
 *   2. the phase-1 trigger + function are gone (writers supply classifier_id directly);
 *   3. a classification is written with the stable classifier_id;
 *   4. re-classifying REPLACES (delete-then-insert) — no duplicate; the (event, classifier, source)
 *      uniqueness on idx_cc_unique_per_source_v2 holds without the version column.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

const sql = getTestDb();

async function pgColumnExists(table: string, column: string): Promise<boolean> {
  const [r] = (await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    ) AS present
  `) as Array<{ present: boolean }>;
  return r.present === true;
}

describe('event_classifications classifier_version_id dropped (P4 phase 5d)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('the dropped column + phase-1 trigger are gone from the schema', async () => {
    expect(await pgColumnExists('event_classifications', 'classifier_version_id')).toBe(false);
    // classifier_id survives and is the durable key.
    expect(await pgColumnExists('event_classifications', 'classifier_id')).toBe(true);

    // The phase-1 derive trigger + its function are retired (writers now set classifier_id directly).
    const [t] = (await sql`
      SELECT
        to_regproc('set_event_classification_classifier_id') IS NULL AS func_gone,
        NOT EXISTS (
          SELECT 1 FROM pg_trigger WHERE tgname = 'trg_set_event_classification_classifier_id'
        ) AS trigger_gone
    `) as Array<{ func_gone: boolean; trigger_gone: boolean }>;
    expect(t.func_gone).toBe(true);
    expect(t.trigger_gone).toBe(true);
  });

  it('manual classify writes with the STABLE classifier_id and re-classify replaces (no dupe)', async () => {
    const org = await createTestOrganization({ name: 'Drop Org' });
    const user = await createTestUser({ email: 'drop@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });

    // A classify_facet classifier (event_classifiers + a current event_classifier_versions row).
    // Seeded directly so the test doesn't depend on a live embeddings service.
    const [c] = (await sql`
      INSERT INTO event_classifiers (slug, name, attribute_key, created_by, organization_id, status)
      VALUES ('mood', 'Mood', 'attr', ${user.id}, ${org.id}, 'active')
      RETURNING id
    `) as Array<{ id: number }>;
    const classifierId = Number(c.id);
    await sql`
      INSERT INTO event_classifier_versions
        (classifier_id, version, is_current, attribute_values, min_similarity, fallback_value, created_by)
      VALUES (${classifierId}, 1, true, '[]'::jsonb, 0.5, 'neutral', ${user.id})
    `;

    const event = await createTestEvent({ content: 'feeling great', organization_id: org.id });

    // The real manual-classify write path (handleClassify -> updateSingleClassification).
    await owner.classifiers.classify({
      classifier_slug: 'mood',
      content_id: event.id,
      value: 'positive',
      source: 'user',
    });

    // `values` is text[]; the fetch_types:false client returns it as a literal
    // array string ("{positive}"). Read it back as a real array via array_to_string.
    const rows = (await sql`
      SELECT classifier_id, array_to_string("values", ',') AS vals, source, is_manual
      FROM event_classifications
      WHERE event_id = ${event.id}
    `) as Array<{ classifier_id: number; vals: string; source: string; is_manual: boolean }>;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].classifier_id)).toBe(classifierId);
    expect(rows[0].vals).toBe('positive');
    expect(rows[0].source).toBe('user');
    expect(rows[0].is_manual).toBe(true);

    // Re-classify the SAME (event, classifier, source) with a new value — replaces, no duplicate.
    await owner.classifiers.classify({
      classifier_slug: 'mood',
      content_id: event.id,
      value: 'negative',
      source: 'user',
    });

    const afterRows = (await sql`
      SELECT classifier_id, array_to_string("values", ',') AS vals FROM event_classifications
      WHERE event_id = ${event.id} AND classifier_id = ${classifierId} AND source = 'user'
    `) as Array<{ classifier_id: number; vals: string }>;
    expect(afterRows).toHaveLength(1); // exactly one — re-classify replaced, no dupe
    expect(Number(afterRows[0].classifier_id)).toBe(classifierId);
    expect(afterRows[0].vals).toBe('negative');
  });
});
