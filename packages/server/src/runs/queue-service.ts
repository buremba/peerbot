/**
 * Run Utilities
 *
 * Centralized functions for run operations including:
 * - Sync run creation
 * - Action run creation
 * - JSON utilities for duplicate detection
 */

import type { DbClient } from '../db/client';
import {
  resolvedEventExecution,
  type BehaviorEventTrigger,
  type BehaviorWorkspaceEventTrigger,
} from '@lobu/core/contracts/tools/manage-behaviors';
import type { ConnectorTriggerSignal } from '@lobu/connector-sdk';
import {
  claimBehaviorCooldown,
  lockBehaviorForActivation,
} from '../behaviors/cooldown';
import {
  MAX_COALESCED_BEHAVIOR_EVENT_INPUTS,
  MAX_WORKSPACE_EVENT_CAUSAL_BEHAVIORS,
  behaviorTriggerSignals,
  isWorkspaceEventTriggerSignal,
  type WorkspaceEventTriggerSignal,
} from '../behaviors/workspace-event-contract';
import { getDb } from '../db/client';
import { DEVICE_ACTION_QUEUE_BUDGET_MS } from '../config/intervals';
import type { Env } from '../index';
import { isCloudMode } from '../utils/cloud-mode';
import { findBundledConnectorFile } from '../utils/connector-catalog';
import { CLOUD_RESTRICTED_CONNECTOR_KEYS } from '../utils/connector-cloud-gate';
import { nextRunAt as nextRunAtFromCron } from '../utils/cron';
import { ToolUserError } from '../utils/errors';
import { stableJson } from '../utils/insert-event';
import logger from '../utils/logger';
import { isUniqueViolation } from '../utils/pg-errors';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../utils/run-statuses';
import { BEHAVIOR_RUN_TYPES_PG } from "./run-types.js";

type WatcherDispatchSource = 'scheduled' | 'manual' | 'event';
export type BehaviorActivationTrigger =
  | BehaviorEventTrigger
  | BehaviorWorkspaceEventTrigger;
export type BehaviorActivationSignal =
  | ConnectorTriggerSignal
  | WorkspaceEventTriggerSignal;

export interface WatcherRunPayload {
  watcher_id: number;
  /**
   * The managed agent executing this run. Absent for device-executed runs
   * (the device lane claims via `device_worker_id`) and for manual runs open
   * to any connected MCP client.
   */
  agent_id?: string;
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
  /** Present for event activations; each signal points at already-durable input. */
  trigger_signal?: BehaviorActivationSignal;
  /** Coalesced deliveries waiting in this run, including trigger_signal. */
  trigger_signals?: BehaviorActivationSignal[];
  delivery_ids?: string[];
  trigger_execution?: 'turn' | 'window';
  trigger_output?: 'silent' | 'reply_to_source';
  trigger_key?: string;
  source_fingerprint?: string;
}

function behaviorEventTriggerKey(trigger: BehaviorActivationTrigger): string {
  if (trigger.source === 'workspace') {
    return stableJson({
      kind: trigger.kind,
      source: trigger.source,
      entity_type: trigger.entity_type ?? null,
      event_types: [...trigger.event_types].sort(),
      match: trigger.match ?? null,
      execution: resolvedEventExecution(trigger),
      active_run: trigger.active_run ?? 'coalesce',
    });
  }
  return stableJson({
    kind: 'event',
    connector_key: trigger.connector_key,
    connection_id: trigger.connection_id ?? null,
    event_types: [...trigger.event_types].sort(),
    match: trigger.match ?? null,
    execution: resolvedEventExecution(trigger),
    active_run: trigger.active_run ?? 'queue',
    output: trigger.output ?? 'silent',
    skip_if_unchanged: trigger.skip_if_unchanged ?? true,
  });
}

const WATCHER_EXECUTION_UNIQUE_INDEX = 'idx_runs_executing_per_behavior';

/**
 * Claim one pending Behavior run while holding the durable per-Behavior row
 * lock. Both the server dispatcher and device poller use this transition so
 * replicas cannot promote different queued runs from the same Behavior at the
 * same time.
 */
