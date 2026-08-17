/**
 * reconcileDeviceCapabilities — auto-wired device connections must seed
 * `default_connection_config` exactly like manage_connections create/connect do.
 *
 * Auto-wire was the only connection creation path that skipped the merge, so a
 * device swap (old row tombstoned, new device polls in) minted a connection with
 * `config = NULL` and effective action modes silently fell back to raw descriptor
 * `requires_approval`. Prod 2026-08: org 8dc12bdd, chrome rows 369 (upload_file
 * auto, tombstoned) / 432 / 479 (new device, config NULL, requires approval).
 *
 * The same pass must (a) seed new rows from the org definition default, (b) heal
 * a surviving NULL-config row once a default exists, and (c) never clobber an
 * explicit per-connection config. No default → keep writing NULL, so the legacy
 * shape (and anything downstream that expects NULL) is untouched.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileDeviceCapabilities } from '../../worker-api/device-reconcile';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization, createTestUser } from '../setup/test-fixtures';

const sql = getTestDb();

const CONNECTOR = 'test.device_config_seed';
const CAPABILITY = 'test_device_config_seed';
const VERSION = '1.0.0';

const DEFAULT_CONFIG = { action_modes: { upload_file: 'auto' } };

async function seedDefinition(orgId: string, defaultConfig: Record<string, unknown> | null) {
  await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, version, status, required_capability,
      runtime, feeds_schema, auth_schema, actions_schema, options_schema,
      default_connection_config
    ) VALUES (
      ${orgId}, ${CONNECTOR}, 'Test Device Config Seed', ${VERSION}, 'active', ${CAPABILITY},
      ${sql.json({ kind: 'device' })}, ${sql.json({})}, ${sql.json({})},
      ${sql.json({})}, ${sql.json({})}, ${defaultConfig ? sql.json(defaultConfig) : null}
    )
  `;
  // device-manifest connectors install `connector_versions` through
  // upsertConnectorDefinitionRecords; the ready-gate version_key check needs
  // the match present, exactly as the pin-guard harness does.
  await sql`
    INSERT INTO connector_versions (organization_id, connector_key, version)
    VALUES (${orgId}, ${CONNECTOR}, ${VERSION})
    ON CONFLICT DO NOTHING
  `;
}

const MANIFEST = {
  key: CONNECTOR,
  version: VERSION,
  name: 'Test Device Config Seed',
  required_capability: CAPABILITY,
  runtime: { platforms: ['macos'] },
  feeds_schema: {},
};

async function seedWorker(userId: string, orgId: string): Promise<string> {
  const workerId = `mac-${Math.random().toString(36).slice(2, 10)}`;
  const manifests = {
    [CONNECTOR]: {
      manifest: MANIFEST,
      manifest_hash: `hash-${CONNECTOR}-${VERSION}`,
      received_at: new Date().toISOString(),
    },
  };
  const [row] = (await sql`
    INSERT INTO device_workers (
      user_id, worker_id, platform, capabilities, label, organization_id,
      last_seen_at, connector_manifests
    ) VALUES (
      ${userId}, ${workerId}, 'macos', ${sql.json([CAPABILITY])},
      'Mac mini', ${orgId}, NOW(), ${sql.json(manifests)}
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return String(row.id);
}

async function seedConn(
  orgId: string,
  userId: string,
  config: Record<string, unknown> | null | undefined
): Promise<number> {
  const slug = `conn-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = (await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      auth_profile_id, created_by, visibility, config
    ) VALUES (
      ${orgId}, ${CONNECTOR}, ${slug}, 'Test Device Config Seed', 'active',
      NULL, ${userId}, 'private', ${config === undefined ? null : config ? sql.json(config) : null}
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function configOf(id: number): Promise<Record<string, unknown> | null> {
  const [row] = (await sql`
    SELECT config FROM connections WHERE id = ${id}
  `) as unknown as Array<{ config: unknown }>;
  if (row == null || row.config == null) return null;
  return typeof row.config === 'string' ? JSON.parse(row.config) : (row.config as Record<string, unknown>);
}

async function setUpOrg(): Promise<{ orgId: string; userId: string }> {
  const user = await createTestUser();
  const org = await createTestOrganization();
  await sql`
    UPDATE "organization"
    SET metadata = ${JSON.stringify({ personal_org_for_user_id: user.id })}
    WHERE id = ${org.id}
  `;
  return { orgId: org.id, userId: user.id };
}

describe('device reconcile config seeding', () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    ({ orgId, userId } = await setUpOrg());
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('creates a connection whose config is seeded from the definition default', async () => {
    await seedDefinition(orgId, DEFAULT_CONFIG);
    await seedWorker(userId, orgId);

    await reconcileDeviceCapabilities(userId);

    const [row] = (await sql`
      SELECT id, config FROM connections
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR} AND deleted_at IS NULL
    `) as unknown as Array<{ id: number; config: unknown }>;
    expect(row).toBeDefined();
    expect(row.config).toEqual(DEFAULT_CONFIG);
  });

  it('seeds an existing NULL-config connection once the definition has a default', async () => {
    await seedDefinition(orgId, DEFAULT_CONFIG);
    await seedWorker(userId, orgId);
    const id = await seedConn(orgId, userId, null);

    await reconcileDeviceCapabilities(userId);

    expect(await configOf(id)).toEqual(DEFAULT_CONFIG);
  });

  it('never clobbers an explicit per-connection config', async () => {
    await seedDefinition(orgId, DEFAULT_CONFIG);
    await seedWorker(userId, orgId);
    const explicit = { action_modes: { upload_file: 'approval' } };
    const id = await seedConn(orgId, userId, explicit);

    await reconcileDeviceCapabilities(userId);

    expect(await configOf(id)).toEqual(explicit);
  });

  it('keeps config NULL when the definition has no default', async () => {
    await seedDefinition(orgId, null);
    await seedWorker(userId, orgId);

    await reconcileDeviceCapabilities(userId);

    const [row] = (await sql`
      SELECT config FROM connections
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR} AND deleted_at IS NULL
    `) as unknown as Array<{ config: unknown }>;
    expect(row).toBeDefined();
    expect(row.config).toBeNull();
  });
});