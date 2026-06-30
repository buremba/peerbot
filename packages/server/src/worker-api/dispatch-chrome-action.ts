/**
 * POST /api/workers/dispatch-chrome-action
 *
 * Thin bridge: a connector running on the connector-worker fleet wants to
 * call a chrome connector action against the paired Owletto extension in
 * the same org. We:
 *
 *   1. Look up the parent sync run's org from runs.
 *   2. Pick an online chrome connection in that org.
 *   3. Enqueue an action run via `createConnectorOperationRun` (the same
 *      helper `manage_operations.execute` uses for device-bound calls).
 *   4. Await completion via the shared `waitForDeviceActionRun` (also
 *      reused from manage_operations).
 *   5. Return the action_output.
 *
 * No new state machine, no new queue — the device-action runs queue does
 * the work end-to-end, the same way the user drove it manually via
 * `POST /api/{org}/manage_operations { action: 'execute' }` earlier today.
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

/**
 * Resolve an online Owletto Chrome extension to run a chrome action against, and
 * self-heal the org's `chrome` connection pin to it.
 *
 * Both this dispatch and the poll claim gate on `connections.device_worker_id`,
 * but nothing keeps the generic `chrome` action connection bound to the current
 * extension worker: re-pairing mints a NEW device worker and leaves the chrome
 * connection pinned to the old (now offline) one — or never pinned at all (it's
 * not a bundled device connector, so `device-reconcile` doesn't touch it). The
 * result: a server-side chrome connector (Revolut, LinkedIn) can't reach an
 * extension that IS online, and dispatch fails with "no online paired
 * extension". So resolve any online, debugger-capable chrome-extension worker in
 * the org INDEPENDENT of the existing pin, then repin the connection to it
 * before enqueuing — fixing both the NULL-pin and stale-pin (post-re-pair) cases.
 *
 * Returns the chrome connection id + the resolved worker, or null when no online
 * extension exists in the org.
 */
export async function resolveOnlineChromeConnection(
  organizationId: string,
  sql = getDb()
): Promise<{ connectionId: number; deviceWorkerId: string } | null> {
  const rows = (await sql`
    SELECT
      con.id AS connection_id,
      con.device_worker_id AS current_pin,
      dw.id AS online_worker_id
    FROM connections con
    JOIN device_workers dw ON dw.organization_id = con.organization_id
    WHERE con.organization_id = ${organizationId}
      AND con.connector_key = 'chrome'
      AND con.status = 'active'
      AND con.deleted_at IS NULL
      AND dw.platform = 'chrome-extension'
      AND dw.capabilities::jsonb @> '["browser.debugger"]'::jsonb
      AND dw.last_seen_at > now() - make_interval(mins => ${DEVICE_ONLINE_WINDOW_MINUTES})
    ORDER BY dw.last_seen_at DESC
    LIMIT 1
  `) as Array<{ connection_id: number; current_pin: string | null; online_worker_id: string }>;

  if (rows.length === 0) return null;
  const { connection_id, current_pin, online_worker_id } = rows[0];

  // Self-heal the pin so the poll claim (which gates on device_worker_id) routes
  // the run to the online worker. Covers a NULL pin and a stale post-re-pair pin.
  if (current_pin !== online_worker_id) {
    await sql`
      UPDATE connections
      SET device_worker_id = ${online_worker_id}::uuid, updated_at = now()
      WHERE id = ${connection_id}
    `;
  }

  return { connectionId: connection_id, deviceWorkerId: online_worker_id };
}

/**
 * Core chrome-action dispatch, callable in-process (no HTTP Context):
 *
 *   1. Pick an online paired Owletto chrome connection in `organizationId`.
 *   2. Enqueue a device-bound chrome action run via `createConnectorOperationRun`.
 *   3. Await completion via `waitForDeviceActionRun` and return its output.
 *
 * Used by the HTTP bridge (a connector on the worker fleet, after it has
 * authorized the parent sync run) AND by `manage_operations` inline action
 * execution (a connector action — e.g. the office-bot Deliveroo connector —
 * running in-gateway that wants to scrape the paired extension). Caller is
 * responsible for any parent-run authorization; this function only resolves a
 * chrome worker and drives the run.
 */
export async function dispatchChromeActionToExtension(params: {
  organizationId: string;
  actionKey: string;
  actionInput: Record<string, unknown>;
  /** Parent run id, for log correlation only. */
  parentRunId?: number;
  /** Abort the wait early (e.g. the calling reaction hit its budget). */
  abortSignal?: AbortSignal;
}): Promise<ChromeActionDispatchResult> {
  const { organizationId, actionKey, actionInput, parentRunId, abortSignal } =
    params;
  const sql = getDb();

  // (1) Pick an online chrome extension in this org and pin the chrome
  //     connection to it (self-heals NULL / stale-after-re-pair pins so the
  //     poll claim can route the run). See resolveOnlineChromeConnection.
  const chromeConnection = await resolveOnlineChromeConnection(organizationId, sql);
  if (!chromeConnection) {
    return {
      status: 'failed',
      error_message:
        'No online paired Owletto Chrome extension in this organization. Pair a Chrome extension first (and make sure it is running).',
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

  // (2) Insert a device-bound chrome connector action run.
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
      action_key: actionKey,
      chrome_connection_id: chromeConnection.connectionId,
      device_worker_id: chromeConnection.deviceWorkerId,
    },
    '[dispatchChromeAction] dispatched'
  );

  // (3) Wait for the chrome extension to claim and complete.
  return waitForDeviceActionRun(runId, organizationId, abortSignal);
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

  // (1) Authorize: parent run must exist, be a running sync claimed by
  // this worker. We don't re-gate on workerAuthMode — the parent claim
  // already gated org access; trusted callers (WORKER_API_TOKEN) are
  // server-side fleets that already have full access.
  const parentRows = (await sql`
    SELECT r.organization_id, r.status, r.claimed_by, r.run_type
    FROM runs r
    WHERE r.id = ${body.parent_run_id}
    LIMIT 1
  `) as Array<{
    organization_id: string;
    status: string;
    claimed_by: string | null;
    run_type: string;
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
  const organizationId = parentRun.organization_id;

  // (2-4) Resolve a chrome worker, enqueue the device action run, and await
  // completion — shared with manage_operations inline action execution.
  const result = await dispatchChromeActionToExtension({
    organizationId,
    actionKey: body.action_key,
    actionInput: body.action_input ?? {},
    parentRunId: body.parent_run_id,
  });
  return c.json(result);
}
