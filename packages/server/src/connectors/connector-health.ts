/**
 * Connector-health alerter.
 *
 * Per-feed hard auto-pause + `feed.auto_paused` covers feeds that keep failing
 * on run. It cannot catch a connector that has silently stopped scheduling
 * runs, an active connection that collects nothing, a whole connection whose
 * every feed is dead, or a connection where most feeds have been auto-paused
 * while one survivor masks them. Those failure modes used to surface to nobody
 * for weeks in prod (expired Revolut sessions, LinkedIn connection 412 dark
 * for 11 days, etc.).
 *
 * This module is a periodic, read-only scan over `connections` + `feeds` that
 * classifies each active connection as healthy or unhealthy by clear rules and
 * emits a structured `logger.error` for each NEWLY-unhealthy connection. That
 * `logger.error` is forwarded by the pino→Sentry bridge (`utils/logger.ts`) to
 * the existing Sentry→Slack alert path — no new alerting infra.
 *
 * Multi-replica safety: registered as a single-claimant scheduled job (one
 * claimant per tick via the runs-queue), AND the per-connection dedupe is
 * Postgres-mediated — `connections.unhealthy_alerted_at` is flipped NULL→now()
 * by an atomic conditional UPDATE, so the alert fires exactly once on the
 * transition into unhealthy (re-armed by a NULL reset on recovery). No per-pod
 * in-memory state is read or mutated across replicas.
 */

import { type DbClient, getDb } from '../db/client';
import { notifyBrowserAuthExpired } from '../notifications/triggers';
import logger from '../utils/logger';

/**
 * Does this feed error look like an expired/invalid site session (the user must
 * re-login), rather than infra/transport (offline device, network, 5xx)? Used
 * to fire a user-facing "needs sign-in" notification on top of the operator
 * alert. Kept deliberately tight so device-offline ("No online paired Owletto
 * Chrome extension …") and generic failures are NOT misclassified as auth.
 */
const AUTH_EXPIRED_RE =
  /(sign[\s-]?in|\bsso\b|re-?auth|reauthenticat|session\s+(?:expired|needs|invalid|timed)|cookies?[\s\S]{0,30}expired|authentication\s+failed|unauthor|login\s+required|not\s+logged\s*in)/i;

export function isBrowserAuthExpiredError(lastError: string | null | undefined): boolean {
  return !!lastError && AUTH_EXPIRED_RE.test(lastError);
}

/**
 * A feed is "failing" if its most recent sync failed OR it has accumulated at
 * least this many consecutive failures.
 */
const FAILURE_THRESHOLD = 3;

/**
 * Don't flag a connection until it has had time to do its first sync. A
 * just-created connection with no successful sync yet is not "dying".
 */
const MIN_CONNECTION_AGE_HOURS = 24;

/**
 * An active connection with zero non-deleted feeds older than this is
 * collecting nothing and is flagged. (Consent-only / managed-grant connections
 * legitimately have no feeds, but they are not `status='active'` collectors —
 * see scoping in the query.)
 */
const ZERO_FEEDS_GRACE_HOURS = 48;

/**
 * A connection that was collecting (at least one feed has a past successful
 * sync) but whose newest successful sync across all feeds is older than this is
 * flagged as "stopped collecting".
 */
const NO_SYNC_DAYS = 7;

/**
 * Fraction of the feeds a connection is still expected to run that must be
 * PERSISTENTLY failing before the connection is "degraded" — sick even though
 * at least one feed still works.
 *
 * Why a proportion and not "any failing feed": a single transiently-failing
 * feed alongside nine healthy ones is normal operational noise, and alerting on
 * it would make the signal useless. Why 0.5: a connection collecting less than
 * half of what it is configured to collect is materially broken. Prod LinkedIn
 * connection 412 sat at 10/11 = 0.91 for eleven days while reporting fully
 * healthy.
 *
 * This ratio ALONE is not enough: it is trivially reachable on a tiny
 * connection (1 of 2 expected feeds failing is exactly 0.5 and fires), which
 * would page an operator for a single bad feed. `DEGRADED_MIN_EXPECTED_FEEDS`
 * below is what keeps that quiet — see its docstring.
 */
