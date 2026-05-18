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

import { basename } from 'node:path';
import { getDb, pgTextArray } from '../db/client';
import {
  type BundledDeviceConnector,
  compileConnectorFromFile,
  findBundledConnectorFile,
  getBundledDeviceConnectors,
} from '../utils/connector-catalog';
import { extractConnectorMetadata } from '../utils/connector-compiler';
import { upsertConnectorDefinitionRecords } from '../utils/connector-definition-install';
import { ensureUniqueConnectionSlug } from '../utils/connections';
import { errorMessage } from '../utils/errors';
import logger from '../utils/logger';

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
  matchingDeviceIds: string[]
): Promise<void> {
  const sql = getDb();

  // Self-heal the device pin against the user's current fleet. Cheap, idempotent
  // (the WHERE matches nothing when the pin is already a valid fresh device), and
  // runs even on the fast path so a stale pin doesn't silently strand the feeds.
  const reconcilePin = async (db: typeof sql, connectionId: number) => {
    const target = matchingDeviceIds.length === 1 ? matchingDeviceIds[0] : null;
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
        -- jsonb_agg, not array_agg: postgres.js (fetch_types:false) returns a
        -- text[] result column as the literal string "{a,b}", which would make
        -- the fast-path feed check below silently always miss. jsonb arrays are
        -- parsed to JS arrays by the db client's value transform.
        COALESCE(
          jsonb_agg(f.feed_key) FILTER (WHERE f.id IS NOT NULL),
          '[]'::jsonb
        ) AS active_feed_keys
      FROM connector_definitions cd
      LEFT JOIN connector_versions cv
        ON cv.connector_key = cd.key AND cv.version = cd.version
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
      GROUP BY c.id, cv.connector_key
      LIMIT 1
    `) as unknown as Array<{
      connection_id: number | null;
      version_key: string | null;
      active_feed_keys: string[] | null;
    }>;
    if (existingReady[0]?.connection_id) {
      await reconcilePin(sql, existingReady[0].connection_id);
    }
    const activeFeedKeys = new Set(existingReady[0]?.active_feed_keys ?? []);
    if (
      existingReady[0]?.connection_id &&
      existingReady[0]?.version_key &&
      declaredFeedKeys.length > 0 &&
      declaredFeedKeys.every((feedKey) => activeFeedKeys.has(feedKey))
    ) {
      return;
    }

    // Compile metadata outside the lock (pure CPU + a child process — slow).
    const filePath = findBundledConnectorFile(connectorKey);
    if (!filePath) {
      logger.warn({ connectorKey }, '[auto-wire] Bundled connector file not found');
      return;
    }
    const compiledCode = await compileConnectorFromFile(filePath);
    const metadata = await extractConnectorMetadata(compiledCode);
    if (!metadata.key || !metadata.name || !metadata.version) return;
    const feedsSchema = metadata.feeds as Record<
      string,
      { configSchema?: unknown; userManaged?: boolean }
    > | null;
    // Skip feeds the connector marks `userManaged` — they need per-instance
    // config (e.g. local.directory.files needs a folder_id per folder) that
    // auto-wire can't supply. The Mac app creates them explicitly via
    // /api/workers/me/feeds once it has the folder bookmark.
    const feedKeys = feedsSchema
      ? Object.keys(feedsSchema).filter((k) => !feedsSchema[k]?.userManaged)
      : [];

    let connectionId: number | undefined;
    await sql.begin(async (tx) => {
      // Serialize per (user, connector): two concurrent polls / two devices
      // both reach here, but only one holds the lock at a time, so the
      // existence-check-then-insert below is atomic.
      await tx`SELECT pg_advisory_xact_lock(hashtext('lobu:autowire'), hashtext(${`${userId}:${connectorKey}`}))`;

      // 2. Ensure the connector definition + version are installed (idempotent).
      await upsertConnectorDefinitionRecords({
        sql: tx,
        organizationId,
        metadata,
        versionRecord: {
          compiledCode: null,
          compiledCodeHash: null,
          sourceCode: null,
          sourcePath: basename(filePath),
        },
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

  let deviceConnectors: BundledDeviceConnector[];
  try {
    deviceConnectors = await getBundledDeviceConnectors();
  } catch (err) {
    logger.warn(
      { userId, err: errorMessage(err) },
      '[device-connectors] Failed to read device connector catalog'
    );
    return;
  }
  if (deviceConnectors.length === 0) return;

  // deviceId → { capabilities it advertises, org it's attached to } (fresh
  // devices only). A device connector is wired into the device's org; a user
  // with devices in two orgs auto-wires the connector into each.
  const deviceCaps = new Map<string, { caps: Set<string>; orgId: string | null }>();
  try {
    const rows = (await sql`
      SELECT id, capabilities, organization_id
      FROM device_workers
      WHERE user_id = ${userId}
        AND last_seen_at > now() - ${DEVICE_WORKER_FRESH_INTERVAL}::interval
    `) as unknown as Array<{ id: string; capabilities: unknown; organization_id: string | null }>;
    for (const r of rows) {
      const caps = Array.isArray(r.capabilities) ? (r.capabilities as string[]) : [];
      deviceCaps.set(r.id, { caps: new Set(caps), orgId: r.organization_id });
    }
  } catch (err) {
    logger.warn(
      { userId, err: errorMessage(err) },
      '[device-connectors] Failed to read device capabilities'
    );
    return;
  }

  const orgsWithDevices = [
    ...new Set(
      [...deviceCaps.values()].map((d) => d.orgId).filter((o): o is string => Boolean(o))
    ),
  ];
  if (orgsWithDevices.length === 0) return;
  const devicesWithCapabilityInOrg = (capability: string, orgId: string): string[] =>
    [...deviceCaps.entries()]
      .filter(([, d]) => d.orgId === orgId && d.caps.has(capability))
      .map(([id]) => id);

  await Promise.allSettled(
    deviceConnectors.flatMap((dc) =>
      orgsWithDevices.map((orgId) => {
        const matchingDeviceIds = devicesWithCapabilityInOrg(dc.requiredCapability, orgId);
        return matchingDeviceIds.length > 0
          ? ensureDeviceConnectorWired(userId, orgId, dc.key, dc.feedKeys, matchingDeviceIds)
          : pauseStaleDeviceFeeds(userId, orgId, dc.key);
      })
    )
  );
}
