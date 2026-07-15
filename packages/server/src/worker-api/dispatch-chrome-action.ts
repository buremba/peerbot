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

import type { DispatchChromeActionRequest } from '@lobu/core/contracts/worker/protocol';
import type { Context } from 'hono';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { waitForDeviceActionRun } from '../tools/admin/manage_operations';
import { errorMessage } from '../utils/errors';
import logger from '../utils/logger';
import { isUniqueViolation } from '../utils/pg-errors';
import { createConnectorOperationRun } from '../runs/queue-service';

// Online window for chrome extension device workers, in minutes. Matches
// the /api/me/devices "online" flag.
const DEVICE_ONLINE_WINDOW_MINUTES = 20;

/** Live unique index: one chrome connection per (org, device_worker) pin. */
const CHROME_DEVICE_PIN_UNIQUE = 'idx_connections_org_connector_device_live';

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

type ChromeConnRow = {
  connection_id: number;
  current_pin: string | null;
  /** Online debugger-capable worker id for current_pin, else null. */
  pin_online_worker_id: string | null;
};

/**
 * Resolve an online Owletto Chrome extension to run a chrome action against.
 *
 * Resolution order:
 *   1. preferredDeviceWorkerId if online + chrome-extension + debugger:
 *      - return the chrome connection already pinned to it (no UPDATE)
 *      - else rebind a safe candidate (NULL / offline pin; or the sole chrome
 *        row for single-connection affinity rebind)
 *   2. No preference: sticky online pin on any chrome row (deterministic by id)
 *   3. Freshest unowned online worker + safe rebind candidate (heal NULL/stale)
 *
 * Never steals a device pin already held by another live chrome connection —
 * that hits idx_connections_org_connector_device_live and used to 500 the
 * dispatcher (multi-Chrome orgs: Mac mini + MacBook).
 */