export async function claimPendingWatcherRun(
  tx: DbClient,
  params: {
    runId: number;
    watcherId: number;
    claimedBy: string;
    status: 'claimed' | 'running';
  }
): Promise<boolean> {
  const watcher = await tx`
    SELECT id
    FROM watchers
    WHERE id = ${params.watcherId}
    FOR UPDATE SKIP LOCKED
  `;
  if (watcher.length === 0) return false;

  try {
    const claimed = await tx.savepoint(
      async (sp) => sp`
        UPDATE runs r
        SET status = ${params.status},
            claimed_at = current_timestamp,
            last_heartbeat_at = CASE
              WHEN ${params.status}::text = 'running' THEN current_timestamp
              ELSE r.last_heartbeat_at
            END,
            claimed_by = ${params.claimedBy}
        WHERE r.id = ${params.runId}
          AND r.watcher_id = ${params.watcherId}
          AND r.run_type = ANY(${BEHAVIOR_RUN_TYPES_PG}::text[])
          AND r.status = 'pending'
          -- Same-type guard, deliberately not widened to both run types: one
          -- Behavior at a time per Behavior, and one eval at a time per
          -- Behavior, but an eval replay must never be blocked by (or block)
          -- the real run it is replaying.
          AND NOT EXISTS (
            SELECT 1
            FROM runs active
            WHERE active.watcher_id = r.watcher_id
              AND active.run_type = r.run_type
              AND active.status IN ('claimed', 'running')
          )
        RETURNING r.id
      `
    );
    return claimed.length > 0;
  } catch (error) {
    // During a rolling deployment an older replica may still claim without
    // taking the watcher row lock. The unique index remains authoritative;
    // contain that expected contention inside the savepoint and skip the run.
    if (isUniqueViolation(error, WATCHER_EXECUTION_UNIQUE_INDEX)) return false;
    throw error;
  }
}

// ============================================
// Run Management
// ============================================

/**
 * A feed whose connector can't be resolved to runnable code is an orphan: the
 * connector was archived/uninstalled, or its version was registered without
 * compiled code and has no bundled source to compile on demand. Soft-delete it
 * in-place so it stops appearing in CheckDueFeeds — a warn + return null would
 * repeat at the same cadence forever (~1/min), and a large enough orphan set
 * fills the CheckDueFeeds LIMIT 100 and starves legitimate feeds. Operators
 * recover by registering connector code and clearing `deleted_at`.
 */
async function softDeleteOrphanFeed(
  sql: DbClient,
  feedId: number,
  feed: { connector_key: string; organization_id: string },
  reason: string
): Promise<void> {
  await sql`
    UPDATE feeds
    SET deleted_at = current_timestamp
    WHERE id = ${feedId}
  `;
  logger.warn(
    { feedId, connector_key: feed.connector_key, organization_id: feed.organization_id },
    `[queue] Soft-deleted orphan feed — ${reason}`
  );
}

/**
 * Resolve the active connector version (pinned_version → newest active
 * connector_definition) and, when `requireRunnable`, verify the
 * connector_versions row has compiled_code OR a bundled source file on disk.
 * Returns a discriminated result so each caller maps the failure modes to its
 * own behavior (sync soft-deletes the orphan feed; auth/action throw).
 */
type ConnectorVersionResolution =
  | { ok: true; version: string; compiledCode: string | null; sourcePath: string | null }
  | { ok: false; reason: 'no-definition' }
  | { ok: false; reason: 'no-version'; version: string }
  | { ok: false; reason: 'not-runnable'; version: string };

async function resolveActiveConnectorVersion(
  sql: DbClient,
  params: {
    orgId: string;
    connectorKey: string;
    requireRunnable: boolean;
    pinnedVersion?: string | null;
  }
): Promise<ConnectorVersionResolution> {
  let version: string;
  if (params.pinnedVersion) {
    version = params.pinnedVersion;
  } else {
    const defRows = await sql`
      SELECT version FROM connector_definitions
      WHERE key = ${params.connectorKey}
        AND organization_id = ${params.orgId}
        AND status = 'active'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `;
    if (defRows.length === 0) {
      return { ok: false, reason: 'no-definition' };
    }
    version = (defRows[0] as { version: string }).version;
  }

  if (!params.requireRunnable) {
    return { ok: true, version, compiledCode: null, sourcePath: null };
  }

  const versionRows = await sql`
    SELECT compiled_code, source_path FROM connector_versions
    WHERE connector_key = ${params.connectorKey} AND version = ${version}
      AND (organization_id = ${params.orgId} OR organization_id IS NULL)
    ORDER BY organization_id NULLS LAST
    LIMIT 1
  `;
  if (versionRows.length === 0) {
    return { ok: false, reason: 'no-version', version };
  }
  const { compiled_code, source_path } = versionRows[0] as {
    compiled_code: string | null;
    source_path: string | null;
  };
  // Runnable if ANY runtime code source exists: stored compiled code, a
  // source_path the runtime can compile on demand, or a bundled connector
  // file. Union of all three so no run type (sync/auth/operation) regresses —
  // resolveConnectorCode() resolves from whichever is present at execution.
  if (
    !compiled_code &&
    !source_path &&
    !findBundledConnectorFile(params.connectorKey)
  ) {
    return { ok: false, reason: 'not-runnable', version };
  }
  return { ok: true, version, compiledCode: compiled_code, sourcePath: source_path };
}

/**
 * Why no sync run was queued. The reasons differ in remedy — `already_active`
 * resolves itself when the current run finishes, while the others never will
 * (the two connector reasons also retire the feed) — so callers that surface
 * a skip to a human must render the specific reason, not a catch-all.
 */
