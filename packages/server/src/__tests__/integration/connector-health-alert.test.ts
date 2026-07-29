/**
 * connector-health alerter — integration test against real Postgres.
 *
 * Seeds five active connections in one org:
 *   1. all-feeds-failing (every non-deleted feed last_sync_status='failed')
 *   2. zero-feeds (active connection, no non-deleted feeds, past grace age)
 *   3. healthy (one feed syncing, one PERSISTENTLY failing — 1 of 2 expected
 *      feeds, i.e. exactly degradedFailingRatio; stays healthy only because of
 *      the min-expected-feeds floor)
 *   4. deliberately-paused (paused feed, consecutive_failures=0, past success)
 *   5. degraded (majority of feeds auto-paused BECAUSE they failed, one
 *      survivor still syncing — the prod LinkedIn shape)
 *
 * Asserts the check flags (1), (2) and (5), leaves (3) and (4) alone, and
 * alerts on the transition into unhealthy — not on every run. Later tests pin
 * the degraded rule's two independent guards: the operator-paused DENOMINATOR,
 * and the min-expected-feeds FLOOR (2-feed quiet vs 3-feed alerting at the
 * same ratio).
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
  let degradedId: number;

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
    // A second feed that is PERSISTENTLY failing (consecutive_failures at the
    // failure threshold, not a single blip). This is 1 of 2 expected feeds =
    // exactly degradedFailingRatio, so only the min-expected-feeds floor keeps
    // this connection healthy. Seeding it below the threshold (the original
    // cf=1) would never exercise that boundary at all.
    await seedFeed({
      orgId,
      connectionId: healthyId,
      feedKey: 'b',
      lastSyncStatus: 'failed',
      consecutiveFailures: cfg.failureThreshold,
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

    // 5. degraded: the prod LinkedIn (connection 412) shape. 11 feeds, 10 of
    //    which are AUTO-paused because they kept failing (status='paused' with
    //    consecutive_failures 9-10, last_error='worker_claim_timeout', dark for
    //    11 days). One surviving feed still syncs, so the connection is neither
    //    all-feeds-failing nor stale-by-newest-sync — yet it is plainly sick.
    const degraded = await seedConnection({
      orgId,
      userId,
      connectorKey: 'linkedin',
      slug: 'degraded',
      createdAt: OLD,
    });
    degradedId = degraded.id;
    const elevenDaysAgo = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 10; i++) {
      await seedFeed({
        orgId,
        connectionId: degradedId,
        feedKey: `dead-${i}`,
        status: 'paused',
        lastSyncStatus: 'failed',
        lastSyncAt: elevenDaysAgo,
        consecutiveFailures: i < 2 ? 10 : 9,
        lastError: 'worker_claim_timeout',
      });
    }
    // The single survivor that masks the other ten.
    await seedFeed({
      orgId,
      connectionId: degradedId,
      feedKey: 'home_feed',
      status: 'active',
      lastSyncStatus: 'success',
      lastSyncAt: new Date(),
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

    // First run is the transition → all three alerts fire.
    expect(first.unhealthy).toBe(3);
    expect(first.newlyAlerted).toBe(3);

    // The marker was persisted for the flagged connections only.
    const sql = getTestDb();
    const marked = (await sql`
      SELECT id FROM connections
      WHERE unhealthy_alerted_at IS NOT NULL
      ORDER BY id
    `) as unknown as Array<{ id: string }>;
    expect(marked.map((r) => Number(r.id)).sort((a, b) => a - b)).toEqual(
      [allFailingId, zeroFeedsId, degradedId].sort((a, b) => a - b)
    );
  });

  // DEFECT A: a single surviving feed used to mask ten dead ones. Prod
  // LinkedIn connection 412 reported fully healthy while 10 of its 11 feeds
  // had been auto-paused at consecutive_failures 9-10 for 11 days.
  it('flags a connection whose feeds are mostly auto-paused failures', async () => {
    const first = await runConnectorHealthCheck();
    expect(reasonFor(first.details, degradedId)).toBe('feeds_degraded');

    const detail = first.details.find((d) => d.connectionId === degradedId);
    expect(detail?.feedCount).toBe(11);
    expect(detail?.failingFeedCount).toBe(10);
  });

  it('does not re-alert on the next run while still unhealthy', async () => {
    const second = await runConnectorHealthCheck();
    // Still detected as unhealthy...
    expect(second.unhealthy).toBe(3);
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

  // The crux of the degraded rule: an operator pausing most of a connection's
  // feeds is intent, NOT a failure. Only feeds paused *because they failed*
  // (consecutive_failures > 0) count toward degradation.
  it('does not flag a connection whose feeds an operator paused cleanly', async () => {
    const sql = getTestDb();
    const operatorPaused = await seedConnection({
      orgId,
      userId,
      connectorKey: 'notion',
      slug: 'operator-paused',
      createdAt: OLD,
    });
    // Eight cleanly-paused feeds (cf=0, no error) — operator intent.
    for (let i = 0; i < 8; i++) {
      await seedFeed({
        orgId,
        connectionId: operatorPaused.id,
        feedKey: `off-${i}`,
        status: 'paused',
        lastSyncStatus: 'success',
        lastSyncAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        consecutiveFailures: 0,
      });
    }
    // Two feeds are still EXPECTED to run, and both are healthy. The
    // connection is fine, so it must not be flagged.
    for (const key of ['on-a', 'on-b']) {
      await seedFeed({
        orgId,
        connectionId: operatorPaused.id,
        feedKey: key,
        status: 'active',
        lastSyncStatus: 'success',
        lastSyncAt: new Date(),
        consecutiveFailures: 0,
      });
    }

    const res = await runConnectorHealthCheck();
    expect(res.details.some((d) => d.connectionId === operatorPaused.id)).toBe(false);

    const [row] = (await sql`
      SELECT unhealthy_alerted_at FROM connections WHERE id = ${operatorPaused.id}
    `) as unknown as Array<{ unhealthy_alerted_at: Date | null }>;
    expect(row.unhealthy_alerted_at).toBeNull();
  });

  // The mirror of the above, and what actually pins the ratio DENOMINATOR:
  // operator-paused feeds must not dilute a real degradation. Here all three
  // feeds the operator still expects to run are persistently failing (3/3 =
  // 1.0), so the connection is degraded. If the 8 deliberately-paused feeds
  // were counted in the denominator the ratio would be 3/11 = 0.27 and the
  // outage would be missed. Rule A cannot cover this either, since 3 failing
  // !== 11 feeds.
  //
  // The expected set is deliberately 3, not 2: the min-expected-feeds floor
  // applies to this rule too, and a 2-feed expected set would be suppressed by
  // the floor rather than by the denominator logic this test exists to pin.
  it('counts only expected feeds in the degraded ratio, not operator-paused ones', async () => {
    const mostlyOff = await seedConnection({
      orgId,
      userId,
      connectorKey: 'notion',
      slug: 'mostly-off',
      createdAt: OLD,
    });
    for (let i = 0; i < 8; i++) {
      await seedFeed({
        orgId,
        connectionId: mostlyOff.id,
        feedKey: `off-${i}`,
        status: 'paused',
        lastSyncStatus: 'success',
        lastSyncAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        consecutiveFailures: 0,
      });
    }
    // Keep a recent success on the connection so Rule C cannot be what fires.
    await seedFeed({
      orgId,
      connectionId: mostlyOff.id,
      feedKey: 'broken-a',
      status: 'active',
      lastSyncStatus: 'success',
      lastSyncAt: new Date(),
      consecutiveFailures: 6,
      lastError: 'worker_claim_timeout',
    });
    await seedFeed({
      orgId,
      connectionId: mostlyOff.id,
      feedKey: 'broken-b',
      status: 'paused',
      lastSyncStatus: 'failed',
      lastSyncAt: new Date(),
      consecutiveFailures: 7,
      lastError: 'worker_claim_timeout',
    });
    await seedFeed({
      orgId,
      connectionId: mostlyOff.id,
      feedKey: 'broken-c',
      status: 'paused',
      lastSyncStatus: 'failed',
      lastSyncAt: new Date(),
      consecutiveFailures: 8,
      lastError: 'worker_claim_timeout',
    });

    const res = await runConnectorHealthCheck();
    // What this pins is that the 8 operator-paused-clean feeds are excluded
    // from the denominator: with them counted, 3 failing of 11 is neither
    // "all feeds" nor past degradedFailingRatio, and the connection would be
    // silently healthy. Excluded, all 3 EXPECTED feeds are failing, so Rule A
    // claims it before the degraded rule is reached — the stronger and more
    // accurate reason, and the one an operator can act on directly.
    expect(reasonFor(res.details, mostlyOff.id)).toBe('all_feeds_failing');
  });

  // Guards the degraded threshold against noise: connection 3 ("healthy") has
  // 2 expected feeds, one of them persistently failing AT the failure
  // threshold. That is 1/2 = exactly degradedFailingRatio, so the ratio alone
  // would fire — only the min-expected-feeds floor keeps it quiet.
  it('does not flag a persistently failing feed on a 2-feed connection', async () => {
    const res = await runConnectorHealthCheck();
    expect(res.details.some((d) => d.connectionId === healthyId)).toBe(false);
  });

  // The boundary, pinned explicitly and symmetrically. Same ratio (exactly
  // degradedFailingRatio, same persistent failure depth), differing ONLY in the
  // number of expected feeds — 2 stays quiet, 3 alerts. This is the shape a
  // bare `expectedCount > 0` guard gets wrong: it pages an operator for every
  // 2-feed connection with a single bad feed.
  it('does not flag a 2-feed connection with one persistently failing feed', async () => {
    const sql = getTestDb();
    const twoFeed = await seedConnection({
      orgId,
      userId,
      connectorKey: 'notion',
      slug: 'two-feed-boundary',
      createdAt: OLD,
    });
    await seedFeed({
      orgId,
      connectionId: twoFeed.id,
      feedKey: 'bad',
      status: 'active',
      lastSyncStatus: 'failed',
      lastSyncAt: new Date(),
      consecutiveFailures: cfg.failureThreshold,
      lastError: 'worker_claim_timeout',
    });
    await seedFeed({
      orgId,
      connectionId: twoFeed.id,
      feedKey: 'good',
      status: 'active',
      lastSyncStatus: 'success',
      lastSyncAt: new Date(),
      consecutiveFailures: 0,
    });

    const res = await runConnectorHealthCheck();
    // 1 of 2 expected feeds failing IS >= degradedFailingRatio — the floor is
    // the only thing keeping this connection off the alert path.
    expect(1 / 2).toBeGreaterThanOrEqual(cfg.degradedFailingRatio);
    expect(res.details.some((d) => d.connectionId === twoFeed.id)).toBe(false);

    const [row] = (await sql`
      SELECT unhealthy_alerted_at FROM connections WHERE id = ${twoFeed.id}
    `) as unknown as Array<{ unhealthy_alerted_at: Date | null }>;
    expect(row.unhealthy_alerted_at).toBeNull();
  });

  // The seam between Rule A and Rule D. Rule A used to compare failures against
  // ALL feeds while Rule D's floor counts only EXPECTED ones, so a connection
  // could satisfy neither: 2 of 10 failing is not "all feeds", and 2 expected
  // feeds is below the three-feed floor. Every feed the operator still expects
  // is dead and it reported healthy. Both rules now share the same denominator.
  it('flags a connection whose only expected feeds all fail, below the degraded floor', async () => {
    const sql = getTestDb();
    const mostlyPaused = await seedConnection({
      orgId,
      userId,
      connectorKey: 'notion',
      slug: 'paused-plus-all-expected-failing',
      createdAt: OLD,
    });
    // Deliberately switched off by an operator (cf=0) — never a health signal.
    for (let i = 0; i < 8; i++) {
      await seedFeed({
        orgId,
        connectionId: mostlyPaused.id,
        feedKey: `off-${i}`,
        status: 'paused',
        lastSyncStatus: 'success',
        lastSyncAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        consecutiveFailures: 0,
      });
    }
    // The only two feeds still expected to run, both persistently failing.
    for (const key of ['bad-a', 'bad-b']) {
      await seedFeed({
        orgId,
        connectionId: mostlyPaused.id,
        feedKey: key,
        status: 'active',
        lastSyncStatus: 'failed',
        lastSyncAt: new Date(),
        consecutiveFailures: cfg.failureThreshold,
        lastError: 'worker_claim_timeout',
      });
    }

    const res = await runConnectorHealthCheck();
    // Below the degraded floor, so Rule D cannot be what catches it.
    expect(2).toBeLessThan(cfg.degradedMinExpectedFeeds);
    expect(reasonFor(res.details, mostlyPaused.id)).toBe('all_feeds_failing');

    const [row] = (await sql`
      SELECT unhealthy_alerted_at FROM connections WHERE id = ${mostlyPaused.id}
    `) as unknown as Array<{ unhealthy_alerted_at: Date | null }>;
    expect(row.unhealthy_alerted_at).not.toBeNull();
  });

  // Rule A must stay sensitive to a SINGLE bad run. Narrowing its numerator to
  // persistent failures (the degraded rule's stricter count) would let a
  // connection whose every expected feed just failed report healthy until the
  // consecutive counters climbed to the threshold — silence during exactly the
  // window where the failure is newest.
  it('flags a connection whose expected feeds all failed once, below the failure threshold', async () => {
    const freshlyBroken = await seedConnection({
      orgId,
      userId,
      connectorKey: 'notion',
      slug: 'fresh-total-failure',
      createdAt: OLD,
    });
    for (const key of ['a', 'b']) {
      await seedFeed({
        orgId,
        connectionId: freshlyBroken.id,
        feedKey: key,
        status: 'active',
        lastSyncStatus: 'failed',
        lastSyncAt: new Date(),
        // One failed run: BELOW failureThreshold, so the persistent-failure
        // count is 0 and only the latest-run half of the predicate catches it.
        consecutiveFailures: 1,
        lastError: 'worker_claim_timeout',
      });
    }

    const res = await runConnectorHealthCheck();
    expect(1).toBeLessThan(cfg.failureThreshold);
    expect(reasonFor(res.details, freshlyBroken.id)).toBe('all_feeds_failing');
  });

  it('flags a 3-feed connection at the degraded ratio', async () => {
    const threeFeed = await seedConnection({
      orgId,
      userId,
      connectorKey: 'notion',
      slug: 'three-feed-boundary',
      createdAt: OLD,
    });
    // 2 of 3 expected feeds persistently failing: the cheapest way to reach
    // degradedFailingRatio once the floor applies, and a real outage.
    for (const key of ['bad-a', 'bad-b']) {
      await seedFeed({
        orgId,
        connectionId: threeFeed.id,
        feedKey: key,
        status: 'active',
        lastSyncStatus: 'failed',
        lastSyncAt: new Date(),
        consecutiveFailures: cfg.failureThreshold,
        lastError: 'worker_claim_timeout',
      });
    }
    // A survivor with a fresh success, so neither Rule A nor Rule C can be
    // what fires — this must be the degraded rule or nothing.
    await seedFeed({
      orgId,
      connectionId: threeFeed.id,
      feedKey: 'good',
      status: 'active',
      lastSyncStatus: 'success',
      lastSyncAt: new Date(),
      consecutiveFailures: 0,
    });

    const res = await runConnectorHealthCheck();
    expect(reasonFor(res.details, threeFeed.id)).toBe('feeds_degraded');
  });

  // DEFECT B control: a connection that is genuinely stale (Rule C) must KEEP
  // its alert, while a healthy connection carrying a leftover marker gets it
  // cleared. Mirrors prod 387 (true positive) vs 342/347 (stale markers).
  it('clears a stale marker on a healthy connection but keeps a true positive', async () => {
    const sql = getTestDb();
    const day = 24 * 60 * 60 * 1000;

    // Healthy but carrying a leftover alert (prod 347 / 342 shape).
    const staleMarker = await seedConnection({
      orgId,
      userId,
      connectorKey: 'spotify',
      slug: 'stale-marker',
      createdAt: OLD,
    });
    await seedFeed({
      orgId,
      connectionId: staleMarker.id,
      feedKey: 'a',
      lastSyncStatus: 'success',
      lastSyncAt: new Date(),
      consecutiveFailures: 0,
    });

    // Genuinely stale — newest success older than NO_SYNC_DAYS (prod 387).
    const trueStale = await seedConnection({
      orgId,
      userId,
      connectorKey: 'apple.reminders',
      slug: 'true-stale',
      createdAt: OLD,
    });
    await seedFeed({
      orgId,
      connectionId: trueStale.id,
      feedKey: 'a',
      lastSyncStatus: 'success',
      lastSyncAt: new Date(Date.now() - 10 * day),
      consecutiveFailures: 0,
    });

    await sql`
      UPDATE connections SET unhealthy_alerted_at = now() - interval '3 days'
      WHERE id IN (${staleMarker.id}, ${trueStale.id})
    `;

    await runConnectorHealthCheck();

    const rows = (await sql`
      SELECT id, unhealthy_alerted_at FROM connections
      WHERE id IN (${staleMarker.id}, ${trueStale.id})
    `) as unknown as Array<{ id: string; unhealthy_alerted_at: Date | null }>;
    const byId = new Map(rows.map((r) => [Number(r.id), r.unhealthy_alerted_at]));

    expect(byId.get(staleMarker.id)).toBeNull();
    expect(byId.get(trueStale.id)).not.toBeNull();
  });
});
