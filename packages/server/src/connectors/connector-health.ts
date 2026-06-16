/**
 * Connector-health alerter.
 *
 * The per-feed repair-agent (`repair-agent.ts`) only fires when a worker
 * actually RUNS and fails — it cannot catch a connector that has silently
 * stopped scheduling runs, an active connection that collects nothing, or a
 * whole connection whose every feed is dead. Those failure modes currently
 * surface to nobody and have gone unnoticed for weeks in prod (expired Revolut
 * sessions, "Authentication failed — cookies may be expired", etc.).
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
import logger from '../utils/logger';

/**
 * A feed is "failing" if its most recent sync failed OR it has accumulated at
 * least this many consecutive failures. Matches the repair-agent default.
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

export interface ConnectorHealthConfig {
  failureThreshold: number;
  minConnectionAgeHours: number;
  zeroFeedsGraceHours: number;
  noSyncDays: number;
}

export const DEFAULT_CONNECTOR_HEALTH_CONFIG: ConnectorHealthConfig = {
  failureThreshold: FAILURE_THRESHOLD,
  minConnectionAgeHours: MIN_CONNECTION_AGE_HOURS,
  zeroFeedsGraceHours: ZERO_FEEDS_GRACE_HOURS,
  noSyncDays: NO_SYNC_DAYS,
};

export type UnhealthyReason = 'all_feeds_failing' | 'zero_feeds' | 'no_recent_sync';

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
  details: UnhealthyConnection[];
}

interface HealthDeps {
  sql?: DbClient;
  config?: ConnectorHealthConfig;
  now?: () => number;
}

interface UnhealthyRow {
  id: string;
  organization_id: string;
  connector_key: string;
  display_name: string | null;
  feed_count: string;
  failing_feed_count: string;
  active_feed_count: string;
  newest_sync_at: Date | null;
  last_error: string | null;
}

/**
 * The detection query. Read-only. Returns one row per active, non-deleted
 * connection that is past the min-age grace window, with aggregates over its
 * non-deleted feeds, so the JS classifier can decide healthy vs. unhealthy
 * (and which rule tripped). Chat connections live in a separate table
 * (`agent_connections`) and are intentionally NOT scanned here.
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
  const failingCount = Number(row.failing_feed_count);
  const activeCount = Number(row.active_feed_count);

  // Rule B: active connection, zero non-deleted feeds. (Grace handled by the
  // query's min-age window — a connection that has existed > min age and still
  // has no feeds is collecting nothing.)
  if (feedCount === 0) return 'zero_feeds';

  // A connection whose only feeds are deliberately paused (cf=0) is NOT
  // unhealthy — operator intent. activeCount === 0 means every feed is a
  // paused-clean feed.
  if (activeCount === 0) return null;

  // Rule A: every non-deleted feed is failing.
  if (failingCount === feedCount) return 'all_feeds_failing';

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

  const rows = await loadConnectionHealthRows(sql, cfg);

  const result: ConnectorHealthResult = {
    scanned: rows.length,
    unhealthy: 0,
    newlyAlerted: 0,
    recovered: 0,
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
  }

  return result;
}
