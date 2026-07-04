/**
 * Device worker management endpoints.
 *
 * Session-authenticated (mcpAuth) endpoints for managing registered device
 * workers:
 *
 *   GET    /api/me/devices
 *   POST   /api/me/devices/mint-child-token
 *   PATCH  /api/me/devices/:id
 *   DELETE /api/me/devices/:id
 */

import { isKnownPlatform } from '@lobu/core';
import type { Context } from 'hono';
import { createAuth } from '../auth';
import { findExistingPersonalOrg } from '../auth/personal-org-provisioning';
import { PersonalAccessTokenService } from '../auth/tokens';
import { getDb, pgBigintArray } from '../db/client';
import type { Env } from '../index';
import { captureServerError } from '../sentry';
import { errorMessage } from '../utils/errors';
import { recordLifecycleEvent } from '../utils/insert-event';
import logger from '../utils/logger';
import { getWorkspaceRole } from '../utils/organization-access';
import { parseJsonBody } from '../gateway/routes/shared/helpers';

/**
 * GET /api/me/devices
 *
 * Returns the calling user's registered device workers, each with its surrogate
 * id (used as `device_worker_id` when pinning a connection), the workspace the
 * device is attached to, how many connections are pinned to it (and how many of
 * those are erroring), and when its feeds last synced.
 * Requires session / PAT / OAuth authentication (mcpAuth).
 */
