import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSecureToken } from '../../auth/oauth/utils';
import type { Env } from '../../index';
import { materializeDueFeeds } from '../../scheduled/check-due-feeds';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { post } from '../setup/test-helpers';

const CONNECTOR_KEY = 'apple.test_device_manifest';

async function seedDeviceOwner(platform = 'macos') {
  const sql = getTestDb();
  const userId = `user_${generateSecureToken(4)}`;
  const orgId = `org-device-manifest-${generateSecureToken(4)}`;
  const workerId = `wk-${generateSecureToken(6)}`;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, 'Device Manifest Owner', ${`${userId}@test.local`}, true, NOW(), NOW())
  `;
  await sql`
    INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
    VALUES (
      ${orgId}, 'Device Manifest Org', ${orgId}, 'private',
      ${sql.json({ personal_org_for_user_id: userId })}, NOW()
    )
  `;
  await sql`
    INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`mem_${generateSecureToken(4)}`}, ${orgId}, ${userId}, 'owner', NOW())
  `;
  await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
    VALUES (${userId}, ${workerId}, ${platform}, '0.1.0', ${sql.json([])}, 'Test Device', ${orgId})
  `;
  return { userId, orgId, workerId };
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    key: CONNECTOR_KEY,
    version: '0.1.0',
    name: 'Device Manifest Test',
    description: 'Metadata-only connector manifest registered by a device.',
    required_capability: 'screentime',
    runtime: { platforms: ['macos'] },
    auth_schema: { methods: [{ type: 'none' }] },
    feeds_schema: {
      snapshots: {
        key: 'snapshots',
        name: 'Snapshots',
        configSchema: { type: 'object', properties: {} },
        eventKinds: {
          snapshot: {
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id'],
              properties: {
                source: { type: 'string', const: 'device_manifest_test' },
                origin_id: { type: 'string' },
              },
            },
          },
        },
      },
    },
    ...overrides,
  };
}

async function readFeedStatus(orgId: string, key = CONNECTOR_KEY) {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT f.status
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE c.organization_id = ${orgId} AND c.connector_key = ${key}
    ORDER BY f.id ASC
    LIMIT 1
  `) as unknown as Array<{ status: string }>;
  return rows[0]?.status ?? null;
}

async function readDefinition(orgId: string, key = CONNECTOR_KEY) {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT key, name, required_capability, runtime, feeds_schema
    FROM connector_definitions
    WHERE organization_id = ${orgId} AND key = ${key}
    LIMIT 1
  `) as unknown as Array<{
    key: string;
    name: string;
    required_capability: string | null;
    runtime: unknown;
    feeds_schema: unknown;
  }>;
  return rows[0] ?? null;
}

async function poll(
  workerId: string,
  connectorManifests: unknown[],
  platform = 'macos',
  capabilities: Record<string, boolean> = { screentime: true },
) {
  return post('/api/workers/poll', {
    body: {
      worker_id: workerId,
      platform,
      app_version: '9.9.0',
      label: 'Test Device',
      capabilities,
      connector_manifests: connectorManifests,
    },
  });
}

/**
 * Poll and claim the just-installed connector's due feed run. When the poll
 * handler's materialize cooldown is hot (see the primer comment below), the
 * first poll installs the connector but claims nothing; running the
 * materializer directly and re-polling is the deterministic equivalent of
 * waiting out the 5s cooldown.
 */
async function pollClaimingDueFeed(workerId: string, connectorManifests: unknown[]) {
  const first = await poll(workerId, connectorManifests);
  expect(first.status).toBe(200);
  const firstBody = await first.json();
  if (firstBody.connector_key) {
    return firstBody;
  }

  await materializeDueFeeds({} as Env, getTestDb());
  const second = await poll(workerId, connectorManifests);
  expect(second.status).toBe(200);
  return second.json();
}

const OWLETTO_MANIFEST_DIRS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    mac: resolve(here, '../../../../owletto/apps/mac/Owletto/ConnectorManifests'),
    chrome: resolve(here, '../../../../owletto/apps/chrome/connector-manifests'),
  };
})();

/**
 * The owletto submodule is a private repo, so contributor sandboxes without
 * access to it cannot init it. Skip the manifest-parity tests there — but in
 * CI (which checks the submodule out) a missing dir must FAIL, not skip, or a
 * broken submodule checkout would silently drop manifest validation.
 */
