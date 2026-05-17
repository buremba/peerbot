/**
 * Run Utilities
 *
 * Centralized functions for run operations including:
 * - Sync run creation
 * - Action run creation
 * - JSON utilities for duplicate detection
 */

import type { DbClient } from '../db/client';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { findBundledConnectorFile } from './connector-catalog';
import logger from '../utils/logger';
import { isUniqueViolation } from '../utils/pg-errors';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from './run-statuses';

export type WatcherDispatchSource = 'scheduled' | 'manual';

export interface WatcherRunPayload {
  watcher_id: number;
  agent_id: string;
  window_start: string;
  window_end: string;
  dispatch_source: WatcherDispatchSource;
  /**
   * Snapshot of the watcher's `current_version_id` at run-creation time.
   * The agent and `complete_window` use this fixed version for the entire
   * extraction lifecycle so a mid-run group edit cannot validate v1's output
   * against v2's schema.
   */
  version_id: number | null;
  /**
   * When non-null, the watcher is pinned to a user-owned device worker.
   * The server-side dispatcher (`packages/server/src/watchers/automation.ts`)
   * MUST refuse to claim such rows — they are claimed exclusively by the
   * matching device worker via `/api/workers/poll`. Mirrors the
   * `connections.device_worker_id` lane that the worker poll already
   * supports for sync runs.
   */
  device_worker_id?: string | null;
  /**
   * Hint to the device-side dispatcher (Owletto Mac app, etc.) for which
   * local CLI executor to spawn (e.g. `claude-code`, `codex`, `gemini`).
   * Free-form string. Empty / null means "use the device's configured
   * default agent".
   */
  agent_kind?: string | null;
}

// ============================================
// Run Management
// ============================================

/**
 * Create a pending sync run for a feed.
 *
 * @param feedId Feed ID
 * @param env Environment bindings
 * @returns Run ID if created, null if skipped
 */
async function createSyncRunWithClient(sql: DbClient, feedId: number): Promise<number | null> {
  // Check if there's already a pending/running run for this feed
  const existing = await sql`
    SELECT id FROM runs
    WHERE feed_id = ${feedId}
      AND run_type = 'sync'
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
    LIMIT 1
  `;

  if (existing.length > 0) {
    logger.info(
      `[queue] Skipping run creation for feed ${feedId} - already has pending/running run`
    );
    return null;
  }

  // Get feed details (including pinned_version)
  const feedRows = await sql`
    SELECT f.organization_id, f.connection_id, f.pinned_version, c.connector_key
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE f.id = ${feedId}
  `;
  if (feedRows.length === 0) {
    logger.warn(`[queue] Feed ${feedId} not found`);
    return null;
  }
  const feed = feedRows[0] as {
    organization_id: string;
    connection_id: number;
    connector_key: string;
    pinned_version: string | null;
  };

  // Resolve connector version: pinned_version → connector_definitions.version
  let connectorVersion: string;

  if (feed.pinned_version) {
    connectorVersion = feed.pinned_version;
  } else {
    const defRows = await sql`
      SELECT version FROM connector_definitions
      WHERE key = ${feed.connector_key}
        AND organization_id = ${feed.organization_id}
        AND status = 'active'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `;
    if (defRows.length === 0) {
      // An orphan feed: the connector was archived/uninstalled in this org
      // but the feed wasn't soft-deleted. Pre-fix this threw an Error on
      // every CheckDueFeeds tick (1 / min), producing ~380 error logs / min
      // for 33 feeds. Soft-delete the feed in-place so it stops appearing
      // in CheckDueFeeds — otherwise warning + returning null would just
      // produce a warn-level repeat at the same cadence forever, and a
      // large enough orphan set could fill the CheckDueFeeds LIMIT 100
      // and starve legitimate feeds.
      //
      // Operators can recover by clearing `deleted_at` after reinstalling
      // the connector definition.
      await sql`
        UPDATE feeds
        SET deleted_at = current_timestamp
        WHERE id = ${feedId}
      `;
      logger.warn(
        {
          feedId,
          connector_key: feed.connector_key,
          organization_id: feed.organization_id,
        },
        '[queue] Soft-deleted orphan feed — no active connector_definition for (connector_key, org).'
      );
      return null;
    }
    connectorVersion = (defRows[0] as { version: string }).version;
  }

  // Verify connector version exists and has compiled code or a source_path for on-demand compilation
  const versionRows = await sql`
    SELECT compiled_code, source_path FROM connector_versions
    WHERE connector_key = ${feed.connector_key} AND version = ${connectorVersion}
    LIMIT 1
  `;
  if (versionRows.length === 0) {
    throw new Error(
      `No connector version '${connectorVersion}' found for '${feed.connector_key}'. Build/register connector code first.`
    );
  }

  const { compiled_code } = versionRows[0] as {
    compiled_code: string | null;
    source_path: string | null;
  };
  if (!compiled_code && !findBundledConnectorFile(feed.connector_key)) {
    throw new Error(
      `Connector '${feed.connector_key}' has no compiled code and no bundled source file for version '${connectorVersion}'.`
    );
  }

  const inserted = await sql`
    INSERT INTO runs (
      organization_id, run_type, feed_id, connection_id,
      connector_key, connector_version, status, approval_status, created_at
    ) VALUES (
      ${feed.organization_id}, 'sync', ${feedId}, ${feed.connection_id},
      ${feed.connector_key}, ${connectorVersion}, 'pending', 'auto', current_timestamp
    )
    RETURNING id
  `;
  const runId = Number((inserted[0] as { id: unknown }).id);

  logger.info(
    `[queue] Created sync run ${runId} for feed ${feedId} (${feed.connector_key}, version=${connectorVersion})`
  );
  return runId;
}

