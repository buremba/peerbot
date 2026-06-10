/**
 * Device-scoped feed CRUD.
 *
 * The Mac app uses these to create / list / delete feeds on its auto-wired
 * device connection (e.g. one feed per local folder for `local.directory`).
 * Scope = (this device's user, this device's auto-wired connection for the
 * given connector_key). Server never sees the security-scoped bookmark — just
 * the metadata the Mac app posts in the feed config.
 *
 *   GET    /api/workers/me/feeds?worker_id=...&connector_key=...
 *   POST   /api/workers/me/feeds
 *   DELETE /api/workers/me/feeds/:id  { worker_id, connector_key }
 */

import type { Context } from 'hono';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { errorMessage } from '../utils/errors';
import logger from '../utils/logger';
import { resolveDeviceWorkerForRequest } from './device-auth-profiles';

async function resolveDeviceConnection(
  c: Context<{ Bindings: Env }>,
  workerId: string,
  connectorKey: string
): Promise<{
  device: { id: string; organization_id: string } | null;
  connection: { id: number } | null;
  error?: Response;
}> {
  const { device, error } = await resolveDeviceWorkerForRequest(c, workerId);
  if (error || !device) return { device: null, connection: null, error };
  const sql = getDb();
  // The user-scoped device worker auto-wires a single connection for the
  // connector in its home org (see device-reconcile.ts). Match on
  // (user, connector, org) — user_id link via device_workers.created_by — to
  // find that row. Either pinned to this device or unpinned with no other
  // pin owner.
  const rows = (await sql`
    SELECT c.id
    FROM connections c
    JOIN device_workers dw ON dw.user_id = c.created_by
    WHERE dw.id = ${device.id}
      AND c.connector_key = ${connectorKey}
      AND c.organization_id = ${device.organization_id}
      AND c.deleted_at IS NULL
      AND (c.device_worker_id IS NULL OR c.device_worker_id = ${device.id}::uuid)
    ORDER BY c.created_at ASC
    LIMIT 1
  `) as unknown as Array<{ id: number }>;
  const row = rows[0];
  if (!row) {
    return {
      device,
      connection: null,
      error: c.json(
        {
          error: `No connection wired yet for connector '${connectorKey}'. The device must advertise the capability via /api/workers/poll once first so auto-wire creates it.`,
        },
        404
      ),
    };
  }
  return { device, connection: { id: row.id } };
}

/**
 * GET /api/workers/me/feeds?worker_id=...&connector_key=...
 */
