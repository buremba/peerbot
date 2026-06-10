/**
 * POST /api/workers/poll
 *
 * Worker polls for the next available run. Handles device registration/upsert,
 * platform binding, capability authorization, and multi-lane run claiming.
 */

import { authorizeCapabilities } from '@lobu/core';
import type { Context } from 'hono';
import { getDb, pgTextArray } from '../db/client';
import type { Env } from '../index';
import { materializeDueFeeds } from '../scheduled/check-due-feeds';
import {
  DEFAULT_AGENT_ID,
  ensureDefaultWatcher,
  hasOrgSentinel,
  DEFAULT_AGENT_SENTINEL,
} from '../auth/default-provisioning';
import { reconcileDeviceCapabilities } from './device-reconcile';
import { findBundledConnectorFile } from '../utils/connector-catalog';
import { resolveConnectorCode } from '../utils/ensure-connector-installed';
import { resolveDeviceClaimableOrgs } from '../utils/device-claimable-orgs';
import { errorMessage } from '../utils/errors';
import { mergeExecutionConfig, resolveExecutionAuth } from '../utils/execution-context';
import logger from '../utils/logger';
import { recordLifecycleEvent } from '../utils/insert-event';
import { isCloudMode } from '../utils/cloud-mode';
import { normalizeAdvertisedCapabilities } from './shared';

