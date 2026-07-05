import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSecureToken } from '../../auth/oauth/utils';
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

function loadOwlettoManifests(kind: 'mac' | 'chrome'): Array<Record<string, unknown>> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir =
    kind === 'mac'
      ? resolve(here, '../../../../owletto/apps/mac/Owletto/ConnectorManifests')
      : resolve(here, '../../../../owletto/apps/chrome/connector-manifests');
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

    const res = await poll(workerId, [manifest()]);
    expect(res.status).toBe(200);
    const body = await res.json();

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

  it('drops a manifest whose key does not belong to the polling platform', async () => {
    const { orgId, workerId } = await seedDeviceOwner();

    const res = await poll(workerId, [manifest({ key: 'chrome.history' })]);
    expect(res.status).toBe(200);

    expect(await readDefinition(orgId, 'chrome.history')).toBeNull();
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

  it('accepts the actual Owletto Mac manifests and installs their connector definitions', async () => {
    const { orgId, workerId } = await seedDeviceOwner('macos');
    const manifests = loadOwlettoManifests('mac');

    const res = await poll(workerId, manifests, 'macos', capabilitiesFor(manifests));
    expect(res.status).toBe(200);

    expect(await readDefinition(orgId, 'apple.screen_time')).not.toBeNull();
    expect(await readDefinition(orgId, 'apple.computer_use')).not.toBeNull();
    expect(await readDefinition(orgId, 'local.directory')).not.toBeNull();
    expect(await readDefinition(orgId, 'chrome.history')).toBeNull();
  });

  it('accepts the actual Owletto Chrome manifests and installs their connector definitions', async () => {
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
