/**
 * Integration tests for the metric MCP tools (query_metric + list_metrics) over
 * the real DB. Seeds a declared "company" metric + an aliased entity + charges,
 * then exercises the tool handlers: query_metric returns the deduped governed
 * number, and list_metrics surfaces the catalog (and filters by keyword).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { TestApiClient } from '../../setup/test-mcp-client';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { listMetrics } from '../../../tools/admin/list_metrics';
import { queryMetric } from '../../../tools/admin/query_metric';

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
    outflow: { description: 'Money leaving the account.', where: "metadata->>'direction'='out'", on: 'event', appliedBefore: 'dedupe' },
  },
  measures: {
    spend: { eventSet: 'charges', agg: 'sum', expr: "(metadata->>'amount')::numeric", segments: ['outflow'], description: 'Total outflow to this company, by currency.' },
  },
  dimensions: { currency: { expr: "metadata->>'currency'", description: 'Charge currency.' } },
};

describe('metric MCP tools', () => {
  let ctx: ToolContext;
  const env = {} as Env;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Metric Tools Org' });
    const user = await createTestUser({ email: 'metric-tools@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    ctx = { organizationId: org.id, userId: user.id, memberRole: 'owner', isAuthenticated: true };

    const owner = await TestApiClient.for({ organizationId: org.id, userId: user.id, memberRole: 'owner' });
    await owner.entity_schema.createType({ slug: 'company', name: 'Company', metrics_config: METRICS });

    const company = await createTestEntity({ name: 'Anthropic', entity_type: 'company', organization_id: org.id });
    const sql = getTestDb();
    await sql`UPDATE entities SET metadata = ${sql.json({ aliases: ['Claude.ai', 'Anthropic'] })} WHERE id = ${company.id}`;

    const charge = (m: Record<string, unknown>) =>
      createTestEvent({ organization_id: org.id, content: 'charge', semantic_type: 'transaction', connector_key: 'revolut', metadata: m });
    await charge({ date: '2025-10-08', amount: 78.35, currency: 'GBP', direction: 'out', description: 'Claude.ai' });
    await charge({ date: '2025-11-01', amount: 20.0, currency: 'GBP', direction: 'out', description: 'Anthropic' });
    await charge({ date: '2025-11-01', amount: 20.0, currency: 'GBP', direction: 'out', description: 'Anthropic' }); // dup
    await charge({ date: '2025-11-05', amount: 99.0, currency: 'GBP', direction: 'in', description: 'Claude.ai' }); // refund
  });

  it('query_metric returns the deduped, governed sum', async () => {
    const res = (await queryMetric(
      { entity_type: 'company', measure: 'spend', by: ['currency'] },
      env,
      ctx,
    )) as { rows: Record<string, unknown>[]; row_count: number };
    const gbp = res.rows.find((r) => r.currency === 'GBP');
    expect(Number(gbp?.spend)).toBeCloseTo(98.35, 2);
  });

  it('list_metrics surfaces the catalog', async () => {
    const res = (await listMetrics({}, env, ctx)) as {
      entity_types: Array<{ entity_type: string; measures: { name: string }[]; dimensions: { name: string }[]; segments: { name: string }[] }>;
    };
    const company = res.entity_types.find((e) => e.entity_type === 'company');
    expect(company?.measures.map((m) => m.name)).toContain('spend');
    expect(company?.dimensions.map((d) => d.name)).toContain('currency');
    expect(company?.segments.map((s) => s.name)).toContain('outflow');
  });

  it('list_metrics keyword filter narrows to matching members', async () => {
    const res = (await listMetrics({ q: 'outflow' }, env, ctx)) as {
      entity_types: Array<{ entity_type: string; segments: { name: string }[]; dimensions: { name: string }[] }>;
    };
    const company = res.entity_types.find((e) => e.entity_type === 'company');
    expect(company?.segments.map((s) => s.name)).toContain('outflow');
    // "currency" dimension doesn't match "outflow" → filtered out.
    expect(company?.dimensions.length).toBe(0);
  });
});
