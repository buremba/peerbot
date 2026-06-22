/**
 * Coverage for the embedding-classification WRITE path (upsertClassifications) — the batch
 * DELETE+INSERT that executeClassificationQuery uses. This is the path that had been silently broken
 * (its only caller, the reconciliation cron, swallows errors) by two real, prod-reproducing bugs:
 *   1. the values text[] param was passed as a raw JS array — under fetch_types:false (prod config,
 *      which getTestDb shares) that serializes to a malformed literal; fixed with pgTextArray()::text[];
 *   2. a per-row placeholder stride of 10 vs 8 bound params — any batch with >1 classification
 *      mis-mapped its params; fixed to 8.
 * The test client runs PROD_PG_VALUE_OPTIONS, so this exercises the SAME serialization as production.
 */

import { describe, expect, it } from 'vitest';
import {
  type AllClassification,
  upsertClassifications,
} from '../../../utils/classification-query';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEvent, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const sql = getTestDb();

describe('upsertClassifications (embedding write path)', () => {
  it('writes a multi-classification batch (array + stride) and re-classify replaces, no dupe', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Embed Org' });
    const user = await createTestUser({ email: 'embed@test.com' });
    const e1 = await createTestEvent({ content: 'one', organization_id: org.id });
    const e2 = await createTestEvent({ content: 'two', organization_id: org.id });

    const [c] = (await sql`
      INSERT INTO classify_facet (organization_id, slug, name, attribute_key, status, created_by)
      VALUES (${org.id}, 'sentiment', 'Sentiment', 'attr', 'active', ${user.id}) RETURNING id
    `) as Array<{ id: number }>;
    const classifierId = Number(c.id);

    const mk = (contentId: number, value: string): AllClassification => ({
      content_id: contentId,
      classifier_id: classifierId,
      value,
      confidences_map: { [value]: 0.9 },
      met_threshold: true,
      threshold: 0.5,
      best_match_attribute: value,
      actual_confidence: 0.9,
    });

    // The 2-row batch is exactly what used to crash (raw-array param + j*10 stride).
    const result = await upsertClassifications(sql, [
      mk(Number(e1.id), 'positive'),
      mk(Number(e2.id), 'negative'),
    ]);
    expect(result).toHaveLength(2);

    // (under fetch_types:false a text[] reads back as the pg-literal string '{...}')
    const rows = (await sql`
      SELECT event_id, "values"::text AS vals FROM event_classifications
      WHERE classifier_id = ${classifierId} AND source = 'embedding' ORDER BY event_id
    `) as Array<{ event_id: number; vals: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].vals).toBe('{positive}');
    expect(rows[1].vals).toBe('{negative}');

    // Re-classify e1 → DELETE-on-(event,classifier) then INSERT replaces, no duplicate.
    await upsertClassifications(sql, [mk(Number(e1.id), 'neutral')]);
    const e1rows = (await sql`
      SELECT "values"::text AS vals FROM event_classifications
      WHERE event_id = ${Number(e1.id)} AND classifier_id = ${classifierId} AND source = 'embedding'
    `) as Array<{ vals: string }>;
    expect(e1rows).toHaveLength(1);
    expect(e1rows[0].vals).toBe('{neutral}');
  });
});
