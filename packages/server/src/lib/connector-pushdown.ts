/**
 * Pushdown: run a read-only query LIVE against a connection's source by invoking
 * its connector in `query` mode — no copy, no events. Used by query_sql when a
 * `connection` is given, and by virtual-feed reads ({@link readVirtualFeed}).
 * The DB socket lives in the connector subprocess (behind the worker egress
 * controls), never in the gateway. Reuses the same inline-run path as
 * operations.execute (feed-sync.ts).
 */

import { executeCompiledConnector } from '@lobu/connector-worker/executor/runtime';
import {
  classifyToolError,
  getErrorMessage,
  type ToolErrorCode,
} from '@lobu/core';
import { compileConnectionRowVisibility } from '../authz/connection-visibility';
import type { AuthzScope } from '../authz/scope';
import { getDb } from '../db/client';
import { dbEgressConfig } from '../utils/cloud-mode';
import { findBundledConnectorFile } from '../utils/connector-catalog';
import { assertConnectorAllowedInCloud } from '../utils/connector-cloud-gate';
import { resolveConnectorCodeForKey } from '../utils/ensure-connector-installed';
import { mergeExecutionConfig, resolveExecutionAuth } from '../utils/execution-context';
import {
  ATLASSIAN_JIRA_ISSUES_FEED_KEY,
  isAtlassianMcpConfig,
  normalizeMcpProxyConfig,
  readAtlassianMcpVirtualFeed,
} from '../operations/atlassian-mcp-feed';
import {
  isMetadataOnlyDeviceConnector,
  readDeviceVirtualFeed,
} from './device-virtual-feed';