export async function createSyncRun(
  feedId: number,
  _env: Env,
  db?: DbClient
): Promise<number | null> {
  const sql = db ?? getDb();

  try {
    if (db) {
      return await createSyncRunWithClient(sql, feedId);
    }

    return await sql.begin(async (tx) => createSyncRunWithClient(tx, feedId));
  } catch (error) {
    if (isUniqueViolation(error, 'idx_runs_active_sync_per_feed')) {
      logger.info(`[queue] Skipping run creation for feed ${feedId} - duplicate active sync run`);
      return null;
    }
    logger.error({ error }, `[queue] Failed to create sync run for feed ${feedId}`);
    throw error;
  }
}

async function findActiveWatcherRun(
  sql: DbClient,
  watcherId: number
): Promise<{ id: number; status: string } | null> {
  const existing = await sql`
    SELECT id, status
    FROM runs
    WHERE watcher_id = ${watcherId}
      AND run_type = 'watcher'
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
    ORDER BY created_at ASC
    LIMIT 1
  `;

  if (existing.length === 0) return null;

  return {
    id: Number((existing[0] as { id: unknown }).id),
    status: String((existing[0] as { status: unknown }).status),
  };
}

async function createWatcherRunWithClient(
  sql: DbClient,
  params: {
    organizationId: string;
    watcherId: number;
    agentId: string;
    windowStart: string;
    windowEnd: string;
    dispatchSource: WatcherDispatchSource;
    deviceWorkerId?: string | null;
    agentKind?: string | null;
  }
): Promise<{ runId: number; status: string; created: boolean }> {
  const existing = await findActiveWatcherRun(sql, params.watcherId);
  if (existing) {
    logger.info(
      `[queue] Reusing active watcher run ${existing.id} for watcher ${params.watcherId}`
    );
    return { runId: existing.id, status: existing.status, created: false };
  }

  // Snapshot the watcher's current_version_id at run-creation time so the
  // entire run uses a fixed version even if the group is edited mid-run.
  const versionRows = await sql`
    SELECT current_version_id FROM watchers WHERE id = ${params.watcherId} LIMIT 1
  `;
  const snapshotVersionId =
    versionRows.length > 0 && versionRows[0].current_version_id != null
      ? Number(versionRows[0].current_version_id)
      : null;

  // device_worker_id + agent_kind get persisted into approved_input so the
  // server-side dispatcher (#802) can skip device-pinned rows from the SQL
  // side, and so /api/workers/poll can claim them with a parallel CTE
  // branch without a runs-schema migration. Empty strings are normalized to
  // null so the dispatcher's `OR '' = ''` guard treats them as un-pinned.
  const normalizedDeviceWorkerId =
    typeof params.deviceWorkerId === 'string' && params.deviceWorkerId.trim() !== ''
      ? params.deviceWorkerId.trim()
      : null;
  const normalizedAgentKind =
    typeof params.agentKind === 'string' && params.agentKind.trim() !== ''
      ? params.agentKind.trim()
      : null;

  const payload: WatcherRunPayload = {
    watcher_id: params.watcherId,
    agent_id: params.agentId,
    window_start: params.windowStart,
    window_end: params.windowEnd,
    dispatch_source: params.dispatchSource,
    version_id: snapshotVersionId,
    device_worker_id: normalizedDeviceWorkerId,
    agent_kind: normalizedAgentKind,
  };

  const inserted = await sql`
    INSERT INTO runs (
      organization_id,
      run_type,
      watcher_id,
      approval_status,
      status,
      approved_input,
      created_at
    ) VALUES (
      ${params.organizationId},
      'watcher',
      ${params.watcherId},
      'auto',
      'pending',
      ${sql.json(payload)},
      current_timestamp
    )
    RETURNING id, status
  `;

  const runId = Number((inserted[0] as { id: unknown }).id);
  const status = String((inserted[0] as { status: unknown }).status);

  logger.info(
    `[queue] Created watcher run ${runId} for watcher ${params.watcherId} (${params.dispatchSource})`
  );

  return { runId, status, created: true };
}

