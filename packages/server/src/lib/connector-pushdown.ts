/**
 * Pushdown: run a read-only query LIVE against a connection's source by invoking
 * its connector in `query` mode — no copy, no events. Used by query_sql when a
 * `connection` is given, and by virtual-feed reads ({@link readVirtualFeed}).
 * The DB socket lives in the connector subprocess (behind the worker egress
 * controls), never in the gateway. Reuses the same inline-run path as
 * operations.execute (feed-sync.ts).
 */

import { executeCompiledConnector } from '@lobu/connector-worker/executor/runtime';
import { compileConnectionRowVisibility } from '../authz/connection-visibility';
import type { AuthzScope } from '../authz/scope';
import { getDb } from '../db/client';
import { isCloudMode } from '../utils/cloud-mode';
import { assertConnectorAllowedInCloud } from '../utils/connector-cloud-gate';
import { resolveConnectorCode } from '../utils/ensure-connector-installed';
import { resolveExecutionAuth } from '../utils/execution-context';

interface ConnectorQueryParams {
  organizationId: string;
  /** Connection slug (org-scoped). */
  connectionSlug: string;
  /** Read-only SQL to push down (a derived entity's backing_sql, or a feed query). */
  query: string;
  /** Caller identity — enforces the same connection visibility as manage_connections. */
  userId: string | null;
  /** Owner/admin callers see every connection; members only org-visible or their own. */
  isAdmin: boolean;
  feedKey?: string;
  config?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  sort?: { column: string; order: 'asc' | 'desc' };
}

interface ConnectorQueryResult {
  rows: Record<string, unknown>[];
  columns: { name: string; type: string }[];
  total?: number;
}

export async function runConnectorQuery(p: ConnectorQueryParams): Promise<ConnectorQueryResult> {
  const sql = getDb();
  // Resolve org-scoped + active, enforcing the same visibility as manage_connections:
  // a member only reaches org-visible connections or ones they created.
  const connRows = await sql`
    SELECT id, connector_key, auth_profile_id, app_auth_profile_id
    FROM connections
    WHERE organization_id = ${p.organizationId}
      AND slug = ${p.connectionSlug}
      AND deleted_at IS NULL
      AND status = 'active'
      AND (${p.isAdmin} OR visibility = 'org' OR created_by = ${p.userId})
    LIMIT 1
  `;
  if (connRows.length === 0) {
    throw new Error(`source connection '${p.connectionSlug}' not found or not accessible`);
  }
  const conn = connRows[0] as {
    id: number;
    connector_key: string;
    auth_profile_id: number | null;
    app_auth_profile_id: number | null;
  };

  // Execution-time cloud gate: blocking connection CREATION isn't enough — an
  // existing raw-DB connection must not run pushdown under LOBU_CLOUD_MODE either.
  assertConnectorAllowedInCloud(conn.connector_key);

  const compiledRows = await sql`
    SELECT compiled_code FROM connector_versions
    WHERE connector_key = ${conn.connector_key}
    ORDER BY created_at DESC LIMIT 1
  `;
  const rawCode =
    (compiledRows[0] as { compiled_code: string | null } | undefined)?.compiled_code ?? null;
  const compiledCode = await resolveConnectorCode(conn.connector_key, rawCode);

  const { credentials, connectionCredentials, sessionState } = await resolveExecutionAuth({
    organizationId: p.organizationId,
    connectionId: conn.id,
    authProfileId: Number(conn.auth_profile_id) || null,
    appAuthProfileId: Number(conn.app_auth_profile_id) || null,
    credentialDb: getDb(),
    logContext: { connection: p.connectionSlug },
    logMessage: 'Failed to resolve connector query credentials',
  });

  const result = await executeCompiledConnector({
    compiledCode,
    job: {
      mode: 'query',
      feedKey: p.feedKey ?? null,
      query: p.query,
      // ONLY the connection's own credentials reach ctx.config — deliberately NOT
      // the gateway's process.env, so a connection missing DATABASE_URL fails
      // cleanly instead of falling back to Lobu's own DB. The egress policy is the
      // one non-credential we inject: under cloud mode a DB connector must reject
      // internal/metadata hosts (block-private); self-hosted reaches its own
      // private DB (allow-private). env is {} so this is the only channel for it.
      // Injected LAST so neither caller config nor credentials can override this
      // security control.
      config: {
        ...connectionCredentials,
        ...(p.config ?? {}),
        LOBU_DB_EGRESS_POLICY: isCloudMode() ? 'block-private' : 'allow-private',
      },
      env: {},
      sessionState,
      credentials,
      limit: p.limit,
      offset: p.offset,
      sort: p.sort,
    },
  });

  if (result.mode !== 'query') {
    throw new Error(`Expected query result, got mode=${result.mode}`);
  }
  return { rows: result.rows, columns: result.columns ?? [], total: result.total };
}

/** Params for {@link readVirtualFeed}. */
export interface ReadVirtualFeedParams {
  /**
   * The requesting principal + tenant. The feed's backing connection is resolved
   * through the SAME connection-visibility compiler every read seam uses, so a
   * user is fenced exactly as on the SQL seam: org-visible connections, or a
   * private connection they own. A `null` principal (headless) sees org-only.
   */
  scope: AuthzScope;
  /** The virtual feed to read (feeds.id). Must be a `virtual = true` row. */
  feedId: number;
  /**
   * Keyword terms for RECALL. When present and non-empty, the connector's
   * `search()` runs (terms pushed down to the source); otherwise its `query()`
   * runs (plain live read). A connector lacking the needed method throws a
   * "recall over virtual unsupported" / "live queries unsupported" capability
   * error — surfaced, not branched on.
   */
  terms?: string[];
  /** Row cap pushed down to the source (connector clamps it). */
  limit?: number;
  offset?: number;
  sort?: { column: string; order: 'asc' | 'desc' };
}

