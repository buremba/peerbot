/**
 * SPIKE — what does the materializer itself cost?
 *
 * `declared-edges-scale.test.ts` proves the two sweeps use their indexes. That
 * is necessary and not sufficient: the sweeps are one query each, while the
 * per-item path runs a fixed handful of round-trips for EVERY item in the
 * batch. On an ERP sync that is the whole cost, and no EXPLAIN will show it.
 *
 * So this measures two things:
 *
 *   1. Round-trips per item — exact, deterministic, and the number that
 *      actually scales. Asserted, so adding a query inside the loop fails here
 *      rather than in production.
 *   2. Wall time per item across growing batches — logged, and asserted only
 *      for SHAPE (linear, not quadratic), because absolute timings on shared CI
 *      hardware are noise.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import type { DbClient } from '../../db/client';
import { type DeclaredEdgeRule, materializeDeclaredEdges } from '../declared-edges-spike';
import { applyEventAttributions, clearEntityLinkRulesCache } from '../entity-link-upsert';
import { ensureMemberEntityType } from '../member-entity-type';

const FEED_KEY = 'documents';

const RULES: DeclaredEdgeRule[] = [
  {
    type: 'invoice_customer',
    name: 'bench_rule',
    from: {
      entityType: '$member',
      identities: [{ namespace: 'erp_invoice', eventPath: 'metadata.origin_id' }],
    },
    to: {
      entityType: '$member',
      identities: [{ namespace: 'erp_customer', eventPath: 'metadata.customer_origin_id' }],
    },
  },
];

function invoices(count: number, seed: string) {
  return Array.from({ length: count }, (_, i) => ({
    origin_type: 'invoice',
    metadata: {
      origin_id: `${seed}-INV-${i}`,
      // A realistic fan-in: many invoices per customer.
      customer_origin_id: `${seed}-CARI-${i % Math.max(1, Math.floor(count / 10))}`,
      customer_name: `Customer ${i % 10}`,
    },
  }));
}

/**
 * Counts tagged-template calls. postgres.js exposes `sql` as a callable with
 * methods hanging off it, so the apply trap sees exactly one hit per query
 * while `.json()` / `.begin()` still resolve normally.
 */
function countingSql(inner: DbClient): { proxy: DbClient; count: () => number } {
  let calls = 0;
  const proxy = new Proxy(inner as unknown as (...a: unknown[]) => unknown, {
    apply(target, _thisArg, args) {
      calls += 1;
      return Reflect.apply(target, inner, args);
    },
    get(target, prop, receiver) {
      const value = Reflect.get(target as object, prop, receiver);
      return typeof value === 'function' ? value.bind(inner) : value;
    },
  }) as unknown as DbClient;
  return { proxy, count: () => calls };
}

async function seed(name: string, items: Array<Record<string, unknown>>) {
  const org = await createTestOrganization({ name });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  await ensureMemberEntityType(org.id);
  clearEntityLinkRulesCache();

  await createTestConnectorDefinition({
    key: 'prodma',
    name: 'prodma',
    organization_id: org.id,
    feeds_schema: {
      [FEED_KEY]: {
        eventKinds: {
          invoice: {
            attributions: [
              {
                role: 'belongs_to',
                autoCreate: true,
                target: {
                  entityType: '$member',
                  titlePath: 'metadata.origin_id',
                  identities: [{ namespace: 'erp_invoice', eventPath: 'metadata.origin_id' }],
                },
              },
              {
                role: 'about',
                autoCreate: true,
                target: {
                  entityType: '$member',
                  titlePath: 'metadata.customer_name',
                  identities: [
                    { namespace: 'erp_customer', eventPath: 'metadata.customer_origin_id' },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  });
  clearEntityLinkRulesCache();

  const connection = await createTestConnection({
    organization_id: org.id,
    connector_key: 'prodma',
    display_name: 'Prodma',
    created_by: user.id,
    createDefaultFeed: false,
  });
  const sql = getTestDb();
  await sql`
    INSERT INTO entity_relationship_types (organization_id, slug, name, status, created_at, updated_at)
    VALUES (${org.id}, 'invoice_customer', 'invoice_customer', 'active', current_timestamp, current_timestamp)
  `;
  await applyEventAttributions({
    connectorKey: 'prodma',
    connectionId: connection.id,
    feedKey: FEED_KEY,
    orgId: org.id,
    items,
  });
  return { org, user, connection };
}

describe('SPIKE: what the declared-edge materializer costs per item', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('spends a FIXED number of round-trips per item, independent of batch size', async () => {
    const perItem: number[] = [];

    for (const size of [10, 40]) {
      const items = invoices(size, `S${size}`);
      const { org, user, connection } = await seed(`rt org ${size}`, items);

      const { proxy, count } = countingSql(getTestDb());
      await materializeDeclaredEdges({
        orgId: org.id,
        connectionId: connection.id,
        ruleVersion: '1',
        rules: RULES,
        items,
        createdBy: user.id,
        syncToken: `bench-${size}`,
        sql: proxy,
      });
      perItem.push(count() / size);
      await cleanupTestDatabase();
      clearEntityLinkRulesCache();
    }

    // eslint-disable-next-line no-console
    console.log(`[bench] round-trips per item: ${perItem.map((n) => n.toFixed(1)).join(' -> ')}`);

    // The per-item cost must not grow with batch size — that would mean work
    // proportional to what came before, which is how a sync that is fine at 100
    // items falls over at 100k.
    expect(perItem[1]).toBeLessThanOrEqual(perItem[0] + 0.5);

    // And it is a real per-item cost, not amortized: this is the number to beat
    // if the materializer is ever batched. Recorded so a regression is visible.
    expect(perItem[0]).toBeGreaterThan(1);
    expect(perItem[0]).toBeLessThan(20);
  });

  it('scales linearly in wall time, not quadratically', async () => {
    const timings: Array<{ size: number; perItemMs: number }> = [];

    for (const size of [25, 100]) {
      const items = invoices(size, `T${size}`);
      const { org, user, connection } = await seed(`time org ${size}`, items);

      const started = performance.now();
      const result = await materializeDeclaredEdges({
        orgId: org.id,
        connectionId: connection.id,
        ruleVersion: '1',
        rules: RULES,
        items,
        createdBy: user.id,
        syncToken: `time-${size}`,
      });
      const elapsed = performance.now() - started;
      expect(result.created).toBe(size);
      timings.push({ size, perItemMs: elapsed / size });
      await cleanupTestDatabase();
      clearEntityLinkRulesCache();
    }

    // eslint-disable-next-line no-console
    console.log(
      `[bench] ms per item: ${timings
        .map((t) => `${t.size}=${t.perItemMs.toFixed(2)}ms`)
        .join(' ')}`
    );

    // Deliberately loose: this catches an O(n^2) regression, not a slow day on
    // CI. A quadratic path would show per-item cost growing with n, so 4x the
    // batch would be ~4x the per-item cost.
    expect(timings[1].perItemMs).toBeLessThan(timings[0].perItemMs * 3 + 5);
  });
});