export async function listMyDeviceFeeds(c: Context<{ Bindings: Env }>) {
  const workerId = (c.req.query('worker_id') ?? '').trim();
  const connectorKey = (c.req.query('connector_key') ?? '').trim();
  if (!workerId || !connectorKey) {
    return c.json({ error: 'worker_id and connector_key are required' }, 400);
  }
  const { device, connection, error } = await resolveDeviceConnection(c, workerId, connectorKey);
  if (error || !connection) return error ?? c.json({ feeds: [] });
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT id, feed_key, display_name, status, config, schedule, next_run_at,
             last_sync_at, created_at, updated_at
      FROM feeds
      WHERE connection_id = ${connection.id}
        AND deleted_at IS NULL
      ORDER BY created_at ASC
    `) as unknown as Array<Record<string, unknown>>;
    return c.json({ connection_id: connection.id, organization_id: device!.organization_id, feeds: rows });
  } catch (err) {
    logger.error({ error: errorMessage(err) }, '[listMyDeviceFeeds] Error');
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * POST /api/workers/me/feeds
 *
 * Body: { worker_id, connector_key, feed_key, display_name, config }
 *
 * Creates a feed on this device's auto-wired connection. Config is whatever
 * the connector's feed definition declares (e.g. {folder_id, display_name}
 * for local.directory.files).
 */
export async function createMyDeviceFeed(c: Context<{ Bindings: Env }>) {
  let body: {
    worker_id?: string;
    connector_key?: string;
    feed_key?: string;
    display_name?: string;
    config?: Record<string, unknown>;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const workerId = (body.worker_id ?? '').trim();
  const connectorKey = (body.connector_key ?? '').trim();
  const feedKey = (body.feed_key ?? '').trim();
  const displayName = (body.display_name ?? '').trim();
  if (!workerId || !connectorKey || !feedKey || !displayName) {
    return c.json({ error: 'worker_id, connector_key, feed_key, display_name are required' }, 400);
  }
  const { device, connection, error } = await resolveDeviceConnection(c, workerId, connectorKey);
  if (error || !connection) return error!;
  try {
    const sql = getDb();
    // Idempotent on (connection_id, feed_key, config->>'folder_id'): two
    // concurrent reconciles must not produce duplicate feeds for the same
    // folder. We probe with a SELECT first, then INSERT; race window is
    // narrowed by the surrounding worker poll cadence. Stronger guarantee
    // would be a partial unique index — feed key namespaces vary by
    // connector so we leave that as a follow-up.
    const folderIdInConfig =
      typeof (body.config as Record<string, unknown> | undefined)?.folder_id === 'string'
        ? ((body.config as Record<string, unknown>).folder_id as string)
        : null;
    if (folderIdInConfig) {
      const existing = (await sql`
        SELECT id, feed_key, display_name, status, config, created_at
        FROM feeds
        WHERE connection_id = ${connection.id}
          AND feed_key = ${feedKey}
          AND config->>'folder_id' = ${folderIdInConfig}
          AND deleted_at IS NULL
        LIMIT 1
      `) as unknown as Array<Record<string, unknown>>;
      if (existing.length > 0) {
        return c.json({ feed: existing[0] });
      }
    }
    const inserted = (await sql`
      INSERT INTO feeds (
        organization_id, connection_id, feed_key, display_name, status, config, next_run_at
      ) VALUES (
        ${device!.organization_id}, ${connection.id}, ${feedKey}, ${displayName}, 'active',
        ${body.config ? sql.json(body.config) : null},
        NOW()
      )
      RETURNING id, feed_key, display_name, status, config, created_at
    `) as unknown as Array<Record<string, unknown>>;
    return c.json({ feed: inserted[0] });
  } catch (err) {
    logger.error({ error: errorMessage(err) }, '[createMyDeviceFeed] Error');
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * DELETE /api/workers/me/feeds/:id  { worker_id, connector_key }
 *
 * Soft-deletes the feed (deleted_at = now()) — matches existing manage_feeds
 * convention. The feed must belong to this device's connection for the given
 * connector.
 */
export async function deleteMyDeviceFeed(c: Context<{ Bindings: Env }>) {
  const feedId = Number((c.req.param('id') ?? '').trim());
  if (!Number.isFinite(feedId)) {
    return c.json({ error: 'invalid feed id' }, 400);
  }
  let body: { worker_id?: string; connector_key?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const workerId = (body.worker_id ?? '').trim();
  const connectorKey = (body.connector_key ?? '').trim();
  if (!workerId || !connectorKey) {
    return c.json({ error: 'worker_id and connector_key are required' }, 400);
  }
  const { connection, error } = await resolveDeviceConnection(c, workerId, connectorKey);
  if (error || !connection) return error!;
  try {
    const sql = getDb();
    const updated = (await sql`
      UPDATE feeds
      SET deleted_at = NOW(), updated_at = NOW(), status = 'paused'
      WHERE id = ${feedId}
        AND connection_id = ${connection.id}
        AND deleted_at IS NULL
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    if (updated.length === 0) {
      return c.json({ error: 'Feed not found on this device' }, 404);
    }
    return c.json({ ok: true });
  } catch (err) {
    logger.error({ error: errorMessage(err) }, '[deleteMyDeviceFeed] Error');
    return c.json({ error: errorMessage(err) }, 500);
  }
}