/** Result from {@link readVirtualFeed} — live rows, never persisted. */
export interface ReadVirtualFeedResult {
  rows: Record<string, unknown>[];
  columns: { name: string; type: string }[];
  total?: number;
}

/**
 * Read a VIRTUAL feed LIVE by id — the "(later) virtual-feed reads" seam this
 * module was built for. Resolves the feed + its backing connection under the
 * AuthzScope connection-visibility rule, asserts the feed is virtual, then runs
 * the connector's `search()` (when `terms` are given) or `query()` in the
 * subprocess behind the worker egress controls. Persists NOTHING (no events, no
 * checkpoint). Multi-replica safe: a pure per-request read with all state in
 * Postgres — no pod-local state, runnable on any replica.
 *
 * The live SQL is the feed's stored `config.query` (the same read-only SELECT
 * shape sync uses), so a connector author keeps one query authoring surface.
 */
export async function readVirtualFeed(p: ReadVirtualFeedParams): Promise<ReadVirtualFeedResult> {
  const sql = getDb();

  // Resolve the feed + connection, fenced by the SAME visibility compiler the
  // SQL seam uses. Params: $1 feedId, $2 principal (compiler), $3 organizationId.
  const vis = compileConnectionRowVisibility(p.scope, 2, 'c');
  const feedRows = (await sql.unsafe(
    `SELECT f.id, f.feed_key, f.config, f.virtual,
            c.id AS connection_id, c.connector_key,
            c.auth_profile_id, c.app_auth_profile_id
     FROM feeds f
     JOIN connections c ON c.id = f.connection_id
     WHERE f.id = $1
       AND f.organization_id = $3
       AND f.deleted_at IS NULL
       AND c.deleted_at IS NULL
       AND c.status = 'active'
       ${vis.sql}
     LIMIT 1`,
    [p.feedId, ...vis.params, p.scope.organizationId],
  )) as unknown as Array<{
    id: number;
    feed_key: string;
    config: Record<string, unknown> | null;
    virtual: boolean;
    connection_id: number;
    connector_key: string;
    auth_profile_id: number | null;
    app_auth_profile_id: number | null;
  }>;

  if (feedRows.length === 0) {
    throw new Error(`virtual feed '${p.feedId}' not found or not accessible`);
  }
  const feed = feedRows[0];
  if (feed.virtual !== true) {
    throw new Error(`feed '${p.feedId}' is not a virtual feed — only virtual feeds can be read live`);
  }

  const feedConfig = (feed.config ?? {}) as Record<string, unknown>;
  const liveQuery = typeof feedConfig.query === 'string' ? feedConfig.query : null;
  if (!liveQuery) {
    throw new Error(`virtual feed '${p.feedId}' has no \`query\` in its config`);
  }

  // Execution-time cloud gate, identical to the slug pushdown above.
  assertConnectorAllowedInCloud(feed.connector_key);

  const compiledRows = await sql`
    SELECT compiled_code FROM connector_versions
    WHERE connector_key = ${feed.connector_key}
    ORDER BY created_at DESC LIMIT 1
  `;
  const rawCode =
    (compiledRows[0] as { compiled_code: string | null } | undefined)?.compiled_code ?? null;
  const compiledCode = await resolveConnectorCode(feed.connector_key, rawCode);

  const { credentials, connectionCredentials, sessionState } = await resolveExecutionAuth({
    organizationId: p.scope.organizationId,
    connectionId: feed.connection_id,
    authProfileId: Number(feed.auth_profile_id) || null,
    appAuthProfileId: Number(feed.app_auth_profile_id) || null,
    credentialDb: getDb(),
    logContext: { feedId: String(p.feedId) },
    logMessage: 'Failed to resolve virtual feed read credentials',
  });

  // Same credential/egress discipline as runConnectorQuery: only the
  // connection's own credentials reach ctx.config, with the egress policy
  // injected LAST so neither config nor credentials can override it.
  const config = {
    ...connectionCredentials,
    ...feedConfig,
    LOBU_DB_EGRESS_POLICY: isCloudMode() ? 'block-private' : 'allow-private',
  };

  const terms = (p.terms ?? []).map((t) => t.trim()).filter(Boolean);
  const result = await executeCompiledConnector({
    compiledCode,
    job:
      terms.length > 0
        ? {
            mode: 'search',
            feedKey: feed.feed_key,
            query: liveQuery,
            terms,
            config,
            env: {},
            sessionState,
            credentials,
            limit: p.limit,
            offset: p.offset,
            sort: p.sort,
          }
        : {
            mode: 'query',
            feedKey: feed.feed_key,
            query: liveQuery,
            config,
            env: {},
            sessionState,
            credentials,
            limit: p.limit,
            offset: p.offset,
            sort: p.sort,
          },
  });

  if (result.mode !== 'query' && result.mode !== 'search') {
    throw new Error(`Expected query/search result, got mode=${result.mode}`);
  }
  return { rows: result.rows, columns: result.columns ?? [], total: result.total };
}
