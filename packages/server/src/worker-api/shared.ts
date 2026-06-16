/**
 * Shared helpers for the worker API.
 *
 * `authorizeRunForWorker` — re-used by heartbeat, stream, complete,
 * complete-watcher, complete-action, and complete-auth to verify the caller
 * owns the run it's acting on.
 *
 * `normalizeAdvertisedCapabilities` — sanitises the raw capabilities map the
 * device sends on poll.
 */

import type { Context } from 'hono';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { runInWorkerScope } from '../utils/device-claimable-orgs';

const WORKER_CAPABILITY_NAME_RE = /^[a-z][a-z0-9_.:-]{0,63}$/;

export function normalizeAdvertisedCapabilities(capabilities: Record<string, boolean>): string[] {
  return Array.from(
    new Set(
      Object.entries(capabilities)
        .map(([key, value]) => [key.trim(), value] as const)
        .filter(([key, value]) => value === true && WORKER_CAPABILITY_NAME_RE.test(key))
        .map(([key]) => key)
    )
  );
}

/**
 * Verify that the request's worker auth scope is allowed to touch this run.
 * Trusted/anonymous workers see everything; a user-scoped device worker can
 * only touch a run that (a) is currently `running`, (b) — when the caller
 * passes its worker id, always required here — was claimed by that same
 * `worker_id`, and (c) is in scope for this worker: either in one of the
 * user's orgs, or whose connection is pinned to a device this user owns.
 * `worker_id` is client-supplied and only unique per install, so (b) alone is
 * not a sufficient gate — (c) keeps a worker from heartbeating/completing some
 * unrelated org's run by guessing a `(run_id, worker_id)` pair. (a) stops
 * re-touching a pending/finished run.
 *
 * Returns a Hono response on rejection, or null on pass.
 */
export async function authorizeRunForWorker(
  c: Context<{ Bindings: Env }>,
  runId: number,
  expectedWorkerId?: string,
  opts?: {
    /**
     * Accept runs already in a terminal state. Used by the device watcher
     * EXIT REPORT (`/runs/:id/complete-watcher`): the CLI agent completes
     * the run itself via MCP `complete_window` before the subprocess exits,
     * so by the time the dispatcher reports the exit the run is normally
     * `completed` — that's the happy path, not a conflict. Ownership
     * (scope + claimed_by) is still enforced.
     */
    allowTerminal?: boolean;
  }
): Promise<Response | null> {
  if (c.var.workerAuthMode !== 'user') {
    return null;
  }
  const workerUserId = c.var.workerUserId;
  const orgIds = c.var.workerOrgIds ?? [];
  const sql = getDb();
  const rows = (await sql`
    SELECT r.status, r.claimed_by, r.organization_id,
           dw.user_id AS device_owner,
           wdw.user_id AS watcher_device_owner
    FROM runs r
    LEFT JOIN connections con ON con.id = r.connection_id
    LEFT JOIN device_workers dw ON dw.id = con.device_worker_id
    LEFT JOIN watchers w ON w.id = r.watcher_id
    LEFT JOIN device_workers wdw ON wdw.id = w.device_worker_id
    WHERE r.id = ${runId}
    LIMIT 1
  `) as unknown as Array<{
    status: string;
    claimed_by: string | null;
    organization_id: string;
    device_owner: string | null;
    watcher_device_owner: string | null;
  }>;
  if (rows.length === 0) {
    return c.json({ error: 'Run not found' }, 404);
  }
  const run = rows[0];
  // Watcher runs pinned to a device the worker owns are in scope too (the pin
  // is the owner's consent), so a device can FINISH a cross-org run it claimed —
  // not just claim it. Without this the poll widening would 403 on completion.
  const inScope = runInWorkerScope(run, { workerUserId, orgIds });
  if (!inScope) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (run.status !== 'running' && !opts?.allowTerminal) {
    return c.json({ error: 'Run is not in progress' }, 409);
  }
  if (!expectedWorkerId?.trim()) {
    return c.json({ error: 'worker_id is required' }, 400);
  }
  if (run.claimed_by !== expectedWorkerId) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return null;
}
