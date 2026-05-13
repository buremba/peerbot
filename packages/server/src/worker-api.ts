/**
 * Worker API Endpoints
 *
 * HTTP handlers for worker operations.
 * Updated for V1 integration platform: runs-based job model.
 */

import type { Context } from 'hono';
import { createAuth } from './auth';
import { getDb, parsePgNumberArray, pgBigintArray, pgTextArray } from './db/client';
import { emit } from './events/emitter';
import type { Env } from './index';
import { notifyBrowserAuthExpired } from './notifications/triggers';
import { materializeDueFeeds } from './scheduled/check-due-feeds';
import { supersedeActionEvent } from './tools/admin/manage_operations';
import { getAuthProfileById, getBrowserSessionReadiness } from './utils/auth-profiles';
import {
  maybeCloseRepairThread,
  maybeOpenOrAppendRepairThread,
} from './connectors/repair-agent';
import { autoLinkEvent } from './utils/auto-linker';
import { nextRunAt as nextRunAtFromCron } from './utils/cron';
import { reconcileDeviceCapabilities } from './worker-api/device-reconcile';
import { resolveConnectorCode } from './utils/ensure-connector-installed';
import { applyEntityLinks } from './utils/entity-link-upsert';
import { errorMessage } from './utils/errors';
import { validateConnectorEventSemanticType } from './utils/event-kind-validation';
import { mergeExecutionConfig, resolveExecutionAuth } from './utils/execution-context';
import { insertEvent } from './utils/insert-event';
import logger from './utils/logger';
import { getWorkspaceRole } from './utils/organization-access';

const DUE_FEEDS_LOCK_KEY = 71001;
const DUE_FEED_MATERIALIZE_COOLDOWN_MS = 5000;
let lastDueFeedMaterializeAttemptAt = 0;

const WORKER_CAPABILITY_NAME_RE = /^[a-z][a-z0-9_.:-]{0,63}$/;

