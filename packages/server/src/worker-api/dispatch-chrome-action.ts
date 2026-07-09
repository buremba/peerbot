/**
 * POST /api/workers/dispatch-chrome-action
 *
 * Thin bridge: a connector running on the connector-worker fleet wants to
 * call a chrome connector action against the paired Owletto extension in
 * the same org. We:
 *
 *   1. Look up the parent sync run's org (+ optional data connection) from runs.
 *   2. Pick an online chrome connection / extension (prefer parent connection's
 *      chrome-extension pin when set — browser affinity for LinkedIn/X/etc.).
 *   3. Enqueue an action run via `createConnectorOperationRun` (the same
 *      helper `manage_operations.execute` uses for device-bound calls).
 *   4. Await completion via the shared `waitForDeviceActionRun` (also
 *      reused from manage_operations).
 *   5. Return the action_output.
 *
 * Multi-replica safe by reuse: all signalling is via Postgres rows on the
 * `runs` table; the chrome extension's `/api/workers/complete-action` POST
 * can land on any replica and finalize the run row.
 */

import type { Context } from 'hono';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { waitForDeviceActionRun } from '../tools/admin/manage_operations';
import { errorMessage } from '../utils/errors';
import logger from '../utils/logger';
import { createConnectorOperationRun } from '../runs/queue-service';

interface DispatchChromeActionBody {
  parent_run_id: number;
  worker_id: string;
  action_key: string;
  action_input: Record<string, unknown>;
}

// Online window for chrome extension device workers, in minutes. Matches
// the /api/me/devices "online" flag.
const DEVICE_ONLINE_WINDOW_MINUTES = 20;

export interface ChromeActionDispatchResult {
  status: 'completed' | 'failed' | 'timeout';
  output?: Record<string, unknown>;
  error_message?: string;
}

export type ResolveOnlineChromeOptions = {
  /**
   * Prefer this device_workers.id when it is an online debugger-capable
   * chrome-extension. Used for browser affinity: a LinkedIn/X/Revolut
   * connection may set device_worker_id to a chrome-extension worker to mean
   * "scrape with this browser" (parent sync still runs on the fleet — see
   * poll.ts browser-affinity claim rules).
   */
  preferredDeviceWorkerId?: string | null;
  /**
   * When preferredDeviceWorkerId is set but that extension is offline / not
   * eligible, fail instead of falling back to last_seen (avoids scraping the
   * wrong profile). Default true when a preference is provided.
   */
  failIfPreferredOffline?: boolean;
};

/**
 * Resolve an online Owletto Chrome extension to run a chrome action against.
 *
 * Resolution order:
 *   1. preferredDeviceWorkerId if online + chrome-extension + debugger
 *   2. The org chrome connection's current pin if still online (sticky —
 *      multi-Chrome orgs must not jump to last_seen DESC)
 *   3. Freshest online debugger-capable extension (heal NULL / stale pin)
 *
 * When we select a worker, the org `chrome` connection is repinned to it so
 * the poll claim path can route the action run.
 */