export async function createWatcherRun(
  params: {
    organizationId: string;
    watcherId: number;
    agentId: string;
    windowStart: string;
    windowEnd: string;
    dispatchSource: WatcherDispatchSource;
    deviceWorkerId?: string | null;
    agentKind?: string | null;
  },
  db?: DbClient
): Promise<{ runId: number; status: string; created: boolean }> {
  const sql = db ?? getDb();

  try {
    if (db) {
      return await createWatcherRunWithClient(sql, params);
    }

    return await sql.begin(async (tx) => createWatcherRunWithClient(tx, params));
  } catch (error) {
    if (isUniqueViolation(error, 'idx_runs_active_watcher_per_watcher')) {
      const existing = await findActiveWatcherRun(sql, params.watcherId);
      if (existing) {
        logger.info(
          `[queue] Reusing concurrent watcher run ${existing.id} for watcher ${params.watcherId}`
        );
        return { runId: existing.id, status: existing.status, created: false };
      }
    }

    logger.error({ error, watcherId: params.watcherId }, '[queue] Failed to create watcher run');
    throw error;
  }
}

/**
 * Create an action run.
 *
 * @param params Action run parameters
 * @returns Run ID
 */
/**
 * Create an auth run to drive a connector's interactive authenticate() flow.
 * The auth profile must already exist (typically in 'pending_auth' status).
 */