const DEGRADED_FAILING_RATIO = 0.5;

/**
 * Minimum number of expected feeds (feeds the operator has NOT deliberately
 * paused) a connection must have before the degraded rule may fire at all.
 *
 * A ratio is meaningless at small denominators. With 2 expected feeds, one
 * persistently-failing feed is 1/2 = 0.5 and clears `DEGRADED_FAILING_RATIO`
 * — so without this floor every 2-feed connection with one bad feed pages an
 * operator, which is exactly the alert fatigue the degraded rule exists to
 * avoid. At 3 expected feeds the cheapest way to reach the ratio is 2 of 3
 * feeds persistently failing, which is a real outage rather than one flaky
 * feed.
 *
 * The floor does NOT weaken coverage of the case this rule was built for: prod
 * LinkedIn 412 has 11 expected feeds with 10 failing. And a small connection
 * whose feeds ALL fail is still caught — by Rule A (`all_feeds_failing`), which
 * has no floor. What the floor gives up is exactly one shape: a 1-or-2-feed
 * connection that is partly (not wholly) failing. That is deliberate.
 *
 * Pinned by 'does not flag a 2-feed connection with one persistently failing
 * feed' and 'flags a 3-feed connection at the degraded ratio' in
 * `__tests__/integration/connector-health-alert.test.ts`.
 */
const DEGRADED_MIN_EXPECTED_FEEDS = 3;

export interface ConnectorHealthConfig {
  failureThreshold: number;
  minConnectionAgeHours: number;
  zeroFeedsGraceHours: number;
  noSyncDays: number;
  degradedFailingRatio: number;
  degradedMinExpectedFeeds: number;
}

export const DEFAULT_CONNECTOR_HEALTH_CONFIG: ConnectorHealthConfig = {
  failureThreshold: FAILURE_THRESHOLD,
  minConnectionAgeHours: MIN_CONNECTION_AGE_HOURS,
  zeroFeedsGraceHours: ZERO_FEEDS_GRACE_HOURS,
  noSyncDays: NO_SYNC_DAYS,
  degradedFailingRatio: DEGRADED_FAILING_RATIO,
  degradedMinExpectedFeeds: DEGRADED_MIN_EXPECTED_FEEDS,
};

export type UnhealthyReason =
  | 'all_feeds_failing'
  | 'feeds_degraded'
  | 'zero_feeds'
  | 'no_recent_sync';

