/**
 * Device-scoped browser auth profile CRUD.
 *
 * The Mac app uses these to create, list, and revoke browser-session auth
 * profiles bound to a physical device worker (mirror mode and CDP-attach).
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

export const BROWSER_KIND_SET: ReadonlySet<BrowserKind> = new Set(['chrome', 'brave', 'arc', 'edge']);

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
 * Body: { worker_id, display_name, browser_kind, cdp_url?, auth_data? }
 *
 * Create a browser-session auth profile bound to this device. The two
 * supported shapes are mirror (auth_data.source_profile_dir, cookies
 * decrypted on the device at sync time) and CDP attach (cdp_url, Lobu
 * connects to a Chrome the user is running with remote debugging).
 * Cookies stay on the device; server's auth_data carries only the
 * non-secret pointer to the source profile.
 */
export async function createMyDeviceAuthProfile(c: Context<{ Bindings: Env }>) {
  let body: {
    worker_id?: string;
    display_name?: string;
    browser_kind?: string;
    cdp_url?: string;
    auth_data?: {
      source_profile_dir?: string;
      source_browser_root?: string;
      source_browser?: string;
      mode?: string;
      /** Opt-in per profile. When true and DevToolsActivePort exists at
       * sync time, the connector subprocess attaches via CDP to the
       * user's running Chrome. Default false — Lobu only touches the
       * user's browser process when explicitly granted. */
      allow_cdp_attach?: boolean;
    };
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const workerId = (body.worker_id ?? '').trim();
  const displayName = (body.display_name ?? '').trim();
  const browserKind = (body.browser_kind ?? '').trim() as BrowserKind;
  const cdpUrl = (body.cdp_url ?? '').trim();
  const mirrorSourceDir = (body.auth_data?.source_profile_dir ?? '').trim();
  const mirrorBrowserRoot = (body.auth_data?.source_browser_root ?? '').trim();
  const mirrorSourceBrowser = (body.auth_data?.source_browser ?? '').trim();
  if (!workerId || !displayName || !browserKind) {
    return c.json({ error: 'worker_id, display_name, browser_kind are required' }, 400);
  }
  if (!BROWSER_KIND_SET.has(browserKind)) {
    return c.json({ error: `browser_kind must be one of: ${[...BROWSER_KIND_SET].join(', ')}` }, 400);
  }
  // Two valid shapes for a browser_session profile:
  //   - Mirror mode (optionally with CDP override on auth_data.allow_cdp_attach):
  //     auth_data.source_profile_dir + source_browser_root set; cdp_url may
  //     pin a port the user wants the connector to attach to.
  //   - Pure CDP attach: cdp_url only, no mirror fields.
  const hasMirrorSourceDir = mirrorSourceDir.length > 0;
  const hasMirrorBrowserRoot = mirrorBrowserRoot.length > 0;
  // Reject partial mirror metadata loudly. Without this check, a request
  // that supplies only source_profile_dir (no source_browser_root) plus a
  // cdp_url would pass as "pure CDP attach" and silently drop the mirror
  // intent. The caller meant mirror but the row would never apply it.
  if (hasMirrorSourceDir !== hasMirrorBrowserRoot) {
    return c.json(
      {
        error:
          'mirror mode requires both auth_data.source_profile_dir and auth_data.source_browser_root',
      },
      400
    );
  }
  const isMirror = hasMirrorSourceDir && hasMirrorBrowserRoot;
  if (!isMirror && cdpUrl.length === 0) {
    return c.json(
      {
        error:
          'browser_session needs auth_data.source_profile_dir (mirror) or cdp_url (attach)',
      },
      400
    );
  }
  const { device, error } = await resolveDeviceWorkerForRequest(c, workerId);
  if (error) return error;
  try {
    // Idempotency key:
    //   - Mirror mode: (org, device, browser_kind, auth_data.source_profile_dir)
    //   - CDP/legacy:  (org, device, browser_kind) — only one of these per
    //     device since they describe Lobu-owned or device-owned Chrome
    //     state, not per-profile state.
    // This lets the user mirror multiple Chrome profiles (Default + Work)
    // on the same Mac without collisions, while a re-add of the same source
    // profile updates the existing row instead of erroring.
    const sql = getDb();
    const existingRows = isMirror
      ? ((await sql`
          SELECT id, organization_id, slug, display_name, connector_key,
                 profile_kind, status, auth_data, account_id, provider,
                 created_by, created_at, updated_at,
                 device_worker_id, browser_kind, user_data_dir, cdp_url
          FROM auth_profiles
          WHERE organization_id = ${device!.organization_id}
            AND device_worker_id = ${device!.id}
            AND profile_kind = 'browser_session'
            AND browser_kind = ${browserKind}
            AND auth_data->>'source_profile_dir' = ${mirrorSourceDir}
            AND status <> 'revoked'
          ORDER BY created_at ASC
          LIMIT 1
        `) as unknown as Array<Record<string, unknown>>)
      : ((await sql`
          SELECT id, organization_id, slug, display_name, connector_key,
                 profile_kind, status, auth_data, account_id, provider,
                 created_by, created_at, updated_at,
                 device_worker_id, browser_kind, user_data_dir, cdp_url
          FROM auth_profiles
          WHERE organization_id = ${device!.organization_id}
            AND device_worker_id = ${device!.id}
            AND profile_kind = 'browser_session'
            AND browser_kind = ${browserKind}
            AND (auth_data->>'source_profile_dir') IS NULL
            AND status <> 'revoked'
          ORDER BY created_at ASC
          LIMIT 1
        `) as unknown as Array<Record<string, unknown>>);
    // For mirror mode, the non-secret config lives in auth_data so we don't
    // pollute the column surface with mirror-specific fields. The Mac app
    // re-decrypts cookies at sync time, so we never write a cookie blob.
    const newAuthData = isMirror
      ? {
          mode: 'mirror',
          source_profile_dir: mirrorSourceDir,
          source_browser_root: mirrorBrowserRoot,
          source_browser: mirrorSourceBrowser || 'chrome',
          // Strict opt-in. Anything other than explicit `true` becomes
          // `false` — including missing field on an existing row that the
          // Mac app hasn't migrated yet. Keeps Lobu from touching the
          // user's Chrome unless they actively checked the box.
          allow_cdp_attach: body.auth_data?.allow_cdp_attach === true,
        }
      : {};
    // Mirror profiles are usable immediately (cookies live in the
    // user's Chrome already). Pure CDP attach is pending until first run.
    const initialStatus = !isMirror && cdpUrl ? 'pending_auth' : 'active';
    if (existingRows.length > 0) {
      const existing = existingRows[0]!;
      // Refresh the volatile fields on re-mirror so the user can switch
      // a profile between cookies-only and live-Chrome by re-clicking
      // Mirror with a different checkbox state.
      const updated = (await sql`
        UPDATE auth_profiles
        SET user_data_dir = NULL,
            cdp_url = ${cdpUrl || null},
            display_name = ${displayName},
            auth_data = ${sql.json(newAuthData)},
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
      cdpUrl: cdpUrl || null,
      authData: newAuthData,
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
  let body: { worker_id?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
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
