/**
 * connector-health alerter — integration test against real Postgres.
 *
 * Seeds four active connections in one org:
 *   1. all-feeds-failing (every non-deleted feed last_sync_status='failed')
 *   2. zero-feeds (active connection, no non-deleted feeds, past grace age)
 *   3. healthy (a feed that synced successfully recently)
 *   4. deliberately-paused (paused feed, consecutive_failures=0, past success)
 *
 * Asserts the check flags ONLY (1) and (2), leaves (3) and (4) alone, and
 * alerts on the transition into unhealthy — not on every run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONNECTOR_HEALTH_CONFIG,
  runConnectorHealthCheck,
  type UnhealthyReason,
} from '../../connectors/connector-health';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization, createTestUser } from '../setup/test-fixtures';

const cfg = DEFAULT_CONNECTOR_HEALTH_CONFIG;
// Created comfortably outside the min-age grace window so age never masks a flag.
const OLD = new Date(Date.now() - (cfg.minConnectionAgeHours + 24) * 60 * 60 * 1000);

interface SeededConn {
  id: number;
}

async function seedConnection(opts: {
  orgId: string;
  userId: string;
  connectorKey: string;
  slug: string;
  createdAt: Date;
}): Promise<SeededConn> {
  const sql = getTestDb();
  const [row] = await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      created_by, visibility, created_at, updated_at
    ) VALUES (
      ${opts.orgId}, ${opts.connectorKey}, ${opts.slug},
      ${`Conn ${opts.slug}`}, 'active', ${opts.userId}, 'org',
      ${opts.createdAt}, ${opts.createdAt}
    )
    RETURNING id
  `;
  return { id: Number(row.id) };
}

async function seedFeed(opts: {
  orgId: string;
  connectionId: number;
  feedKey: string;
  status?: string;
  lastSyncStatus?: string | null;
  lastSyncAt?: Date | null;
  consecutiveFailures?: number;
  lastError?: string | null;
  deletedAt?: Date | null;
}): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, status,
      last_sync_status, last_sync_at, consecutive_failures, last_error,
      deleted_at, created_at, updated_at
    ) VALUES (
      ${opts.orgId}, ${opts.connectionId}, ${opts.feedKey},
      ${opts.status ?? 'active'},
      ${opts.lastSyncStatus ?? null}, ${opts.lastSyncAt ?? null},
      ${opts.consecutiveFailures ?? 0}, ${opts.lastError ?? null},
      ${opts.deletedAt ?? null}, NOW(), NOW()
    )
  `;
}

describe('connector-health alerter', () => {
  let orgId: string;
  let userId: string;
  let allFailingId: number;
  let zeroFeedsId: number;
  let healthyId: number;
  let pausedId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Connector Health Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'health-owner@test.com' });
    userId = user.id;

    // 1. all-feeds-failing: two feeds, both last_sync_status='failed'.
    const allFailing = await seedConnection({
      orgId,
      userId,
      connectorKey: 'revolut',
      slug: 'all-failing',
      createdAt: OLD,
    });
    allFailingId = allFailing.id;
    await seedFeed({
      orgId,
      connectionId: allFailingId,
      feedKey: 'a',
      lastSyncStatus: 'failed',
      consecutiveFailures: 5,
      lastError: 'Authentication failed — cookies may be expired',
      lastSyncAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });
    await seedFeed({
      orgId,
      connectionId: allFailingId,
      feedKey: 'b',
      lastSyncStatus: 'failed',
      consecutiveFailures: 4,
      lastError: 'Revolut session needs sign-in',
    });
    // A deleted feed that once succeeded must NOT rescue the connection.
    await seedFeed({
      orgId,
      connectionId: allFailingId,
      feedKey: 'deleted-ok',
      lastSyncStatus: 'success',
      lastSyncAt: new Date(),
      deletedAt: new Date(),
    });

    // 2. zero-feeds: active connection with no non-deleted feeds.
    const zeroFeeds = await seedConnection({
      orgId,
      userId,
      connectorKey: 'linkedin',
      slug: 'zero-feeds',
      createdAt: OLD,
    });
    zeroFeedsId = zeroFeeds.id;
    // Only a deleted feed — counts as zero live feeds.
    await seedFeed({
      orgId,
      connectionId: zeroFeedsId,
      feedKey: 'gone',
      lastSyncStatus: 'success',
      lastSyncAt: new Date(),
      deletedAt: new Date(),
    });

    // 3. healthy: a feed that synced successfully today.
    const healthy = await seedConnection({
      orgId,
      userId,
      connectorKey: 'github',
      slug: 'healthy',
      createdAt: OLD,
    });
    healthyId = healthy.id;
    await seedFeed({
      orgId,
      connectionId: healthyId,
      feedKey: 'a',
      lastSyncStatus: 'success',
      lastSyncAt: new Date(),
      consecutiveFailures: 0,
    });
    // A second feed currently failing but the connection is NOT all-failing.
    await seedFeed({
      orgId,
      connectionId: healthyId,
      feedKey: 'b',
      lastSyncStatus: 'failed',
      consecutiveFailures: 1,
    });

    // 4. deliberately-paused: only a paused, never-failing feed with a past
    //    success. Operator intent — must not be flagged.
    const paused = await seedConnection({
      orgId,
      userId,
      connectorKey: 'gmail',
      slug: 'paused',
      createdAt: OLD,
    });
    pausedId = paused.id;
    await seedFeed({
      orgId,
      connectionId: pausedId,
      feedKey: 'a',
      status: 'paused',
      lastSyncStatus: 'success',
      lastSyncAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      consecutiveFailures: 0,
    });
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  function reasonFor(
    details: Awaited<ReturnType<typeof runConnectorHealthCheck>>['details'],
    id: number
  ): UnhealthyReason | undefined {
    return details.find((d) => d.connectionId === id)?.reason;
  }

  it('flags only the unhealthy connections and alerts on the transition', async () => {
    const first = await runConnectorHealthCheck();

    const flagged = new Set(first.details.map((d) => d.connectionId));
    expect(flagged.has(allFailingId)).toBe(true);
    expect(flagged.has(zeroFeedsId)).toBe(true);
    expect(flagged.has(healthyId)).toBe(false);
    expect(flagged.has(pausedId)).toBe(false);

    expect(reasonFor(first.details, allFailingId)).toBe('all_feeds_failing');
    expect(reasonFor(first.details, zeroFeedsId)).toBe('zero_feeds');

    // First run is the transition → both alerts fire.
    expect(first.unhealthy).toBe(2);
    expect(first.newlyAlerted).toBe(2);

    // The marker was persisted for the flagged connections only.
    const sql = getTestDb();
    const marked = (await sql`
      SELECT id FROM connections
      WHERE unhealthy_alerted_at IS NOT NULL
      ORDER BY id
    `) as unknown as Array<{ id: string }>;
    expect(marked.map((r) => Number(r.id)).sort((a, b) => a - b)).toEqual(
      [allFailingId, zeroFeedsId].sort((a, b) => a - b)
    );
  });

  it('does not re-alert on the next run while still unhealthy', async () => {
    const second = await runConnectorHealthCheck();
    // Still detected as unhealthy...
    expect(second.unhealthy).toBe(2);
    // ...but no new alert fires (transition already claimed).
    expect(second.newlyAlerted).toBe(0);
    expect(second.recovered).toBe(0);
  });

  it('re-arms and re-alerts after recovery', async () => {
    const sql = getTestDb();
    // Recover the all-failing connection: its feeds now succeed.
    await sql`
      UPDATE feeds
      SET last_sync_status = 'success',
          last_sync_at = NOW(),
          consecutive_failures = 0
      WHERE connection_id = ${allFailingId} AND deleted_at IS NULL
    `;

    const afterRecovery = await runConnectorHealthCheck();
    expect(afterRecovery.recovered).toBe(1);
    // Marker cleared.
    const [row] = (await sql`
      SELECT unhealthy_alerted_at FROM connections WHERE id = ${allFailingId}
    `) as unknown as Array<{ unhealthy_alerted_at: Date | null }>;
    expect(row.unhealthy_alerted_at).toBeNull();

    // Break it again → alert re-fires (transition NULL→set once more).
    await sql`
      UPDATE feeds
      SET last_sync_status = 'failed', consecutive_failures = 6
      WHERE connection_id = ${allFailingId} AND deleted_at IS NULL
    `;
    const broken = await runConnectorHealthCheck();
    expect(broken.newlyAlerted).toBe(1);
    expect(reasonFor(broken.details, allFailingId)).toBe('all_feeds_failing');
  });
});
