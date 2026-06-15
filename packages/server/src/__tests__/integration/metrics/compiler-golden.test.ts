/**
 * Golden test for the metric compiler (alias resolver). Seeds Revolut-style
 * charges + a "company" entity with aliases, then runs the declared
 * `company.spend` measure end-to-end (compile → org-scope → execute) and asserts
 * the DEDUPED, outflow-only, per-currency sum. This is the correctness gate:
 * it covers alias matching, dedupe, segment filtering, the currency dimension,
 * and SUM — the exact pipeline that must not silently over/under-count.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { getTestDb } from '../../setup/test-db';
import { cleanupTestDatabase } from '../../setup/test-db';
import { TestApiClient } from '../../setup/test-mcp-client';
import { runMetric } from '../../../metrics/run-metric';

const METRICS = {
  eventSets: {
    charges: {
      by: 'alias',
      field: "metadata->>'description'",
      against: 'aliases',
      where: "semantic_type='transaction' AND connector_key='revolut'",
      dedupeKey: ["metadata->>'date'", "metadata->>'amount'", "metadata->>'description'"],
    },
  },
  segments: {
    outflow: {
      description: 'Money leaving the account.',
      where: "metadata->>'direction'='out'",
      on: 'event',
      appliedBefore: 'dedupe',
    },
  },
  measures: {
    spend: {
      eventSet: 'charges',
      agg: 'sum',
      expr: "(metadata->>'amount')::numeric",
      segments: ['outflow'],
      description: 'Total outflow to this company, by currency.',
    },
    charges: {
      eventSet: 'charges',
      agg: 'count',
      segments: ['outflow'],
      description: 'Number of distinct outflow charges.',
    },
  },
  dimensions: {
    currency: { expr: "metadata->>'currency'", description: 'Charge currency.' },
  },
};

describe('metric compiler — alias resolver golden', () => {
  let orgId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Metric Golden Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'metric-golden@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });

    // The declared metric layer for "company".
    await owner.entity_schema.createType({
      slug: 'company',
      name: 'Company',
      metrics_config: METRICS,
    });

    // The Anthropic company with its aliases (what the resolver matches on).
    const company = await createTestEntity({
      name: 'Anthropic',
      entity_type: 'company',
      organization_id: orgId,
    });
    const sql = getTestDb();
    await sql`
      UPDATE entities SET metadata = ${sql.json({ aliases: ['Claude.ai', 'Anthropic'] })}
      WHERE id = ${company.id}
    `;

    // Seed charges. Expected GBP spend = 78.35 + 20.00 = 98.35:
    const charge = (m: Record<string, unknown>) =>
      createTestEvent({
        organization_id: orgId,
        content: 'charge',
        semantic_type: 'transaction',
        connector_key: 'revolut',
        metadata: m,
      });
    await charge({ date: '2025-10-08', amount: 78.35, currency: 'GBP', direction: 'out', description: 'Claude.ai' });
    await charge({ date: '2025-11-01', amount: 20.0, currency: 'GBP', direction: 'out', description: 'Anthropic' });
    // exact duplicate (Revolut double-ingest) → deduped away by dedupeKey
    await charge({ date: '2025-11-01', amount: 20.0, currency: 'GBP', direction: 'out', description: 'Anthropic' });
    // refund (direction in) → excluded by the outflow segment
    await charge({ date: '2025-11-05', amount: 99.0, currency: 'GBP', direction: 'in', description: 'Claude.ai' });
    // USD charge → its own currency row
    await charge({ date: '2026-03-14', amount: 23.93, currency: 'USD', direction: 'out', description: 'Claude.ai' });
    // a non-Anthropic vendor → not matched by aliases
    await charge({ date: '2025-11-10', amount: 5.0, currency: 'GBP', direction: 'out', description: 'Spotify' });
  });

  it('sums deduped outflow by currency, matching only aliased charges', async () => {
    const rows = await runMetric({
      organizationId: orgId,
      entityType: 'company',
      measure: 'spend',
      by: ['currency'],
    });
    const byCur = Object.fromEntries(rows.map((r) => [r.currency as string, Number(r.spend)]));
    expect(byCur.GBP).toBeCloseTo(98.35, 2); // dup collapsed, refund + Spotify excluded
    expect(byCur.USD).toBeCloseTo(23.93, 2);
  });

  it('counts deduped outflow charges', async () => {
    const rows = await runMetric({
      organizationId: orgId,
      entityType: 'company',
      measure: 'charges',
      by: ['currency'],
    });
    const byCur = Object.fromEntries(rows.map((r) => [r.currency as string, Number(r.charges)]));
    expect(byCur.GBP).toBe(2); // Claude.ai 78.35 + Anthropic 20.00 (dup collapsed)
    expect(byCur.USD).toBe(1);
  });
});