export async function listDeviceWorkers(c: Context<{ Bindings: Env }>) {
  const userId = c.var.user?.id;
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT
        dw.id,
        dw.worker_id,
        dw.platform,
        dw.app_version,
        dw.capabilities,
        dw.label,
        dw.last_seen_at,
        (dw.last_seen_at > now() - interval '20 minutes') AS online,
        dw.organization_id,
        o.name AS organization_name,
        o.slug AS organization_slug,
        (SELECT count(*) FROM connections cn WHERE cn.device_worker_id = dw.id AND cn.deleted_at IS NULL)::int AS connector_count,
        (SELECT count(*) FROM connections cn WHERE cn.device_worker_id = dw.id AND cn.deleted_at IS NULL AND cn.status = 'error')::int AS connector_error_count,
        (
          SELECT max(f.last_sync_at) FROM feeds f
          JOIN connections cn ON cn.id = f.connection_id
          WHERE cn.device_worker_id = dw.id AND f.deleted_at IS NULL
        ) AS last_sync_at,
        (
          SELECT coalesce(
            json_agg(
              json_build_object(
                'connection_id', cn.id,
                'connector_key', cn.connector_key,
                'display_name', coalesce(cd.name, cn.connector_key),
                'status', cn.status,
                'organization_slug', cno.slug
              )
              ORDER BY cn.created_at
            ),
            '[]'::json
          )
          FROM connections cn
          LEFT JOIN organization cno ON cno.id = cn.organization_id
          LEFT JOIN LATERAL (
            SELECT name FROM connector_definitions
            WHERE key = cn.connector_key AND status = 'active' AND organization_id = cn.organization_id
            ORDER BY updated_at DESC LIMIT 1
          ) cd ON TRUE
          WHERE cn.device_worker_id = dw.id AND cn.deleted_at IS NULL
        ) AS connectors
      FROM device_workers dw
      LEFT JOIN organization o ON o.id = dw.organization_id
      WHERE dw.user_id = ${userId}
      ORDER BY dw.last_seen_at DESC
    `) as unknown as Array<{
      id: string;
      worker_id: string;
      platform: string | null;
      app_version: string | null;
      capabilities: string[];
      label: string | null;
      last_seen_at: string;
      online: boolean;
      organization_id: string | null;
      organization_name: string | null;
      organization_slug: string | null;
      connector_count: number;
      connector_error_count: number;
      last_sync_at: string | null;
      connectors: Array<{
        connection_id: number;
        connector_key: string;
        display_name: string;
        status: string;
        organization_slug: string | null;
      }>;
    }>;
    return c.json({
      devices: rows.map((r) => ({
        id: r.id,
        worker_id: r.worker_id,
        platform: r.platform,
        app_version: r.app_version,
        capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
        label: r.label,
        last_seen_at: r.last_seen_at,
        online: r.online,
        organization_id: r.organization_id,
        organization_name: r.organization_name,
        organization_slug: r.organization_slug,
        connector_count: r.connector_count ?? 0,
        connector_error_count: r.connector_error_count ?? 0,
        last_sync_at: r.last_sync_at,
        connectors: Array.isArray(r.connectors) ? r.connectors : [],
      })),
    });
  } catch (err: unknown) {
    logger.error({ error: errorMessage(err) }, '[listDeviceWorkers] Error');
    captureServerError(c, err, 'listDeviceWorkers');
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * POST /api/me/devices/mint-child-token  { platform, label? }
 *
 * Hand-off path for the Mac bridge to pair a sibling device (today: the
 * Owletto Chrome extension) without a second OAuth dance. The Mac app's
 * bearer authenticates the caller; we mint a fresh PAT in the same user's
 * personal org, generate a new worker_id, and return both for the sibling
 * to use as if it had completed device-authorization on its own.
 *
 * Scope of the child token is the same `device_worker:run` scope the
 * regular Mac OAuth flow ends up with — capability authorization at
 * /api/workers/poll still constrains what the child can advertise per its
 * declared `platform` (see @lobu/core/capabilities).
 */
export async function mintDeviceChildToken(c: Context<{ Bindings: Env }>) {
  const userId = c.var.user?.id;
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  // The caller must already hold a device-worker bearer — i.e. a session
  // that itself was minted for running on a device (the Mac bridge's
  // signed-in OAuth token, or a previously-issued child PAT). A plain
  // browser/web session shouldn't be allowed to silently escalate into a
  // device worker; if a user wants to pair Chrome from a browser they go
  // through the OAuth device-authorization flow, not this endpoint.
  const callerScopes = c.var.mcpAuthInfo?.scopes ?? [];
  if (!callerScopes.includes('device_worker:run')) {
    return c.json(
      { error: 'insufficient_scope', required: 'device_worker:run' },
      403
    );
  }

  const body = await parseJsonBody<{
    platform?: string;
    label?: string;
    /**
     * Optional: the sibling's existing worker_id. When the Mac bridge forwards
     * the extension's already-stored id we reuse that device identity (re-mint
     * the bound PAT, keep the same row) instead of minting a fresh one, so
     * native re-pairs don't churn the device id and accumulate orphaned
     * `device_workers` rows. See the reuse branch below.
     */
    worker_id?: string;
  }>(c, 'Invalid or missing JSON body');
  if (body instanceof Response) return body;
  const platform = (body.platform ?? '').trim();
  if (!platform) {
    return c.json({ error: 'platform is required' }, 400);
  }
  // Only known device platforms can mint children — keeps the surface tight.
  // Today: chrome-extension. (The Mac app calling for itself would just use
  // its existing OAuth token; macos/ios don't need this path.)
  if (platform !== 'chrome-extension' || !isKnownPlatform(platform)) {
    return c.json({ error: `platform '${platform}' is not eligible for child-token mint` }, 400);
  }
  const label = body.label?.toString().trim() || null;
  // The sibling's previously-stored worker_id, if the Mac bridge forwarded it.
  // Trimmed; validated against ownership + platform in the reuse branch below,
  // so a stale/garbage value just falls through to a fresh mint.
  const requestedWorkerId = (body.worker_id ?? '').trim();

  try {
    const sql = getDb();
    // Device clients (Owletto Chrome extension via the Mac bridge) ALWAYS bind
    // to the user's personal org — never the calling token's org. Personal
    // device data (browser context, captured pages, …) belongs in the user's
    // private workspace; a team org reaches the device by pinning a watcher /
    // connection to it (see resolveDeviceClaimableOrgs), not by re-binding the
    // device token. Ignoring `c.var.organizationId` here is what makes a Mac
    // app whose own token is bound to a team org still land Chrome's data in
    // the personal org.
    const personalOrg = await findExistingPersonalOrg(userId, sql);
    const organizationId: string | null = personalOrg?.id ?? null;
    if (!organizationId) {
      return c.json(
        { error: 'personal_org_missing', error_description: 'User has no personal org to bind the device to.' },
        403
      );
    }

    // Identity reuse: when the sibling forwards its existing worker_id AND it
    // already belongs to this user as a chrome-extension device, keep that
    // identity stable — re-mint the PAT bound to the same worker_id (revoking
    // the previous child PAT first) and reuse the existing device_workers row.
    // This is what stops each Mac-bridge re-pair from minting a fresh uuid and
    // orphaning the previous row (the source of the duplicate "chrome" entries
    // on the Devices page). Falls through to a fresh mint for the first-ever
    // pair, a stale/garbage id, or an id owned by another user/platform — i.e.
    // any case where reuse would be unsafe or a no-op.
    let workerId: string;
    if (requestedWorkerId) {
      const existing = (await sql`
        SELECT worker_id FROM device_workers
        WHERE user_id = ${userId}
          AND worker_id = ${requestedWorkerId}
          AND platform = 'chrome-extension'
        LIMIT 1
      `) as unknown as Array<{ worker_id: string }>;
      workerId = existing[0]?.worker_id ?? crypto.randomUUID();
    } else {
      workerId = crypto.randomUUID();
    }
    const reused = workerId === requestedWorkerId;

    const patService = new PersonalAccessTokenService(sql);
    // Upsert the device_workers row (exists on reuse, created on first mint).
    // On the reuse path this MUST run inside the same transaction as the PAT
    // mint/revoke (see below) so last_seen_at refresh + new-PAT-visibility
    // commit atomically — otherwise a concurrent reaper could see the reused
    // row still stale (30+ days unseen) and the freshly-minted PAT as already
    // committed, then delete the row and revoke that brand-new PAT. The helper
    // takes the db handle (sql for fresh-mint, tx for reuse) so both paths run
    // the identical statement. Platform is bound once and never changed here
    // (poll's ON CONFLICT preserves it via COALESCE + a SELECT-then-reject
    // check, and the gateway's capability authorization uses the stored
    // platform rather than whatever the bearer self-reports).
    const upsertDeviceWorker = (db: typeof sql) => db`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
      VALUES (${userId}, ${workerId}, ${platform}, ${db.json([])}, ${label}, ${organizationId})
      ON CONFLICT (user_id, worker_id) DO UPDATE
        SET last_seen_at = NOW(),
            label = COALESCE(EXCLUDED.label, device_workers.label)
    `;

    let created: { id: number; token: string };
    if (reused) {
      created = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('lobu:mint-child'), hashtext(${workerId}))`;
        // Refresh last_seen_at in the SAME transaction so the reaper can never
        // observe a committed, valid PAT bound to a still-stale reused row. Do
        // this BEFORE the PAT mint/revoke so this tx acquires the device_workers
        // row lock before any personal_access_tokens row locks — the same
        // lock order the reaper uses (DELETE device_workers → UPDATE PATs),
        // which avoids a cross-transaction deadlock when both touch the same
        // stale reused device at once.
        await upsertDeviceWorker(tx);
        const minted = await new PersonalAccessTokenService(tx).create(
          userId,
          organizationId,
          `device:${platform}:${workerId.slice(0, 8)}`,
          {
            scope: 'device_worker:run',
            description: label ?? undefined,
            workerId,
          }
        );
        await tx`
          UPDATE personal_access_tokens
          SET revoked_at = NOW(), updated_at = NOW()
          WHERE user_id = ${userId}
            AND worker_id = ${workerId}
            AND id <> ${minted.id}
            AND revoked_at IS NULL
        `;
        return minted;
      });
    } else {
      created = await patService.create(
        userId,
        organizationId,
        `device:${platform}:${workerId.slice(0, 8)}`,
        {
          scope: 'device_worker:run',
          description: label ?? undefined,
          workerId,
        }
      );
      // Fresh row — no staleness to race against, so the upsert runs outside a
      // transaction (the INSERT sets last_seen_at = NOW() via the column default).
      await upsertDeviceWorker(sql);
    }

    // Also mint a Better Auth session token for the same user. The sibling
    // device's iframe needs a session cookie (not a PAT) to land signed-in;
    // the extension installs this via /api/exchange-token. Without it the
    // user has to type their password a second time after auto-pair.
    let sessionToken: string | null = null;
    try {
      const auth = await createAuth(c.env, c.req.raw);
      const ctx = await auth.$context;
      const session = await ctx.internalAdapter.createSession(userId);
      sessionToken = session?.token ?? null;
    } catch (err) {
      // Session mint is best-effort — child PAT is the primary credential.
      // Falling back to no session_token means the iframe shows sign-in,
      // matching pre-existing behaviour for siblings that haven't adopted
      // the handoff.
      logger.warn(
        { err: errorMessage(err), userId },
        '[mintDeviceChildToken] session mint failed; returning child PAT only'
      );
    }

    const gatewayUrl = new URL(c.req.url).origin;
    if (reused) {
      logger.info(
        { userId, workerId, platform },
        '[mintDeviceChildToken] reused existing device identity on re-pair'
      );
    }
    return c.json({
      worker_id: workerId,
      access_token: created.token,
      session_token: sessionToken,
      gateway_url: gatewayUrl,
      label,
      platform,
    });
  } catch (err) {
    logger.error({ err: errorMessage(err) }, '[mintDeviceChildToken] failed');
    captureServerError(c, err, 'mintDeviceChildToken');
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * PATCH /api/me/devices/:id  { organization_id }
 *
 * Re-attach one of the caller's devices to a different workspace they belong to.
 * A device's connectors live in its workspace; moving the device un-pins and
 * pauses the connections (and their feeds) it backed in the previous one.
 */
export async function updateDeviceWorkerOrg(c: Context<{ Bindings: Env }>) {
  const userId = c.var.user?.id;
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const deviceWorkerId = (c.req.param('id') ?? '').trim();
  if (!deviceWorkerId) {
    return c.json({ error: 'device id is required' }, 400);
  }
  let organizationId: string;
  try {
    const body = await c.req.json<{ organization_id?: string }>();
    organizationId = (body.organization_id ?? '').trim();
    if (!organizationId) {
      return c.json({ error: 'organization_id is required' }, 400);
    }
  } catch {
    return c.json({ error: 'Invalid or missing JSON body' }, 400);
  }
  try {
    const sql = getDb();
    const role = await getWorkspaceRole(sql, organizationId, userId);
    if (!role) {
      return c.json({ error: 'You are not a member of that workspace' }, 403);
    }
    const updated = await sql.begin(async (tx) => {
      const owned = (await tx`
        SELECT organization_id FROM device_workers WHERE id = ${deviceWorkerId} AND user_id = ${userId} LIMIT 1
      `) as unknown as Array<{ organization_id: string | null }>;
      if (owned.length === 0) return false;
      if (owned[0].organization_id !== organizationId) {
        const affected = (await tx`
          UPDATE connections
          SET device_worker_id = NULL,
              status = 'paused',
              error_message = 'Device was moved to another workspace',
              updated_at = NOW()
          WHERE device_worker_id = ${deviceWorkerId}
          RETURNING id
        `) as unknown as Array<{ id: number }>;
        const ids = affected.map((r) => r.id);
        if (ids.length > 0) {
          await tx`
            UPDATE feeds SET status = 'paused', updated_at = NOW()
            WHERE connection_id = ANY(${pgBigintArray(ids)}::bigint[]) AND deleted_at IS NULL AND status = 'active'
          `;
        }
        await tx`UPDATE device_workers SET organization_id = ${organizationId} WHERE id = ${deviceWorkerId}`;
      }
      return true;
    });
    if (!updated) {
      return c.json({ error: 'Device not found or not owned by you' }, 404);
    }
    return c.json({ ok: true });
  } catch (err: unknown) {
    logger.error({ error: errorMessage(err) }, '[updateDeviceWorkerOrg] Error');
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * DELETE /api/me/devices/:id
 *
 * Permanently forgets one of the caller's registered devices. Connections
 * pinned to it are un-pinned and paused — they can't run anywhere without the
 * device — and their active feeds are paused. If the device app is still
 * running it re-registers on its next heartbeat as a fresh device.
 */
export async function deleteDeviceWorker(c: Context<{ Bindings: Env }>) {
  const userId = c.var.user?.id;
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const deviceWorkerId = (c.req.param('id') ?? '').trim();
  if (!deviceWorkerId) {
    return c.json({ error: 'device id is required' }, 400);
  }
  try {
    const sql = getDb();
    const deleted = await sql.begin(async (tx) => {
      const owned = (await tx`
        SELECT organization_id, label, worker_id FROM device_workers
        WHERE id = ${deviceWorkerId} AND user_id = ${userId}
        LIMIT 1
      `) as unknown as Array<{
        organization_id: string | null;
        label: string | null;
        worker_id: string;
      }>;
      if (owned.length === 0) return null;
      // Un-pin and pause every connection backed by this device — a device
      // connector can't run anywhere without it; the owner re-pins to a new
      // device (or removes the connection) to bring it back.
      const affected = (await tx`
        UPDATE connections
        SET device_worker_id = NULL,
            status = 'paused',
            error_message = 'Device was removed',
            updated_at = NOW()
        WHERE device_worker_id = ${deviceWorkerId}
        RETURNING id
      `) as unknown as Array<{ id: number }>;
      const ids = affected.map((r) => r.id);
      if (ids.length > 0) {
        await tx`
          UPDATE feeds SET status = 'paused', updated_at = NOW()
          WHERE connection_id = ANY(${pgBigintArray(ids)}::bigint[]) AND deleted_at IS NULL AND status = 'active'
        `;
      }
      await tx`DELETE FROM device_workers WHERE id = ${deviceWorkerId} AND user_id = ${userId}`;
      return owned[0];
    });
    if (!deleted) {
      return c.json({ error: 'Device not found or not owned by you' }, 404);
    }
    if (deleted.organization_id) {
      recordLifecycleEvent({
        organizationId: deleted.organization_id,
        entityType: 'device',
        op: 'deleted',
        entityId: deviceWorkerId,
        summary: `Device "${deleted.label ?? deleted.worker_id}" removed`,
      });
    }
    return c.json({ ok: true });
  } catch (err: unknown) {
    logger.error({ error: errorMessage(err) }, '[deleteDeviceWorker] Error');
    return c.json({ error: errorMessage(err) }, 500);
  }
}