export async function resolveOnlineChromeConnection(
  organizationId: string,
  sql = getDb(),
  opts: ResolveOnlineChromeOptions = {}
): Promise<{ connectionId: number; deviceWorkerId: string } | null> {
  const preferredId = opts.preferredDeviceWorkerId ?? null;
  const failIfPreferredOffline =
    opts.failIfPreferredOffline ?? preferredId != null;

  const rows = (await sql`
    SELECT
      con.id AS connection_id,
      con.device_worker_id AS current_pin,
      pinned.id AS pinned_online_worker_id,
      preferred.id AS preferred_online_worker_id,
      fresh.id AS fresh_online_worker_id
    FROM connections con
    LEFT JOIN device_workers pinned
      ON pinned.id = con.device_worker_id
     AND pinned.organization_id = con.organization_id
     AND pinned.platform = 'chrome-extension'
     AND pinned.capabilities::jsonb @> '["browser.debugger"]'::jsonb
     AND pinned.last_seen_at > now() - make_interval(mins => ${DEVICE_ONLINE_WINDOW_MINUTES})
    LEFT JOIN device_workers preferred
      ON ${preferredId}::uuid IS NOT NULL
     AND preferred.id = ${preferredId}::uuid
     AND preferred.organization_id = con.organization_id
     AND preferred.platform = 'chrome-extension'
     AND preferred.capabilities::jsonb @> '["browser.debugger"]'::jsonb
     AND preferred.last_seen_at > now() - make_interval(mins => ${DEVICE_ONLINE_WINDOW_MINUTES})
    LEFT JOIN LATERAL (
      SELECT dw.id
      FROM device_workers dw
      WHERE dw.organization_id = con.organization_id
        AND dw.platform = 'chrome-extension'
        AND dw.capabilities::jsonb @> '["browser.debugger"]'::jsonb
        AND dw.last_seen_at > now() - make_interval(mins => ${DEVICE_ONLINE_WINDOW_MINUTES})
      ORDER BY dw.last_seen_at DESC
      LIMIT 1
    ) fresh ON TRUE
    WHERE con.organization_id = ${organizationId}
      AND con.connector_key = 'chrome'
      AND con.status = 'active'
      AND con.deleted_at IS NULL
    LIMIT 1
  `) as Array<{
    connection_id: number;
    current_pin: string | null;
    pinned_online_worker_id: string | null;
    preferred_online_worker_id: string | null;
    fresh_online_worker_id: string | null;
  }>;

  if (rows.length === 0) return null;
  const {
    connection_id,
    current_pin,
    pinned_online_worker_id,
    preferred_online_worker_id,
    fresh_online_worker_id,
  } = rows[0];

  // Explicit browser affinity (data connection pin → chrome-extension) wins.
  if (preferredId) {
    if (preferred_online_worker_id) {
      if (current_pin !== preferred_online_worker_id) {
        await sql`
          UPDATE connections
          SET device_worker_id = ${preferred_online_worker_id}::uuid, updated_at = now()
          WHERE id = ${connection_id}
            AND deleted_at IS NULL
        `;
      }
      return {
        connectionId: connection_id,
        deviceWorkerId: preferred_online_worker_id,
      };
    }
    if (failIfPreferredOffline) {
      // Caller surfaces a clear error — do not silently scrape another profile.
      return null;
    }
  }

  // Sticky org chrome pin, else freshest online debugger extension.
  const online_worker_id = pinned_online_worker_id ?? fresh_online_worker_id;
  if (!online_worker_id) return null;

  if (current_pin !== online_worker_id) {
    await sql`
      UPDATE connections
      SET device_worker_id = ${online_worker_id}::uuid, updated_at = now()
      WHERE id = ${connection_id}
        AND deleted_at IS NULL
    `;
  }

  return { connectionId: connection_id, deviceWorkerId: online_worker_id };
}

/**
 * Look up browser affinity for a parent sync: if the data connection is pinned
 * to a chrome-extension worker, that pin means "use this browser" (not "run
 * the parent sync on the extension" — see poll.ts).
 */