export async function createAuthRun(params: {
  organizationId: string;
  connectorKey: string;
  authProfileId: number;
  createdByUserId: string;
}): Promise<number> {
  const sql = getDb();

  // Resolve connector version
  const defRows = await sql`
    SELECT version FROM connector_definitions
    WHERE key = ${params.connectorKey}
      AND organization_id = ${params.organizationId}
      AND status = 'active'
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `;
  if (defRows.length === 0) {
    throw new Error(`No active connector definition found for '${params.connectorKey}'.`);
  }
  const connectorVersion = (defRows[0] as { version: string }).version;

  const versionRows = await sql`
    SELECT compiled_code, source_path FROM connector_versions
    WHERE connector_key = ${params.connectorKey} AND version = ${connectorVersion}
    LIMIT 1
  `;
  if (versionRows.length === 0) {
    throw new Error(
      `No connector version '${connectorVersion}' found for '${params.connectorKey}'.`
    );
  }
  const { compiled_code, source_path } = versionRows[0] as {
    compiled_code: string | null;
    source_path: string | null;
  };
  if (!compiled_code && !source_path) {
    throw new Error(
      `Connector '${params.connectorKey}' has no compiled code or source_path for version '${connectorVersion}'.`
    );
  }

  try {
    const inserted = await sql`
      INSERT INTO runs (
        organization_id, run_type, connector_key, connector_version,
        auth_profile_id, created_by_user_id, approval_status, status, created_at
      ) VALUES (
        ${params.organizationId}, 'auth', ${params.connectorKey}, ${connectorVersion},
        ${params.authProfileId}, ${params.createdByUserId}, 'auto', 'pending', current_timestamp
      )
      RETURNING id
    `;
    const runId = Number((inserted[0] as { id: unknown }).id);
    logger.info(
      `[queue] Created auth run ${runId} (${params.connectorKey}, profile=${params.authProfileId})`
    );
    return runId;
  } catch (error) {
    if (isUniqueViolation(error, 'idx_runs_active_auth_per_profile')) {
      const existing = await sql`
        SELECT id, created_by_user_id FROM runs
        WHERE auth_profile_id = ${params.authProfileId}
          AND run_type = 'auth'
          AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (existing.length > 0) {
        const row = existing[0] as { id: unknown; created_by_user_id: string | null };
        if (row.created_by_user_id && row.created_by_user_id !== params.createdByUserId) {
          throw new Error(
            'An authentication flow is already in progress for this profile by another user.'
          );
        }
        return Number(row.id);
      }
    }
    throw error;
  }
}

export async function createConnectorOperationRun(params: {
  organizationId: string;
  connectionId: number;
  connectorKey: string;
  operationKey: string;
  operationInput: Record<string, unknown>;
  approvalMode: 'inline' | 'queued';
  requireCompiledCode?: boolean;
}): Promise<number> {
  const sql = getDb();

  const approvalStatus = params.approvalMode === 'queued' ? 'pending' : 'auto';
  const status = params.approvalMode === 'queued' ? 'pending' : 'running';

  // Resolve connector version from connector_definitions
  const defRows = await sql`
    SELECT version FROM connector_definitions
    WHERE key = ${params.connectorKey}
      AND organization_id = ${params.organizationId}
      AND status = 'active'
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `;
  if (defRows.length === 0) {
    throw new Error(`No active connector definition found for '${params.connectorKey}'.`);
  }
  const connectorVersion = (defRows[0] as { version: string }).version;

  // Verify connector version exists and has compiled code or source_path for on-demand compilation
  if (params.requireCompiledCode) {
    const versionRows = await sql`
      SELECT compiled_code, source_path FROM connector_versions
      WHERE connector_key = ${params.connectorKey} AND version = ${connectorVersion}
      LIMIT 1
    `;
    if (versionRows.length === 0) {
      throw new Error(
        `No connector version '${connectorVersion}' found for '${params.connectorKey}'. Build/register connector code first.`
      );
    }

    const { compiled_code, source_path } = versionRows[0] as {
      compiled_code: string | null;
      source_path: string | null;
    };
    if (!compiled_code && !source_path) {
      throw new Error(
        `Connector '${params.connectorKey}' has no compiled code or source_path for version '${connectorVersion}'.`
      );
    }
  }

  const inserted = await sql`
    INSERT INTO runs (
      organization_id, run_type, connection_id, connector_key, connector_version,
      action_key, action_input, approval_status, status, created_at
    ) VALUES (
      ${params.organizationId}, 'action', ${params.connectionId},
      ${params.connectorKey}, ${connectorVersion},
      ${params.operationKey}, ${sql.json(params.operationInput)},
      ${approvalStatus}, ${status}, current_timestamp
    )
    RETURNING id
  `;

  const runId = Number((inserted[0] as { id: unknown }).id);
  logger.info(
    `[queue] Created action run ${runId} (${params.connectorKey}/${params.operationKey}, approval=${approvalStatus})`
  );
  return runId;
}