interface ConnectorQueryParams {
  /** The ACL gate — tenant + principal. Its `organizationId`/`principal` drive
   * the same connection visibility as manage_connections. */
  scope: AuthzScope;
  /** Connection slug (org-scoped). */
  connectionSlug: string;
  /** Read-only SQL to push down (a derived entity's backing_sql, or a feed query). */
  query: string;
  /** Owner/admin callers see every connection; members only org-visible or their
   * own. A full management-tier bypass. */
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
  // owner/admin callers reach every connection; everyone else gets the shared
  // connection-visibility predicate.
  const visibility = p.isAdmin
    ? sql``
    : sql`${sql.unsafe(compileConnectionRowVisibility(p.scope, 'connections'))}`;
  const connRows = await sql`
    SELECT id, connector_key, auth_profile_id, app_auth_profile_id, config
    FROM connections
    WHERE organization_id = ${p.scope.organizationId}
      AND slug = ${p.connectionSlug}
      AND deleted_at IS NULL
      AND status = 'active'
      ${visibility}
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
    config: Record<string, unknown> | null;
  };

  // Execution-time cloud gate: blocking connection CREATION isn't enough — an
  // existing raw-DB connection must not run pushdown under LOBU_CLOUD_MODE either.
  assertConnectorAllowedInCloud(conn.connector_key);

  const compiledCode = await resolveConnectorCodeForKey(
    conn.connector_key,
    p.scope.organizationId
  );

  const { credentials, connectionCredentials, sessionState } = await resolveExecutionAuth({
    organizationId: p.scope.organizationId,
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
      // Same merge as feed-sync / worker poll: connection.config under
      // credentials + caller overrides (any connector-level config).
      // ONLY the connection's own credentials reach ctx.config — deliberately NOT
      // the gateway's process.env, so a connection missing DATABASE_URL fails
      // cleanly instead of falling back to Lobu's own DB. The egress policy is the
      // one non-credential we inject: under cloud mode a DB connector must reject
      // internal/metadata hosts (block-private); self-hosted reaches its own
      // private DB (allow-private). env is {} so this is the only channel for it.
      // Injected LAST so neither caller config nor credentials can override this
      // security control.
      config: {
        ...mergeExecutionConfig(conn.config, connectionCredentials, p.config),
        ...dbEgressConfig(),
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
  /** Caller cancellation, threaded into device and HTTP transports. */
  signal?: AbortSignal;
  /** Absolute wall-clock deadline. Compiled connectors are killed at this deadline. */
  deadlineAt?: number;
}

/** Result from {@link readVirtualFeed} — live rows, never persisted. */
export interface ReadVirtualFeedResult {
  rows: Record<string, unknown>[];
  columns: { name: string; type: string }[];
  total?: number;
}

function deadlineError(feedId: number): Error & { exitReason: 'timeout' } {
  return Object.assign(new Error(`source read for feed '${feedId}' timed out`), {
    exitReason: 'timeout' as const,
  });
}

function remainingReadMs(p: ReadVirtualFeedParams): number | undefined {
  if (p.signal?.aborted) throw deadlineError(p.feedId);
  if (p.deadlineAt === undefined) return undefined;
  const remaining = Math.trunc(p.deadlineAt - Date.now());
  if (remaining <= 0) throw deadlineError(p.feedId);
  return remaining;
}

/** Classify a thrown connector/source failure using structured diagnostics first. */
export function classifyPushdownFailure(err: unknown): ToolErrorCode {
  const diagnostic = err as {
    httpStatus?: unknown;
    exitReason?: unknown;
  } | null;
  const httpStatus = typeof diagnostic?.httpStatus === 'number' ? diagnostic.httpStatus : undefined;
  const exitReason =
    diagnostic?.exitReason === 'timeout' ||
    diagnostic?.exitReason === 'oom' ||
    diagnostic?.exitReason === 'crash' ||
    diagnostic?.exitReason === 'error_message'
      ? diagnostic.exitReason
      : undefined;
  const code = classifyToolError({ httpStatus, exitReason, message: getErrorMessage(err) });
  return code === 'INTERNAL' ? 'UPSTREAM_5XX' : code;
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
  remainingReadMs(p);
  const sql = getDb();

  // Resolve the feed + connection, fenced by the SAME visibility compiler the
  // SQL seam uses.
  const vis = compileConnectionRowVisibility(p.scope, 'c');
  const feedRows = (await sql.unsafe(
    `SELECT f.id, f.feed_key, f.config, f.virtual,
            c.id AS connection_id, c.connector_key,
            c.auth_profile_id, c.app_auth_profile_id,
            c.device_worker_id,
            COALESCE(c.config, '{}'::jsonb) AS connection_config,
            cd.mcp_config, cd.runtime, cd.required_capability, cd.has_compiled_code
     FROM feeds f
     JOIN connections c ON c.id = f.connection_id
     LEFT JOIN LATERAL (
       SELECT cd0.mcp_config, cd0.runtime, cd0.required_capability,
              EXISTS (
                -- Does the SELECTED version ship code THIS path can execute?
                --
                -- Mirrors resolveConnectorCodeForKey's own resolution: the
                -- definition's version, org artifact preferred over the shared
                -- one. source_path is deliberately NOT part of it, and that is
                -- not an oversight — resolveConnectorCode() reads only
                -- compiled_code (recompiling from source_code when the config
                -- hash moved) and otherwise falls through to the bundled file;
                -- it never loads source_path. queue-service's
                -- resolveActiveConnectorVersion DOES accept source_path, but
                -- that is a laxer readiness gate, and device manifests set it to
                -- device-manifest://... precisely as a non-executable marker.
                -- Adopting that union here would classify every device connector
                -- as having code and break this routing outright.
                SELECT 1
                FROM connector_versions cv
                WHERE cv.connector_key = cd0.key
                  AND cv.version = cd0.version
                  AND (cv.organization_id = cd0.organization_id
                       OR cv.organization_id IS NULL)
                  AND cv.compiled_code IS NOT NULL
                  AND cv.compiled_code <> ''
              ) AS has_compiled_code
       FROM connector_definitions cd0
       WHERE cd0.key = c.connector_key
         AND cd0.status = 'active'
         AND cd0.organization_id = $2
       ORDER BY cd0.updated_at DESC
       LIMIT 1
     ) cd ON TRUE
     WHERE f.id = $1
       AND f.organization_id = $2
       AND f.deleted_at IS NULL
       AND f.status = 'active'
       AND c.deleted_at IS NULL
       AND c.status = 'active'
       ${vis}
     LIMIT 1`,
    [p.feedId, p.scope.organizationId],
  )) as unknown as Array<{
    id: number;
    feed_key: string;
    config: Record<string, unknown> | null;
    virtual: boolean;
    connection_id: number;
    connector_key: string;
    auth_profile_id: number | null;
    app_auth_profile_id: number | null;
    device_worker_id: string | null;
    connection_config: Record<string, unknown>;
    mcp_config: Record<string, unknown> | null;
    runtime: Record<string, unknown> | null;
    required_capability: string | null;
    has_compiled_code: boolean | null;
  }>;

  if (feedRows.length === 0) {
    throw new Error(`virtual feed '${p.feedId}' not found or not accessible`);
  }
  const feed = feedRows[0];
  if (feed.virtual !== true) {
    throw new Error(`feed '${p.feedId}' is not a virtual feed — only virtual feeds can be read live`);
  }

  const feedConfig = (feed.config ?? {}) as Record<string, unknown>;
  const storedQuery = typeof feedConfig.query === 'string' ? feedConfig.query : '';
  remainingReadMs(p);

  // Execution-time cloud gate, identical to the slug pushdown above.
  assertConnectorAllowedInCloud(feed.connector_key);

  const mcpConfig = isAtlassianMcpConfig(feed.mcp_config)
    ? normalizeMcpProxyConfig(feed.mcp_config)
    : null;
  if (mcpConfig) {
    if (feed.feed_key !== ATLASSIAN_JIRA_ISSUES_FEED_KEY) {
      throw new Error(
        `Atlassian MCP virtual feed '${feed.feed_key}' has no registered live-read adapter`
      );
    }
    return readAtlassianMcpVirtualFeed({
      organizationId: p.scope.organizationId,
      connectionId: Number(feed.connection_id),
      connectorKey: feed.connector_key,
      mcpConfig,
      feedConfig,
      connectionConfig: feed.connection_config,
      query: storedQuery || (typeof feedConfig.jql === 'string' ? feedConfig.jql : ''),
      terms: p.terms,
      limit: p.limit,
      offset: p.offset,
      sort: p.sort,
      signal: p.signal,
      deadlineAt: p.deadlineAt,
    });
  }

  // Native device connectors (whatsapp.local, apple.*, os.shell, …) are
  // metadata-only on the server: there is no compiled bundle to run, so
  // `resolveConnectorCodeForKey` below would throw. Their live reads are served
  // natively by the paired device over the device action queue.
  //
  // The discriminator is runtime metadata AND the absence of compiled code, not
  // `runtime != null` on its own: `runtime` is descriptive (platforms, nix
  // inputs) and a compiled connector may legitimately carry it while still
  // having a bundle. Such a connector keeps the compiled pushdown, which is a
  // strictly better read path than a device round-trip. A pin is not part of
  // this either — it says which machine executes, not whether server code
  // exists.
  //
  // "Has code" is deliberately BROADER than the stored artifact: a BUNDLED
  // connector ships as source in the image and legitimately has
  // `connector_versions.compiled_code IS NULL` (resolveConnectorCode falls
  // through to `findBundledConnectorFile`). Reading only the column would route
  // every bundled connector that declares a runtime onto the device queue.
  const hasConnectorCode =
    feed.has_compiled_code === true || findBundledConnectorFile(feed.connector_key) !== null;
  if (isMetadataOnlyDeviceConnector(feed.runtime, hasConnectorCode)) {
    remainingReadMs(p);
    return readDeviceVirtualFeed({
      organizationId: p.scope.organizationId,
      feedId: Number(feed.id),
      feedKey: feed.feed_key,
      // Same precedence as the compiled path below: connection config first,
      // feed config wins. No credentials — a device connector authenticates as
      // the logged-in desktop app, and the worker never receives secrets.
      feedConfig: mergeExecutionConfig(feed.connection_config, feedConfig),
      connectionId: Number(feed.connection_id),
      connectorKey: feed.connector_key,
      deviceWorkerId: feed.device_worker_id,
      requiredCapability: feed.required_capability,
      terms: p.terms,
      limit: p.limit,
      offset: p.offset,
      sort: p.sort,
      signal: p.signal,
    });
  }

  const compiledCode = await resolveConnectorCodeForKey(
    feed.connector_key,
    p.scope.organizationId
  );

  const { credentials, connectionCredentials, sessionState } = await resolveExecutionAuth({
    organizationId: p.scope.organizationId,
    connectionId: feed.connection_id,
    authProfileId: Number(feed.auth_profile_id) || null,
    appAuthProfileId: Number(feed.app_auth_profile_id) || null,
    credentialDb: getDb(),
    logContext: { feedId: String(p.feedId) },
    logMessage: 'Failed to resolve virtual feed read credentials',
  });

  // Same merge order as feed-sync / worker poll:
  // connection.config → credentials → feed config → egress.
  // Feed-level keys win so a feed can override connection-level settings.
  const config = {
    ...mergeExecutionConfig(feed.connection_config, connectionCredentials, feedConfig),
    ...dbEgressConfig(),
  };

  const terms = (p.terms ?? []).map((t) => t.trim()).filter(Boolean);
  const timeoutMs = remainingReadMs(p);
  const result = await executeCompiledConnector({
    compiledCode,
    job:
      terms.length > 0
        ? {
            mode: 'search',
            feedKey: feed.feed_key,
            query: storedQuery,
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
            query: storedQuery,
            config,
            env: {},
            sessionState,
            credentials,
            limit: p.limit,
            offset: p.offset,
            sort: p.sort,
          },
    timeoutMs,
  });

  if (result.mode !== 'query' && result.mode !== 'search') {
    throw new Error(`Expected query/search result, got mode=${result.mode}`);
  }
  return { rows: result.rows, columns: result.columns ?? [], total: result.total };
}