export async function resolveOnlineChromeConnection(
  organizationId: string,
  sql = getDb(),
  opts: ResolveOnlineChromeOptions = {}
): Promise<{ connectionId: number; deviceWorkerId: string } | null> {
  const preferredId = opts.preferredDeviceWorkerId ?? null;
  const failIfPreferredOffline =
    opts.failIfPreferredOffline ?? preferredId != null;

  const chromeRows = (await sql`
    SELECT
      con.id AS connection_id,
      con.device_worker_id AS current_pin,
      pinned.id AS pin_online_worker_id
    FROM connections con
    LEFT JOIN device_workers pinned
      ON pinned.id = con.device_worker_id
     AND pinned.organization_id = con.organization_id
     AND pinned.platform = 'chrome-extension'
     AND pinned.capabilities::jsonb @> '["browser.debugger"]'::jsonb
     AND pinned.last_seen_at > now() - make_interval(mins => ${DEVICE_ONLINE_WINDOW_MINUTES})
    WHERE con.organization_id = ${organizationId}
      AND con.connector_key = 'chrome'
      AND con.status = 'active'
      AND con.deleted_at IS NULL
    ORDER BY con.id ASC
  `) as ChromeConnRow[];

  if (chromeRows.length === 0) return null;

  const onlineWorkers = (await sql`
    SELECT dw.id
    FROM device_workers dw
    WHERE dw.organization_id = ${organizationId}
      AND dw.platform = 'chrome-extension'
      AND dw.capabilities::jsonb @> '["browser.debugger"]'::jsonb
      AND dw.last_seen_at > now() - make_interval(mins => ${DEVICE_ONLINE_WINDOW_MINUTES})
    ORDER BY dw.last_seen_at DESC
  `) as Array<{ id: string }>;

  const onlineWorkerIds = new Set(onlineWorkers.map((w) => w.id));

  const logSelection = (
    reason: string,
    connectionId: number,
    deviceWorkerId: string,
    repaired: boolean
  ) => {
    logger.info(
      {
        organization_id: organizationId,
        preferred_device_worker_id: preferredId,
        chrome_connection_id: connectionId,
        device_worker_id: deviceWorkerId,
        selection_reason: reason,
        repaired,
        chrome_connection_count: chromeRows.length,
      },
      '[dispatchChromeAction] chrome connection resolved'
    );
  };

  // Prefer existing owner of a target worker (no UPDATE). Concurrent-safe:
  // re-read on unique violation after a guarded rebind.
  const findOwnerOf = async (
    deviceWorkerId: string
  ): Promise<number | null> => {
    const local = chromeRows.find((r) => r.current_pin === deviceWorkerId);
    if (local) return local.connection_id;
    const rows = (await sql`
      SELECT id
      FROM connections
      WHERE organization_id = ${organizationId}
        AND connector_key = 'chrome'
        AND status = 'active'
        AND device_worker_id = ${deviceWorkerId}::uuid
        AND deleted_at IS NULL
      LIMIT 1
    `) as Array<{ id: number }>;
    return rows[0]?.id ?? null;
  };

  /**
   * Rebind `connectionId` onto `deviceWorkerId` only when the target is still
   * unowned AND the candidate still holds the pin we selected it on
   * (`expectedCurrentPin`). The compare-and-swap stops two concurrent
   * resolutions targeting different workers from both picking the same
   * NULL/stale candidate and silently clobbering each other's pin — the loser's
   * UPDATE affects zero rows and falls through to the winner-handling path.
   * On race/unique violation, return the winner's connection.
   */
  const rebindChromeToWorker = async (
    connectionId: number,
    expectedCurrentPin: string | null,
    deviceWorkerId: string,
    reason: string
  ): Promise<{ connectionId: number; deviceWorkerId: string } | null> => {
    const existingOwner = await findOwnerOf(deviceWorkerId);
    if (existingOwner != null) {
      logSelection(`${reason}:existing_owner`, existingOwner, deviceWorkerId, false);
      return { connectionId: existingOwner, deviceWorkerId };
    }

    try {
      const updated = (await sql`
        UPDATE connections
        SET device_worker_id = ${deviceWorkerId}::uuid, updated_at = now()
        WHERE id = ${connectionId}
          AND organization_id = ${organizationId}
          AND connector_key = 'chrome'
          AND status = 'active'
          AND deleted_at IS NULL
          AND device_worker_id IS NOT DISTINCT FROM ${expectedCurrentPin}::uuid
          AND NOT EXISTS (
            SELECT 1
            FROM connections other
            WHERE other.organization_id = ${organizationId}
              AND other.connector_key = 'chrome'
              AND other.device_worker_id = ${deviceWorkerId}::uuid
              AND other.deleted_at IS NULL
              AND other.id <> ${connectionId}
          )
        RETURNING id
      `) as Array<{ id: number }>;

      if (updated.length > 0) {
        logSelection(reason, connectionId, deviceWorkerId, true);
        return { connectionId, deviceWorkerId };
      }

      // Lost the race or candidate vanished — return whoever owns the target.
      const winner = await findOwnerOf(deviceWorkerId);
      if (winner != null) {
        logSelection(`${reason}:race_winner`, winner, deviceWorkerId, false);
        return { connectionId: winner, deviceWorkerId };
      }
      return null;
    } catch (err) {
      if (isUniqueViolation(err, CHROME_DEVICE_PIN_UNIQUE)) {
        const winner = await findOwnerOf(deviceWorkerId);
        if (winner != null) {
          logSelection(`${reason}:unique_recovery`, winner, deviceWorkerId, false);
          return { connectionId: winner, deviceWorkerId };
        }
        return null;
      }
      throw err;
    }
  };

  /**
   * Pick a chrome row safe to rebind onto an unowned target worker.
   * Never steals a pin held by a *different* live chrome connection on that
   * target (caller checks ownership first). Source candidates:
   *   1. NULL pin
   *   2. Offline / ineligible pin
   *   3. Sole chrome connection (single-connection browser-affinity rebind)
   */
  const pickRebindCandidate = (): ChromeConnRow | null => {
    const nullPinned = chromeRows.find((r) => r.current_pin == null);
    if (nullPinned) return nullPinned;
    const offlinePinned = chromeRows.find((r) => r.pin_online_worker_id == null);
    if (offlinePinned) return offlinePinned;
    if (chromeRows.length === 1) return chromeRows[0];
    return null;
  };

  // --- Preferred browser affinity ---
  if (preferredId) {
    if (onlineWorkerIds.has(preferredId)) {
      const ownerId = await findOwnerOf(preferredId);
      if (ownerId != null) {
        logSelection('preferred_existing_owner', ownerId, preferredId, false);
        return { connectionId: ownerId, deviceWorkerId: preferredId };
      }

      const candidate = pickRebindCandidate();
      if (!candidate) {
        // Multi-chrome: every chrome row is sticky on another online browser
        // and preferred has no chrome lane. Do not steal.
        logger.info(
          {
            organization_id: organizationId,
            preferred_device_worker_id: preferredId,
            chrome_connection_count: chromeRows.length,
            selection_reason: 'preferred_unowned_no_rebind_candidate',
          },
          '[dispatchChromeAction] chrome connection unresolved'
        );
        return null;
      }

      return rebindChromeToWorker(
        candidate.connection_id,
        candidate.current_pin,
        preferredId,
        'preferred_rebind'
      );
    }

    if (failIfPreferredOffline) {
      return null;
    }
    // Preferred offline and fallback allowed — continue to sticky / heal.
  }

  // --- Sticky: any chrome already online (multi-Chrome: do not jump to last_seen) ---
  const sticky = chromeRows.find((r) => r.pin_online_worker_id != null);
  if (sticky?.pin_online_worker_id) {
    logSelection(
      'sticky_online_pin',
      sticky.connection_id,
      sticky.pin_online_worker_id,
      false
    );
    return {
      connectionId: sticky.connection_id,
      deviceWorkerId: sticky.pin_online_worker_id,
    };
  }

  // --- Heal: freshest online worker not owned by a live chrome row ---
  const ownedPins = new Set(
    chromeRows.map((r) => r.current_pin).filter((p): p is string => p != null)
  );
  const unownedOnline = onlineWorkers.find((w) => !ownedPins.has(w.id));
  if (!unownedOnline) {
    return null;
  }

  const candidate = pickRebindCandidate();
  if (!candidate) {
    return null;
  }

  return rebindChromeToWorker(
    candidate.connection_id,
    candidate.current_pin,
    unownedOnline.id,
    'heal_unowned_online'
  );
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
  let body: DispatchChromeActionRequest;
  try {
    body = await c.req.json<DispatchChromeActionRequest>();
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
