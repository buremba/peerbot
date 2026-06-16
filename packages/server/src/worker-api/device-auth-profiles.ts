/**
 * Device-scoped browser auth profile CRUD.
 *
 * The Mac app uses these to create, list, and revoke browser-session auth
 * profiles bound to a physical device worker (CDP-attach).
 *
 *   GET    /api/workers/me/auth-profiles?worker_id=...
 *   POST   /api/workers/me/auth-profiles
 *   DELETE /api/workers/me/auth-profiles/:id  { worker_id }
 */

import type { Context } from 'hono';
import { getDb } from '../db/client';
import type { Env } from '../index';
import {
  type BrowserKind,
  createAuthProfile,
} from '../utils/auth-profiles';
import { errorMessage } from '../utils/errors';
import logger from '../utils/logger';
import { parseJsonBody } from '../gateway/routes/shared/helpers';

const BROWSER_KIND_SET: ReadonlySet<BrowserKind> = new Set(['chrome', 'brave', 'arc', 'edge']);

/**
 * Resolve the device_workers row for the authenticated user + workerId.
 *
 * Returns `{ device }` on success or `{ device: null, error }` on failure so
 * callers can early-return the error response without throwing.
 */
export async function resolveDeviceWorkerForRequest(
  c: Context<{ Bindings: Env }>,
  workerId: string
): Promise<{ device: { id: string; organization_id: string } | null; error?: Response }> {
  const userId = c.var.workerUserId;
  if (!userId) {
    return { device: null, error: c.json({ error: 'Unauthorized' }, 401) };
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT id, organization_id
    FROM device_workers
    WHERE user_id = ${userId} AND worker_id = ${workerId}
    LIMIT 1
  `) as unknown as Array<{ id: string; organization_id: string | null }>;
  const row = rows[0];
  if (!row) {
    return { device: null, error: c.json({ error: 'Device not registered yet — poll first' }, 404) };
  }
  if (!row.organization_id) {
    return { device: null, error: c.json({ error: 'Device has no organization attached' }, 409) };
  }
  return { device: { id: row.id, organization_id: row.organization_id } };
}

/**
 * GET /api/workers/me/auth-profiles?worker_id=...
 *
 * List the browser-session auth profiles owned by this device worker. The Mac
 * app uses this to reconcile its local --user-data-dir directories against
 * server state after each poll.
 */
export async function listMyDeviceAuthProfiles(c: Context<{ Bindings: Env }>) {
  const workerId = (c.req.query('worker_id') ?? '').trim();
  if (!workerId) {
    return c.json({ error: 'worker_id query param is required' }, 400);
  }
  const { device, error } = await resolveDeviceWorkerForRequest(c, workerId);
  if (error) return error;
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT id, slug, display_name, connector_key, profile_kind, status,
             browser_kind, user_data_dir, cdp_url, auth_data,
             created_at, updated_at
      FROM auth_profiles
      WHERE device_worker_id = ${device!.id}
        AND profile_kind = 'browser_session'
        AND status <> 'revoked'
      ORDER BY created_at DESC
    `) as unknown as Array<Record<string, unknown>>;
    return c.json({ profiles: rows });
  } catch (err) {
    logger.error({ error: errorMessage(err) }, '[listMyDeviceAuthProfiles] Error');
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * POST /api/workers/me/auth-profiles
 *
 * Body: { worker_id, display_name, browser_kind, cdp_url }
 *
 * Create a browser-session auth profile bound to this device. Auth is CDP
 * attach: Lobu connects to a Chrome the user runs with remote debugging
 * (cdp_url). No cookies ever touch the server.
 */
export async function createMyDeviceAuthProfile(c: Context<{ Bindings: Env }>) {
  const body = await parseJsonBody<{
    worker_id?: string;
    display_name?: string;
    browser_kind?: string;
    cdp_url?: string;
  }>(c);
  if (body instanceof Response) return body;
  const workerId = (body.worker_id ?? '').trim();
  const displayName = (body.display_name ?? '').trim();
  const browserKind = (body.browser_kind ?? '').trim() as BrowserKind;
  const cdpUrl = (body.cdp_url ?? '').trim();
  if (!workerId || !displayName || !browserKind) {
    return c.json({ error: 'worker_id, display_name, browser_kind are required' }, 400);
  }
  if (!BROWSER_KIND_SET.has(browserKind)) {
    return c.json({ error: `browser_kind must be one of: ${[...BROWSER_KIND_SET].join(', ')}` }, 400);
  }
  if (cdpUrl.length === 0) {
    return c.json({ error: 'browser_session needs cdp_url (CDP attach)' }, 400);
  }
  const { device, error } = await resolveDeviceWorkerForRequest(c, workerId);
  if (error) return error;
  try {
    // Idempotency key: (org, device, browser_kind) — one CDP-attach profile
    // per browser per device; a re-add updates the existing row.
    const sql = getDb();
    const existingRows = (await sql`
      SELECT id, organization_id, slug, display_name, connector_key,
             profile_kind, status, auth_data, account_id, provider,
             created_by, created_at, updated_at,
             device_worker_id, browser_kind, user_data_dir, cdp_url
      FROM auth_profiles
      WHERE organization_id = ${device!.organization_id}
        AND device_worker_id = ${device!.id}
        AND profile_kind = 'browser_session'
        AND browser_kind = ${browserKind}
        AND status <> 'revoked'
      ORDER BY created_at ASC
      LIMIT 1
    `) as unknown as Array<Record<string, unknown>>;
    // CDP attach is pending until the first run authenticates against the
    // live Chrome session.
    const initialStatus = 'pending_auth';
    if (existingRows.length > 0) {
      const existing = existingRows[0]!;
      const updated = (await sql`
        UPDATE auth_profiles
        SET user_data_dir = NULL,
            cdp_url = ${cdpUrl},
            display_name = ${displayName},
            auth_data = ${sql.json({})},
            status = ${initialStatus},
            updated_at = now()
        WHERE id = ${existing.id as number}
        RETURNING id, organization_id, slug, display_name, connector_key,
                  profile_kind, status, auth_data, account_id, provider,
                  created_by, created_at, updated_at,
                  device_worker_id, browser_kind, user_data_dir, cdp_url
      `) as unknown as Array<Record<string, unknown>>;
      return c.json({ profile: updated[0] ?? existing });
    }
    const profile = await createAuthProfile({
      organizationId: device!.organization_id,
      connectorKey: null,
      displayName,
      profileKind: 'browser_session',
      status: initialStatus,
      createdBy: c.var.workerUserId,
      deviceWorkerId: device!.id,
      browserKind,
      userDataDir: null,
      cdpUrl,
      authData: {},
    });
    return c.json({ profile });
  } catch (err) {
    logger.error({ error: errorMessage(err) }, '[createMyDeviceAuthProfile] Error');
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * DELETE /api/workers/me/auth-profiles/:id  { worker_id }
 *
 * Soft-revoke an auth profile owned by this device. Connections referencing
 * this profile keep their auth_profile_id (the slug surfaces in the UI as
 * "auth revoked, reconnect"), matching the existing convention.
 */
export async function deleteMyDeviceAuthProfile(c: Context<{ Bindings: Env }>) {
  const profileId = Number((c.req.param('id') ?? '').trim());
  if (!Number.isFinite(profileId)) {
    return c.json({ error: 'invalid profile id' }, 400);
  }
  const body = await parseJsonBody<{ worker_id?: string }>(c);
  if (body instanceof Response) return body;
  const workerId = (body.worker_id ?? '').trim();
  if (!workerId) {
    return c.json({ error: 'worker_id is required' }, 400);
  }
  const { device, error } = await resolveDeviceWorkerForRequest(c, workerId);
  if (error) return error;
  try {
    const sql = getDb();
    const updated = (await sql`
      UPDATE auth_profiles
      SET status = 'revoked', updated_at = now()
      WHERE id = ${profileId}
        AND device_worker_id = ${device!.id}
        AND profile_kind = 'browser_session'
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    if (updated.length === 0) {
      return c.json({ error: 'Profile not found on this device' }, 404);
    }
    return c.json({ ok: true });
  } catch (err) {
    logger.error({ error: errorMessage(err) }, '[deleteMyDeviceAuthProfile] Error');
    return c.json({ error: errorMessage(err) }, 500);
  }
}
