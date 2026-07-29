/**
 * Device-connector reconciliation.
 *
 * Extracted verbatim from `worker-api.ts`. On every user-scoped worker poll we
 * reconcile the user's device connectors against what their device fleet can
 * actually serve (capabilities advertised by devices seen recently). Wire /
 * re-activate connectors whose capability is served; pause the auto-wired feeds
 * of connectors whose capability has dropped out so `materializeDueFeeds` stops
 * creating runs nothing can claim.
 */

import { getDb, pgTextArray } from '../db/client';
import { findExistingPersonalOrg } from '../auth/personal-org-provisioning';
import {
  type BundledDeviceConnector,
  bundledConnectorSourcePath,
  compileConnectorFromFile,
  findBundledConnectorFile,
  getBundledDeviceConnectors,
} from '../utils/connector-catalog';
import { extractConnectorMetadata, type ConnectorMetadata } from '../utils/connector-compiler';
import { upsertConnectorDefinitionRecords } from '../utils/connector-definition-install';
import { ensureUniqueConnectionSlug } from '../utils/connections';
import { clearDevicePinTombstoneIfPinned } from '../utils/device-pin-tombstones';
import { errorMessage } from '../utils/errors';
import logger from '../utils/logger';
import { getDeviceManifestSourcesForUser, sortJson, type DeviceConnectorSource } from './device-manifests';

/** A device worker counts toward "serves capability X" only if seen this recently. */
const DEVICE_WORKER_FRESH_INTERVAL = '7 days';

/**
 * Install + wire a bundled device connector into the user's personal org:
 * connector definition (idempotent), a no-auth connection, the first feed, and
 * re-activate the feed if a previous "capability went away" pass had paused it.
 * Called by {@link reconcileDeviceCapabilities} for each device connector whose
 * `requiredCapability` is currently advertised by the user's fleet — which
 * connectors those are is read from the catalog, never hardcoded here.
 *
 * The per-(user, connector) advisory lock serializes concurrent polls / multiple
 * devices so they don't race past the existence checks and create duplicates.
 * Best-effort: failures are logged but never surface to the poll response.
 *
 * Device pin (`connections.device_worker_id`): when exactly one of the user's
 * fresh devices advertises the capability, the connection is auto-pinned to it
 * (a deterministic 1:1 binding the Devices page can show); when several qualify
 * it's left unpinned ("any of my fresh devices that advertise the capability").
 * A pin to a device that's still in the fresh set is treated as deliberate and
 * never overridden; a pin to a device that has dropped out is repaired (to the
 * sole remaining fresh device, or NULL) so the connection keeps running.
 */
