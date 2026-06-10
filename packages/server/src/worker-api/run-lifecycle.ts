/**
 * Run lifecycle endpoints.
 *
 * Handlers for the in-flight and completion phases of connector/watcher/auth
 * runs: heartbeat, stream, complete, complete-watcher, complete-action,
 * complete-auth, complete-embeddings, fetch-events, emit-auth-artifact,
 * poll-auth-signal.
 */

import type { Context } from 'hono';
import { getDb, parsePgNumberArray } from '../db/client';
import { emit } from '../events/emitter';
import type { Env } from '../index';
import { notifyBrowserAuthExpired } from '../notifications/triggers';
import { supersedeActionEvent } from '../tools/admin/manage_operations';
import {
  getAuthProfileById,
  getBrowserSessionReadiness,
} from '../utils/auth-profiles';
import {
  maybeCloseRepairThread,
  maybeOpenOrAppendRepairThread,
} from '../connectors/repair-agent';
import { autoLinkEvent } from '../utils/auto-linker';
import { nextRunAt as nextRunAtFromCron } from '../utils/cron';
import { advanceWatcherSchedule } from '../watchers/automation';
import { getNextNumericId } from '../tools/admin/helpers/db-helpers';
import { applyEntityLinks } from '../utils/entity-link-upsert';
import { errorMessage } from '../utils/errors';
import { validateConnectorEventSemanticType } from '../utils/event-kind-validation';
import {
  materializeInlineAttachments,
  triggerAudioTranscriptions,
} from '../utils/inline-attachments';
import { configuredEmbeddingModelSqlLiteral } from '../utils/embeddings';
import { insertEvent, recordLifecycleEvent } from '../utils/insert-event';
import logger from '../utils/logger';
import { authorizeRunForWorker } from './shared';

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
        embedding_model?: string;
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

    // Connector-emitted inline attachments (e.g. whatsapp.local voice notes)
    // come over the wire as base64 in `attachment.data`. Materialize each into
    // the ArtifactStore before the row hits events.attachments — the events
    // table is not a binary store. Audio attachments are queued for async
    // transcription after insert.
    const { items: materializedItems, pendingTranscriptions } =
      await materializeInlineAttachments(batch.items);
    batch.items = materializedItems as typeof batch.items;

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
            embeddingModel: item.embedding_model,
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

    // Kick off background transcription for any audio attachments
    // materialized above. Runs detached — never blocks the stream-batch ack.
    triggerAudioTranscriptions(run.organization_id, pendingTranscriptions);

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

    // Atomic terminal-state transition. The `status = 'running' AND
    // claimed_by = worker_id` guard makes the UPDATE a no-op if the run was
    // already finalized by another path (e.g. the gateway reaped it on
    // timeout and the worker is reporting in late) or if this worker isn't
    // the claimant. Without it, a late completion resurrects a reaped run and
    // the feed/auth bookkeeping below double-applies (consecutive_failures,
    // items_collected, next_run_at, auth_data). Mirrors completeActionRun.
    const updatedRuns =
      req.status === 'failed'
        ? ((await sql`
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
        AND status = 'running'
        AND claimed_by = ${req.worker_id}
      RETURNING feed_id, connection_id
    `) as unknown as Array<{ feed_id: number | null; connection_id: number | null }>)
        : ((await sql`
      UPDATE runs
      SET status = 'completed',
          completed_at = current_timestamp,
          items_collected = ${req.items_collected ?? 0},
          error_message = ${req.error_message ?? null},
          checkpoint = COALESCE(${req.checkpoint ? sql.json(req.checkpoint) : null}, checkpoint)
      WHERE id = ${req.run_id}
        AND status = 'running'
        AND claimed_by = ${req.worker_id}
      RETURNING feed_id, connection_id
    `) as unknown as Array<{ feed_id: number | null; connection_id: number | null }>);

    if (updatedRuns.length === 0) {
      // The run was already finalized (timeout race) or this worker isn't the
      // claimant. Skip all feed/auth bookkeeping and return an idempotent
      // already-finalized response.
      logger.info(
        { run_id: req.run_id, worker_id: req.worker_id, claimed_status: req.status },
        '[completeWorkerJob] no-op: run already in terminal state (likely gateway timeout)'
      );
      return c.json({ success: false, reason: 'already_finalized' });
    }

    // Update the feed's sync state
    const runRows = updatedRuns;
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
      // updated streak state. Fire-and-forget — all errors are swallowed
      // inside the helper, the inner UPDATEs use atomic claims so concurrent
      // invocations are safe, and the worker-completion ACK should not wait on
      // repair-thread bookkeeping. (If the process dies mid-check the next
      // failure re-triggers it.)
      if (isSuccess) {
        void maybeCloseRepairThread(feedId, req.run_id).catch((err) => {
          logger.warn(
            { feed_id: feedId, error: errorMessage(err) },
            '[completeWorkerJob] maybeCloseRepairThread threw'
          );
        });
      } else {
        void maybeOpenOrAppendRepairThread(feedId, req.run_id).catch((err) => {
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
 * POST /api/workers/me/runs/:runId/complete-watcher
 *
 * Device-side completion path for a watcher run that was executed by a local
 * CLI agent (Claude Code, Codex, etc.) on the user's machine. The Owletto
 * Mac app's `WatcherDispatcher` posts here once the subprocess exits.
 *
 * Unlike the MCP-resident `manage_watchers(action="complete_window")` path,
 * the device flow has no JWT window token, no extraction schema validation,
 * and no entity-link resolution — the CLI output is free-form text. We
 * still write a `watcher_windows` row so the dashboard surfaces the run
 * the same way as a server-side watcher completion.
 *
 * Authorization: the caller must own the claim — same gate as
 * /api/workers/complete (status='running' AND claimed_by === worker_id).
 */
export async function completeWatcherRun(c: Context<{ Bindings: Env }>) {
  const runIdParam = c.req.param('runId');
  if (!runIdParam) {
    return c.json({ error: 'runId is required' }, 400);
  }
  const runId = Number(runIdParam);
  if (!Number.isFinite(runId) || runId <= 0) {
    return c.json({ error: 'Invalid runId' }, 400);
  }

  let body: {
    worker_id: string;
    output?: string;
    error?: string;
    duration_ms?: number;
    exit_code?: number | null;
    exit_signal?: string | null;
    exit_reason?: 'ok' | 'error_message' | 'timeout' | 'oom' | 'crash';
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid or missing JSON body' }, 400);
  }

  const denied = await authorizeRunForWorker(c, runId, body.worker_id);
  if (denied) return denied;

  const sql = getDb();
  // Reload the row now that authorization has cleared. We need the watcher_id
  // + organization_id + approved_input to write the completion side-effects.
  // The transaction below will re-lock and re-check status under SELECT ...
  // FOR UPDATE; this read just gates the cheap rejection paths.
  const runRows = (await sql`
    SELECT id, organization_id, watcher_id, approved_input, run_type, claimed_at, status
    FROM runs
    WHERE id = ${runId}
    LIMIT 1
  `) as unknown as Array<{
    id: number;
    organization_id: string;
    watcher_id: number | null;
    approved_input: Record<string, unknown> | null;
    run_type: string;
    claimed_at: string | Date | null;
    status: string;
  }>;
  const run = runRows[0];
  if (!run) return c.json({ error: 'Run not found' }, 404);
  if (run.run_type !== 'watcher') {
    return c.json({ error: 'Not a watcher run' }, 409);
  }
  if (run.watcher_id == null) {
    return c.json({ error: 'Watcher run missing watcher_id' }, 500);
  }

  const watcherId = Number(run.watcher_id);
  const approved = (run.approved_input ?? {}) as Record<string, unknown>;

  // Fix 2 (pi round-2): device-identity binding pinned to the OAuth token, not
  // the request body.
  //
  // The previous version looked up `(workerUserId, body.worker_id)` in
  // `device_workers`, but `body.worker_id` is client-supplied. A same-user
  // token could complete as a different registered worker by posting that
  // worker's id. The fix is the same trick `pollWorkerJob` already uses: if
  // the token was minted with a `workerId` binding (`device_worker:run`
  // PATs/OAuth tokens always are), require `body.worker_id === boundWorkerId`
  // AND, if the run is pinned to a device, the bound worker's
  // `device_workers.id` matches `approved_input.device_worker_id`.
  //
  // For legacy/admin tokens with no `workerId` binding we fall through to the
  // old user_id+worker_id lookup, but emit a warning so the audit trail can
  // catch this path if it ever fires in production (Lobu for Mac always
  // mints worker-bound tokens via /api/me/devices/mint-child-token).
  if (c.var.workerAuthMode === 'user') {
    const workerUserId = c.var.workerUserId;
    const boundWorkerId = c.var.mcpAuthInfo?.workerId ?? null;
    const pinnedDeviceWorkerId =
      typeof approved.device_worker_id === 'string' ? approved.device_worker_id : null;

    if (boundWorkerId) {
      if (boundWorkerId !== body.worker_id) {
        logger.warn(
          { run_id: runId, body_worker_id: body.worker_id, bound_worker_id: boundWorkerId },
          '[completeWatcherRun] body.worker_id != token-bound worker_id — rejecting'
        );
        return c.json(
          {
            error: 'worker_id_mismatch',
            error_description: `this token is bound to worker_id '${boundWorkerId}'`,
          },
          403
        );
      }
      if (pinnedDeviceWorkerId && workerUserId) {
        const deviceRows = (await sql`
          SELECT id
          FROM device_workers
          WHERE user_id = ${workerUserId}
            AND worker_id = ${boundWorkerId}
          LIMIT 1
        `) as unknown as Array<{ id: string }>;
        const callerDeviceWorkerId = deviceRows[0]?.id ?? null;
        if (!callerDeviceWorkerId || callerDeviceWorkerId !== pinnedDeviceWorkerId) {
          logger.warn(
            {
              run_id: runId,
              bound_worker_id: boundWorkerId,
              caller_device: callerDeviceWorkerId,
              pinned_device: pinnedDeviceWorkerId,
            },
            '[completeWatcherRun] device_worker_id mismatch — rejecting'
          );
          return c.json({ error: 'Forbidden: device worker mismatch' }, 403);
        }
      }
    } else if (workerUserId && pinnedDeviceWorkerId) {
      // Legacy/admin path: no worker-bound token. Fall back to the
      // (user_id, body.worker_id) lookup; this is weaker than the bound path
      // but still gates on user ownership. Emit a warning so prod telemetry
      // can flag if any non-Mac caller hits this branch.
      logger.warn(
        { run_id: runId, worker_user_id: workerUserId, body_worker_id: body.worker_id },
        '[completeWatcherRun] no token-bound workerId — falling back to user_id+worker_id check'
      );
      const deviceRows = (await sql`
        SELECT id
        FROM device_workers
        WHERE user_id = ${workerUserId}
          AND worker_id = ${body.worker_id}
        LIMIT 1
      `) as unknown as Array<{ id: string }>;
      const callerDeviceWorkerId = deviceRows[0]?.id ?? null;
      if (!callerDeviceWorkerId || callerDeviceWorkerId !== pinnedDeviceWorkerId) {
        logger.warn(
          {
            run_id: runId,
            body_worker_id: body.worker_id,
            caller_device: callerDeviceWorkerId,
            pinned_device: pinnedDeviceWorkerId,
          },
          '[completeWatcherRun] device_worker_id mismatch (legacy path) — rejecting'
        );
        return c.json({ error: 'Forbidden: device worker mismatch' }, 403);
      }
    }
  }

  // Fix 5: validate the window bounds BEFORE opening any transaction. The
  // legacy code defaulted silently to `new Date().toISOString()` — that hid
  // garbage payloads behind a fresh timestamp. If approved_input contains a
  // bound, it must be a parseable ISO string; otherwise the run is
  // unrecoverably malformed and we mark it failed up front (so it can't get
  // stuck in `running` waiting for a stale-run sweep that may not exist).
  const validateIsoBound = (
    key: 'window_start' | 'window_end',
    fallback: string
  ): { value: string } | { error: string } => {
    const raw = approved[key];
    if (raw === undefined || raw === null) return { value: fallback };
    if (typeof raw !== 'string') {
      return { error: `approved_input.${key} must be an ISO timestamp string` };
    }
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) {
      return { error: `approved_input.${key} is not a valid ISO timestamp` };
    }
    return { value: raw };
  };

  const nowIso = new Date().toISOString();
  const startResult = validateIsoBound('window_start', nowIso);
  const endResult = validateIsoBound('window_end', nowIso);
  if ('error' in startResult || 'error' in endResult) {
    const reason =
      'error' in startResult ? startResult.error : (endResult as { error: string }).error;
    // Mark the run failed so the watcher's `next_run_at` advances and the
    // schedule doesn't loop on this poisoned payload forever.
    //
    // Pi round-2 #C: only advance the schedule when the UPDATE actually
    // changed a row. Without `RETURNING id`, two concurrent malformed
    // completions would BOTH advance the schedule — the second one's UPDATE
    // matches zero rows (status already 'failed') but we'd still tick
    // `next_run_at` forward, potentially skipping a window.
    try {
      const failedRows = (await sql`
        UPDATE runs
        SET status = 'failed',
            completed_at = current_timestamp,
            error_message = ${`Invalid completion payload: ${reason}`},
            exit_reason = 'error_message'
        WHERE id = ${runId}
          AND status = 'running'
        RETURNING id
      `) as unknown as Array<{ id: number }>;
      if (failedRows.length > 0) {
        await advanceWatcherSchedule(sql, watcherId);
      }
    } catch (err) {
      logger.error(
        { run_id: runId, err: errorMessage(err) },
        '[completeWatcherRun] failed to mark run failed after validation error'
      );
    }
    return c.json({ error: reason }, 400);
  }

  const windowStart = startResult.value;
  const windowEnd = endResult.value;
  // Granularity isn't stored on watcher runs — infer once for the window
  // row. A blank string fails the NOT NULL constraint; default to "ad_hoc"
  // for device-driven runs (the dashboard's rollup logic treats this as a
  // leaf window with no parent).
  const granularity = 'ad_hoc';

  const hasError = typeof body.error === 'string' && body.error.trim() !== '';
  const output = typeof body.output === 'string' ? body.output : '';
  const durationMs =
    typeof body.duration_ms === 'number' && Number.isFinite(body.duration_ms)
      ? Math.max(0, Math.floor(body.duration_ms))
      : null;

  // Track whether the work was already done by a concurrent completion. Used
  // after the transaction to return an idempotent 200 instead of failing the
  // duplicate-INSERT path that pi-#3 flagged.
  let alreadyCompleted = false;

  try {
    await sql.begin(async (tx) => {
      // Fix 3: lock the run row inside the transaction. Without this, two
      // concurrent POSTs can both pass `authorizeRunForWorker` (which reads
      // without a lock), both enter the tx, both INSERT a watcher_windows
      // row, and the second one's run-UPDATE fails the `status='running'`
      // filter — leaving a duplicate window row and a 500.
      const lockedRows = (await tx`
        SELECT status
        FROM runs
        WHERE id = ${runId}
        FOR UPDATE
      `) as unknown as Array<{ status: string }>;
      const currentStatus = lockedRows[0]?.status ?? null;
      if (!currentStatus) {
        // Disappeared between the pre-tx read and the lock — treat as 404 by
        // throwing; outer catch surfaces as 500, callers will retry.
        throw new Error('Run vanished while acquiring lock');
      }
      if (currentStatus !== 'running') {
        // A concurrent caller already terminated this run. Idempotent path:
        // do nothing here and let the outer code return 200 with the existing
        // terminal status. This is safe because the duplicate write would
        // either violate the watcher_windows PK or insert a phantom row.
        alreadyCompleted = true;
        return;
      }

      if (hasError) {
        await tx`
          UPDATE runs
          SET status = 'failed',
              completed_at = current_timestamp,
              error_message = ${body.error ?? null},
              exit_code = ${body.exit_code ?? null},
              exit_signal = ${body.exit_signal ?? null},
              exit_reason = ${body.exit_reason ?? 'error_message'}
          WHERE id = ${runId}
            AND status = 'running'
        `;
      } else {
        // Fix 4 (pi round-2 #B): allocate the window id via the shared
        // helper, which now takes a per-table `pg_advisory_xact_lock` keyed
        // on `hashtext('watcher_windows_id_alloc')`. Because this runs inside
        // `sql.begin`, the lock is held until tx commit — bracketing the
        // SELECT MAX + INSERT, so two concurrent completions on DIFFERENT
        // watcher runs serialize on allocation and never collide on the
        // watcher_windows PK. (Same-watcher concurrent completions are
        // already serialized by the SELECT … FOR UPDATE on runs.id above.)
        const windowId = await getNextNumericId(tx, 'watcher_windows');

        const extractedData = {
          kind: 'device_cli_output',
          output,
          agent_kind:
            typeof approved.agent_kind === 'string' && (approved.agent_kind as string).trim()
              ? (approved.agent_kind as string).trim()
              : null,
        } as Record<string, unknown>;
        const runMetadata = {
          source: 'device_worker',
          device_worker_id:
            typeof approved.device_worker_id === 'string'
              ? approved.device_worker_id
              : null,
          watcher_run_id: runId,
        } as Record<string, unknown>;

        await tx`
          INSERT INTO watcher_windows (
            id, watcher_id, version_id, window_start, window_end, granularity,
            extracted_data, content_analyzed, model_used, client_id, run_metadata,
            is_rollup, depth, source_window_ids, run_id, execution_time_ms, created_at
          ) VALUES (
            ${windowId}, ${watcherId}, NULL, ${windowStart}, ${windowEnd}, ${granularity},
            ${tx.json(extractedData)}, 0, 'device-cli', NULL, ${tx.json(runMetadata)},
            false, 0, NULL, ${runId}, ${durationMs}, current_timestamp
          )
        `;

        await tx`
          UPDATE runs
          SET status = 'completed',
              completed_at = current_timestamp,
              window_id = ${windowId},
              error_message = NULL,
              exit_code = ${body.exit_code ?? null},
              exit_signal = ${body.exit_signal ?? null},
              exit_reason = ${body.exit_reason ?? 'ok'}
          WHERE id = ${runId}
            AND status = 'running'
        `;
      }

      await tx`
        UPDATE watchers
        SET last_fired_at = NOW(),
            updated_at = NOW()
        WHERE id = ${watcherId}
      `;

      // Fix 1: advance `next_run_at` in the SAME transaction that recorded
      // the completion. Without this the scheduled-jobs tick sees the
      // watcher as still due (last_fired_at moved, next_run_at didn't) and
      // re-materializes immediately — looping forever on every minute tick.
      // The helper is shared with `manage_watchers(action="complete_window")`
      // and the terminal-failure path in `automation.ts`.
      await advanceWatcherSchedule(tx, watcherId);
    });
  } catch (err) {
    logger.error(
      { error: errorMessage(err), run_id: runId, watcher_id: watcherId },
      '[completeWatcherRun] Failed to record completion'
    );
    return c.json({ error: errorMessage(err) }, 500);
  }

  if (alreadyCompleted) {
    // Re-read the terminal status so we echo back what actually landed (not
    // what this request would have written). Don't fire the lifecycle event
    // again — the winning concurrent caller already did.
    const finalRows = (await sql`
      SELECT status FROM runs WHERE id = ${runId} LIMIT 1
    `) as unknown as Array<{ status: string }>;
    const finalStatus = finalRows[0]?.status ?? (hasError ? 'failed' : 'completed');
    return c.json({ ok: true, status: finalStatus, idempotent: true });
  }

  // Fire-and-forget: a "change" event so the dashboard's metric_series picks
  // up the device-CLI completion the same way it picks up server-side ones.
  // LifecycleOp is restricted to created/updated/deleted — we use 'updated'
  // and put the actual ran/errored detail under `extra`.
  recordLifecycleEvent({
    organizationId: run.organization_id,
    entityType: 'watcher',
    op: 'updated',
    entityId: String(watcherId),
    summary: hasError
      ? `Watcher run ${runId} failed on device CLI: ${body.error ?? 'unknown error'}`
      : `Watcher run ${runId} completed via device CLI`,
    extra: {
      run_id: runId,
      source: 'device_worker',
      outcome: hasError ? 'failed' : 'completed',
      duration_ms: durationMs,
    },
  });

  return c.json({ ok: true, status: hasError ? 'failed' : 'completed' });
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

    // Return events with no embedding OR an embedding whose stamp is not the
    // configured model — including NULL (legacy row, unknown model). Search
    // excludes those rows from vector comparison, so they must be restamped.
    // `IS DISTINCT FROM` makes NULL count as different from the (non-NULL)
    // configured model. The model is server config, inlined as a validated
    // literal.
    const modelLiteral = configuredEmbeddingModelSqlLiteral();
    const placeholders = safeIds.map((_, i) => `$${i + 1}`).join(',');
    const rows = await sql.unsafe(
      `SELECT e.id, e.payload_text, e.title
       FROM events e
       LEFT JOIN event_embeddings emb ON emb.event_id = e.id
       WHERE e.id IN (${placeholders})
         AND (emb.event_id IS NULL OR emb.embedding_model IS DISTINCT FROM ${modelLiteral})`,
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
      embeddings: Array<{ event_id: number; embedding: number[]; embedding_model?: string }>;
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
        // On conflict, REPLACE a stale-model row (a model swap left its vector in
        // an incompatible space) with the freshly-embedded vector + stamp. The
        // WHERE makes a same-model re-submit a no-op (idempotent), so we never
        // churn rows that are already current.
        const result = await sql.unsafe(
          `INSERT INTO event_embeddings (event_id, embedding, embedding_model)
           VALUES ($1, $2::vector, $3)
           ON CONFLICT (event_id) DO UPDATE
             SET embedding = EXCLUDED.embedding,
                 embedding_model = EXCLUDED.embedding_model,
                 created_at = now()
             WHERE event_embeddings.embedding_model IS DISTINCT FROM EXCLUDED.embedding_model`,
          [item.event_id, vectorStr, item.embedding_model ?? null]
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

    // Same ownership check as the other /complete endpoints — a worker
    // can only finalize runs it claimed. Without this, a leaked worker
    // token could overwrite action_output on arbitrary runs.
    const denied = await authorizeRunForWorker(c, req.run_id, req.worker_id);
    if (denied) return denied;

    const sql = getDb();

    // Atomic terminal-state transition. The WHERE clause makes the
    // UPDATE no-op if the row has already been finalized by another
    // path (e.g. waitForDeviceActionRun timed out and marked it
    // 'timeout'). Without this guard, a slow worker could overwrite a
    // gateway-side timeout decision with success — and the caller has
    // already returned timeout to its caller, so the action would
    // double-finalize.
    const updatedRuns = await sql`
      UPDATE runs
      SET status = ${req.status === 'success' ? 'completed' : 'failed'},
          completed_at = current_timestamp,
          action_output = ${req.action_output ? sql.json(req.action_output) : null},
          error_message = ${req.error_message ?? null}
      WHERE id = ${req.run_id}
        AND status = 'running'
        AND claimed_by = ${req.worker_id}
      RETURNING organization_id, action_key
    `;
    if (updatedRuns.length === 0) {
      // Either the run was already finalized (timeout race) or the
      // worker isn't the claimant. authorizeRunForWorker already gated
      // ownership, so this is almost always the timeout race; return
      // a clear status so the worker's logs are informative.
      logger.info(
        { run_id: req.run_id, worker_id: req.worker_id, claimed_status: req.status },
        '[completeActionRun] no-op: run already in terminal state (likely gateway timeout)'
      );
      return c.json({ success: false, reason: 'already_finalized' });
    }

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