export interface UnhealthyConnection {
  connectionId: number;
  organizationId: string;
  connectorKey: string;
  displayName: string | null;
  reason: UnhealthyReason;
  feedCount: number;
  failingFeedCount: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface ConnectorHealthResult {
  scanned: number;
  unhealthy: number;
  /** Connections that transitioned into unhealthy on THIS run (alerts fired). */
  newlyAlerted: number;
  /** Connections that recovered on THIS run (marker re-armed). */
  recovered: number;
  /** Newly-unhealthy connections whose failure was an expired site session,
   * for which a user-facing "needs sign-in" notification was sent. */
  authNotified: number;
  details: UnhealthyConnection[];
}

interface HealthDeps {
  sql?: DbClient;
  config?: ConnectorHealthConfig;
  now?: () => number;
  /** Injectable for tests; defaults to the real browser-auth-expired trigger. */
  notifyAuthExpired?: typeof notifyBrowserAuthExpired;
}

interface UnhealthyRow {
  id: string;
  organization_id: string;
  connector_key: string;
  display_name: string | null;
  feed_count: string;
  failing_feed_count: string;
  active_feed_count: string;
  operator_paused_feed_count: string;
  persistently_failing_feed_count: string;
  failing_expected_feed_count: string;
  newest_sync_at: Date | null;
  last_error: string | null;
}

/**
 * The detection query. Read-only. Returns one row per active, non-deleted
 * connection that is past the min-age grace window, with aggregates over its
 * non-deleted feeds, so the JS classifier can decide healthy vs. unhealthy
 * (and which rule tripped). NOTE: post-`connections`-unify, chat connections
 * (slack/telegram) share this SAME `connections` table with connector
 * connections — they no longer live in a separate table. The query below has
 * NO connector_key filter, and chat connections own zero feeds, so they would
 * trip the `zero_feeds` rule and false-positive as unhealthy. Verify whether a
 * chat-platform exclusion is needed before relying on this scan's output.
 */
async function loadConnectionHealthRows(
  sql: DbClient,
  cfg: ConnectorHealthConfig
): Promise<UnhealthyRow[]> {
  return (await sql`
    SELECT
      c.id,
      c.organization_id,
      c.connector_key,
      c.display_name,
      COUNT(f.id) AS feed_count,
      COUNT(f.id) FILTER (
        WHERE f.last_sync_status = 'failed'
           OR f.consecutive_failures >= ${cfg.failureThreshold}
      ) AS failing_feed_count,
      -- A feed counts toward "healthy collector" if it is NOT a deliberately
      -- paused, never-failing feed. Paused feeds with consecutive_failures = 0
      -- are operator-intended pauses — they must not make the connection look
      -- unhealthy.
      COUNT(f.id) FILTER (
        WHERE NOT (f.status = 'paused' AND f.consecutive_failures = 0)
      ) AS active_feed_count,
      -- Feeds an OPERATOR deliberately switched off: paused with a clean
      -- failure counter. These are intent, so they are excluded from the
      -- degraded-ratio denominator entirely — pausing 9 of 10 feeds on purpose
      -- must never read as a dying connection. Distinct from a feed the system
      -- AUTO-paused after repeated failures (paused with consecutive_failures
      -- > 0), which is a symptom and stays in the denominator.
      COUNT(f.id) FILTER (
        WHERE f.status = 'paused' AND f.consecutive_failures = 0
      ) AS operator_paused_feed_count,
      -- Feeds failing PERSISTENTLY (past the failure threshold), as opposed to
      -- failing_feed_count which also counts a single most-recent-run blip.
      -- Only persistent failures feed the degraded ratio, so one transiently
      -- failing feed on a small connection is not an alert.
      COUNT(f.id) FILTER (
        WHERE f.consecutive_failures >= ${cfg.failureThreshold}
      ) AS persistently_failing_feed_count,
      -- Rule A's numerator: the SAME "failing" predicate as
      -- failing_feed_count (a single most-recent-run failure counts), but over
      -- expected feeds only. Rule A must stay sensitive to one bad run —
      -- narrowing it to persistent failures would let a connection whose every
      -- expected feed just failed report healthy until the counters climb.
      COUNT(f.id) FILTER (
        WHERE NOT (f.status = 'paused' AND f.consecutive_failures = 0)
          AND (
            f.last_sync_status = 'failed'
            OR f.consecutive_failures >= ${cfg.failureThreshold}
          )
      ) AS failing_expected_feed_count,
      MAX(f.last_sync_at) FILTER (WHERE f.last_sync_status = 'success') AS newest_sync_at,
      (ARRAY_AGG(f.last_error) FILTER (WHERE f.last_error IS NOT NULL))[1] AS last_error
    FROM connections c
    LEFT JOIN feeds f
      ON f.connection_id = c.id
     AND f.deleted_at IS NULL
    WHERE c.status = 'active'
      AND c.deleted_at IS NULL
      AND c.created_at <= now() - make_interval(hours => ${cfg.minConnectionAgeHours})
    GROUP BY c.id, c.organization_id, c.connector_key, c.display_name
  `) as unknown as UnhealthyRow[];
}

/**
 * Classify a single connection row. Returns the tripped rule, or null if
 * healthy. Order matters: zero-feeds is checked before all-feeds-failing
 * (which is vacuously true with zero feeds).
 */
function classify(
  row: UnhealthyRow,
  cfg: ConnectorHealthConfig,
  nowMs: number
): UnhealthyReason | null {
  const feedCount = Number(row.feed_count);
  const activeCount = Number(row.active_feed_count);
  const operatorPausedCount = Number(row.operator_paused_feed_count);
  const persistentlyFailingCount = Number(row.persistently_failing_feed_count);
  const failingExpectedCount = Number(row.failing_expected_feed_count);

  // Rule B: active connection, zero non-deleted feeds. (Grace handled by the
  // query's min-age window — a connection that has existed > min age and still
  // has no feeds is collecting nothing.)
  if (feedCount === 0) return 'zero_feeds';

  // A connection whose only feeds are deliberately paused (cf=0) is NOT
  // unhealthy — operator intent. activeCount === 0 means every feed is a
  // paused-clean feed.
  if (activeCount === 0) return null;

  // Rule A: every feed the operator still EXPECTS to run is failing.
  //
  // The denominator is expected feeds, not all feeds — the same one Rule D
  // uses. Comparing against `feedCount` instead left a hole exactly where the
  // two rules meet: a connection with 8 deliberately-paused-clean feeds and 2
  // persistently failing ones satisfies neither `2 === 10` nor Rule D's
  // three-expected-feed floor, so it reported healthy while 100% of what it was
  // still expected to collect was dead. Deliberately switching feeds off must
  // never make the remaining failures harder to see.
  //
  // The PREDICATE is unchanged from the original rule — a feed counts as
  // failing if its latest sync failed OR it is past the failure threshold.
  // Only the denominator narrowed. Reusing the degraded rule's stricter
  // persistent-failure count here would have been a second regression: a
  // connection whose every expected feed just failed once would report healthy
  // until the counters climbed to the threshold.
  const expectedCount = feedCount - operatorPausedCount;
  if (expectedCount > 0 && failingExpectedCount === expectedCount) {
    return 'all_feeds_failing';
  }

  // Rule D: a substantial proportion of the feeds the operator still expects to
  // run are failing, but at least one survivor keeps Rule A from firing. That
  // survivor also refreshes newest_sync_at, so Rule C cannot catch this either
  // — without this rule the connection reports fully healthy while most of it
  // is dark (prod LinkedIn 412: 10 of 11 feeds auto-paused for eleven days).
  //
  // The denominator excludes operator-paused-clean feeds so that deliberately
  // switching feeds off never trips the rule; only feeds that are running or
  // were auto-paused BY failure are counted. The numerator counts only
  // PERSISTENT failures, so a single bad run on a small connection stays quiet.
  //
  // The min-expected-feeds floor is load-bearing, not belt-and-braces: at 2
  // expected feeds one persistent failure is exactly the ratio and would fire.
  // Small connections that are WHOLLY failing are still caught by Rule A above.
  if (
    expectedCount >= cfg.degradedMinExpectedFeeds &&
    persistentlyFailingCount / expectedCount >= cfg.degradedFailingRatio
  ) {
    return 'feeds_degraded';
  }

  // Rule C: was collecting but stopped. Only applies when at least one feed
  // once succeeded (newest_sync_at not null) — a connection that never synced
  // is covered by the failing/zero rules, not this one (avoids false-flagging
  // brand-new feeds that simply haven't had a successful run yet).
  if (row.newest_sync_at) {
    const ageMs = nowMs - new Date(row.newest_sync_at).getTime();
    if (ageMs > cfg.noSyncDays * 24 * 60 * 60 * 1000) return 'no_recent_sync';
  }

  return null;
}

/**
 * Run one connector-health scan. Emits a `logger.error` per newly-unhealthy
 * connection (transition into unhealthy), re-arms the marker for recovered
 * connections, and is a no-op alert-wise for connections that are still
 * unhealthy from a prior run.
 */
export async function runConnectorHealthCheck(
  deps: HealthDeps = {}
): Promise<ConnectorHealthResult> {
  const sql = deps.sql ?? getDb();
  const cfg = deps.config ?? DEFAULT_CONNECTOR_HEALTH_CONFIG;
  const nowMs = (deps.now ?? (() => Date.now()))();
  const notifyAuthExpired = deps.notifyAuthExpired ?? notifyBrowserAuthExpired;

  const rows = await loadConnectionHealthRows(sql, cfg);

  const result: ConnectorHealthResult = {
    scanned: rows.length,
    unhealthy: 0,
    newlyAlerted: 0,
    recovered: 0,
    authNotified: 0,
    details: [],
  };

  const unhealthyIds: number[] = [];

  for (const row of rows) {
    const reason = classify(row, cfg, nowMs);
    const connectionId = Number(row.id);

    if (!reason) {
      // Healthy: re-arm the alert if it was previously flagged. The conditional
      // WHERE makes this a no-op for connections that were already healthy, and
      // counts a real recovery exactly once across replicas.
      const cleared = (await sql`
        UPDATE connections
        SET unhealthy_alerted_at = NULL, updated_at = now()
        WHERE id = ${connectionId}
          AND unhealthy_alerted_at IS NOT NULL
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      if (cleared.length > 0) result.recovered += 1;
      continue;
    }

    result.unhealthy += 1;
    unhealthyIds.push(connectionId);

    const detail: UnhealthyConnection = {
      connectionId,
      organizationId: row.organization_id,
      connectorKey: row.connector_key,
      displayName: row.display_name,
      reason,
      feedCount: Number(row.feed_count),
      failingFeedCount: Number(row.failing_feed_count),
      lastSyncAt: row.newest_sync_at ? new Date(row.newest_sync_at).toISOString() : null,
      lastError: row.last_error,
    };
    result.details.push(detail);

    // Transition claim: only the replica whose UPDATE actually flips the marker
    // NULL→now() owns the alert. Concurrent ticks on other replicas get zero
    // rows back and stay silent — Postgres-mediated, no in-memory dedupe.
    const claimed = (await sql`
      UPDATE connections
      SET unhealthy_alerted_at = now(), updated_at = now()
      WHERE id = ${connectionId}
        AND unhealthy_alerted_at IS NULL
      RETURNING id
    `) as unknown as Array<{ id: string }>;

    if (claimed.length === 0) continue; // already alerted on a prior tick

    result.newlyAlerted += 1;

    // The alert. logger.error → pino→Sentry bridge → Sentry→Slack. A stable
    // `msg` keeps Sentry grouping per reason; the structured fields carry the
    // org/connector identifiers an operator needs to act.
    logger.error(
      {
        connection_id: connectionId,
        organization_id: row.organization_id,
        connector_key: row.connector_key,
        connection_display_name: row.display_name,
        reason,
        feed_count: detail.feedCount,
        failing_feed_count: detail.failingFeedCount,
        last_successful_sync_at: detail.lastSyncAt,
        last_error: detail.lastError,
      },
      `[connector-health] connector unhealthy (${reason}): ${row.connector_key}`
    );

    // On the unhealthy transition, if the failure is an expired site session
    // (not an offline device / transport error), also notify the org's admins
    // to re-login — the operator alert above can't reach the person who has to
    // sign in. Deduped by the same unhealthy_alerted_at claim, so it fires once
    // per episode. Best-effort: a notification failure must not break the scan.
    if (isBrowserAuthExpiredError(row.last_error)) {
      try {
        await notifyAuthExpired({
          orgId: row.organization_id,
          connectionId,
          connectorKey: row.connector_key,
        });
        result.authNotified += 1;
      } catch (err) {
        logger.warn(
          { err, connection_id: connectionId },
          '[connector-health] failed to send browser-auth-expired notification'
        );
      }
    }
  }

  return result;
}