async function ensureDeviceConnectorWired(
  userId: string,
  organizationId: string,
  connectorKey: string,
  declaredFeedKeys: string[],
  matchingDeviceIds: string[],
  source?: { metadata: ConnectorMetadata; sourcePath: string; manifestHash: string }
): Promise<void> {
  const sql = getDb();

  // Self-heal the device pin against the user's current fleet. Cheap, idempotent
  // (the WHERE matches nothing when the pin is already a valid fresh device), and
  // runs even on the fast path so a stale pin doesn't silently strand the feeds.
  const reconcilePin = async (db: typeof sql, connectionId: number) => {
    let target = matchingDeviceIds.length === 1 ? matchingDeviceIds[0] : null;
    // `idx_connections_org_connector_device_live` is UNIQUE on
    // (organization_id, connector_key, device_worker_id) for live rows, and an
    // org legitimately holds one connection PER DEVICE (same shape as
    // `idx_connections_org_connector_account_live` for OAuth accounts). So the
    // row we were handed is not necessarily the one that owns `target`: retiring
    // a Mac leaves its connection pinned to the stale device while the new Mac's
    // connection holds the only fresh one, and pinning the former to the latter's
    // device violates the index, aborts the whole wire transaction, and retries
    // forever (~8/min in prod for apple.computer_use).
    //
    // Never steal a pin another live connection holds — the same guard
    // `resolveOnlineChromeConnection` already carries for this index (see
    // `findOwnerOf` in dispatch-chrome-action.ts, where it used to 500 the
    // dispatcher). Fall back to NULL rather than skipping the UPDATE: NULL still
    // clears the dead pin (a connection pinned to a vanished device is claimable
    // by nobody, while an unpinned one is claimable by any polling device), so
    // the documented stale-pin repair survives.
    if (target) {
      const owner = (await db`
        SELECT id FROM connections
        WHERE organization_id = ${organizationId}
          AND connector_key = ${connectorKey}
          AND device_worker_id = ${target}::uuid
          AND deleted_at IS NULL
        LIMIT 1
      `) as unknown as Array<{ id: number }>;
      const ownerId = owner[0]?.id;
      if (ownerId != null && Number(ownerId) !== connectionId) {
        logger.warn(
          { userId, connectorKey, connectionId, ownerConnectionId: ownerId, deviceWorkerId: target },
          '[device-connectors] Device already pinned to another connection — unpinning instead'
        );
        target = null;
      }
    }
    // Compare via text on both sides — passing a `pgTextArray(...)` literal
    // through a `::uuid[]` cast trips a postgres "malformed array literal"
    // failure under the extended-protocol path postgres.js uses (the bound
    // text parameter never gets re-parsed as an array before the uuid[] cast
    // runs). `device_worker_id::text = ANY(text[])` sidesteps the cast
    // entirely; UUIDs are canonical lowercase so text equality matches the
    // uuid form 1:1.
    await db`
      UPDATE connections
      SET device_worker_id = ${target}::uuid, updated_at = NOW()
      WHERE id = ${connectionId}
        AND device_worker_id IS DISTINCT FROM ${target}::uuid
        AND (device_worker_id IS NULL OR NOT (device_worker_id::text = ANY(${pgTextArray(matchingDeviceIds)}::text[])))
    `;
    // Pin restore (or already-valid pin): drop DELETE/move tombstones so the
    // connection is not stuck as active + red "Device was removed".
    await clearDevicePinTombstoneIfPinned(db, {
      connectionId,
      matchingDeviceIds,
    });
  };
  const manifestStillAdvertised = async (db: typeof sql): Promise<boolean> => {
    if (!source) return true;
    const rows = await db`
      SELECT 1
      FROM device_workers
      WHERE user_id = ${userId}
        AND last_seen_at > now() - ${DEVICE_WORKER_FRESH_INTERVAL}::interval
        AND (connector_manifests -> ${connectorKey}) ->> 'manifest_hash' = ${source.manifestHash}
      LIMIT 1
    `;
    return rows.length > 0;
  };

  try {
    // Fast path: definition + version + connection + EVERY declared feed active
    // → nothing to repair or re-activate. The feed list comes from the bundled
    // catalog source, not the installed DB row, so adding a new bundled feed
    // still heals existing installs after deploy.
    const existingReady = (await sql`
      SELECT
        c.id AS connection_id,
        cv.connector_key AS version_key,
        cd.name AS def_name,
        cd.description AS def_description,
        cd.version AS def_version,
        cd.auth_schema AS def_auth_schema,
        cd.feeds_schema AS def_feeds_schema,
        cd.actions_schema AS def_actions_schema,
        cd.options_schema AS def_options_schema,
        cd.favicon_domain AS def_favicon_domain,
        cd.required_capability AS def_required_capability,
        cd.runtime AS def_runtime,
        -- jsonb_agg, not array_agg: postgres.js (fetch_types:false) returns a
        -- text[] result column as the literal string "{a,b}", which would make
        -- the fast-path feed check below silently always miss. jsonb arrays are
        -- parsed to JS arrays by the db client's value transform.
        COALESCE(
          jsonb_agg(f.feed_key) FILTER (WHERE f.id IS NOT NULL),
          '[]'::jsonb
        ) AS active_feed_keys
      FROM connector_definitions cd
      LEFT JOIN LATERAL (
        SELECT connector_key
        FROM connector_versions
        WHERE connector_key = cd.key AND version = cd.version
          AND (organization_id = cd.organization_id OR organization_id IS NULL)
        ORDER BY organization_id NULLS LAST
        LIMIT 1
      ) cv ON TRUE
      LEFT JOIN connections c
        ON c.organization_id = cd.organization_id
       AND c.connector_key = cd.key
       AND c.auth_profile_id IS NULL
       AND c.deleted_at IS NULL
      LEFT JOIN feeds f
        ON f.connection_id = c.id
       AND f.status = 'active'
       AND f.deleted_at IS NULL
      WHERE cd.organization_id = ${organizationId}
        AND cd.key = ${connectorKey}
        AND cd.status = 'active'
      GROUP BY c.id, cv.connector_key, cd.id
      LIMIT 1
    `) as unknown as Array<{
      connection_id: number | null;
      version_key: string | null;
      def_name: string | null;
      def_description: string | null;
      def_version: string | null;
      def_auth_schema: unknown;
      def_feeds_schema: unknown;
      def_actions_schema: unknown;
      def_options_schema: unknown;
      def_favicon_domain: string | null;
      def_required_capability: string | null;
      def_runtime: unknown;
      active_feed_keys: string[] | null;
    }>;
    // Device-manifest connectors carry their full metadata in-hand (`source`),
    // so a changed manifest MUST break the fast path or the org catalog is
    // stranded on the old definition forever: the extension re-sends its
    // manifest on every poll, but nothing else ever re-runs the definition
    // upsert once everything is wired (this exact staleness shipped
    // console_capture to device_workers while list_available kept serving the
    // old 12-action chrome catalog). Compare every field the definition upsert
    // writes, in the manifest hash's canonical form. Bundled connectors
    // (`source` undefined) are excluded on purpose — their metadata requires a
    // compile we can't afford per poll; deploys refresh them via other paths.
    const definitionMatchesSource = (row: (typeof existingReady)[0]): boolean => {
      if (!source) return true;
      const m = source.metadata;
      const canon = (v: unknown) => JSON.stringify(sortJson(v ?? null));
      return (
        row.def_name === m.name &&
        (row.def_description ?? null) === (m.description ?? null) &&
        row.def_version === m.version &&
        (row.def_favicon_domain ?? null) === (m.faviconDomain ?? null) &&
        (row.def_required_capability ?? null) === (m.requiredCapability ?? null) &&
        canon(row.def_auth_schema) === canon(m.authSchema) &&
        canon(row.def_feeds_schema) === canon(m.feeds) &&
        canon(row.def_actions_schema) === canon(m.actions) &&
        canon(row.def_options_schema) === canon(m.optionsSchema) &&
        canon(row.def_runtime) === canon(m.runtime)
      );
    };
    const activeFeedKeys = new Set(existingReady[0]?.active_feed_keys ?? []);
    const readyConnectionId = existingReady[0]?.connection_id;
    const ready =
      readyConnectionId != null &&
      existingReady[0]?.version_key != null &&
      definitionMatchesSource(existingReady[0]) &&
      // userManaged-only connectors (e.g. local.directory, browser/*) report
      // declaredFeedKeys=[]. Once the connection + definition are installed,
      // every subsequent poll has nothing to verify — fast-path out.
      // Composing primitives still hit /api/workers/me/feeds to mint
      // explicit per-instance rows; that path is unchanged.
      (declaredFeedKeys.length === 0 ||
        declaredFeedKeys.every((feedKey) => activeFeedKeys.has(feedKey)));
    if (ready) {
      if (source) {
        await sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtext('lobu:autowire'), hashtext(${`${userId}:${connectorKey}`}))`;
          if (await manifestStillAdvertised(tx)) {
            await reconcilePin(tx, readyConnectionId);
          }
        });
      } else {
        await reconcilePin(sql, readyConnectionId);
      }
      return;
    }

    let metadata: ConnectorMetadata;
    let sourcePath: string;
    let feedKeys = declaredFeedKeys;
    if (source) {
      metadata = source.metadata;
      sourcePath = source.sourcePath;
    } else {
      // Compile metadata outside the lock (pure CPU + a child process — slow).
      const filePath = findBundledConnectorFile(connectorKey);
      if (!filePath) {
        logger.warn({ connectorKey }, '[auto-wire] Bundled connector file not found');
        return;
      }
      const compiledCode = await compileConnectorFromFile(filePath);
      metadata = await extractConnectorMetadata(compiledCode);
      sourcePath = bundledConnectorSourcePath(filePath);
      if (!metadata.key || !metadata.name || !metadata.version) return;
      const feedsSchema = metadata.feeds as Record<
        string,
        { configSchema?: unknown; userManaged?: boolean }
      > | null;
      // Skip feeds the connector marks `userManaged` — they need per-instance
      // config (e.g. local.directory.files needs a folder_id per folder) that
      // auto-wire can't supply. The Mac app creates them explicitly via
      // /api/workers/me/feeds once it has the folder bookmark.
      feedKeys = feedsSchema
        ? Object.keys(feedsSchema).filter((k) => !feedsSchema[k]?.userManaged)
        : [];
    }

    let connectionId: number | undefined;
    await sql.begin(async (tx) => {
      // Serialize per (user, connector): two concurrent polls / two devices
      // both reach here, but only one holds the lock at a time, so the
      // existence-check-then-insert below is atomic.
      await tx`SELECT pg_advisory_xact_lock(hashtext('lobu:autowire'), hashtext(${`${userId}:${connectorKey}`}))`;
      // A newer poll may have removed this manifest while this reconcile was
      // waiting for the lock. Re-check the stored fleet inventory so an older
      // poll cannot resurrect a connector the newer poll just retired.
      if (source && !(await manifestStillAdvertised(tx))) return;

      // 2. Ensure the connector definition + version are installed (idempotent).
      await upsertConnectorDefinitionRecords({
        sql: tx,
        organizationId,
        metadata,
        versionRecord: {
          compiledCode: null,
          compiledCodeHash: null,
          compileConfigHash: null,
          sourceCode: null,
          sourcePath,
        },
        // A device-manifest connector's sourcePath is meaningful only to the
        // owning user's daemon → their org's row. A bundled device connector
        // points at the shared on-disk catalog → shared row.
        versionScope: source ? 'organization' : 'shared',
      });

      // 3. Reuse or create the connection (no-auth, active, private). Match on
      //    (org, connector, no auth_profile) — the device-connector identity —
      //    rather than created_by, so orphan rows (created_by IS NULL, or
      //    created by a different user/token) get adopted and self-healed
      //    instead of stranded behind a slug-collision insert.
      const existingConn = (await tx`
        SELECT id, created_by FROM connections
        WHERE organization_id = ${organizationId}
          AND connector_key = ${connectorKey}
          AND auth_profile_id IS NULL
          AND deleted_at IS NULL
        ORDER BY id ASC
        LIMIT 1
      `) as unknown as Array<{ id: number; created_by: string | null }>;
      connectionId = existingConn[0]?.id;
      if (connectionId && existingConn[0].created_by == null) {
        // Backfill ownership so future per-user queries (e.g. /api/me/devices)
        // attribute the connection to the user whose poll wired it.
        await tx`
          UPDATE connections
          SET created_by = ${userId}, updated_at = NOW()
          WHERE id = ${connectionId} AND created_by IS NULL
        `;
      }
      if (!connectionId) {
        // Stable slug for `lobu apply` diffing — same generation path as
        // manage_connections. No insert-retry here: this whole block runs
        // under a `pg_advisory_xact_lock` keyed on (userId, connectorKey) plus
        // the existence check above, so the slug can't be raced for this
        // (org, connector, user) tuple — and a unique violation would abort
        // the surrounding transaction, making a retry pointless anyway.
        const slug = await ensureUniqueConnectionSlug({
          organizationId,
          connectorKey,
          displayName: metadata.name,
          db: tx,
        });
        const inserted = (await tx`
          INSERT INTO connections (
            organization_id, connector_key, slug, display_name, status,
            auth_profile_id, app_auth_profile_id, config, created_by, visibility
          ) VALUES (
            ${organizationId}, ${connectorKey}, ${slug}, ${metadata.name}, 'active',
            NULL, NULL, NULL, ${userId}, 'private'
          )
          RETURNING id
        `) as unknown as Array<{ id: number }>;
        connectionId = inserted[0]?.id;
      }
      if (!connectionId) return;

      // 4. Ensure every feed the connector declares exists, is active, and is
      //    due at least once — multi-feed device connectors (e.g. apple.health
      //    has daily_summaries + workouts) need all of them wired, not just the
      //    first one. Also re-activates feeds a previous "capability went away"
      //    pass had paused.
      for (const feedKey of feedKeys) {
        const existingFeed = (await tx`
          SELECT id FROM feeds
          WHERE connection_id = ${connectionId}
            AND feed_key = ${feedKey}
            AND deleted_at IS NULL
          LIMIT 1
        `) as unknown as Array<{ id: number }>;

        if (existingFeed[0]?.id) {
          await tx`
            UPDATE feeds
            SET status = 'active',
                next_run_at = COALESCE(next_run_at, NOW()),
                updated_at = current_timestamp
            WHERE id = ${existingFeed[0].id}
          `;
        } else {
          await tx`
            INSERT INTO feeds (
              organization_id, connection_id, feed_key, display_name, status, config, next_run_at
            ) VALUES (
              ${organizationId}, ${connectionId}, ${feedKey},
              ${metadata.name}, 'active', NULL, NOW()
            )
          `;
        }
      }

      // Pin the (possibly just-created) connection to the sole fresh device
      // serving the capability, or leave it unpinned when several do.
      await reconcilePin(tx, connectionId);
    });

    if (connectionId) {
      logger.info(
        { userId, connectorKey, organizationId, connectionId },
        '[device-connectors] Wired device connector'
      );
    }
  } catch (err) {
    logger.error(
      { userId, connectorKey, err: errorMessage(err) },
      '[device-connectors] Failed to wire device connector'
    );
  }
}

/**
 * Pause the auto-wired feeds of `connectorKey` in the user's personal org —
 * called when no recently-seen device of the user still advertises the
 * connector's `requiredCapability`, so a `materializeDueFeeds` pass stops
 * creating runs nothing can claim. Limited to no-auth, user-owned connections
 * in the personal org (exactly what {@link ensureDeviceConnectorWired} creates);
 * that function re-activates them if the capability comes back. Best-effort.
 */
async function pauseStaleDeviceFeeds(userId: string, organizationId: string, connectorKey: string) {
  const sql = getDb();
  try {
    await sql`
      UPDATE feeds f
      SET status = 'paused', updated_at = current_timestamp
      FROM connections c
      WHERE f.connection_id = c.id
        AND c.organization_id = ${organizationId}
        AND c.connector_key = ${connectorKey}
        AND c.created_by = ${userId}
        AND c.auth_profile_id IS NULL
        AND c.deleted_at IS NULL
        AND f.status = 'active'
        AND f.deleted_at IS NULL
    `;
  } catch (err) {
    logger.warn(
      { userId, connectorKey, err: errorMessage(err) },
      '[device-connectors] Failed to pause stale device feeds'
    );
  }
}

/**
 * Archive unreferenced org-scoped definitions created by device reconciliation
 * that no current connector source still advertises. This includes manifest
 * versions and metadata-only shared pointers left by a formerly bundled device
 * connector, but excludes org-custom sources. A live connection always protects
 * its definition: connection fields do not record whether reconcile or a user
 * created the row, so deleting based on a guessed "auto-wire shape" would risk
 * deleting user configuration. The wire and archive paths share a per-key lock
 * and re-check stored manifests so concurrent polls converge. Best-effort.
 */
async function archiveVanishedDeviceConnectorDefinitions(
  userId: string,
  organizationId: string,
  liveKeys: string[]
): Promise<void> {
  const sql = getDb();
  try {
    const archived = await sql.begin(async (tx) => {
      const candidates = (await tx`
        SELECT cd.key
        FROM connector_definitions cd
        WHERE cd.organization_id = ${organizationId}
          AND cd.status = 'active'
          AND cd.required_capability IS NOT NULL
          AND NOT (cd.key = ANY(${pgTextArray(liveKeys)}::text[]))
          AND COALESCE((
            SELECT CASE
              WHEN cv.organization_id IS NOT NULL
                THEN cv.source_path LIKE 'device-manifest://%'
              ELSE cv.source_path IS NOT NULL
                AND cv.compiled_code IS NULL
                AND cv.source_code IS NULL
            END
            FROM connector_versions cv
            WHERE cv.connector_key = cd.key
              AND cv.version = cd.version
              AND (cv.organization_id = cd.organization_id OR cv.organization_id IS NULL)
            ORDER BY cv.organization_id NULLS LAST
            LIMIT 1
          ), false)
          AND NOT EXISTS (
            SELECT 1 FROM connections c
            WHERE c.organization_id = cd.organization_id
              AND c.connector_key = cd.key
              AND c.deleted_at IS NULL
          )
        ORDER BY cd.key
      `) as unknown as Array<{ key: string }>;
      for (const { key } of candidates) {
        await tx`SELECT pg_advisory_xact_lock(hashtext('lobu:autowire'), hashtext(${`${userId}:${key}`}))`;
      }
      if (candidates.length === 0) return [];
      const candidateKeys = candidates.map(({ key }) => key);

      const rows = (await tx`
        UPDATE connector_definitions cd
        SET status = 'archived', updated_at = NOW()
        WHERE cd.organization_id = ${organizationId}
          AND cd.status = 'active'
          AND cd.required_capability IS NOT NULL
          AND cd.key = ANY(${pgTextArray(candidateKeys)}::text[])
          AND COALESCE((
            SELECT CASE
              WHEN cv.organization_id IS NOT NULL
                THEN cv.source_path LIKE 'device-manifest://%'
              ELSE cv.source_path IS NOT NULL
                AND cv.compiled_code IS NULL
                AND cv.source_code IS NULL
            END
            FROM connector_versions cv
            WHERE cv.connector_key = cd.key
              AND cv.version = cd.version
              AND (cv.organization_id = cd.organization_id OR cv.organization_id IS NULL)
            ORDER BY cv.organization_id NULLS LAST
            LIMIT 1
          ), false)
          AND NOT EXISTS (
            SELECT 1
            FROM device_workers dw
            WHERE dw.user_id = ${userId}
              AND dw.last_seen_at > now() - ${DEVICE_WORKER_FRESH_INTERVAL}::interval
              AND dw.connector_manifests -> cd.key IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM connections c
            WHERE c.organization_id = cd.organization_id
              AND c.connector_key = cd.key
              AND c.deleted_at IS NULL
          )
        RETURNING cd.key
      `) as unknown as Array<{ key: string }>;
      return rows;
    });

    if (archived.length > 0) {
      logger.info(
        { userId, organizationId, keys: archived.map((r) => r.key) },
        '[device-connectors] Archived definitions no longer served by any connector source'
      );
    }
  } catch (err) {
    logger.warn(
      { userId, organizationId, err: errorMessage(err) },
      '[device-connectors] Failed to archive vanished device connector definitions'
    );
  }
}

/**
 * Reconcile a user's device connectors against what their device fleet can
 * actually serve. The set of device connectors comes from the catalog (any
 * bundled connector with a `runtime` block + a `requiredCapability`); the set of
 * served capabilities is the union over the user's devices seen within
 * `DEVICE_WORKER_FRESH_INTERVAL`. For each device connector: if its capability
 * is served, wire / re-activate it; otherwise pause its auto-wired feeds so
 * `materializeDueFeeds` stops creating runs nothing can claim.
 *
 * Best-effort; runs on every user-scoped poll. Nothing connector-specific is
 * hardcoded — adding a new device connector is just a new file in the catalog.
 */
export async function reconcileDeviceCapabilities(userId: string): Promise<void> {
  const sql = getDb();

  let bundledDeviceConnectors: BundledDeviceConnector[];
  // Both connector sources are fail-soft (empty on error), which makes "no
  // sources" ambiguous: nothing is served, or we failed to look. Only the
  // latter must suppress the archive pass below — an empty-but-successful read
  // is a legitimate "this fleet serves nothing", and is in fact the normal
  // state for a Chrome-only user (no bundled device connectors exist server
  // side; every one of them arrives as a device manifest).
  let sourcesReadable = true;
  try {
    bundledDeviceConnectors = await getBundledDeviceConnectors();
  } catch (err) {
    logger.warn(
      { userId, err: errorMessage(err) },
      '[device-connectors] Failed to read device connector catalog'
    );
    bundledDeviceConnectors = [];
    sourcesReadable = false;
  }

  // Device data ALWAYS lands in the user's personal org — device tokens are
  // force-bound there (see oauth/device/approve + mint-child-token), and a
  // team org reaches a device by pinning a watcher/connection to it
  // (resolveDeviceClaimableOrgs), not by re-binding the device. So auto-wire
  // targets the personal org regardless of where a legacy device_workers row
  // is still homed (older pairings may still carry a team org_id; they
  // converge here on the next poll).
  const personalOrg = await findExistingPersonalOrg(userId, sql);
  if (!personalOrg) {
    // No personal org → nothing to auto-wire. Don't touch team-org connectors
    // a user may have created manually; those survive on their own pins.
    return;
  }
  const personalOrgId = personalOrg.id;

  // deviceId → capabilities it advertises (fresh devices only). We no longer
  // partition by the device's stored org_id: under the personal-org
  // invariant every device serves the personal workspace, so the fleet's
  // combined capabilities decide what gets wired, irrespective of legacy
  // per-device home rows.
  const deviceCaps = new Map<string, Set<string>>();
  try {
    const rows = (await sql`
      SELECT id, capabilities
      FROM device_workers
      WHERE user_id = ${userId}
        AND last_seen_at > now() - ${DEVICE_WORKER_FRESH_INTERVAL}::interval
    `) as unknown as Array<{ id: string; capabilities: unknown }>;
    for (const r of rows) {
      const caps = Array.isArray(r.capabilities) ? (r.capabilities as string[]) : [];
      deviceCaps.set(r.id, new Set(caps));
    }
  } catch (err) {
    logger.warn(
      { userId, err: errorMessage(err) },
      '[device-connectors] Failed to read device capabilities'
    );
    return;
  }
  if (deviceCaps.size === 0) return;
  const devicesWithCapability = (capability: string): string[] =>
    [...deviceCaps.entries()].
      filter(([, caps]) => caps.has(capability))
      .map(([id]) => id);

  let manifestSources: DeviceConnectorSource[] = [];
  try {
    manifestSources = await getDeviceManifestSourcesForUser({
      sql,
      userId,
      liveCapabilities: deviceCaps,
    });
  } catch (err) {
    logger.warn(
      { userId, err: errorMessage(err) },
      '[device-connectors] Failed to read device connector manifests'
    );
    sourcesReadable = false;
  }

  const byKey = new Map<
    string,
    | (BundledDeviceConnector & { source?: undefined })
    | (DeviceConnectorSource & { source: 'device-manifest' })
  >();
  for (const dc of bundledDeviceConnectors) byKey.set(dc.key, dc);
  for (const src of manifestSources) byKey.set(src.key, { ...src, source: 'device-manifest' });

  // Runs BEFORE the early return: a fleet that advertises nothing is precisely
  // the case where every device definition in the org has gone stale, so
  // bailing on an empty `byKey` would skip the one pass that can clean it up.
  // Gated on `sourcesReadable` rather than on `byKey.size` — a transient read
  // failure must never be read as "the fleet serves nothing" and archive a
  // user's whole working set.
  if (sourcesReadable) {
    await archiveVanishedDeviceConnectorDefinitions(userId, personalOrgId, [...byKey.keys()]);
  }
  if (byKey.size === 0) return;

  await Promise.allSettled(
    [...byKey.values()].map((dc) => {
      const matchingDeviceIds = devicesWithCapability(dc.requiredCapability);
      return matchingDeviceIds.length > 0
        ? ensureDeviceConnectorWired(
            userId,
            personalOrgId,
            dc.key,
            dc.feedKeys,
            matchingDeviceIds,
            'source' in dc && dc.source === 'device-manifest'
              ? { metadata: dc.metadata, sourcePath: dc.sourcePath, manifestHash: dc.manifestHash }
              : undefined
          )
        : pauseStaleDeviceFeeds(userId, personalOrgId, dc.key);
    })
  );
}
