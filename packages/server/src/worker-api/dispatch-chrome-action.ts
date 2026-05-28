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
import { createConnectorOperationRun } from '../utils/queue-helpers';

interface DispatchChromeActionBody {
  parent_run_id: number;
  worker_id: string;
  action_key: string;
  action_input: Record<string, unknown>;
}

// Online window for chrome extension device workers, in minutes. Matches
// the /api/me/devices "online" flag.
const DEVICE_ONLINE_WINDOW_MINUTES = 20;

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

  // (2) Pick an online chrome connection in this org.
  const chromeConnectionRows = (await sql`
    SELECT
      con.id AS connection_id,
      con.device_worker_id,
      dw.last_seen_at
    FROM connections con
    JOIN device_workers dw ON dw.id = con.device_worker_id
    WHERE con.organization_id = ${organizationId}
      AND con.connector_key = 'chrome'
      AND con.status = 'active'
      AND con.deleted_at IS NULL
      AND dw.capabilities::jsonb @> '["browser.debugger"]'::jsonb
      AND dw.last_seen_at > now() - make_interval(mins => ${DEVICE_ONLINE_WINDOW_MINUTES})
    ORDER BY dw.last_seen_at DESC
    LIMIT 1
  `) as Array<{
    connection_id: number;
    device_worker_id: string;
    last_seen_at: Date | string;
  }>;

  if (chromeConnectionRows.length === 0) {
    return c.json({
      status: 'failed',
      error_message:
        'No online paired Owletto Chrome extension in this organization. Pair a Chrome extension first (and make sure it is running).',
    });
  }
  const chromeConnection = chromeConnectionRows[0];

  // (3) Insert a device-bound chrome connector action run. Same helper
  // manage_operations.execute uses for device-bound calls.
  let runId: number;
  try {
    runId = await createConnectorOperationRun({
      organizationId,
      connectionId: chromeConnection.connection_id,
      connectorKey: 'chrome',
      operationKey: body.action_key,
      operationInput: body.action_input ?? {},
      approvalMode: 'device',
      requireCompiledCode: false,
    });
  } catch (err) {
    const msg = errorMessage(err);
    logger.error(
      { err: msg, parent_run_id: body.parent_run_id, action_key: body.action_key },
      '[dispatchChromeAction] createConnectorOperationRun failed'
    );
    return c.json({ status: 'failed', error_message: msg });
  }

  logger.info(
    {
      run_id: runId,
      parent_run_id: body.parent_run_id,
      action_key: body.action_key,
      chrome_connection_id: chromeConnection.connection_id,
      device_worker_id: chromeConnection.device_worker_id,
    },
    '[dispatchChromeAction] dispatched'
  );

  // (4) Wait for the chrome extension to claim and complete. Shared with
  // manage_operations.execute's device-bound path.
  const result = await waitForDeviceActionRun(runId, organizationId);
  return c.json(result);
}
