/**
 * Classifier consolidation (P4) phase 4: the hot classification runtime (classification-query.ts)
 * reads the classifier config from classify_facet (flag CLASSIFY_VIA_FACET) instead of the
 * event_classifiers -> event_classifier_versions(is_current) JOIN. This proves the two reads are
 * EQUIVALENT (same classifier_id / version_id / config). Flag-gated so the hot read can be
 * A/B-latency-validated in staging before cutover.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const sql = getTestDb();

describe('classification config read flip equivalence (P4 phase 4)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('the classify_facet config read matches the event_classifier_versions JOIN', async () => {
    const org = await createTestOrganization({ name: 'CFR Org' });
    const user = await createTestUser({ email: 'cfr@test.com' });
    const [c] = (await sql`
      INSERT INTO event_classifiers (slug, name, attribute_key, created_by, organization_id, status)
      VALUES ('cfr', 'CFR', 'attr', ${user.id}, ${org.id}, 'active')
      RETURNING id
    `) as Array<{ id: number }>;
    const cid = Number(c.id);
    await sql`
      INSERT INTO event_classifier_versions
        (classifier_id, version, is_current, attribute_values, min_similarity, fallback_value, preferred_model, extraction_config, created_by)
      VALUES (${cid}, 1, true, '[{"v":"x"}]'::jsonb, 0.6, 'fb', 'm1', '{"a":1}'::jsonb, ${user.id})
    `;

    // The production runtime's config SELECT, both variants (slug pinned to this classifier).
    const joinRows = await sql`
      SELECT fc.id as classifier_id, fcv.id as version_id, fcv.min_similarity, fcv.fallback_value,
             fcv.attribute_values, fc.entity_ids
      FROM event_classifiers fc
      JOIN event_classifier_versions fcv ON fc.id = fcv.classifier_id AND fcv.is_current = true
      WHERE fc.slug = 'cfr' AND fc.status = 'active' AND fc.watcher_id IS NULL
    `;
    const facetRows = await sql`
      SELECT cf.id as classifier_id, cf.current_version_id as version_id, cf.min_similarity,
             cf.fallback_value, cf.attribute_values, cf.entity_ids
      FROM classify_facet cf
      WHERE cf.slug = 'cfr' AND cf.status = 'active' AND cf.watcher_id IS NULL
        AND cf.current_version_id IS NOT NULL
    `;

    expect(facetRows).toHaveLength(1);
    expect(facetRows).toEqual(joinRows); // identical classifier_id/version_id/config
  });

  it('stays equivalent across version-switch and soft-delete (the mutation paths)', async () => {
    const org = await createTestOrganization({ name: 'CFR2 Org' });
    const user = await createTestUser({ email: 'cfr2@test.com' });
    const [c] = (await sql`
      INSERT INTO event_classifiers (slug, name, attribute_key, created_by, organization_id, status)
      VALUES ('cfr2', 'CFR2', 'attr', ${user.id}, ${org.id}, 'active') RETURNING id
    `) as Array<{ id: number }>;
    const cid = Number(c.id);
    await sql`
      INSERT INTO event_classifier_versions (classifier_id, version, is_current, attribute_values, min_similarity, fallback_value, created_by)
      VALUES (${cid}, 1, true, '[{"v":"a"}]'::jsonb, 0.5, 'fb1', ${user.id})
    `;

    const readJoin = async () => sql`
      SELECT fc.id as classifier_id, fcv.id as version_id, fcv.min_similarity, fcv.fallback_value, fcv.attribute_values, fc.entity_ids
      FROM event_classifiers fc JOIN event_classifier_versions fcv ON fc.id = fcv.classifier_id AND fcv.is_current = true
      WHERE fc.slug = 'cfr2' AND fc.status = 'active' AND fc.watcher_id IS NULL
    `;
    const readFacet = async () => sql`
      SELECT cf.id as classifier_id, cf.current_version_id as version_id, cf.min_similarity, cf.fallback_value, cf.attribute_values, cf.entity_ids
      FROM classify_facet cf
      WHERE cf.slug = 'cfr2' AND cf.status = 'active' AND cf.watcher_id IS NULL AND cf.current_version_id IS NOT NULL
    `;

    // Promote a new current version — both reads follow it identically.
    await sql`UPDATE event_classifier_versions SET is_current = false WHERE classifier_id = ${cid}`;
    await sql`
      INSERT INTO event_classifier_versions (classifier_id, version, is_current, attribute_values, min_similarity, fallback_value, created_by)
      VALUES (${cid}, 2, true, '[{"v":"b"}]'::jsonb, 0.8, 'fb2', ${user.id})
    `;
    expect(await readFacet()).toEqual(await readJoin());

    // Soft-delete (status='deprecated') — both reads exclude it identically.
    await sql`UPDATE event_classifiers SET status = 'deprecated' WHERE id = ${cid}`;
    expect(await readFacet()).toHaveLength(0);
    expect(await readJoin()).toHaveLength(0);
  });
});