export async function preferredBrowserWorkerForConnection(
  connectionId: number | null | undefined,
  sql = getDb()
): Promise<string | null> {
  if (connectionId == null) return null;
  const rows = (await sql`
    SELECT dw.id
    FROM connections con
    JOIN device_workers dw ON dw.id = con.device_worker_id
    WHERE con.id = ${connectionId}
      AND con.deleted_at IS NULL
      AND dw.platform = 'chrome-extension'
    LIMIT 1
  `) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/**
 * Core chrome-action dispatch, callable in-process (no HTTP Context):
 *
 *   1. Pick an online paired Owletto chrome connection in `organizationId`.
 *   2. Enqueue a device-bound chrome action run via `createConnectorOperationRun`.
 *   3. Await completion via `waitForDeviceActionRun` and return its output.
 */
export async function dispatchChromeActionToExtension(params: {
  organizationId: string;
  actionKey: string;
  actionInput: Record<string, unknown>;
  /** Parent run id, for log correlation only. */
  parentRunId?: number;
  /**
   * Data connection that owns the parent sync (e.g. LinkedIn). When pinned to
   * a chrome-extension, scrapes target that browser.
   */
  parentConnectionId?: number | null;
  /** Abort the wait early (e.g. the calling reaction hit its budget). */
  abortSignal?: AbortSignal;
}): Promise<ChromeActionDispatchResult> {
  const {
    organizationId,
    actionKey,
    actionInput,
    parentRunId,
    parentConnectionId,
    abortSignal,
  } = params;
  const sql = getDb();

  const preferredDeviceWorkerId = await preferredBrowserWorkerForConnection(
    parentConnectionId,
    sql
  );

  const chromeConnection = await resolveOnlineChromeConnection(organizationId, sql, {
    preferredDeviceWorkerId,
    failIfPreferredOffline: preferredDeviceWorkerId != null,
  });
  if (!chromeConnection) {
    return {
      status: 'failed',
      error_message: preferredDeviceWorkerId
        ? 'The Chrome extension selected for this connection is offline. Open Owletto in that browser (and stay signed in) to continue.'
        : 'No online paired Owletto Chrome extension in this organization. Pair a Chrome extension first (and make sure it is running).',
    };
  }

  // Stamp holder_run_id on every chrome action so the extension can scope
  // scratch-tab ownership/cleanup to the parent sync run.
  const operationInput: Record<string, unknown> = { ...(actionInput ?? {}) };
  if (
    parentRunId != null &&
    operationInput.holder_run_id == null &&
    operationInput.parent_run_id == null
  ) {
    operationInput.holder_run_id = parentRunId;
  }

  let runId: number;
  try {
    runId = await createConnectorOperationRun({
      organizationId,
      connectionId: chromeConnection.connectionId,
      connectorKey: 'chrome',
      operationKey: actionKey,
      operationInput,
      approvalMode: 'device',
      requireCompiledCode: false,
    });
  } catch (err) {
    const msg = errorMessage(err);
    logger.error(
      { err: msg, parent_run_id: parentRunId, action_key: actionKey },
      '[dispatchChromeAction] createConnectorOperationRun failed'
    );
    return { status: 'failed', error_message: msg };
  }

  logger.info(
    {
      run_id: runId,
      parent_run_id: parentRunId,
      parent_connection_id: parentConnectionId,
      action_key: actionKey,
      chrome_connection_id: chromeConnection.connectionId,
      device_worker_id: chromeConnection.deviceWorkerId,
      preferred_device_worker_id: preferredDeviceWorkerId,
    },
    '[dispatchChromeAction] dispatched'
  );

  const result = await waitForDeviceActionRun(runId, organizationId, abortSignal);
  const output =
    result.output && typeof result.output === 'object' && !Array.isArray(result.output)
      ? (result.output as Record<string, unknown>)
      : undefined;
  return { ...result, output };
}

export async function dispatchChromeAction(c: Context<{ Bindings: Env }>) {
  let body: DispatchChromeActionBody;
  try {
    body = await c.req.json<DispatchChromeActionBody>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.parent_run_id !== 'number' || !body.parent_run_id) {
    return c.json({ error: 'parent_run_id is required' }, 400);
  }
  if (!body.worker_id?.trim()) {
    return c.json({ error: 'worker_id is required' }, 400);
  }
  if (!body.action_key?.trim()) {
    return c.json({ error: 'action_key is required' }, 400);
  }

  const sql = getDb();

  // Authorize: parent run must exist, be a running sync claimed by this worker.
  // connection_id drives browser affinity when pinned to a chrome-extension.
  const parentRows = (await sql`
    SELECT r.organization_id, r.status, r.claimed_by, r.run_type, r.connection_id
    FROM runs r
    WHERE r.id = ${body.parent_run_id}
    LIMIT 1
  `) as Array<{
    organization_id: string;
    status: string;
    claimed_by: string | null;
    run_type: string;
    connection_id: number | null;
  }>;
  if (parentRows.length === 0) {
    return c.json({ error: 'parent_run not found' }, 404);
  }
  const parentRun = parentRows[0];
  if (parentRun.status !== 'running') {
    return c.json(
      { error: `parent_run is ${parentRun.status}, must be running` },
      409
    );
  }
  if (parentRun.claimed_by !== body.worker_id) {
    return c.json({ error: 'parent_run is not claimed by this worker' }, 403);
  }
  if (parentRun.run_type !== 'sync') {
    return c.json(
      { error: `parent_run must be a sync run, got ${parentRun.run_type}` },
      400
    );
  }

  const result = await dispatchChromeActionToExtension({
    organizationId: parentRun.organization_id,
    actionKey: body.action_key,
    actionInput: body.action_input ?? {},
    parentRunId: body.parent_run_id,
    parentConnectionId: parentRun.connection_id,
  });
  return c.json(result);
}