export type SyncRunSkipReason =
  | 'already_active'
  | 'feed_not_found'
  | 'cloud_restricted'
  | 'connector_uninstalled'
  | 'connector_version_unrunnable';

export type CreateSyncRunResult =
  | { ok: true; runId: number }
  | { ok: false; reason: SyncRunSkipReason };

/** Operator-facing sentence per cause. Kept beside the reasons so a new reason
 *  cannot be added without deciding what a human should be told. */
export function describeSyncRunSkip(reason: SyncRunSkipReason): string {
  switch (reason) {
    case 'already_active':
      return 'Sync already pending or running for this feed';
    case 'feed_not_found':
      return 'Feed not found';
    case 'cloud_restricted':
      return 'This connector cannot run on Lobu Cloud yet, so no sync was queued';
    case 'connector_uninstalled':
      return 'The connector is no longer installed in this workspace; the feed has been retired';
    case 'connector_version_unrunnable':
      return 'The connector version has no runnable code; the feed has been retired';
  }
}

/**
 * Create a pending sync run for a feed (within an existing client/tx). Skips
 * with a `SyncRunSkipReason` instead of queueing when a run is already active,
 * the feed is missing or cloud-restricted, or the connector resolves to
 * nothing runnable — the connector cases also soft-delete the feed (see
 * softDeleteOrphanFeed).
 */
async function createSyncRunWithClient(
  sql: DbClient,
  feedId: number,
  dryRun = false
): Promise<CreateSyncRunResult> {
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
    return { ok: false, reason: 'already_active' };
  }

  // Get feed details (including pinned_version)
  const feedRows = await sql`
    SELECT f.organization_id, f.connection_id, f.pinned_version, f.schedule, f.timezone,
           c.connector_key
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE f.id = ${feedId}
  `;
  if (feedRows.length === 0) {
    logger.warn(`[queue] Feed ${feedId} not found`);
    return { ok: false, reason: 'feed_not_found' };
  }
  const feed = feedRows[0] as {
    organization_id: string;
    connection_id: number;
    connector_key: string;
    pinned_version: string | null;
    schedule: string | null;
    timezone: string | null;
  };

  // Cloud gate: a raw-DB connector (postgres) has no tenant-URL egress hardening
  // yet, so under LOBU_CLOUD_MODE we don't queue a scheduled sync run for it. The
  // connection is already blocked at create time, but an existing feed must not
  // keep queueing. The feed is left intact (NOT soft-deleted) — it's a valid feed
  // that simply can't run on cloud until hardening lands; self-hosted is
  // unaffected. pollWorkerJob gates again as the hard execution boundary.
  if (isCloudMode() && CLOUD_RESTRICTED_CONNECTOR_KEYS.has(feed.connector_key)) {
    logger.warn(
      { feedId, connector_key: feed.connector_key },
      '[queue] Skipping sync run for cloud-restricted connector under LOBU_CLOUD_MODE'
    );
    return { ok: false, reason: 'cloud_restricted' };
  }

  // Resolve connector version: pinned_version → connector_definitions.version,
  // then verify the version has compiled code or a bundled source for on-demand
  // compilation.
  const resolved = await resolveActiveConnectorVersion(sql, {
    orgId: feed.organization_id,
    connectorKey: feed.connector_key,
    requireRunnable: true,
    pinnedVersion: feed.pinned_version,
  });
  if (!resolved.ok) {
    if (resolved.reason === 'no-definition') {
      // The connector was archived/uninstalled in this org but the feed wasn't
      // soft-deleted (see softDeleteOrphanFeed for why we soft-delete rather
      // than warn-and-return).
      await softDeleteOrphanFeed(
        sql,
        feedId,
        feed,
        'no active connector_definition for (connector_key, org).'
      );
      return { ok: false, reason: 'connector_uninstalled' };
    }
    if (resolved.reason === 'no-version') {
      throw new Error(
        `No connector version '${resolved.version}' found for '${feed.connector_key}'. Build/register connector code first.`
      );
    }
    // not-runnable: version is registered but has neither persisted compiled
    // code nor a bundled source file to compile on demand (e.g. a connector key
    // like `chrome.tabs` that was never a standalone bundled connector). It can
    // never run — treat it as an orphan so it stops storming CheckDueFeeds with
    // a per-poll error instead of looping forever (#1012).
    await softDeleteOrphanFeed(
      sql,
      feedId,
      feed,
      `no compiled code and no bundled source for version '${resolved.version}'.`
    );
    return { ok: false, reason: 'connector_version_unrunnable' };
  }
  const connectorVersion = resolved.version;

  // Manual feeds (schedule null) keep next_run_at null after enqueue so they
  // are not re-picked by the due-feed scheduler.
  const nextRunAt = feed.schedule
    ? nextRunAtFromCron(feed.schedule, new Date(), feed.timezone)
    : null;
  // A dry run inserts the run row and stops there. The sibling `UPDATE feeds`
  // below is a real side effect — it stamps `last_sync_status = 'pending'`,
  // clears `last_error`, and rolls `next_run_at` forward to the next cron slot.
  // Letting a dry run do that would move the feed's schedule and overwrite the
  // recorded outcome of the last REAL sync, which is exactly the state a dry
  // run exists to leave untouched.
  const inserted = dryRun
    ? await sql`
    INSERT INTO runs (
      organization_id, run_type, feed_id, connection_id,
      connector_key, connector_version, status, approval_status, created_at,
      dry_run
    ) VALUES (
      ${feed.organization_id}, 'sync', ${feedId}, ${feed.connection_id},
      ${feed.connector_key}, ${connectorVersion}, 'pending', 'auto', current_timestamp,
      true
    )
    RETURNING id
  `
    : await sql`
    WITH inserted AS (
      INSERT INTO runs (
        organization_id, run_type, feed_id, connection_id,
        connector_key, connector_version, status, approval_status, created_at
      ) VALUES (
        ${feed.organization_id}, 'sync', ${feedId}, ${feed.connection_id},
        ${feed.connector_key}, ${connectorVersion}, 'pending', 'auto', current_timestamp
      )
      RETURNING id, feed_id
    )
    UPDATE feeds f
    SET last_sync_status = 'pending',
        last_error = NULL,
        next_run_at = ${nextRunAt},
        updated_at = current_timestamp
    FROM inserted i
    WHERE f.id = i.feed_id
    RETURNING i.id
  `;
  const runId = Number((inserted[0] as { id: unknown }).id);

  logger.info(
    `[queue] Created sync run ${runId} for feed ${feedId} (${feed.connector_key}, version=${connectorVersion})`
  );
  return { ok: true, runId };
}

