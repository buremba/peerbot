/**
 * Worker API Endpoints
 *
 * HTTP handlers for worker operations.
 * Updated for V1 integration platform: runs-based job model.
 */

import { authorizeCapabilities, isKnownPlatform } from '@lobu/core';
import type { Context } from 'hono';
import { createAuth } from './auth';
import { PersonalAccessTokenService } from './auth/tokens';
import { getDb, parsePgNumberArray, pgBigintArray, pgTextArray } from './db/client';
import { emit } from './events/emitter';
import type { Env } from './index';
import { notifyBrowserAuthExpired } from './notifications/triggers';
import { materializeDueFeeds } from './scheduled/check-due-feeds';
import { supersedeActionEvent } from './tools/admin/manage_operations';
import {
  type BrowserKind,
  createAuthProfile,
  getAuthProfileById,
  getBrowserSessionReadiness,
} from './utils/auth-profiles';
import {
  maybeCloseRepairThread,
  maybeOpenOrAppendRepairThread,
} from './connectors/repair-agent';
import { captureServerError } from './sentry';
import { autoLinkEvent } from './utils/auto-linker';
import { nextRunAt as nextRunAtFromCron } from './utils/cron';
import { advanceWatcherSchedule, enqueueWatcherRunForWatcher } from './watchers/automation';
import {
  DEFAULT_AGENT_ID,
  ensureDefaultWatcher,
  hasOrgSentinel,
  DEFAULT_AGENT_SENTINEL,
} from './auth/default-provisioning';
import { getNextNumericId } from './tools/admin/helpers/db-helpers';
import { reconcileDeviceCapabilities } from './worker-api/device-reconcile';
import { findBundledConnectorFile } from './utils/connector-catalog';
import { resolveConnectorCode } from './utils/ensure-connector-installed';
import { applyEntityLinks } from './utils/entity-link-upsert';
import { errorMessage } from './utils/errors';
import { validateConnectorEventSemanticType } from './utils/event-kind-validation';
import { mergeExecutionConfig, resolveExecutionAuth } from './utils/execution-context';
import {
  materializeInlineAttachments,
  triggerAudioTranscriptions,
} from './utils/inline-attachments';
import { insertEvent, recordLifecycleEvent } from './utils/insert-event';
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
  // they advertise, never the embedded-server connectors. So '' is excluded for them,
  // which means a bridge with no granted capabilities claims *nothing* instead
  // of hijacking-and-failing arbitrary embedded-server connector runs (e.g. hackernews).
  const isUserScopedWorker = c.var.workerAuthMode === 'user';
  // User-scoped (device) callers must post a non-empty worker_id. An empty
  // or missing id would otherwise let a bound PAT (see below) sidestep the
  // binding check by claiming all worker rows under `(user_id, "")`.
  if (isUserScopedWorker && (!worker_id || worker_id.length === 0)) {
    return c.json({ error: 'worker_id is required' }, 400);
  }
  // Worker-id binding: when the caller's PAT was minted via
  // /api/me/devices/mint-child-token, its row in personal_access_tokens
  // carries a non-NULL `worker_id`. The poll body must use the same id —
  // otherwise the caller could escape platform binding by registering
  // arbitrary fresh worker_ids and picking their own platform on each.
  // Comparing unconditionally (not `&& worker_id`) catches the empty-string
  // case too.
  const boundWorkerId = c.var.mcpAuthInfo?.workerId ?? null;
  if (boundWorkerId && boundWorkerId !== worker_id) {
    return c.json(
      {
        error: 'worker_id_mismatch',
        error_description: `this token is bound to worker_id '${boundWorkerId}'`,
      },
      403
    );
  }
  // Platform binding: once a (user_id, worker_id) row has set its platform,
  // subsequent polls cannot change it. Without this lock a chrome-extension
  // PAT could post `platform: "macos"` and unlock the macOS allowlist —
  // the gateway's capability authorization would otherwise believe the
  // self-reported platform. We read the stored platform first, reject
  // mismatches, and use the stored value for authorization.
  let effectivePlatform: string | null = platform;
  if (isUserScopedWorker && c.var.workerUserId && worker_id) {
    const existing = (await sql`
      SELECT platform FROM device_workers
      WHERE user_id = ${c.var.workerUserId} AND worker_id = ${worker_id}
      LIMIT 1
    `) as unknown as Array<{ platform: string | null }>;
    if (existing.length > 0 && existing[0].platform) {
      if (platform && platform !== existing[0].platform) {
        return c.json(
          {
            error: 'platform_mismatch',
            error_description: `worker is bound to platform '${existing[0].platform}'`,
          },
          403
        );
      }
      effectivePlatform = existing[0].platform;
    }
  }
  // For user-scoped (device) workers, authorize the advertised capability set
  // against the platform-specific allowlist in @lobu/core. Anything outside
  // the allowlist for the device's reported platform is silently dropped —
  // a chrome-extension can't claim `os.shell`, an iOS bridge can't claim
  // `browser.debugger`, etc. Trusted-fleet workers (no platform) skip this.
  let authorizedCapabilities = advertisedCapabilities;
  if (isUserScopedWorker) {
    const auth = authorizeCapabilities(effectivePlatform, advertisedCapabilities);
    authorizedCapabilities = auth.authorized;
    if (auth.dropped.length > 0) {
      logger.warn(
        { worker_id, platform: effectivePlatform, dropped: auth.dropped },
        '[pollWorkerJob] dropped capabilities not allowed for platform'
      );
    }
  }
  const capabilityMatchSet = isUserScopedWorker
    ? authorizedCapabilities
    : [''].concat(authorizedCapabilities);

  // Device-worker registry: upsert device_workers row for user-scoped workers
  // so /api/me/devices can enumerate them. Also ensure advertised capability
  // connectors are fully wired. Best-effort — never fail the poll.
  //
  // `deviceWorkerId` is this device's surrogate id; a pending run whose
  // connection is pinned to it (connections.device_worker_id) is claimable
  // regardless of the connector's required_capability — that's how an
  // otherwise-embedded connector (Reddit, …) ends up running on a chosen device.
  const workerUserId = c.var.workerUserId;
  // The org the device's token was issued for — the workspace the user picked on
  // the OAuth device-authorization page. Falls back to the owner's personal
  // workspace for tokens not bound to any org. Sets the device's home only on
  // first registration; moving an existing device is the Devices-page action.
  const workerTokenOrgId = c.var.organizationId ?? null;
  let deviceWorkerId: string | null = null;
  if (workerUserId) {
    try {
      const incomingCaps = authorizedCapabilities;

      // `xmax = 0` on the RETURNING row distinguishes a brand-new device
      // registration from a routine poll-update so we only emit the
      // `device:created` lifecycle event once per device.
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
          -- platform is set-once: COALESCE preserves the original value,
          -- so a compromised PAT can't re-platform a Chrome worker into a
          -- macOS one to unlock OS capabilities. The mismatch check above
          -- already rejects deliberate attempts; this is defense-in-depth
          -- against a race between the SELECT and the UPSERT.
          platform = COALESCE(device_workers.platform, EXCLUDED.platform),
          app_version = EXCLUDED.app_version,
          capabilities = EXCLUDED.capabilities,
          label = COALESCE(EXCLUDED.label, device_workers.label),
          organization_id = COALESCE(device_workers.organization_id, EXCLUDED.organization_id),
          last_seen_at = now()
        RETURNING id, organization_id, (xmax = 0) AS inserted
      `) as unknown as Array<{ id: string; organization_id: string | null; inserted: boolean }>;
      deviceWorkerId = upserted[0]?.id ?? null;
      if (upserted[0]?.inserted && upserted[0]?.organization_id) {
        recordLifecycleEvent({
          organizationId: upserted[0].organization_id,
          entityType: 'device',
          op: 'created',
          entityId: upserted[0].id,
          summary: `Device "${label ?? worker_id}" registered`,
          extra: { platform, worker_id, app_version },
        });

        // Mac-app onboarding: when a device registers for the first time in an
        // org that's a candidate for default provisioning (agent sentinel set
        // → `ensureDefaultAgent` ran for this org at boot), provision a daily
        // check-in watcher pinned to THIS device. The sentinel on
        // `organization.metadata` makes this exactly-once even across multiple
        // first-poll attempts. Deletion stickiness: if the user later removes
        // the watcher via the web UI, the sentinel stays and we do NOT
        // recreate.
        const provisioningOrgId = upserted[0].organization_id;
        const provisioningDeviceId = upserted[0].id;
        try {
          const isCandidateOrg = await hasOrgSentinel(
            provisioningOrgId,
            DEFAULT_AGENT_SENTINEL,
            sql
          );
          if (isCandidateOrg) {
            await ensureDefaultWatcher({
              organizationId: provisioningOrgId,
              agentId: DEFAULT_AGENT_ID,
              deviceWorkerId: provisioningDeviceId,
              sql,
            });
          }
        } catch (err) {
          logger.warn(
            { err: errorMessage(err), organizationId: provisioningOrgId },
            '[pollWorkerJob] default-watcher provisioning failed (non-fatal)'
          );
        }
      }

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
          AND (r.approval_status = 'auto' OR r.approval_status = 'approved')
          AND (
            -- (1) Connector-worker lanes: sync / action / embed_backfill / auth.
            --     Browser-only connectors require the browser capability.
            (
              r.run_type IN ('sync', 'action', 'embed_backfill', 'auth')
              AND (${hasBrowser} OR COALESCE(cd.api_type, 'api') = 'api')
              AND (
                -- (1A) trusted/anonymous fleet worker: the no-capability cloud
                --      connectors plus any capability it happens to advertise,
                --      in any org — but NEVER a connection pinned to a device.
                (
                  ${!isUserScopedWorker}
                  AND COALESCE(cd.required_capability, '') = ANY(${pgTextArray(capabilityMatchSet)}::text[])
                  AND con.device_worker_id IS NULL
                )
                -- (1B) user-scoped device worker: an unpinned capability-matched
                --      device connector in an org this worker can see. Capability
                --      match goes through the authorized set — a chrome-extension
                --      claiming os.shell is dropped server-side (see
                --      @lobu/core/capabilities), and that dropped string MUST NOT
                --      match a connectors required_capability here either.
                OR (
                  ${isUserScopedWorker}
                  AND cd.required_capability IS NOT NULL
                  AND cd.required_capability = ANY(${pgTextArray(authorizedCapabilities)}::text[])
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
                    OR cd.required_capability = ANY(${pgTextArray(authorizedCapabilities)}::text[])
                  )
                  AND r.organization_id = ANY(${pgTextArray(orgScopeIds)}::text[])
                )
              )
            )
            -- (2) Watcher lane: a watcher run with approved_input.device_worker_id
            --     matching this device. Watchers don't carry a connection_id and
            --     don't gate on capabilities — the matching device's local CLI
            --     executor handles the work (Owletto's WatcherDispatcher routes
            --     by approved_input.agent_kind). The server-side dispatcher
            --     (#802) already refuses to claim rows with this pin set, so
            --     this branch is the only legal claim path for them.
            OR (
              ${isUserScopedWorker}
              AND r.run_type = 'watcher'
              AND ${deviceWorkerId}::uuid IS NOT NULL
              AND r.approved_input ? 'device_worker_id'
              AND r.approved_input->>'device_worker_id' = ${deviceWorkerId}::text
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
          last_heartbeat_at = current_timestamp,
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
        r.created_at AS run_created_at,
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
        ap.auth_data AS auth_profile_auth_data,
        w.name AS watcher_name,
        w.slug AS watcher_slug,
        w.agent_kind AS watcher_agent_kind,
        w.notification_channel AS watcher_notification_channel,
        w.notification_priority AS watcher_notification_priority
      FROM runs r
      LEFT JOIN feeds f ON f.id = r.feed_id
      LEFT JOIN connections conn ON conn.id = r.connection_id
      LEFT JOIN connector_versions cv ON cv.connector_key = r.connector_key
        AND cv.version = r.connector_version
      LEFT JOIN auth_profiles ap ON ap.id = r.auth_profile_id
      LEFT JOIN watchers w ON w.id = r.watcher_id
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
    approved_input: Record<string, unknown> | null;
    feed_key: string | null;
    feed_config: Record<string, unknown> | null;
    checkpoint: Record<string, unknown> | null;
    feed_entity_ids: number[] | null;
    auth_profile_id: number | null;
    app_auth_profile_id: number | null;
    connection_config: Record<string, unknown> | null;
    connection_device_worker_id: string | null;
    compiled_code: string | null;
    run_created_at: string | Date | null;
    // Watcher run fields (populated via LEFT JOINs)
    watcher_id: number | null;
    window_id: number | null;
    organization_id: string;
    watcher_name: string | null;
    watcher_slug: string | null;
    watcher_agent_kind: string | null;
    watcher_notification_channel: string | null;
    watcher_notification_priority: string | null;
    // Auth run fields
    run_auth_profile_id: number | null;
    auth_profile_auth_data: Record<string, unknown> | null;
  };

  // Watcher run: device worker is going to spawn a local CLI executor and
  // return the result via /api/workers/me/runs/:runId/complete-watcher. No
  // connector code, no connection credentials, no compiled_code lookup —
  // just the payload envelope the dispatcher needs to build a prompt. The
  // server-side claim filter (#802 + this PR) already guarantees only the
  // matching device can land on this row.
  if (row.run_type === 'watcher') {
    const approved = (row.approved_input ?? {}) as Record<string, unknown>;
    const firedAtRaw = row.run_created_at;
    const firedAt =
      firedAtRaw instanceof Date
        ? firedAtRaw.toISOString()
        : typeof firedAtRaw === 'string' && firedAtRaw.trim()
          ? firedAtRaw
          : new Date().toISOString();
    const watcherIdStr = row.watcher_id != null ? String(row.watcher_id) : '';
    const agentKindFromPayload =
      typeof approved['agent_kind'] === 'string' && (approved['agent_kind'] as string).trim()
        ? (approved['agent_kind'] as string).trim()
        : null;
    return c.json({
      run_id: row.run_id,
      run_type: row.run_type,
      organization_id: row.organization_id,
      payload: {
        watcher: {
          id: watcherIdStr,
          name: row.watcher_name ?? null,
          slug: row.watcher_slug ?? null,
          agent_kind: agentKindFromPayload ?? row.watcher_agent_kind ?? null,
          notification_channel: row.watcher_notification_channel ?? 'canvas',
          notification_priority: row.watcher_notification_priority ?? 'normal',
        },
        event: {
          trigger_event_id: null,
          fired_at: firedAt,
          payload: approved,
        },
        context: {
          device: {
            worker_id: deviceWorkerId,
          },
          user: {
            user_id: workerUserId ?? null,
          },
        },
      },
    });
  }

  // Connector code delivery:
  //   - Fleet workers (server pods, embedded mode) ship the same bundled
  //     connector .ts sources in their image. The gateway omits
  //     `compiled_code` from the response — the worker resolves
  //     `connector_key` against its own filesystem and compiles locally,
  //     keeping its own LRU-capped cache. Cuts gateway poll responses
  //     from ~13 MB to ~kB and stops the gateway-side cache from being
  //     the dominant heap occupant (lobu#771 postmortem trail; 29 cached
  //     bundles totalled ~384 MB).
  //   - Device workers (Lobu Mac Bridge) and DB-only user-uploaded
  //     connectors don't have the source on disk; they still get
  //     `compiled_code` shipped inline. We check the gateway-local
  //     `findBundledConnectorFile` (different filesystem layout from the
  //     worker image — see worker-side resolver in
  //     connector-worker/src/compile-connector.ts) to decide whether the
  //     fleet path applies.
  let compiledCode: string | undefined;
  const gatewayHasLocalSource = row.connector_key
    ? findBundledConnectorFile(row.connector_key) !== null
    : false;
  const workerWillResolveLocally = !isUserScopedWorker && gatewayHasLocalSource;
  if (row.connector_key && !workerWillResolveLocally) {
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
  // `user_data_dir` and `cdp_url` for device-bound browser profiles flow to
  // the worker via `sessionState.user_data_dir` / `sessionState.cdp_url`
  // (set inside resolveExecutionAuth). No need to thread them as separate
  // top-level fields here.
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

  let body: { platform?: string; label?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid or missing JSON body' }, 400);
  }
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

  try {
    const sql = getDb();
    // Same org-resolution rule as /api/workers/poll: prefer the calling
    // token's org, fall back to the user's personal org.
    const orgRows = (await sql`
      SELECT id FROM organization
      WHERE (metadata::jsonb)->>'personal_org_for_user_id' = ${userId}
      LIMIT 1
    `) as unknown as Array<{ id: string }>;
    const organizationId =
      (c.var.organizationId as string | null | undefined) ?? orgRows[0]?.id ?? null;

    const workerId = crypto.randomUUID();
    const patService = new PersonalAccessTokenService(sql);
    const created = await patService.create(
      userId,
      organizationId,
      `device:${platform}:${workerId.slice(0, 8)}`,
      {
        scope: 'device_worker:run',
        description: label ?? undefined,
        workerId,
      }
    );
    // Pre-create the device_workers row with platform set. The next poll
    // call from the child sees this row, can't change platform (poll's
    // ON CONFLICT preserves it via COALESCE + a SELECT-then-reject check),
    // and the gateway's capability authorization uses the stored platform
    // rather than whatever the bearer self-reports.
    await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id)
      VALUES (${userId}, ${workerId}, ${platform}, ${sql.json([])}, ${organizationId})
      ON CONFLICT (user_id, worker_id) DO NOTHING
    `;

    const gatewayUrl = new URL(c.req.url).origin;
    return c.json({
      worker_id: workerId,
      access_token: created.token,
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

const BROWSER_KIND_SET: ReadonlySet<BrowserKind> = new Set(['chrome', 'brave', 'arc', 'edge']);

async function resolveDeviceWorkerForRequest(
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

// -----------------------------------------------------------------------------
// Device-scoped feed CRUD
// -----------------------------------------------------------------------------
//
// The Mac app uses these to create / list / delete feeds on its auto-wired
// device connection (e.g. one feed per local folder for `local.directory`).
// Scope = (this device's user, this device's auto-wired connection for the
// given connector_key). Server never sees the security-scoped bookmark — just
// the metadata the Mac app posts in the feed config.

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

/**
 * POST /api/workers/me/watchers/:watcher_id/trigger
 *
 * Manually fire a watcher run from the device that owns it. The Mac app's
 * "Run now" action posts here. Unlike the scheduled path, this:
 *   - does NOT advance `watchers.next_run_at` (manual fires shouldn't shift
 *     the cron schedule);
 *   - is idempotent against active runs — re-trigger while a previous run is
 *     pending/claimed/running returns the existing `run_id` with
 *     `already_queued: true`;
 *   - requires the calling token's bound `device_workers.id` to match
 *     `watchers.device_worker_id`. No cross-device triggering.
 *
 * Auth: same `/api/workers/*` middleware. `device_worker:run` scope (granted
 * to Mac-app PATs minted via the device-link flow).
 */
export async function triggerWatcherForDevice(c: Context<{ Bindings: Env }>) {
  const watcherIdParam = c.req.param('watcher_id');
  if (!watcherIdParam) {
    return c.json({ error: 'watcher_id is required' }, 400);
  }
  const watcherId = Number(watcherIdParam);
  if (!Number.isFinite(watcherId) || watcherId <= 0) {
    return c.json({ error: 'Invalid watcher_id' }, 400);
  }

  // The middleware already verified the token has `device_worker:run` (or
  // mcp:write/admin). The trigger surface is user-scoped only — trusted
  // server workers shouldn't be triggering device-pinned watchers, that's
  // what the scheduled path is for.
  if (c.var.workerAuthMode !== 'user') {
    return c.json({ error: 'Endpoint is user-scoped only' }, 403);
  }
  const workerUserId = c.var.workerUserId;
  if (!workerUserId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const scopes = c.var.mcpAuthInfo?.scopes ?? [];
  if (
    !scopes.includes('device_worker:run') &&
    !scopes.includes('mcp:write') &&
    !scopes.includes('mcp:admin')
  ) {
    return c.json({ error: 'Worker token missing device_worker:run scope' }, 403);
  }

  // Resolve the caller's bound device worker. mcpAuth populates
  // `mcpAuthInfo.workerId` from the PAT row. Without a bound workerId there's
  // no way to authorize the trigger — manual fires must come from a known
  // physical device.
  const boundWorkerId = c.var.mcpAuthInfo?.workerId ?? null;
  if (!boundWorkerId) {
    return c.json({ error: 'Token is not bound to a device worker' }, 403);
  }

  const sql = getDb();
  let resolvedDeviceWorkerId: string;
  try {
    const deviceRows = (await sql`
      SELECT id, organization_id
      FROM device_workers
      WHERE user_id = ${workerUserId} AND worker_id = ${boundWorkerId}
      LIMIT 1
    `) as unknown as Array<{ id: string; organization_id: string | null }>;
    const device = deviceRows[0];
    if (!device) {
      return c.json({ error: 'Device not registered yet — poll first' }, 404);
    }
    resolvedDeviceWorkerId = device.id;
  } catch (err) {
    logger.error({ error: errorMessage(err) }, '[triggerWatcherForDevice] device lookup failed');
    return c.json({ error: 'Internal error' }, 500);
  }

  // Load the watcher and enforce two checks:
  //   (1) the watcher is in the caller's org scope (auth middleware computed
  //       `workerOrgIds` from the token-bound org + the user's personal org);
  //   (2) `watchers.device_worker_id` matches the caller's device. Even if
  //       the user owns both devices, A cannot trigger a watcher pinned to B
  //       — that's a different pairing in the UI.
  const watcherRows = (await sql`
    SELECT id, organization_id, agent_id, status, device_worker_id::text AS device_worker_id
    FROM watchers
    WHERE id = ${watcherId}
    LIMIT 1
  `) as unknown as Array<{
    id: number;
    organization_id: string;
    agent_id: string | null;
    status: string;
    device_worker_id: string | null;
  }>;
  const watcher = watcherRows[0];
  if (!watcher) {
    return c.json({ error: 'Watcher not found' }, 404);
  }

  const orgIds = c.var.workerOrgIds ?? [];
  if (!orgIds.includes(watcher.organization_id)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!watcher.device_worker_id || watcher.device_worker_id !== resolvedDeviceWorkerId) {
    return c.json({ error: 'Watcher is not pinned to this device' }, 403);
  }
  if ((watcher.status ?? 'active') !== 'active') {
    return c.json({ error: 'Watcher is not active' }, 409);
  }
  if (!watcher.agent_id) {
    return c.json({ error: 'Watcher has no agent assigned' }, 409);
  }

  // Enqueue (or re-use) the run. `enqueueWatcherRunForWatcher` delegates to
  // `createWatcherRun`, which checks for an active run in the same watcher_id
  // lane and reuses it (returns `created: false`). That gives us broad
  // idempotency across pending/claimed/running — re-trigger never starts a
  // second run while the first is still in flight. We intentionally do NOT
  // advance `watchers.next_run_at` here so a manual fire doesn't shift the
  // cron schedule.
  try {
    const result = await enqueueWatcherRunForWatcher(watcherId, 'manual');
    return c.json(
      {
        run_id: result.runId,
        status: result.status,
        already_queued: !result.created,
        queued_at: new Date().toISOString(),
      },
      200
    );
  } catch (err) {
    logger.error(
      { error: errorMessage(err), watcherId },
      '[triggerWatcherForDevice] enqueue failed'
    );
    return c.json({ error: errorMessage(err) }, 500);
  }
}