function itWithOwlettoManifests(kind: keyof typeof OWLETTO_MANIFEST_DIRS) {
  if (existsSync(OWLETTO_MANIFEST_DIRS[kind])) return it;
  return process.env.CI ? it : it.skip;
}

function loadOwlettoManifests(kind: 'mac' | 'chrome'): Array<Record<string, unknown>> {
  const dir = OWLETTO_MANIFEST_DIRS[kind];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>);
}

function capabilitiesFor(manifests: Array<Record<string, unknown>>): Record<string, boolean> {
  return Object.fromEntries(
    manifests
      .map((manifest) => manifest.required_capability)
      .filter((cap): cap is string => typeof cap === 'string')
      .map((cap) => [cap, true]),
  );
}

describe('device connector manifests', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.LOBU_CLOUD_MODE;
    delete process.env.WORKER_API_TOKEN;
  });
  afterEach(async () => {
    await cleanupTestDatabase();
  });

  it('installs a metadata-only device connector from poll and claims its feed run without compiled_code', async () => {
    const { orgId, workerId } = await seedDeviceOwner();

    // Prime the poll handler's module-level due-feed-materialize cooldown
    // (worker-api/poll.ts). The integration suite runs singleFork +
    // isolate:false, so any poll in the previous ~5s — from this file or any
    // other — leaves the cooldown hot and the next poll skips materialization.
    // Making that state explicit turns a timing-dependent flake into a
    // deterministic scenario.
    const primer = await poll(workerId, []);
    expect(primer.status).toBe(200);

    const body = await pollClaimingDueFeed(workerId, [manifest()]);

    const def = await readDefinition(orgId);
    expect(def?.key).toBe(CONNECTOR_KEY);
    expect(def?.required_capability).toBe('screentime');

    expect(body.connector_key).toBe(CONNECTOR_KEY);
    expect(body.feed_key).toBe('snapshots');
    expect(body.compiled_code).toBeUndefined();

    const sql = getTestDb();
    const versionRows = (await sql`
      SELECT compiled_code, source_path FROM connector_versions
      WHERE connector_key = ${CONNECTOR_KEY} AND version = '0.1.0'
      LIMIT 1
    `) as unknown as Array<{ compiled_code: string | null; source_path: string | null }>;
    expect(versionRows[0]?.compiled_code).toBeNull();
    expect(versionRows[0]?.source_path).toBe(`device-manifest://macos/${CONNECTOR_KEY}@0.1.0`);
  });

  it('re-syncs connector_definitions when a later poll ships a changed manifest (new action)', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();

    const actionsV1 = {
      alpha: { key: 'alpha', name: 'Alpha', inputSchema: { type: 'object' } },
    };
    const first = await poll(workerId, [manifest({ actions_schema: actionsV1 })]);
    expect(first.status).toBe(200);

    const readActions = async () => {
      const rows = (await sql`
        SELECT actions_schema FROM connector_definitions
        WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
        LIMIT 1
      `) as unknown as Array<{ actions_schema: Record<string, unknown> | null }>;
      return Object.keys(rows[0]?.actions_schema ?? {}).sort();
    };
    expect(await readActions()).toEqual(['alpha']);

    // The extension updates: same key + version, actions_schema gains `beta`
    // (exactly what happened when console_capture shipped). The wired fast
    // path must not strand the org catalog on the old action set.
    const actionsV2 = {
      ...actionsV1,
      beta: { key: 'beta', name: 'Beta', inputSchema: { type: 'object' } },
    };
    const second = await poll(workerId, [manifest({ actions_schema: actionsV2 })]);
    expect(second.status).toBe(200);
    expect(await readActions()).toEqual(['alpha', 'beta']);

    // Stability: an UNCHANGED manifest must take the fast path again (the
    // definition upsert stamps updated_at, so a moving timestamp here would
    // mean every poll pays the advisory-lock slow path).
    const readUpdatedAt = async () => {
      const rows = (await sql`
        SELECT updated_at FROM connector_definitions
        WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
        LIMIT 1
      `) as unknown as Array<{ updated_at: string }>;
      return rows[0]?.updated_at;
    };
    const afterResync = await readUpdatedAt();
    const third = await poll(workerId, [manifest({ actions_schema: actionsV2 })]);
    expect(third.status).toBe(200);
    expect(await readUpdatedAt()).toEqual(afterResync);
  });

  it('archives a definition whose key the fleet no longer advertises', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();

    // Register the connector, then poll again WITHOUT it — the shape left
    // behind when a per-capability connector is folded into a broader one
    // (prod `chrome.tabs` / `browser.*` after the `chrome` v0.2 consolidation).
    // Reconcile used to only pause feeds, so the definition stayed `active`
    // forever and kept rendering on the connectors list as "Needs setup".
    expect((await poll(workerId, [manifest()])).status).toBe(200);
    expect(await readDefinition(orgId)).not.toBeNull();

    expect((await poll(workerId, [])).status).toBe(200);

    const rows = (await sql`
      SELECT status FROM connector_definitions
      WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
    `) as unknown as Array<{ status: string }>;
    expect(rows.map((r) => r.status)).toEqual(['archived']);

    // Idempotent: this pass runs on EVERY poll, so a re-archive that kept
    // stamping updated_at would churn the row forever.
    const stamp = async () => {
      const r = (await sql`
        SELECT updated_at FROM connector_definitions
        WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY} LIMIT 1
      `) as unknown as Array<{ updated_at: string }>;
      return r[0]?.updated_at;
    };
    const afterFirst = await stamp();
    expect((await poll(workerId, [])).status).toBe(200);
    expect(await stamp()).toEqual(afterFirst);
  });

  it('leaves a second device’s connectors alone when one device drops its manifests', async () => {
    const { userId, orgId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();

    // A second device on the SAME user, serving a different connector. Manifests
    // are stored per device and read back across the whole fleet, so a poll from
    // device A must never archive what device B still serves — the failure mode
    // that would quietly wipe a user's Mac connectors every time Chrome polled.
    const otherWorkerId = `wk-${generateSecureToken(6)}`;
    const otherKey = 'apple.test_other_device';
    await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
      VALUES (${userId}, ${otherWorkerId}, 'macos', '0.1.0', ${sql.json([])}, 'Other Device', ${orgId})
    `;
    expect((await poll(otherWorkerId, [manifest({ key: otherKey })])).status).toBe(200);
    expect((await poll(workerId, [manifest()])).status).toBe(200);

    // Device A drops its manifests; device B has not polled again.
    expect((await poll(workerId, [])).status).toBe(200);

    const statusOf = async (key: string) => {
      const rows = (await sql`
        SELECT status FROM connector_definitions
        WHERE organization_id = ${orgId} AND key = ${key}
      `) as unknown as Array<{ status: string }>;
      return rows.map((r) => r.status);
    };
    expect(await statusOf(CONNECTOR_KEY)).toEqual(['archived']);
    expect(await statusOf(otherKey)).toEqual(['active']);
  });

  it('keeps a definition active when a connection has unknown provenance', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();

    expect((await poll(workerId, [manifest()])).status).toBe(200);
    // `connections.created_by` is nullable. A bare `NOT (created_by = $1 AND …)`
    // is NULL for a NULL creator, which SQL reads as "no blocking row" — so the
    // archive would fire on a connection we cannot attribute to ourselves.
    // Unknown provenance must protect the definition, not permit its removal.
    await sql`
      UPDATE connections SET created_by = NULL
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR_KEY}
    `;

    expect((await poll(workerId, [])).status).toBe(200);

    const rows = (await sql`
      SELECT status FROM connector_definitions
      WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
    `) as unknown as Array<{ status: string }>;
    expect(rows.map((r) => r.status)).toEqual(['active']);
  });

  it('keeps a definition active when a user-configured connection references it', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const sql = getTestDb();

    expect((await poll(workerId, [manifest()])).status).toBe(200);
    // Someone OTHER than the polling device owner configured this connector, so
    // it is not reconcile's own auto-wired row. A poll that no longer sees the
    // manifest must leave it — retiring machinery we created is fine, deleting
    // a connector another human set up is not.
    const otherUserId = `user_${generateSecureToken(4)}`;
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${otherUserId}, 'Other Owner', ${`${otherUserId}@test.local`}, true, NOW(), NOW())
    `;
    await sql`
      UPDATE connections SET created_by = ${otherUserId}
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR_KEY}
    `;

    expect((await poll(workerId, [])).status).toBe(200);

    const rows = (await sql`
      SELECT status FROM connector_definitions
      WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
    `) as unknown as Array<{ status: string }>;
    expect(rows.map((r) => r.status)).toEqual(['active']);
  });

  it('drops a manifest whose key does not belong to the polling platform', async () => {
    const { orgId, workerId } = await seedDeviceOwner();

    const res = await poll(workerId, [manifest({ key: 'chrome.history' })]);
    expect(res.status).toBe(200);

    expect(await readDefinition(orgId, 'chrome.history')).toBeNull();
  });

  it('drops a manifest that still declares removed entityLinks rules', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const legacyManifest = manifest({
      feeds_schema: {
        snapshots: {
          key: 'snapshots',
          name: 'Snapshots',
          eventKinds: {
            snapshot: {
              entityLinks: [
                {
                  entityType: 'person',
                  identities: [{ namespace: 'email', eventPath: 'metadata.email' }],
                },
              ],
            },
          },
        },
      },
    });

    const res = await poll(workerId, [legacyManifest]);
    expect(res.status).toBe(200);

    expect(await readDefinition(orgId)).toBeNull();

    const sql = getTestDb();
    const rows = (await sql`
      SELECT connector_manifests
      FROM device_workers
      WHERE worker_id = ${workerId}
      LIMIT 1
    `) as unknown as Array<{ connector_manifests: Record<string, unknown> }>;
    expect(rows[0]?.connector_manifests).toEqual({});
  });

  it('keeps manifest inventory separate from live permission state so revoked capabilities pause feeds', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    const connectorManifest = manifest();

    const first = await poll(workerId, [connectorManifest], 'macos', { screentime: true });
    expect(first.status).toBe(200);
    expect(await readFeedStatus(orgId)).toBe('active');

    const second = await poll(workerId, [connectorManifest], 'macos', {});
    expect(second.status).toBe(200);
    expect(await readFeedStatus(orgId)).toBe('paused');
  });

  itWithOwlettoManifests('mac')('accepts the actual Owletto Mac manifests and installs their connector definitions', async () => {
    const { orgId, workerId } = await seedDeviceOwner('macos');
    const manifests = loadOwlettoManifests('mac');

    const res = await poll(workerId, manifests, 'macos', capabilitiesFor(manifests));
    expect(res.status).toBe(200);

    expect(await readDefinition(orgId, 'apple.screen_time')).not.toBeNull();
    expect(await readDefinition(orgId, 'apple.computer_use')).not.toBeNull();
    expect(await readDefinition(orgId, 'local.directory')).not.toBeNull();
    expect(await readDefinition(orgId, 'chrome.history')).toBeNull();

    const whatsapp = await readDefinition(orgId, 'whatsapp.local');
    const feedsSchema = whatsapp?.feeds_schema as
      | {
          messages?: {
            eventKinds?: {
              message?: { entityLinks?: unknown; attributions?: unknown };
            };
          };
        }
      | undefined;
    const messageKind = feedsSchema?.messages?.eventKinds?.message;
    expect(messageKind?.entityLinks).toBeUndefined();
    expect(messageKind?.attributions).toEqual([
      expect.objectContaining({
        role: 'authored_by',
        autoCreate: true,
        target: expect.objectContaining({ entityType: 'person' }),
      }),
    ]);
  });

  itWithOwlettoManifests('chrome')('accepts the actual Owletto Chrome manifests and installs their connector definitions', async () => {
    const { orgId, workerId } = await seedDeviceOwner('chrome-extension');
    const manifests = loadOwlettoManifests('chrome');

    const res = await poll(
      workerId,
      manifests,
      'chrome-extension',
      capabilitiesFor(manifests),
    );
    expect(res.status).toBe(200);

    expect(await readDefinition(orgId, 'chrome')).not.toBeNull();
    expect(await readDefinition(orgId, 'chrome.history')).not.toBeNull();
    expect(await readDefinition(orgId, 'chrome.bookmarks')).not.toBeNull();
    expect(await readDefinition(orgId, 'apple.screen_time')).toBeNull();
  });
});