export async function createSyncRun(
  feedId: number,
  _env: Env,
  db?: DbClient,
  // Defaults false so all four existing call sites (connect/routes, app-install,
  // check-due-feeds, manage_feeds) keep persisting. Only an explicit opt-in is
  // dry — a flag that defaulted the other way would silently stop real syncs.
  opts?: { dryRun?: boolean }
): Promise<CreateSyncRunResult> {
  const sql = db ?? getDb();
  const dryRun = opts?.dryRun === true;

  try {
    if (db) {
      return await createSyncRunWithClient(sql, feedId, dryRun);
    }

    return await sql.begin(async (tx) =>
      createSyncRunWithClient(tx, feedId, dryRun)
    );
  } catch (error) {
    if (isUniqueViolation(error, 'idx_runs_active_sync_per_feed')) {
      logger.info(`[queue] Skipping run creation for feed ${feedId} - duplicate active sync run`);
      // Lost the race against a concurrent trigger — indistinguishable, from
      // here, from having found that run on the way in.
      return { ok: false, reason: 'already_active' };
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
      AND run_type = 'behavior'
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
    agentId?: string | null;
    windowStart: string;
    windowEnd: string;
    dispatchSource: WatcherDispatchSource;
    deviceWorkerId?: string | null;
    agentKind?: string | null;
    sourceFingerprint?: string;
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
    agent_id: params.agentId ?? undefined,
    window_start: params.windowStart,
    window_end: params.windowEnd,
    dispatch_source: params.dispatchSource,
    version_id: snapshotVersionId,
    device_worker_id: normalizedDeviceWorkerId,
    agent_kind: normalizedAgentKind,
    source_fingerprint: params.sourceFingerprint,
  };
  const idempotencyKey = [
    'behavior',
    params.watcherId,
    params.dispatchSource,
    params.windowStart,
    params.windowEnd,
  ].join(':');

  const inserted = await sql`
    INSERT INTO runs (
      organization_id,
      run_type,
      watcher_id,
      approval_status,
      status,
      approved_input,
      idempotency_key,
      created_at
    ) VALUES (
      ${params.organizationId},
      'behavior',
      ${params.watcherId},
      'auto',
      'pending',
      ${sql.json(payload)},
      ${idempotencyKey},
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
    agentId?: string | null;
    windowStart: string;
    windowEnd: string;
    dispatchSource: WatcherDispatchSource;
    deviceWorkerId?: string | null;
    agentKind?: string | null;
    sourceFingerprint?: string;
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
    if (isUniqueViolation(error, 'runs_idempotency_key_uniq')) {
      const idempotencyKey = [
        'behavior',
        params.watcherId,
        params.dispatchSource,
        params.windowStart,
        params.windowEnd,
      ].join(':');
      const rows = await sql`
        SELECT id, status
        FROM runs
        WHERE idempotency_key = ${idempotencyKey}
          AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
        LIMIT 1
      `;
      const existing = rows.length > 0
        ? { id: Number(rows[0]?.id), status: String(rows[0]?.status) }
        : null;
      if (existing) {
        logger.info(
          `[queue] Reusing concurrent watcher run ${existing.id} for watcher ${params.watcherId}`
        );
        return { runId: existing.id, status: existing.status, created: false };
      }
    }

    // Partial unique index idx_runs_pending_non_event_per_behavior:
    // one pending non-event behavior run per behavior. Manual vs scheduled
    // (different idempotency keys) still collides here under TOCTOU races.
    if (isUniqueViolation(error, 'idx_runs_pending_non_event_per_behavior')) {
      const rows = await sql`
        SELECT id, status
        FROM runs
        WHERE watcher_id = ${params.watcherId}
          AND run_type = 'behavior'
          AND watcher_id IS NOT NULL
          AND status = 'pending'
          AND COALESCE(approved_input->>'dispatch_source', 'scheduled') <> 'event'
        LIMIT 1
      `;
      const existing = rows.length > 0
        ? { id: Number(rows[0]?.id), status: String(rows[0]?.status) }
        : null;
      if (existing) {
        logger.info(
          `[queue] Reusing concurrent pending non-event watcher run ${existing.id} for watcher ${params.watcherId}`
        );
        return { runId: existing.id, status: existing.status, created: false };
      }
    }

    logger.error({ error, watcherId: params.watcherId }, '[queue] Failed to create watcher run');
    throw error;
  }
}

/** An activation that produced (or joined) a durable run. */
export interface BehaviorEventRunQueued {
  runId: number;
  status: string;
  created: boolean;
  disposition: 'queued' | 'coalesced' | 'duplicate';
}

/**
 * An activation refused by the Behavior's `min_cooldown_seconds` window. No
 * run exists, so there is no id to dispatch — the distinct shape stops callers
 * treating a suppressed activation as a queued one.
 */
export interface BehaviorEventRunSuppressed {
  runId: null;
  status: 'suppressed';
  created: false;
  disposition: 'cooldown';
}

export type BehaviorEventRunResult =
  | BehaviorEventRunQueued
  | BehaviorEventRunSuppressed;

/**
 * Durably materialize a normalized event signal as a Behavior run. A
 * per-Behavior transaction lock makes queue/coalesce decisions replica-safe;
 * delivery_ids in historical runs provide dedupe without a webhook ledger.
 */
export async function createBehaviorEventRun(
  params: {
    organizationId: string;
    watcherId: number;
    agentId?: string | null;
    trigger: BehaviorActivationTrigger;
    signal: BehaviorActivationSignal;
    deviceWorkerId?: string | null;
    agentKind?: string | null;
  },
  db?: DbClient
): Promise<BehaviorEventRunResult> {
  const sql = db ?? getDb();
  const execute = async (tx: DbClient): Promise<BehaviorEventRunResult> => {
    await lockBehaviorForActivation(tx, params.watcherId);

    const duplicate = await tx`
      SELECT id, status
      FROM runs
      WHERE watcher_id = ${params.watcherId}
        AND run_type = 'behavior'
        AND COALESCE(approved_input->'delivery_ids', '[]'::jsonb)
            @> ${tx.json([params.signal.delivery_id])}::jsonb
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (duplicate.length > 0) {
      return {
        runId: Number(duplicate[0]?.id),
        status: String(duplicate[0]?.status),
        created: false,
        disposition: 'duplicate',
      };
    }

    const policy = params.trigger.active_run ??
      (params.trigger.source === 'workspace' ? 'coalesce' : 'queue');
    const triggerKey = behaviorEventTriggerKey(params.trigger);
    const occurredAt = params.signal.occurred_at
      ? new Date(params.signal.occurred_at)
      : new Date();
    const safeOccurredAt = Number.isNaN(occurredAt.getTime())
      ? new Date()
      : occurredAt;
    const signalWindowStart = safeOccurredAt.toISOString();
    const signalWindowEnd = new Date(safeOccurredAt.getTime() + 1).toISOString();
    if (policy === 'coalesce') {
      const pending = await tx`
        SELECT id, status, approved_input
        FROM runs
        WHERE watcher_id = ${params.watcherId}
          AND run_type = 'behavior'
          AND status = 'pending'
          AND approved_input->>'dispatch_source' = 'event'
          AND approved_input->>'trigger_key' = ${triggerKey}
          AND CASE
            WHEN jsonb_typeof(approved_input->'delivery_ids') = 'array'
              THEN jsonb_array_length(approved_input->'delivery_ids')
            ELSE 0
          END < ${MAX_COALESCED_BEHAVIOR_EVENT_INPUTS}
        -- Connector events retain FIFO coalescing. Workspace events prefer the
        -- newest overflow batch because an older run can have room for another
        -- delivery while its bounded root/causal ancestry is already full.
        ORDER BY
          CASE WHEN ${params.trigger.source === 'workspace'} THEN created_at END DESC,
          created_at ASC,
          id ASC
        LIMIT 1
        FOR UPDATE
      `;
      if (pending.length > 0) {
        const input = (pending[0]?.approved_input ?? {}) as WatcherRunPayload;
        const signals = behaviorTriggerSignals(input);
        const deliveryIds = input.delivery_ids ??
          signals.map((signal) => signal.delivery_id);
        const nextSignals = [...signals, params.signal];
        const nextWorkspaceSignals = nextSignals.filter(
          isWorkspaceEventTriggerSignal
        );
        const causalBehaviorIds = new Set(
          nextWorkspaceSignals.flatMap((signal) => signal.causal_behavior_ids)
        );
        causalBehaviorIds.add(params.watcherId);
        const rootEventIds = new Set(
          nextWorkspaceSignals.flatMap((signal) => signal.root_event_ids)
        );
        // A coalesced run inherits the union of every incoming causal path when
        // it emits a downstream event. Split into another durable run before
        // either half of that ancestry becomes an unbounded payload — and
        // before `deriveWorkspaceEventCausality` would have to reject the
        // producer's completed window for exceeding the same bounds.
        if (
          causalBehaviorIds.size <= MAX_WORKSPACE_EVENT_CAUSAL_BEHAVIORS &&
          rootEventIds.size <= MAX_COALESCED_BEHAVIOR_EVENT_INPUTS
        ) {
          const currentWindowStart = Date.parse(input.window_start);
          const currentWindowEnd = Date.parse(input.window_end);
          const nextInput: WatcherRunPayload = {
            ...input,
            window_start: Number.isFinite(currentWindowStart) &&
                currentWindowStart <= safeOccurredAt.getTime()
              ? input.window_start
              : signalWindowStart,
            window_end: Number.isFinite(currentWindowEnd) &&
                currentWindowEnd >= safeOccurredAt.getTime() + 1
              ? input.window_end
              : signalWindowEnd,
            trigger_signals: nextSignals,
            delivery_ids: [...deliveryIds, params.signal.delivery_id],
          };
          const merged = await tx`
            UPDATE runs
            SET approved_input = ${tx.json(nextInput)}
            WHERE id = ${pending[0]?.id}
              AND status = 'pending'
          `;
          // A zero rowcount means the run left 'pending' between the snapshot
          // and the merge (only possible for writers outside our advisory
          // lock, e.g. old pods during a rolling deploy). Fall through and
          // queue a fresh run rather than dropping the signal.
          if (merged.count > 0) {
            return {
              runId: Number(pending[0]?.id),
              status: String(pending[0]?.status),
              created: false,
              disposition: 'coalesced',
            };
          }
        }
      }
    }

    // Only a genuinely NEW firing consumes the operator's cooldown window.
    // Everything above this line either returned an existing run (a duplicate
    // delivery) or folded the signal into one already pending (coalesce) —
    // neither starts the Behavior again, so neither should count against
    // `min_cooldown_seconds`. We hold the per-Behavior advisory lock, so the
    // read-and-consume inside this claim cannot interleave with another
    // replica handling a concurrent delivery.
    if (!(await claimBehaviorCooldown(tx, params.watcherId))) {
      return {
        runId: null,
        status: 'suppressed',
        created: false,
        disposition: 'cooldown',
      };
    }

    const versionRows = await tx`
      SELECT current_version_id
      FROM watchers
      WHERE id = ${params.watcherId}
      LIMIT 1
    `;
    const versionId = versionRows[0]?.current_version_id == null
      ? null
      : Number(versionRows[0]?.current_version_id);
    const payload: WatcherRunPayload = {
      watcher_id: params.watcherId,
      agent_id: params.agentId ?? undefined,
      window_start: signalWindowStart,
      window_end: signalWindowEnd,
      dispatch_source: 'event',
      version_id: versionId,
      device_worker_id: params.deviceWorkerId ?? null,
      agent_kind: params.agentKind ?? null,
      trigger_signal: params.signal,
      trigger_signals: [params.signal],
      delivery_ids: [params.signal.delivery_id],
      trigger_execution: resolvedEventExecution(params.trigger),
      trigger_output: params.trigger.source === 'workspace'
        ? 'silent'
        : (params.trigger.output ?? 'silent'),
      trigger_key: triggerKey,
    };
    const inserted = await tx`
      INSERT INTO runs (
        organization_id, run_type, watcher_id, approval_status, status,
        approved_input, idempotency_key, created_at
      ) VALUES (
        ${params.organizationId}, 'behavior', ${params.watcherId}, 'auto',
        'pending', ${tx.json(payload)},
        ${`behavior:${params.watcherId}:${params.signal.delivery_id}`},
        current_timestamp
      )
      RETURNING id, status
    `;
    return {
      runId: Number(inserted[0]?.id),
      status: String(inserted[0]?.status),
      created: true,
      disposition: 'queued',
    };
  };

  if (db) return execute(sql);
  try {
    return await sql.begin(execute);
  } catch (error) {
    // Concurrent insert of the same delivery from a writer that did not
    // serialize on our advisory lock (rolling-deploy old pods). The existing
    // run is authoritative; report it instead of failing the delivery.
    if (isUniqueViolation(error, 'runs_idempotency_key_uniq')) {
      const rows = await sql`
        SELECT id, status
        FROM runs
        WHERE idempotency_key = ${`behavior:${params.watcherId}:${params.signal.delivery_id}`}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (rows.length > 0) {
        return {
          runId: Number(rows[0]?.id),
          status: String(rows[0]?.status),
          created: false,
          disposition: 'duplicate',
        };
      }
    }
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
}, db: DbClient = getDb()): Promise<number> {
  const sql = db;

  // Resolve + verify the connector version is runnable.
  const resolved = await resolveActiveConnectorVersion(sql, {
    orgId: params.organizationId,
    connectorKey: params.connectorKey,
    requireRunnable: true,
  });
  if (!resolved.ok) {
    if (resolved.reason === 'no-definition') {
      throw new Error(`No active connector definition found for '${params.connectorKey}'.`);
    }
    if (resolved.reason === 'no-version') {
      throw new Error(
        `No connector version '${resolved.version}' found for '${params.connectorKey}'.`
      );
    }
    throw new Error(
      `Connector '${params.connectorKey}' has no compiled code or source_path for version '${resolved.version}'.`
    );
  }
  const connectorVersion = resolved.version;

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
  /** Durable caller key. A terminal action run remains authoritative forever. */
  idempotencyKey?: string;
  /**
   * - 'inline'  → status='running', approval='auto'. Caller executes
   *               the connector inline on the gateway (server-side
   *               connectors only).
   * - 'queued'  → status='pending', approval='pending'. Waits for human
   *               approval before any worker can claim.
   * - 'device'  → status='pending', approval='auto'. Skips human gate,
   *               waits for a device worker to claim via /poll. Used
   *               for connectors with `runtime` set (chrome-extension,
   *               macos bridge, ios bridge). No gateway-side execution.
   */
  approvalMode: 'inline' | 'queued' | 'device';
  requireCompiledCode?: boolean;
  /**
   * The TRUSTED principal (kind + stable id) that requested this operation,
   * derived from execution context — never from caller-supplied attribution.
   * Persisted so a queued run's connector-action policy can be RE-EVALUATED at
   * approve time against the principal that queued it, not the approver (sol
   * review #5). Null for a human requester (no per-principal policy applies).
   */
  policyPrincipalKind?: 'agent' | 'watcher' | 'user' | null;
  policyPrincipalId?: string | null;
  /** Trusted user who initiated the operation, used for downstream visibility checks. */
  createdByUserId?: string | null;
  /** Trusted Behavior provenance from the executing ToolContext. */
  watcherId?: number | null;
  /** Trusted firing canvas/window id paired with watcherId. */
  windowId?: number | null;
  /**
   * Optional transaction handle. When passed, the run INSERT (and its
   * connector-version read) execute on the caller's transaction instead of the
   * singleton pool, so the caller can bind run creation atomically to a sibling
   * write (e.g. the pending approval EVENT — #2033 item 16). If the caller's tx
   * rolls back, the run never exists.
   */
  db?: DbClient;
}): Promise<{
  runId: number;
  created: boolean;
  status: string;
  approvalStatus: string;
  actionOutput: unknown;
  errorMessage: string | null;
}> {
  const sql = params.db ?? getDb();

  const approvalStatus = params.approvalMode === 'queued' ? 'pending' : 'auto';
  const status = params.approvalMode === 'inline' ? 'running' : 'pending';

  // Ephemeral device/browser/shell action runs get a bounded claim horizon:
  // a `device` run waits for a device worker to claim it via /poll, and an
  // unclaimed one must not sit pending forever — nor must a stale run be
  // claimable by a device that polls back after the operator already gave up.
  // The horizon matches the gateway's pre-claim wait budget: polling stops
  // claiming the run when the caller gives up, and the reaper terminalizes it
  // on its next tick. Durable human-gated runs (`queued`) get NO expiry here —
  // the long-horizon approval reaper owns their lifecycle. `inline` runs
  // execute immediately on the gateway and are already claimed.
  const expiresAtSeconds =
    params.approvalMode === 'device' ? DEVICE_ACTION_QUEUE_BUDGET_MS / 1000 : null;

  // Resolve connector version, verifying it is runnable only when the caller
  // requires compiled code (device/inline executors that load the bundle).
  const resolved = await resolveActiveConnectorVersion(sql, {
    orgId: params.organizationId,
    connectorKey: params.connectorKey,
    requireRunnable: params.requireCompiledCode ?? false,
  });
  if (!resolved.ok) {
    if (resolved.reason === 'no-definition') {
      throw new Error(`No active connector definition found for '${params.connectorKey}'.`);
    }
    if (resolved.reason === 'no-version') {
      throw new Error(
        `No connector version '${resolved.version}' found for '${params.connectorKey}'. Build/register connector code first.`
      );
    }
    throw new Error(
      `Connector '${params.connectorKey}' has no compiled code or source_path for version '${resolved.version}'.`
    );
  }
  const connectorVersion = resolved.version;

  const inserted = await sql<{
    id: number;
    status: string;
    approval_status: string;
    action_output: unknown;
    error_message: string | null;
  }>`
    INSERT INTO runs (
      organization_id, run_type, connection_id, connector_key, connector_version,
      action_key, action_input, approval_status, status,
      watcher_id, window_id,
      policy_principal_kind, policy_principal_id, created_by_user_id,
      action_idempotency_key, expires_at, created_at
    ) VALUES (
      ${params.organizationId}, 'action', ${params.connectionId},
      ${params.connectorKey}, ${connectorVersion},
      ${params.operationKey}, ${sql.json(params.operationInput)},
      ${approvalStatus}, ${status},
      ${params.watcherId ?? null}, ${params.windowId ?? null},
      ${params.policyPrincipalKind ?? null}, ${params.policyPrincipalId ?? null},
      ${params.createdByUserId ?? null},
      ${params.idempotencyKey ?? null},
      ${expiresAtSeconds == null
        ? null
        : sql`current_timestamp + (${expiresAtSeconds}::int * interval '1 second')`},
      current_timestamp
    )
    ON CONFLICT (organization_id, action_idempotency_key)
      WHERE run_type = 'action' AND action_idempotency_key IS NOT NULL
    DO NOTHING
    RETURNING id, status, approval_status, action_output, error_message
  `;

  if (inserted.length === 0) {
    if (!params.idempotencyKey) {
      throw new Error('Action run insert returned no row without an idempotency key.');
    }
    const existing = await sql<{
      id: number;
      connection_id: number;
      connector_key: string;
      action_key: string;
      action_input: Record<string, unknown> | null;
      policy_principal_kind: string | null;
      policy_principal_id: string | null;
      created_by_user_id: string | null;
      watcher_id: number | null;
      window_id: number | null;
      status: string;
      approval_status: string;
      action_output: unknown;
      error_message: string | null;
    }>`
      SELECT id, connection_id, connector_key, action_key, action_input,
             policy_principal_kind, policy_principal_id, created_by_user_id,
             watcher_id, window_id,
             status, approval_status, action_output, error_message
      FROM runs
      WHERE organization_id = ${params.organizationId}
        AND run_type = 'action'
        AND action_idempotency_key = ${params.idempotencyKey}
      LIMIT 1
    `;
    const prior = existing[0];
    if (!prior) {
      throw new Error('Concurrent action idempotency winner was not readable.');
    }
    const sameRequest =
      Number(prior.connection_id) === params.connectionId &&
      prior.connector_key === params.connectorKey &&
      prior.action_key === params.operationKey &&
      stableJson(prior.action_input ?? {}) === stableJson(params.operationInput) &&
      prior.policy_principal_kind === (params.policyPrincipalKind ?? null) &&
      prior.policy_principal_id === (params.policyPrincipalId ?? null) &&
      prior.created_by_user_id === (params.createdByUserId ?? null);
    const priorWatcherId = prior.watcher_id == null ? null : Number(prior.watcher_id);
    const priorWindowId = prior.window_id == null ? null : Number(prior.window_id);
    const requestedWatcherId = params.watcherId ?? null;
    const requestedWindowId = params.windowId ?? null;
    const compatibleProvenance =
      (priorWatcherId == null || priorWatcherId === requestedWatcherId) &&
      (priorWindowId == null || priorWindowId === requestedWindowId);
    if (!sameRequest || !compatibleProvenance) {
      throw new ToolUserError(
        `Action idempotency key '${params.idempotencyKey}' is already bound to a different request.`,
        409
      );
    }
    // Runs created before Behavior action provenance was stamped can be safely
    // hydrated on an exact idempotent replay. Never overwrite a non-null stamp:
    // a key already bound to another window remains a conflict above.
    if (
      (priorWatcherId == null && requestedWatcherId != null) ||
      (priorWindowId == null && requestedWindowId != null)
    ) {
      await sql`
        UPDATE runs
        SET watcher_id = COALESCE(watcher_id, ${requestedWatcherId}),
            window_id = COALESCE(window_id, ${requestedWindowId})
        WHERE id = ${Number(prior.id)}
          AND organization_id = ${params.organizationId}
      `;
    }
    return {
      runId: Number(prior.id),
      created: false,
      status: prior.status,
      approvalStatus: prior.approval_status,
      actionOutput: prior.action_output,
      errorMessage: prior.error_message,
    };
  }

  const row = inserted[0];
  const runId = Number(row.id);
  logger.info(
    `[queue] Created action run ${runId} (${params.connectorKey}/${params.operationKey}, approval=${approvalStatus})`
  );
  return {
    runId,
    created: true,
    status: row.status,
    approvalStatus: row.approval_status,
    actionOutput: row.action_output,
    errorMessage: row.error_message,
  };
}
