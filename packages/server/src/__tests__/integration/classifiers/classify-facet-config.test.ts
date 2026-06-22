/**
 * Classifier consolidation (P4) phase 3: classify_facet gains the CURRENT version's config
 * (attribute_values, min_similarity, fallback_value, preferred_model, extraction_config,
 * current_version_id), mirrored from event_classifier_versions by a trigger whenever a version
 * becomes is_current. Additive — nothing reads it yet; completes the config-home for the
 * staging-gated hot-path read flip.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const sql = getTestDb();

async function makeClassifier(orgId: string, userId: string, slug: string) {
  const [c] = (await sql`
    INSERT INTO event_classifiers (slug, name, attribute_key, created_by, organization_id, status)
    VALUES (${slug}, ${slug}, 'attr', ${userId}, ${orgId}, 'active')
    RETURNING id
  `) as Array<{ id: number }>;
  return Number(c.id);
}

async function addVersion(
  classifierId: number,
  userId: string,
  version: number,
  isCurrent: boolean,
  cfg: { min_similarity: number; fallback_value: string; preferred_model: string }
) {
  const [v] = (await sql`
    INSERT INTO event_classifier_versions
      (classifier_id, version, is_current, attribute_values, min_similarity, fallback_value, preferred_model, extraction_config, created_by)
    VALUES (${classifierId}, ${version}, ${isCurrent}, '[]'::jsonb, ${cfg.min_similarity}, ${cfg.fallback_value}, ${cfg.preferred_model}, '{}'::jsonb, ${userId})
    RETURNING id
  `) as Array<{ id: number }>;
  return Number(v.id);
}

async function facetConfig(id: number) {
  const [f] = (await sql`
    SELECT current_version_id, min_similarity, fallback_value, preferred_model
    FROM classify_facet WHERE id = ${id}
  `) as Array<{
    current_version_id: number;
    min_similarity: number;
    fallback_value: string;
    preferred_model: string;
  }>;
  return f;
}

describe('classify_facet config mirror (P4 phase 3)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('mirrors the current version config to the facet, and follows the current pointer', async () => {
    const org = await createTestOrganization({ name: 'CFC Org' });
    const user = await createTestUser({ email: 'cfc@test.com' });
    const cid = await makeClassifier(org.id, user.id, 'cfc');

    const v1 = await addVersion(cid, user.id, 1, true, {
      min_similarity: 0.7,
      fallback_value: 'unknown',
      preferred_model: 'm1',
    });
    let f = await facetConfig(cid);
    expect(Number(f.current_version_id)).toBe(v1);
    expect(Number(f.min_similarity)).toBe(0.7);
    expect(f.fallback_value).toBe('unknown');
    expect(f.preferred_model).toBe('m1');

    // Promote a new current version → the facet follows it.
    await sql`UPDATE event_classifier_versions SET is_current = false WHERE id = ${v1}`;
    const v2 = await addVersion(cid, user.id, 2, true, {
      min_similarity: 0.9,
      fallback_value: 'other',
      preferred_model: 'm2',
    });
    f = await facetConfig(cid);
    expect(Number(f.current_version_id)).toBe(v2);
    expect(Number(f.min_similarity)).toBe(0.9);
    expect(f.preferred_model).toBe('m2');
  });

  it('re-mirrors when the current version config is edited IN PLACE (manual classify / value learning)', async () => {
    const org = await createTestOrganization({ name: 'CFC Inplace Org' });
    const user = await createTestUser({ email: 'cfci@test.com' });
    const cid = await makeClassifier(org.id, user.id, 'cfci');
    const v1 = await addVersion(cid, user.id, 1, true, {
      min_similarity: 0.5,
      fallback_value: 'x',
      preferred_model: 'm',
    });

    // attribute_values is edited IN PLACE on the current version (manage_classifiers.ts:718 /
    // classifier-extraction.ts:390) without touching is_current — the facet must still re-mirror.
    await sql`UPDATE event_classifier_versions SET attribute_values = '[{"v":"new"}]'::jsonb WHERE id = ${v1}`;
    const [f] = (await sql`
      SELECT attribute_values FROM classify_facet WHERE id = ${cid}
    `) as Array<{ attribute_values: unknown }>;
    expect(f.attribute_values).toEqual([{ v: 'new' }]);
  });
});