function normalizeAdvertisedCapabilities(capabilities: Record<string, boolean>): string[] {
  return Array.from(
    new Set(
      Object.entries(capabilities)
        .map(([key, value]) => [key.trim(), value] as const)
        .filter(
          ([key, value]) =>
            value === true && key !== 'browser' && WORKER_CAPABILITY_NAME_RE.test(key)
        )
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
async function authorizeRunForWorker(
  c: Context<{ Bindings: Env }>,
  runId: number,
  expectedWorkerId?: string
): Promise<Response | null> {
  if (c.var.workerAuthMode !== 'user') {
    return null;
  }
  const workerUserId = c.var.workerUserId;
  const orgIds = c.var.workerOrgIds ?? [];
  const sql = getDb();
  const rows = (await sql`
    SELECT r.status, r.claimed_by, r.organization_id, dw.user_id AS device_owner
    FROM runs r
    LEFT JOIN connections con ON con.id = r.connection_id
    LEFT JOIN device_workers dw ON dw.id = con.device_worker_id
    WHERE r.id = ${runId}
    LIMIT 1
  `) as unknown as Array<{
    status: string;
    claimed_by: string | null;
    organization_id: string;
    device_owner: string | null;
  }>;
  if (rows.length === 0) {
    return c.json({ error: 'Run not found' }, 404);
  }
  const run = rows[0];
  const inScope =
    orgIds.includes(run.organization_id) ||
    (!!workerUserId && run.device_owner === workerUserId);
  if (!inScope) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (run.status !== 'running') {
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

/**
 * POST /api/workers/poll
 *
 * Worker polls for next available sync run.
 * Returns run details or empty response if no runs available.
 */
export async function pollWorkerJob(c: Context<{ Bindings: Env }>) {
  let worker_id: string;
  let capabilities: Record<string, boolean> = {};
  let platform: string | null = null;
  let app_version: string | null = null;
  let label: string | null = null;
  try {
    const body = await c.req.json<{
      worker_id: string;
      capabilities?: Record<string, boolean>;
      platform?: string;
      app_version?: string;
      label?: string;
    }>();
    worker_id = body.worker_id;
    capabilities = body.capabilities ?? {};
    platform = body.platform ?? null;
    app_version = body.app_version ?? null;
    label = body.label ?? null;
  } catch {
    return c.json({ error: 'Invalid or missing JSON body' }, 400);
  }
  const sql = getDb();
  const hasBrowser = capabilities.browser ?? false;
  // Capability set the worker advertised (excluding browser, which has its
  // own legacy gate via connector_definitions.api_type). Used to filter on
  // connector_definitions.required_capability.
  const advertisedCapabilities = normalizeAdvertisedCapabilities(capabilities);
  // Trusted fleet workers (WORKER_API_TOKEN) run the no-capability cloud
  // connectors too, so '' (a NULL required_capability becomes '' via COALESCE
  // below) belongs in their match set. User-scoped workers — the Lobu Mac
  // Bridge, anything in `workerAuthMode === 'user'` — are *device* workers:
  // they may ONLY claim runs whose connector declares a `required_capability`
  // they advertise, never the cloud connectors. So '' is excluded for them,
  // which means a bridge with no granted capabilities claims *nothing* instead
  // of hijacking-and-failing arbitrary cloud-connector runs (e.g. hackernews).
  const isUserScopedWorker = c.var.workerAuthMode === 'user';
  const capabilityMatchSet = isUserScopedWorker
    ? advertisedCapabilities
    : [''].concat(advertisedCapabilities);

  // Device-worker registry: upsert device_workers row for user-scoped workers
  // so /api/me/devices can enumerate them. Also ensure advertised capability
  // connectors are fully wired. Best-effort — never fail the poll.
  //
  // `deviceWorkerId` is this device's surrogate id; a pending run whose
  // connection is pinned to it (connections.device_worker_id) is claimable
  // regardless of the connector's required_capability — that's how an
  // otherwise-cloud connector (Reddit, …) ends up running on a chosen device.
  const workerUserId = c.var.workerUserId;
  // The org the device's token was issued for — the workspace the user picked on
  // the OAuth device-authorization page. Falls back to the owner's personal
  // workspace for tokens not bound to any org. Sets the device's home only on
  // first registration; moving an existing device is the Devices-page action.
  const workerTokenOrgId = c.var.organizationId ?? null;
  let deviceWorkerId: string | null = null;
  if (workerUserId) {
    try {
      const incomingCaps = advertisedCapabilities;

      const upserted = (await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
        VALUES (
          ${workerUserId}, ${worker_id}, ${platform}, ${app_version},
          ${sql.json(incomingCaps)}, ${label},
          COALESCE(
            ${workerTokenOrgId}::text,
            (SELECT id FROM organization WHERE (metadata::jsonb)->>'personal_org_for_user_id' = ${workerUserId} LIMIT 1)
          )
        )
        ON CONFLICT (user_id, worker_id) DO UPDATE SET
          platform = EXCLUDED.platform,
          app_version = EXCLUDED.app_version,
          capabilities = EXCLUDED.capabilities,
          label = COALESCE(EXCLUDED.label, device_workers.label),
          organization_id = COALESCE(device_workers.organization_id, EXCLUDED.organization_id),
          last_seen_at = now()
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      deviceWorkerId = upserted[0]?.id ?? null;

      // Reconcile this user's device connectors against the capabilities their
      // whole fleet currently advertises: auto-wire / re-activate the ones that
      // are present (cheap fast path, also heals partially-wired state), pause
      // the ones that have gone away. The just-upserted row above is already
      // visible to this query, so the polling device's capabilities count.
      await reconcileDeviceCapabilities(workerUserId);
    } catch (err) {
      logger.error(
        { worker_id, err: errorMessage(err) },
        '[pollWorkerJob] device_workers upsert failed (non-fatal)'
      );
    }
  }

  // User-scoped workers (e.g. Lobu for Mac) can only claim runs in the
  // org their token is bound to, plus the user's personal org (where device
  // connectors auto-wire) — the set is computed in the /api/workers/* auth
  // middleware. Trusted workers (matched WORKER_API_TOKEN) and anonymous
  // local-dev requests see all pending runs — preserving the existing
  // server-side worker fleet behavior.
  const workerAuthMode = c.var.workerAuthMode;
  const workerOrgIds = c.var.workerOrgIds;
  if (workerAuthMode === 'user' && (!workerOrgIds || workerOrgIds.length === 0)) {
    // No org in scope — nothing this worker can ever claim.
    return c.json({ next_poll_seconds: 30 });
  }
  const orgScopeActive = workerAuthMode === 'user';
  // Always pass a non-empty array to ANY() to keep the SQL valid; the gate
  // below only activates when orgScopeActive is true.
  const orgScopeIds = orgScopeActive && workerOrgIds ? workerOrgIds : [''];

  const claimNextPendingRun = async () =>
    sql.begin(async (tx) => {
      const claimed = await tx`
      WITH next_run AS (
        SELECT r.id
        FROM runs r
        LEFT JOIN connections con ON con.id = r.connection_id
        LEFT JOIN LATERAL (
          SELECT cd.api_type, cd.required_capability
          FROM connector_definitions cd
          WHERE cd.key = r.connector_key
            AND cd.organization_id = r.organization_id
            AND cd.status = 'active'
          ORDER BY cd.updated_at DESC, cd.id DESC
          LIMIT 1
        ) cd ON true
        WHERE r.status = 'pending'
          -- Connector worker only ever claims its own lanes. The lobu-queue
          -- run types (chat_message, schedule, agent_run, internal) are
          -- claimed in-process by the gateway's RunsQueue; an explicit
          -- allow-list keeps the lanes separated.
          AND r.run_type IN ('sync', 'action', 'embed_backfill', 'auth')
          AND (r.approval_status = 'auto' OR r.approval_status = 'approved')
          AND (${hasBrowser} OR COALESCE(cd.api_type, 'api') = 'api')
          AND (
            -- (A) trusted/anonymous fleet worker: the no-capability cloud
            --     connectors plus any capability it happens to advertise, in
            --     any org — but NEVER a connection pinned to a device.
            (
              ${!isUserScopedWorker}
              AND COALESCE(cd.required_capability, '') = ANY(${pgTextArray(capabilityMatchSet)}::text[])
              AND con.device_worker_id IS NULL
            )
            -- (B) user-scoped device worker: an unpinned capability-matched
            --     device connector in an org this worker can see ...
            OR (
              ${isUserScopedWorker}
              AND cd.required_capability IS NOT NULL
              AND cd.required_capability = ANY(${pgTextArray(advertisedCapabilities)}::text[])
              AND con.device_worker_id IS NULL
              AND r.organization_id = ANY(${pgTextArray(orgScopeIds)}::text[])
            )
            -- ... or any connection explicitly pinned to THIS device (this is
            --     "run the Reddit connector on my Mac"). Still: a device-only
            --     connector needs the capability currently advertised, and the
            --     pin only counts in an org this worker can see (which includes
            --     the org the device is attached to).
            OR (
              ${isUserScopedWorker}
              AND ${deviceWorkerId}::uuid IS NOT NULL
              AND con.device_worker_id = ${deviceWorkerId}::uuid
              AND (
                cd.required_capability IS NULL
                OR cd.required_capability = ANY(${pgTextArray(advertisedCapabilities)}::text[])
              )
              AND r.organization_id = ANY(${pgTextArray(orgScopeIds)}::text[])
            )
          )
        ORDER BY
          CASE WHEN r.run_type = 'auth' THEN 0 ELSE 1 END,
          r.created_at ASC
        FOR UPDATE OF r SKIP LOCKED
        LIMIT 1
      )
      UPDATE runs r
      SET status = 'running',
          claimed_at = current_timestamp,
          claimed_by = ${worker_id}
      FROM next_run nr
      WHERE r.id = nr.id
      RETURNING r.id
    `;

      if (claimed.length === 0) {
        return null;
      }

      const runId = Number((claimed[0] as { id: unknown }).id);

      const rows = await tx`
      SELECT
        r.id AS run_id,
        r.run_type,
        r.feed_id,
        r.connection_id,
        r.connector_key,
        r.connector_version,
        r.action_key,
        r.action_input,
        r.approved_input,
        r.watcher_id,
        r.window_id,
        r.organization_id,
        r.auth_profile_id AS run_auth_profile_id,
        f.feed_key,
        f.config AS feed_config,
        f.checkpoint,
        f.entity_ids AS feed_entity_ids,
        conn.auth_profile_id,
        conn.app_auth_profile_id,
        conn.config AS connection_config,
        conn.device_worker_id AS connection_device_worker_id,
        cv.compiled_code,
        ap.auth_data AS auth_profile_auth_data
      FROM runs r
      LEFT JOIN feeds f ON f.id = r.feed_id
      LEFT JOIN connections conn ON conn.id = r.connection_id
      LEFT JOIN connector_versions cv ON cv.connector_key = r.connector_key
        AND cv.version = r.connector_version
      LEFT JOIN auth_profiles ap ON ap.id = r.auth_profile_id
      WHERE r.id = ${runId}
      LIMIT 1
    `;

      return rows[0] ?? null;
    });

  let pending = await claimNextPendingRun();

  if (!pending) {
    const now = Date.now();
    if (now - lastDueFeedMaterializeAttemptAt >= DUE_FEED_MATERIALIZE_COOLDOWN_MS) {
      lastDueFeedMaterializeAttemptAt = now;

      await sql.begin(async (tx) => {
        const lockRows = await tx<{ acquired: boolean }>`
          SELECT pg_try_advisory_xact_lock(${DUE_FEEDS_LOCK_KEY}) AS acquired
        `;

        if (!lockRows[0]?.acquired) {
          return;
        }

        await materializeDueFeeds(c.env, tx);
      });

      pending = await claimNextPendingRun();
    }
  }

  if (!pending) {
    return c.json({ next_poll_seconds: 10 });
  }

  const row = pending as unknown as {
    run_id: number;
    run_type: string;
    feed_id: number | null;
    connection_id: number | null;
    connector_key: string;
    connector_version: string | null;
    action_key: string | null;
    action_input: Record<string, unknown> | null;
    feed_key: string | null;
    feed_config: Record<string, unknown> | null;
    checkpoint: Record<string, unknown> | null;
    feed_entity_ids: number[] | null;
    auth_profile_id: number | null;
    app_auth_profile_id: number | null;
    connection_config: Record<string, unknown> | null;
    connection_device_worker_id: string | null;
    compiled_code: string | null;
    // Watcher run fields (populated via LEFT JOINs)
    watcher_id: number | null;
    window_id: number | null;
    organization_id: string;
    // Auth run fields
    run_auth_profile_id: number | null;
    auth_profile_auth_data: Record<string, unknown> | null;
  };

  let compiledCode: string | undefined;
  if (row.connector_key) {
    try {
      compiledCode = await resolveConnectorCode(row.connector_key, row.compiled_code);
    } catch (err) {
      const message = errorMessage(err);
      await sql`
        UPDATE runs
        SET status = 'failed',
            completed_at = current_timestamp,
            error_message = ${message}
        WHERE id = ${row.run_id}
      `;
      logger.error(
        { run_id: row.run_id, connector_key: row.connector_key, err },
        'Failed to resolve connector code for claimed worker run'
      );
      return c.json({ next_poll_seconds: 1, skipped_run_id: row.run_id, error: message });
    }
  }

  // Credential delivery:
  //  - trusted/anonymous fleet workers always resolve connection credentials;
  //  - a user-scoped device worker only gets real credentials when the run's
  //    connection is *explicitly pinned to a device* (connections.device_worker_id),
  //    which was authorized at bind time. A device connector reached via the
  //    capability match (no pin) is no-auth by construction, so it gets nothing —
  //    a connector misconfigured with both a `required_capability` and an auth
  //    profile still can't leak secrets to an arbitrary capability-matched device.
  const connectionIsDevicePinned = row.connection_device_worker_id != null;
  const deliverConnectionAuth = !!row.connection_id && (!isUserScopedWorker || connectionIsDevicePinned);
  const { credentials, connectionCredentials, sessionState } = deliverConnectionAuth
    ? await resolveExecutionAuth({
        organizationId: row.organization_id,
        connectionId: row.connection_id!,
        authProfileId: row.auth_profile_id,
        appAuthProfileId: row.app_auth_profile_id,
        credentialDb: sql,
        logContext: { run_id: row.run_id },
        logMessage: 'Failed to resolve connection credentials for worker poll',
      })
    : {
        credentials: null,
        connectionCredentials: {},
        sessionState: null,
      };

  return c.json({
    run_id: row.run_id,
    run_type: row.run_type,
    connector_key: row.connector_key,
    connector_version: row.connector_version ?? undefined,
    feed_key: row.feed_key ?? undefined,
    feed_id: row.feed_id ?? undefined,
    connection_id: row.connection_id ?? undefined,
    config: mergeExecutionConfig(row.connection_config, row.feed_config),
    checkpoint: row.checkpoint ?? undefined,
    entity_ids: row.feed_entity_ids ?? undefined,
    credentials,
    connection_credentials:
      Object.keys(connectionCredentials).length > 0 ? connectionCredentials : undefined,
    compiled_code: compiledCode,
    session_state: sessionState ?? undefined,
    action_key: row.action_key ?? undefined,
    action_input: (row as any).approved_input ?? row.action_input ?? undefined,
    auth_profile_id: deliverConnectionAuth ? (row.run_auth_profile_id ?? undefined) : undefined,
    previous_credentials: deliverConnectionAuth ? (row.auth_profile_auth_data ?? undefined) : undefined,
  });
}

/**
 * POST /api/workers/heartbeat
 *
 * Worker sends periodic heartbeat to indicate it's still processing.
 */
export async function heartbeat(c: Context<{ Bindings: Env }>) {
  try {
    const { run_id, worker_id, progress } = await c.req.json<{
      run_id: number;
      worker_id: string;
      progress?: { items_collected_so_far?: number };
    }>();

    const denied = await authorizeRunForWorker(c, run_id, worker_id);
    if (denied) return denied;

    const sql = getDb();

    await sql`
      UPDATE runs
      SET last_heartbeat_at = current_timestamp,
          items_collected = COALESCE(${progress?.items_collected_so_far ?? null}, items_collected)
      WHERE id = ${run_id}
    `;

    return c.json({ continue: true });
  } catch (err: unknown) {
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * POST /api/workers/stream
 *
 * Worker streams content batch for a sync run.
 */
export async function streamContent(c: Context<{ Bindings: Env }>) {
  try {
    const batch = await c.req.json<{
      type: 'batch';
      run_id: number;
      worker_id?: string;
      items: Array<{
        id: string;
        title?: string;
        payload_type?: 'text' | 'markdown' | 'json_template' | 'media' | 'empty';
        payload_text: string;
        payload_data?: Record<string, unknown>;
        payload_template?: Record<string, unknown> | null;
        attachments?: unknown[];
        author_name?: string;
        occurred_at: string;
        source_url?: string;
        score?: number;
        metadata?: Record<string, unknown>;
        origin_parent_id?: string;
        origin_type?: string;
        embedding?: number[];
        semantic_type?: string;
      }>;
      checkpoint?: Record<string, unknown>;
    }>();

    const denied = await authorizeRunForWorker(c, batch.run_id, batch.worker_id);
    if (denied) return denied;

    const sql = getDb();

    // Look up run details for event columns
    const runRows = (await sql`
    SELECT r.feed_id, r.connection_id, r.connector_key, r.organization_id,
           f.feed_key, f.entity_ids
    FROM runs r
    LEFT JOIN feeds f ON f.id = r.feed_id
    WHERE r.id = ${batch.run_id}
  `) as unknown as Array<{
      feed_id: number | null;
      connection_id: number | null;
      connector_key: string;
      organization_id: string;
      feed_key: string | null;
      entity_ids: number[] | null;
    }>;

    if (runRows.length === 0) {
      return c.json({ error: 'Run not found' }, 404);
    }

    const run = runRows[0];
    const entityIds = parsePgNumberArray(run.entity_ids);

    // Auto-create dimension entities declared via eventKinds[kind].entityLinks
    // before inserting events. One query per (entityType, matchField) per
    // batch — cheap compared to the per-event inserts that follow.
    await applyEntityLinks({
      connectorKey: run.connector_key,
      feedKey: run.feed_key,
      orgId: run.organization_id,
      items: batch.items,
    });

    let totalItems = 0;
    const rejectedItems: Array<{ id: string; semantic_type?: string; errors: string[] }> = [];

    for (const item of batch.items) {
      try {
        const itemOriginType = item.origin_type ?? null;
        const itemSemanticType = item.semantic_type ?? itemOriginType ?? 'content';
        const validationType = itemOriginType ?? itemSemanticType;

        // Validate connector-declared type against the feed's eventKinds schema.
        if (validationType && run.feed_key) {
          const kindResult = await validateConnectorEventSemanticType(
            validationType,
            item.metadata as Record<string, unknown> | undefined,
            run.connector_key,
            run.feed_key,
            run.organization_id
          );
          if (!kindResult.valid) {
            logger.warn(
              {
                run_id: batch.run_id,
                item_id: item.id,
                semantic_type: validationType,
                errors: kindResult.errors,
              },
              'Connector event semantic type validation failed — rejecting event'
            );
            rejectedItems.push({
              id: item.id,
              semantic_type: validationType,
              errors: kindResult.errors,
            });
            continue;
          }
        }

        // Skip events with no content — connectors must provide text
        if (!item.payload_text && !item.title) {
          logger.warn(
            { run_id: batch.run_id, item_id: item.id, connector: run.connector_key },
            '[stream] Skipping event with empty payload_text and title'
          );
          continue;
        }

        const inserted = await insertEvent(
          {
            entityIds: entityIds,
            organizationId: run.organization_id,
            originId: item.id,
            title: item.title,
            payloadType: item.payload_type,
            content: item.payload_text,
            payloadData: item.payload_data,
            payloadTemplate: item.payload_template,
            attachments: item.attachments,
            authorName: item.author_name,
            sourceUrl: item.source_url,
            occurredAt: item.occurred_at,
            score: item.score,
            embedding: item.embedding,
            metadata: item.metadata as Record<string, unknown> | undefined,
            semanticType: itemSemanticType,
            originType: itemOriginType,
            connectorKey: run.connector_key,
            connectionId: run.connection_id,
            feedKey: run.feed_key,
            feedId: run.feed_id,
            runId: batch.run_id,
            parentOriginId: item.origin_parent_id,
          },
          { onConflictUpdate: true }
        );
        if (inserted) {
          totalItems++;
          if (entityIds.length > 0) {
            autoLinkEvent({
              eventId: Number(inserted.id),
              entityIds,
              content: item.payload_text,
              title: item.title,
              organizationId: run.organization_id,
            }).catch(() => {});
          }
        }
      } catch (err) {
        console.error('[stream] Insert failed for item', item.id, ':', err);
        throw err;
      }
    }

    // Update feed + run checkpoint if provided (so mid-run state like QR codes
    // surface in UI via recent_runs[0].checkpoint before the run completes).
    if (batch.checkpoint) {
      if (run.feed_id) {
        await sql`
      UPDATE feeds
      SET checkpoint = ${sql.json(batch.checkpoint)},
          updated_at = current_timestamp
      WHERE id = ${run.feed_id}
    `;
      }
      await sql`
      UPDATE runs
      SET checkpoint = ${sql.json(batch.checkpoint)}
      WHERE id = ${batch.run_id}
    `;
    }

    return c.json({
      batches_received: 1,
      total_items: totalItems,
      ...(rejectedItems.length > 0 && { rejected_items: rejectedItems }),
    });
  } catch (err: unknown) {
    const stack = err instanceof Error ? err.stack : undefined;
    console.error('[stream] Error:', errorMessage(err), stack);
    return c.json({ error: errorMessage(err), stack }, 500);
  }
}

/**
 * POST /api/workers/complete
 *
 * Worker signals sync run completion (success or failure).
 */
export async function completeWorkerJob(c: Context<{ Bindings: Env }>) {
  try {
    const req = await c.req.json<{
      run_id: number;
      worker_id: string;
      status: 'success' | 'failed';
      items_collected?: number;
      error_message?: string;
      checkpoint?: Record<string, unknown>;
      auth_update?: Record<string, unknown>;
      // Diagnostic fields from the subprocess executor (failed-run path only).
      // The worker redacts output_tail before sending; backend stores as-is.
      output_tail?: string;
      exit_code?: number | null;
      exit_signal?: string | null;
      exit_reason?: 'ok' | 'error_message' | 'timeout' | 'oom' | 'crash';
    }>();

    const denied = await authorizeRunForWorker(c, req.run_id, req.worker_id);
    if (denied) return denied;

    const sql = getDb();

    if (req.status === 'failed') {
      await sql`
      UPDATE runs
      SET status = 'failed',
          completed_at = current_timestamp,
          items_collected = ${req.items_collected ?? 0},
          error_message = ${req.error_message ?? null},
          checkpoint = COALESCE(${req.checkpoint ? sql.json(req.checkpoint) : null}, checkpoint),
          output_tail = ${req.output_tail ?? null},
          exit_code = ${req.exit_code ?? null},
          exit_signal = ${req.exit_signal ?? null},
          exit_reason = ${req.exit_reason ?? null}
      WHERE id = ${req.run_id}
    `;
    } else {
      await sql`
      UPDATE runs
      SET status = 'completed',
          completed_at = current_timestamp,
          items_collected = ${req.items_collected ?? 0},
          error_message = ${req.error_message ?? null},
          checkpoint = COALESCE(${req.checkpoint ? sql.json(req.checkpoint) : null}, checkpoint)
      WHERE id = ${req.run_id}
    `;
    }

    // Update the feed's sync state
    const runRows = (await sql`
    SELECT feed_id, connection_id FROM runs WHERE id = ${req.run_id}
  `) as unknown as Array<{ feed_id: number | null; connection_id: number | null }>;
    const feedId = runRows[0]?.feed_id;

    if (feedId) {
      const feedRows = (await sql`
      SELECT schedule FROM feeds WHERE id = ${feedId}
    `) as unknown as Array<{ schedule: string | null }>;

      const schedule = feedRows[0]?.schedule ?? '0 */6 * * *';
      const nextRun = nextRunAtFromCron(schedule);
      const isSuccess = req.status === 'success';

      await sql`
        UPDATE feeds
        SET last_sync_at = current_timestamp,
            last_sync_status = ${req.status},
            last_error = ${isSuccess ? null : (req.error_message ?? null)},
            consecutive_failures = ${isSuccess ? sql`0` : sql`consecutive_failures + 1`},
            first_failure_at = ${isSuccess ? sql`NULL` : sql`COALESCE(first_failure_at, current_timestamp)`},
            items_collected = ${isSuccess ? sql`items_collected + ${req.items_collected ?? 0}` : sql`items_collected`},
            checkpoint = ${isSuccess ? sql`COALESCE(${req.checkpoint ? sql.json(req.checkpoint) : null}, checkpoint)` : sql`checkpoint`},
            next_run_at = ${nextRun},
            updated_at = current_timestamp
        WHERE id = ${feedId}
      `;

      // Repair-agent trigger: open / append / close threads based on the
      // updated streak state. All errors swallowed inside the helper — must
      // never block the worker-completion path.
      if (isSuccess) {
        await maybeCloseRepairThread(feedId, req.run_id).catch((err) => {
          logger.warn(
            { feed_id: feedId, error: errorMessage(err) },
            '[completeWorkerJob] maybeCloseRepairThread threw'
          );
        });
      } else {
        await maybeOpenOrAppendRepairThread(feedId, req.run_id).catch((err) => {
          logger.warn(
            { feed_id: feedId, error: errorMessage(err) },
            '[completeWorkerJob] maybeOpenOrAppendRepairThread threw'
          );
        });
      }
    }

    // Persist refreshed browser auth data on the auth profile
    const connectionId = runRows[0]?.connection_id;
    if (req.status === 'success' && req.auth_update && connectionId) {
      const connectionRows = (await sql`
        SELECT c.organization_id, c.connector_key, c.auth_profile_id
        FROM connections c
        WHERE c.id = ${connectionId}
        LIMIT 1
      `) as Array<{
        organization_id: string;
        connector_key: string;
        auth_profile_id: number | null;
      }>;

      const connection = connectionRows[0];
      const authProfile =
        connection?.auth_profile_id != null
          ? await getAuthProfileById(connection.organization_id, connection.auth_profile_id)
          : null;

      if (authProfile?.profile_kind === 'browser_session') {
        const nextAuthData = {
          ...(authProfile.auth_data ?? {}),
          ...req.auth_update,
        };
        const nextStatus = (
          await getBrowserSessionReadiness(nextAuthData, connection.connector_key)
        ).usable
          ? 'active'
          : 'pending_auth';

        await sql`
          UPDATE auth_profiles
          SET auth_data = ${sql.json(nextAuthData)},
              status = ${nextStatus},
              updated_at = current_timestamp
          WHERE id = ${authProfile.id}
        `;

        await sql`
          UPDATE connections
          SET status = ${nextStatus === 'active' ? 'active' : 'pending_auth'},
              updated_at = current_timestamp
          WHERE auth_profile_id = ${authProfile.id}
        `;

        await sql`
          UPDATE feeds f
          SET status = ${nextStatus === 'active' ? 'active' : 'paused'},
              next_run_at = ${
                nextStatus === 'active' ? sql`COALESCE(f.next_run_at, NOW())` : sql`NULL`
              },
              updated_at = current_timestamp
          FROM connections c
          WHERE f.connection_id = c.id
            AND c.auth_profile_id = ${authProfile.id}
        `;

        if (nextStatus === 'pending_auth') {
          notifyBrowserAuthExpired({
            orgId: connection.organization_id,
            connectionId,
            connectorKey: connection.connector_key,
            authProfileSlug: authProfile.slug,
          }).catch(() => {});
        }
      } else if (authProfile?.profile_kind === 'interactive') {
        // Interactive profiles (e.g. WhatsApp/Baileys) manage their own session
        // tokens. Merge the connector's auth_update into auth_data. A sentinel
        // { creds: null } wipes the profile and forces re-pair.
        const update = (req.auth_update ?? {}) as Record<string, unknown>;
        const wiped = update.creds === null;
        const nextAuthData = wiped ? {} : { ...(authProfile.auth_data ?? {}), ...update };
        const nextStatus = wiped ? 'pending_auth' : 'active';

        await sql`
          UPDATE auth_profiles
          SET auth_data = ${sql.json(nextAuthData)},
              status = ${nextStatus},
              updated_at = current_timestamp
          WHERE id = ${authProfile.id}
        `;

        if (wiped) {
          await sql`
            UPDATE connections
            SET status = 'pending_auth',
                updated_at = current_timestamp
            WHERE auth_profile_id = ${authProfile.id}
          `;
          await sql`
            UPDATE feeds f
            SET status = 'paused', next_run_at = NULL, updated_at = current_timestamp
            FROM connections c
            WHERE f.connection_id = c.id AND c.auth_profile_id = ${authProfile.id}
          `;
        }
      }
    }

    logger.info({ run_id: req.run_id, status: req.status }, 'Run completed');

    return c.json({ success: true });
  } catch (err: unknown) {
    logger.error({ error: errorMessage(err) }, '[completeWorkerJob] Error');
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * POST /api/workers/fetch-events
 *
 * Worker fetches event content for embedding generation.
 * Returns event IDs and payload_text for the given IDs.
 */
export async function fetchEventsForEmbedding(c: Context<{ Bindings: Env }>) {
  try {
    const { event_ids } = await c.req.json<{ event_ids: number[] }>();

    if (!event_ids || event_ids.length === 0) {
      return c.json({ events: [] });
    }

    const sql = getDb();

    // Build safe IN clause
    const safeIds = event_ids.filter((id) => Number.isInteger(id) && id > 0);
    if (safeIds.length === 0) {
      return c.json({ events: [] });
    }

    const placeholders = safeIds.map((_, i) => `$${i + 1}`).join(',');
    const rows = await sql.unsafe(
      `SELECT e.id, e.payload_text, e.title
       FROM events e
       LEFT JOIN event_embeddings emb ON emb.event_id = e.id
       WHERE e.id IN (${placeholders})
         AND emb.event_id IS NULL`,
      safeIds
    );

    return c.json({
      events: rows.map((r) => ({
        id: Number(r.id),
        content: (r.payload_text as string) ?? '',
        title: (r.title as string) ?? null,
      })),
    });
  } catch (err: unknown) {
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * POST /api/workers/complete-embeddings
 *
 * Worker submits generated embeddings for a batch of events.
 * Used by embed_backfill runs.
 */
export async function completeEmbeddings(c: Context<{ Bindings: Env }>) {
  try {
    const req = await c.req.json<{
      run_id: number;
      worker_id: string;
      embeddings: Array<{ event_id: number; embedding: number[] }>;
      error_message?: string;
    }>();

    const sql = getDb();

    if (!req.embeddings || req.embeddings.length === 0) {
      if (req.error_message) {
        await sql`
          UPDATE runs
          SET status = 'failed',
              completed_at = current_timestamp,
              error_message = ${req.error_message}
          WHERE id = ${req.run_id}
        `;
        return c.json({ success: false, error: req.error_message }, 400);
      }
      // Empty batch means all events already had embeddings — mark as completed
      await sql`
        UPDATE runs
        SET status = 'completed',
            completed_at = current_timestamp
        WHERE id = ${req.run_id}
      `;
      return c.json({ success: true, updated: 0 });
    }

    let updated = 0;
    for (const item of req.embeddings) {
      try {
        // pgvector expects '[0.1,0.2,...]' format
        const vectorStr = `[${item.embedding.join(',')}]`;
        const result = await sql.unsafe(
          'INSERT INTO event_embeddings (event_id, embedding) VALUES ($1, $2::vector) ON CONFLICT (event_id) DO NOTHING',
          [item.event_id, vectorStr]
        );
        if (result.count > 0) updated++;
      } catch (err) {
        logger.error(
          { event_id: item.event_id, error: err },
          '[completeEmbeddings] Failed to update event'
        );
      }
    }

    // Mark run as completed
    await sql`
      UPDATE runs
      SET status = 'completed',
          completed_at = current_timestamp,
          items_collected = ${updated}
      WHERE id = ${req.run_id}
    `;

    logger.info(
      { run_id: req.run_id, total: req.embeddings.length, updated },
      'Embedding backfill completed'
    );

    return c.json({ success: true, updated });
  } catch (err: unknown) {
    logger.error({ error: errorMessage(err) }, '[completeEmbeddings] Error');
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * POST /api/workers/emit-auth-artifact
 *
 * Worker streams an auth artifact (QR, redirect URL, prompt) into the run
 * checkpoint so the UI can render it.
 */
export async function emitAuthArtifact(c: Context<{ Bindings: Env }>) {
  try {
    const { run_id, artifact } = await c.req.json<{
      run_id: number;
      worker_id: string;
      artifact: Record<string, unknown>;
    }>();

    const sql = getDb();

    await sql`
      UPDATE runs
      SET checkpoint = ${sql.json({ artifact, emitted_at: new Date().toISOString() })},
          last_heartbeat_at = current_timestamp
      WHERE id = ${run_id}
    `;

    return c.json({ success: true });
  } catch (err: unknown) {
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * POST /api/workers/poll-auth-signal
 *
 * Worker polls for a pending signal on an auth run. The signal is consumed
 * (cleared from the run row) when delivered.
 */
export async function pollAuthSignal(c: Context<{ Bindings: Env }>) {
  try {
    const { run_id, signal_name } = await c.req.json<{
      run_id: number;
      worker_id: string;
      signal_name: string;
    }>();

    const sql = getDb();

    const consumed = await sql.begin(async (tx) => {
      const rows = (await tx`
        SELECT auth_signal FROM runs
        WHERE id = ${run_id}
        FOR UPDATE
      `) as Array<{ auth_signal: Record<string, unknown> | null }>;

      const current = rows[0]?.auth_signal ?? null;
      if (!current) return null;
      if (current.name !== signal_name) return null;

      await tx`UPDATE runs SET auth_signal = NULL WHERE id = ${run_id}`;
      return current.payload ?? {};
    });

    return c.json(consumed ? { signal: consumed } : {});
  } catch (err: unknown) {
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * POST /api/workers/complete-auth
 *
 * Worker signals auth run completion. On success, credentials + metadata are
 * written to the linked auth_profiles row and the profile moves to 'active'.
 */
export async function completeAuthRun(c: Context<{ Bindings: Env }>) {
  try {
    const req = await c.req.json<{
      run_id: number;
      worker_id: string;
      status: 'success' | 'failed';
      credentials?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      error_message?: string;
      // Diagnostic fields from the subprocess executor (failed-run path only).
      // The worker redacts output_tail before sending; backend stores as-is.
      output_tail?: string;
      exit_code?: number | null;
      exit_signal?: string | null;
      exit_reason?: 'ok' | 'error_message' | 'timeout' | 'oom' | 'crash';
    }>();

    const sql = getDb();

    const runRows =
      req.status === 'failed'
        ? ((await sql`
      UPDATE runs
      SET status = 'failed',
          completed_at = current_timestamp,
          error_message = ${req.error_message ?? null},
          auth_signal = NULL,
          output_tail = ${req.output_tail ?? null},
          exit_code = ${req.exit_code ?? null},
          exit_signal = ${req.exit_signal ?? null},
          exit_reason = ${req.exit_reason ?? null}
      WHERE id = ${req.run_id}
      RETURNING auth_profile_id, organization_id
    `) as Array<{ auth_profile_id: number | null; organization_id: string }>)
        : ((await sql`
      UPDATE runs
      SET status = 'completed',
          completed_at = current_timestamp,
          error_message = ${req.error_message ?? null},
          auth_signal = NULL
      WHERE id = ${req.run_id}
      RETURNING auth_profile_id, organization_id
    `) as Array<{ auth_profile_id: number | null; organization_id: string }>);

    const authProfileId = runRows[0]?.auth_profile_id ?? null;
    const organizationId = runRows[0]?.organization_id;

    if (req.status === 'success' && authProfileId && req.credentials) {
      await sql`
        UPDATE auth_profiles
        SET auth_data = ${sql.json(req.credentials)},
            metadata = ${sql.json(req.metadata ?? {})},
            status = 'active',
            updated_at = current_timestamp
        WHERE id = ${authProfileId}
      `;

      // Reactivate any paused connections + feeds linked to this profile.
      await sql`
        UPDATE connections
        SET status = 'active', updated_at = current_timestamp
        WHERE auth_profile_id = ${authProfileId}
          AND status = 'pending_auth'
      `;
      await sql`
        UPDATE feeds f
        SET status = 'active',
            next_run_at = COALESCE(f.next_run_at, NOW()),
            updated_at = current_timestamp
        FROM connections c
        WHERE f.connection_id = c.id
          AND c.auth_profile_id = ${authProfileId}
          AND f.status = 'paused'
      `;

      if (organizationId) {
        emit(organizationId, { keys: ['connections', 'auth-profiles'] });
      }
    } else if (req.status === 'failed' && authProfileId) {
      await sql`
        UPDATE auth_profiles
        SET status = 'error',
            updated_at = current_timestamp
        WHERE id = ${authProfileId}
      `;
    }

    logger.info({ run_id: req.run_id, status: req.status }, 'Auth run completed');
    return c.json({ success: true });
  } catch (err: unknown) {
    logger.error({ error: errorMessage(err) }, '[completeAuthRun] Error');
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * POST /api/auth-runs/:id/signal
 *
 * UI → connector reverse channel. Stores a signal on the run row that the
 * worker's awaitSignal() poll consumes.
 */
/**
 * GET /api/auth-runs/active?connection_id=X
 *
 * Returns the most recent non-terminal auth run the caller started for a
 * connection. Used by the UI to rehydrate a paring flow after a reload so
 * the QR/artifact keeps rendering instead of the sheet falling back to a
 * fresh "Pair device" button.
 */
export async function getActiveAuthRun(c: Context<{ Bindings: Env }>) {
  try {
    const connectionIdStr = c.req.query('connection_id');
    const connectionId = Number(connectionIdStr);
    if (!Number.isFinite(connectionId)) {
      return c.json({ error: 'Invalid connection_id' }, 400);
    }

    const auth = await createAuth(c.env, c.req.raw);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const userId = session?.user?.id;
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const sql = getDb();
    const rows = (await sql`
      SELECT r.id
      FROM runs r
      JOIN connections c ON c.auth_profile_id = r.auth_profile_id
      WHERE c.id = ${connectionId}
        AND r.run_type = 'auth'
        AND r.status IN ('pending', 'claimed', 'running')
        AND r.created_by_user_id = ${userId}
      ORDER BY r.created_at DESC
      LIMIT 1
    `) as Array<{ id: number }>;

    return c.json({ run_id: rows[0]?.id ?? null });
  } catch (err: unknown) {
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * GET /api/auth-runs/:id
 *
 * Session-authenticated endpoint for the UI to poll an auth run's status and
 * latest artifact (checkpoint.artifact). Returns enough shape for a pairing
 * dialog to render qr/code/redirect/prompt/status updates.
 */
export async function getAuthRun(c: Context<{ Bindings: Env }>) {
  try {
    const runIdStr = c.req.param('id');
    const runId = Number(runIdStr);
    if (!Number.isFinite(runId)) {
      return c.json({ error: 'Invalid run id' }, 400);
    }

    const auth = await createAuth(c.env, c.req.raw);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const userId = session?.user?.id;
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const sql = getDb();

    const rows = (await sql`
      SELECT r.id,
             r.organization_id,
             r.status,
             r.connector_key,
             r.checkpoint,
             r.error_message,
             r.created_at,
             r.completed_at,
             r.created_by_user_id,
             ap.id AS auth_profile_id,
             ap.slug AS auth_profile_slug,
             ap.status AS auth_profile_status
      FROM runs r
      LEFT JOIN auth_profiles ap ON ap.id = r.auth_profile_id
      WHERE r.id = ${runId}
        AND r.run_type = 'auth'
      LIMIT 1
    `) as Array<{
      id: number;
      organization_id: string;
      status: string;
      connector_key: string | null;
      checkpoint: Record<string, unknown> | null;
      error_message: string | null;
      created_at: string;
      completed_at: string | null;
      created_by_user_id: string | null;
      auth_profile_id: number | null;
      auth_profile_slug: string | null;
      auth_profile_status: string | null;
    }>;

    if (rows.length === 0) {
      return c.json({ error: 'Auth run not found' }, 404);
    }

    const run = rows[0];
    // Auth run artifacts may contain sensitive credentials (QR pairing codes,
    // OTPs, OAuth callback URLs). Restrict visibility to the initiator only —
    // other org members must not see them.
    if (run.created_by_user_id !== userId) {
      return c.json({ error: 'Auth run not found' }, 404);
    }

    return c.json({
      id: run.id,
      status: run.status,
      connector_key: run.connector_key,
      artifact: run.checkpoint?.artifact ?? null,
      error_message: run.error_message,
      created_at: run.created_at,
      completed_at: run.completed_at,
      auth_profile: run.auth_profile_id
        ? {
            id: run.auth_profile_id,
            slug: run.auth_profile_slug,
            status: run.auth_profile_status,
          }
        : null,
    });
  } catch (err: unknown) {
    return c.json({ error: errorMessage(err) }, 500);
  }
}

export async function postAuthSignal(c: Context<{ Bindings: Env }>) {
  try {
    const runIdStr = c.req.param('id');
    const runId = Number(runIdStr);
    if (!Number.isFinite(runId)) {
      return c.json({ error: 'Invalid run id' }, 400);
    }

    const body = await c.req.json<{
      name: string;
      payload?: Record<string, unknown>;
    }>();

    if (!body.name || typeof body.name !== 'string') {
      return c.json({ error: 'Missing signal name' }, 400);
    }

    const auth = await createAuth(c.env, c.req.raw);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const userId = session?.user?.id;
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const sql = getDb();

    // Only the user who initiated the auth run can send signals to it —
    // signals carry sensitive payloads (OAuth callback tokens, form values).
    const ownerRows = (await sql`
      SELECT organization_id, created_by_user_id
      FROM runs
      WHERE id = ${runId}
        AND run_type = 'auth'
        AND status IN ('pending', 'claimed', 'running')
      LIMIT 1
    `) as Array<{ organization_id: string; created_by_user_id: string | null }>;

    if (ownerRows.length === 0) {
      return c.json({ error: 'Auth run not found or not active' }, 404);
    }

    if (ownerRows[0].created_by_user_id !== userId) {
      return c.json({ error: 'Auth run not found or not active' }, 404);
    }

    const rows = (await sql`
      UPDATE runs
      SET auth_signal = ${sql.json({ name: body.name, payload: body.payload ?? {} })}
      WHERE id = ${runId}
        AND run_type = 'auth'
        AND status IN ('pending', 'claimed', 'running')
      RETURNING id
    `) as Array<{ id: number }>;

    if (rows.length === 0) {
      return c.json({ error: 'Auth run not found or not active' }, 404);
    }

    return c.json({ success: true });
  } catch (err: unknown) {
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * POST /api/workers/complete-action
 *
 * Worker signals action run completion (for async high-risk actions).
 */
export async function completeActionRun(c: Context<{ Bindings: Env }>) {
  try {
    const req = await c.req.json<{
      run_id: number;
      worker_id: string;
      status: 'success' | 'failed';
      action_output?: Record<string, unknown>;
      error_message?: string;
    }>();

    const sql = getDb();

    const updatedRuns = await sql`
      UPDATE runs
      SET status = ${req.status === 'success' ? 'completed' : 'failed'},
          completed_at = current_timestamp,
          action_output = ${req.action_output ? sql.json(req.action_output) : null},
          error_message = ${req.error_message ?? null}
      WHERE id = ${req.run_id}
      RETURNING organization_id, action_key
    `;

    const organizationId = (updatedRuns[0] as any)?.organization_id;
    const actionKey = (updatedRuns[0] as any)?.action_key ?? 'Action';

    if (organizationId) {
      const newStatus = req.status === 'success' ? 'completed' : 'failed';
      await supersedeActionEvent(
        req.run_id,
        organizationId,
        newStatus,
        `${actionKey} — ${newStatus}`,
        req.status === 'success'
          ? `Action completed: ${actionKey}`
          : `Action failed: ${actionKey}${req.error_message ? ` — ${req.error_message}` : ''}`,
        req.status === 'success'
          ? { action_output: req.action_output }
          : { error_message: req.error_message }
      );

      emit(organizationId, { keys: ['contents-filtered', 'notifications'] });
    }

    logger.info({ run_id: req.run_id, status: req.status }, 'Action run completed');
    return c.json({ success: true });
  } catch (err: unknown) {
    logger.error({ error: errorMessage(err) }, '[completeActionRun] Error');
    return c.json({ error: errorMessage(err) }, 500);
  }
}

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
        ) AS last_sync_at
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
      })),
    });
  } catch (err: unknown) {
    logger.error({ error: errorMessage(err) }, '[listDeviceWorkers] Error');
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
        SELECT 1 FROM device_workers WHERE id = ${deviceWorkerId} AND user_id = ${userId} LIMIT 1
      `) as unknown as Array<unknown>;
      if (owned.length === 0) return false;
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
      return true;
    });
    if (!deleted) {
      return c.json({ error: 'Device not found or not owned by you' }, 404);
    }
    return c.json({ ok: true });
  } catch (err: unknown) {
    logger.error({ error: errorMessage(err) }, '[deleteDeviceWorker] Error');
    return c.json({ error: errorMessage(err) }, 500);
  }
}