const DUE_FEEDS_LOCK_KEY = 71001;
const DUE_FEED_MATERIALIZE_COOLDOWN_MS = 5000;
let lastDueFeedMaterializeAttemptAt = 0;

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
  // Capability set the worker advertised, used to filter on
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
  // Local/personal-install fallback. When WORKER_API_TOKEN is unset, a device
  // worker whose token fails auth doesn't 401 — the /api/workers/* middleware
  // degrades it to `anonymous` (workerUserId = null), which previously skipped
  // the device_workers upsert + reconcileDeviceCapabilities below, so device
  // connectors (Screen Time, Photos, …) silently never wired up. In a non-cloud
  // install, re-anchor an anonymous poll to the user that already owns this
  // worker_id and treat it as a device worker END-TO-END (platform binding,
  // capability allowlist, org-scoped claims, registration) — not as a
  // trusted/anonymous fleet worker. Cloud (LOBU_CLOUD_MODE) stays strict: a poll
  // must carry a user-scoped token, so a known worker_id can't be spoofed across
  // tenants.
  let anonLocalUserId: string | null = null;
  let anonLocalOrgId: string | null = null;
  if (c.var.workerAuthMode === 'anonymous' && worker_id && !isCloudMode()) {
    const owner = (await sql`
      SELECT user_id, organization_id FROM device_workers
      WHERE worker_id = ${worker_id} LIMIT 1
    `) as unknown as Array<{ user_id: string; organization_id: string | null }>;
    if (owner.length > 0) {
      anonLocalUserId = owner[0].user_id;
      anonLocalOrgId = owner[0].organization_id;
      logger.info(
        { worker_id, user_id: anonLocalUserId },
        '[pollWorkerJob] local (non-cloud) anonymous device poll → treating as device worker for existing owner'
      );
    }
  }
  // A re-anchored local poll is a device (user-scoped) worker for every check
  // below, so platform binding / capability authorization / org-scoped claiming
  // all apply exactly as for a signed-in device.
  const isUserScopedWorker = c.var.workerAuthMode === 'user' || anonLocalUserId != null;
  // Effective device identity: the token's user/org when user-scoped, else the
  // re-anchored local owner.
  const effectiveWorkerUserId = c.var.workerUserId ?? anonLocalUserId;
  const effectiveWorkerOrgIds = c.var.workerOrgIds ?? (anonLocalOrgId ? [anonLocalOrgId] : null);
  const effectiveTokenOrgId = c.var.organizationId ?? anonLocalOrgId;
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
  if (isUserScopedWorker && effectiveWorkerUserId && worker_id) {
    const existing = (await sql`
      SELECT platform FROM device_workers
      WHERE user_id = ${effectiveWorkerUserId} AND worker_id = ${worker_id}
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
  // Device home org: the workspace the device's token was issued for (or, for a
  // re-anchored local device, the org it already lives in). The upsert COALESCEs
  // to the owner's personal org when null, and sets the home only on first
  // registration; moving an existing device is the Devices-page action.
  const registrationUserId = effectiveWorkerUserId;
  const registrationOrgId = effectiveTokenOrgId;

  let deviceWorkerId: string | null = null;
  if (registrationUserId) {
    try {
      const incomingCaps = authorizedCapabilities;

      // `xmax = 0` on the RETURNING row distinguishes a brand-new device
      // registration from a routine poll-update so we only emit the
      // `device:created` lifecycle event once per device.
      const upserted = (await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
        VALUES (
          ${registrationUserId}, ${worker_id}, ${platform}, ${app_version},
          ${sql.json(incomingCaps)}, ${label},
          COALESCE(
            ${registrationOrgId}::text,
            (SELECT id FROM organization WHERE (metadata::jsonb)->>'personal_org_for_user_id' = ${registrationUserId} LIMIT 1)
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
      await reconcileDeviceCapabilities(registrationUserId);
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
  //
  // Cross-org device pins: also let the device claim runs in any org where it
  // has a pinned watcher/connection AND its owner is still a member of that
  // org. The pin IS the owner's consent — `evaluateDeviceWorkerAccess` only
  // lets a device's owner attach it — so this keeps the device anchored to its
  // home + personal org while serving watchers it was explicitly attached to in
  // other orgs the owner belongs to. The membership join revokes access
  // automatically if the owner later leaves the org. Within-org claiming still
  // follows the pinned/capability rules below, so the device only ever runs the
  // resource it was actually pinned to.
  let claimableOrgIds = effectiveWorkerOrgIds;
  if (isUserScopedWorker && deviceWorkerId && effectiveWorkerUserId) {
    try {
      claimableOrgIds = await resolveDeviceClaimableOrgs(sql, {
        deviceWorkerId,
        ownerUserId: effectiveWorkerUserId,
        baseOrgIds: effectiveWorkerOrgIds ?? [],
      });
    } catch (err) {
      // Non-fatal: fall back to the base [bound, personal] scope.
      logger.warn(
        { worker_id, err: errorMessage(err) },
        '[pollWorkerJob] cross-org pinned-scope lookup failed'
      );
    }
  }
  // Org scope applies to every device (user-scoped) worker — including a
  // re-anchored local device, whose org is claimableOrgIds. A signed-in
  // worker with no org in scope can claim nothing; a re-anchored device with no
  // org falls through to the empty-array gate (claims only by capability).
  if (c.var.workerAuthMode === 'user' && (!claimableOrgIds || claimableOrgIds.length === 0)) {
    // No org in scope — nothing this worker can ever claim.
    return c.json({ next_poll_seconds: 30 });
  }
  const orgScopeActive = isUserScopedWorker;
  // Always pass a non-empty array to ANY() to keep the SQL valid; the gate
  // below only activates when orgScopeActive is true.
  //
  // Two scopes: `orgScopeIds` (widened with cross-org pins) gates the
  // explicitly-PINNED claim branches — the pin is the owner's consent.
  // `baseOrgScopeIds` (token's bound + personal org only) gates the UNPINNED
  // capability-matched branch, so a single pin in org B does NOT also let the
  // device claim unrelated unpinned device-connector runs in org B.
  const orgScopeIds = orgScopeActive && claimableOrgIds ? claimableOrgIds : [''];
  const baseOrgScopeIds =
    orgScopeActive && effectiveWorkerOrgIds && effectiveWorkerOrgIds.length > 0
      ? effectiveWorkerOrgIds
      : [''];

  const claimNextPendingRun = async () =>
    sql.begin(async (tx) => {
      const claimed = await tx`
      WITH next_run AS (
        SELECT r.id
        FROM runs r
        LEFT JOIN connections con ON con.id = r.connection_id
        LEFT JOIN LATERAL (
          SELECT cd.required_capability
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
            (
              r.run_type IN ('sync', 'action', 'embed_backfill', 'auth')
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
                  AND r.organization_id = ANY(${pgTextArray(baseOrgScopeIds)}::text[])
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
        cd.runtime AS connector_runtime,
        ap.auth_data AS auth_profile_auth_data,
        w.name AS watcher_name,
        w.slug AS watcher_slug,
        w.agent_kind AS watcher_agent_kind,
        w.notification_channel AS watcher_notification_channel,
        w.notification_priority AS watcher_notification_priority,
        w.execution_config AS watcher_execution_config,
        wv.prompt AS watcher_prompt
      FROM runs r
      LEFT JOIN feeds f ON f.id = r.feed_id
      LEFT JOIN connections conn ON conn.id = r.connection_id
      LEFT JOIN connector_versions cv ON cv.connector_key = r.connector_key
        AND cv.version = r.connector_version
      LEFT JOIN connector_definitions cd ON cd.key = r.connector_key
        AND cd.organization_id = r.organization_id
        AND cd.status = 'active'
      LEFT JOIN auth_profiles ap ON ap.id = r.auth_profile_id
      LEFT JOIN watchers w ON w.id = r.watcher_id
      LEFT JOIN watcher_versions wv
        ON wv.id = COALESCE((r.approved_input->>'version_id')::bigint, w.current_version_id)
        AND wv.watcher_id = w.watcher_group_id
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
    connector_runtime: { nix?: { packages?: string[] } | null } | null;
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
    watcher_execution_config: Record<string, unknown> | null;
    watcher_prompt: string | null;
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
          execution_config: row.watcher_execution_config ?? null,
          // The prompt of the version this run was pinned to at creation
          // (run's snapshotted approved_input.version_id, else the watcher's
          // current_version_id) — same source complete_window validates
          // against, so a watcher edited after the run was queued doesn't swap
          // the prompt mid-flight. Device-local executors had no other channel
          // for the watcher's instructions (the payload shipped only
          // id/name/slug), so a scheduled watcher's local CLI got a bare
          // "process this" and improvised; shipping it lets the device run the
          // real prompt. Null only if the watcher has no version row.
          prompt: row.watcher_prompt ?? null,
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
            user_id: effectiveWorkerUserId ?? null,
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

  // Native (nixpkgs) packages the connector declared in `runtime.nix.packages`.
  // The worker provisions these on PATH via nix-shell before executing.
  const nixPackages = (row.connector_runtime?.nix?.packages ?? []).filter(
    (p): p is string => typeof p === 'string'
  );

  return c.json({
    run_id: row.run_id,
    run_type: row.run_type,
    connector_key: row.connector_key,
    connector_version: row.connector_version ?? undefined,
    nix_packages: nixPackages.length > 0 ? nixPackages : undefined,
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
