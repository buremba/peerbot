import { createHash } from 'node:crypto';
import { authorizeCapabilities, isKnownPlatform } from '@lobu/core';
import type { DbClient } from '../db/client';
import type { ConnectorMetadata } from '../utils/connector-compiler';
import logger from '../utils/logger';

const MAX_MANIFESTS_PER_POLL = 32;
const MAX_MANIFEST_BYTES = 256 * 1024;

export interface DeviceConnectorManifest {
  key: string;
  version: string;
  name: string;
  description?: string | null;
  favicon_domain?: string | null;
  required_capability: string;
  runtime: { platforms: string[]; scopes?: string[]; nix?: { packages?: string[] } | null };
  auth_schema?: Record<string, unknown> | null;
  feeds_schema?: Record<string, unknown> | null;
  actions_schema?: Record<string, unknown> | null;
  options_schema?: Record<string, unknown> | null;
  manifest_hash?: string | null;
}

export interface StoredDeviceManifest {
  manifest_hash: string;
  received_at: string;
  manifest: DeviceConnectorManifest;
}

export interface DeviceConnectorSource {
  key: string;
  requiredCapability: string;
  feedKeys: string[];
  metadata: ConnectorMetadata;
  sourcePath: string;
  manifestHash: string;
}

export function deviceManifestHash(manifest: DeviceConnectorManifest): string {
  const { manifest_hash: _ignored, ...payload } = manifest;
  for (const key of [
    'description',
    'favicon_domain',
    'auth_schema',
    'actions_schema',
    'options_schema',
  ] as const) {
    if (payload[key] == null) delete payload[key];
  }
  return createHash('sha256').update(JSON.stringify(sortJson(payload))).digest('hex');
}

export function deviceManifestToConnectorMetadata(manifest: DeviceConnectorManifest): ConnectorMetadata {
  return {
    key: manifest.key,
    name: manifest.name,
    description: manifest.description ?? undefined,
    version: manifest.version,
    kind: 'data',
    authSchema: manifest.auth_schema ?? { methods: [{ type: 'none' }] },
    webhook: null,
    feeds: manifest.feeds_schema ?? {},
    actions: manifest.actions_schema ?? null,
    optionsSchema: manifest.options_schema ?? null,
    faviconDomain: manifest.favicon_domain ?? null,
    mcpConfig: null,
    openapiConfig: null,
    requiredCapability: manifest.required_capability,
    runtime: manifest.runtime as ConnectorMetadata['runtime'],
  };
}

export function manifestFeedKeys(manifest: DeviceConnectorManifest): string[] {
  const feeds = manifest.feeds_schema ?? {};
  return Object.entries(feeds)
    .filter(([, def]) => !(isRecord(def) && def.userManaged === true))
    .map(([key]) => key);
}

export function validateDeviceConnectorManifests(params: {
  platform: string | null;
  capabilities: readonly string[];
  manifests: unknown;
}): StoredDeviceManifest[] {
  const { platform, manifests } = params;
  if (!Array.isArray(manifests)) return [];
  if (!platform || !isKnownPlatform(platform)) return [];
  if (manifests.length > MAX_MANIFESTS_PER_POLL) {
    logger.warn({ platform, count: manifests.length }, '[device-manifests] too many manifests; dropping payload');
    return [];
  }
  const encodedBytes = Buffer.byteLength(JSON.stringify(manifests), 'utf8');
  if (encodedBytes > MAX_MANIFEST_BYTES) {
    logger.warn({ platform, encodedBytes }, '[device-manifests] manifest payload too large; dropping payload');
    return [];
  }

  const seen = new Set<string>();
  const valid: StoredDeviceManifest[] = [];
  for (const raw of manifests) {
    try {
      const manifest = normalizeManifest(raw);
      if (seen.has(manifest.key)) continue;
      seen.add(manifest.key);

      if (!connectorKeyAllowedForPlatform(platform, manifest.key)) {
        throw new Error(`connector key '${manifest.key}' is not allowed for platform '${platform}'`);
      }
      if (!manifest.runtime.platforms.includes(platform)) {
        throw new Error(`runtime.platforms must include '${platform}'`);
      }
      const capAuth = authorizeCapabilities(platform, [manifest.required_capability]);
      if (!capAuth.authorized.includes(manifest.required_capability)) {
        throw new Error(`required_capability '${manifest.required_capability}' is not allowed for '${platform}'`);
      }
      if (manifest.auth_schema && !isNoneAuthSchema(manifest.auth_schema)) {
        throw new Error('device manifests may only declare auth_schema.methods=[{type:"none"}]');
      }
      const computedHash = deviceManifestHash(manifest);
      if (manifest.manifest_hash && manifest.manifest_hash !== computedHash) {
        throw new Error('manifest_hash mismatch');
      }
      manifest.manifest_hash = computedHash;
      valid.push({
        manifest_hash: computedHash,
        received_at: new Date().toISOString(),
        manifest,
      });
    } catch (err) {
      logger.warn(
        { platform, err: err instanceof Error ? err.message : String(err) },
        '[device-manifests] dropped invalid manifest'
      );
    }
  }
  return valid;
}

export async function getDeviceManifestSourcesForUser(params: {
  sql: DbClient;
  userId: string;
  liveCapabilities: Map<string, Set<string>>;
}): Promise<DeviceConnectorSource[]> {
  const rows = (await params.sql`
    SELECT id, connector_manifests
    FROM device_workers
    WHERE user_id = ${params.userId}
      AND last_seen_at > now() - '7 days'::interval
  `) as unknown as Array<{ id: string; connector_manifests: unknown }>;

  const winners = new Map<string, { stored: StoredDeviceManifest; deviceId: string }>();
  for (const row of rows) {
    const map = isRecord(row.connector_manifests) ? row.connector_manifests : {};
    for (const value of Object.values(map)) {
      const stored = parseStoredManifest(value);
      if (!stored) continue;
      const existing = winners.get(stored.manifest.key);
      if (!existing || compareManifestWinner(stored, existing.stored) > 0) {
        winners.set(stored.manifest.key, { stored, deviceId: row.id });
      }
    }
  }

  return [...winners.values()].map(({ stored }) => ({
    key: stored.manifest.key,
    requiredCapability: stored.manifest.required_capability,
    feedKeys: manifestFeedKeys(stored.manifest),
    metadata: deviceManifestToConnectorMetadata(stored.manifest),
    sourcePath: `device-manifest://${stored.manifest.runtime.platforms[0]}/${stored.manifest.key}@${stored.manifest.version}`,
    manifestHash: stored.manifest_hash,
  }));
}

export function storedManifestMap(valid: StoredDeviceManifest[]): Record<string, StoredDeviceManifest> {
  return Object.fromEntries(valid.map((entry) => [entry.manifest.key, entry]));
}

function normalizeManifest(raw: unknown): DeviceConnectorManifest {
  if (!isRecord(raw)) throw new Error('manifest must be an object');
  const key = stringField(raw, 'key');
  const version = stringField(raw, 'version');
  const name = stringField(raw, 'name');
  const requiredCapability = stringField(raw, 'required_capability');
  const runtime = raw.runtime;
  if (!isRecord(runtime) || !Array.isArray(runtime.platforms)) {
    throw new Error('runtime.platforms is required');
  }
  const platforms = runtime.platforms.filter((v): v is string => typeof v === 'string');
  if (platforms.length === 0) throw new Error('runtime.platforms cannot be empty');
  return {
    key,
    version,
    name,
    description: optionalStringField(raw, 'description'),
    favicon_domain: optionalStringField(raw, 'favicon_domain'),
    required_capability: requiredCapability,
    runtime: {
      ...runtime,
      platforms,
    } as DeviceConnectorManifest['runtime'],
    auth_schema: optionalRecord(raw, 'auth_schema'),
    feeds_schema: optionalRecord(raw, 'feeds_schema') ?? {},
    actions_schema: optionalRecord(raw, 'actions_schema'),
    options_schema: optionalRecord(raw, 'options_schema'),
    manifest_hash: optionalStringField(raw, 'manifest_hash'),
  };
}

function parseStoredManifest(raw: unknown): StoredDeviceManifest | null {
  if (!isRecord(raw) || !isRecord(raw.manifest)) return null;
  if (typeof raw.manifest_hash !== 'string' || typeof raw.received_at !== 'string') return null;
  try {
    const manifest = normalizeManifest(raw.manifest);
    manifest.manifest_hash = raw.manifest_hash;
    return { manifest_hash: raw.manifest_hash, received_at: raw.received_at, manifest };
  } catch {
    return null;
  }
}

function compareManifestWinner(a: StoredDeviceManifest, b: StoredDeviceManifest): number {
  const versionCmp = compareSemverish(a.manifest.version, b.manifest.version);
  if (versionCmp !== 0) return versionCmp;
  return a.manifest_hash.localeCompare(b.manifest_hash);
}

function compareSemverish(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => Number.parseInt(p, 10));
  const pb = b.split(/[.-]/).map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = Number.isFinite(pa[i]) ? pa[i]! : 0;
    const db = Number.isFinite(pb[i]) ? pb[i]! : 0;
    if (da !== db) return da - db;
  }
  return a.localeCompare(b);
}

function connectorKeyAllowedForPlatform(platform: string, key: string): boolean {
  if (platform === 'macos') {
    return key.startsWith('apple.') || key === 'local.directory' || key === 'whatsapp.local';
  }
  if (platform === 'chrome-extension') {
    return key === 'chrome' || key.startsWith('chrome.');
  }
  return false;
}

function isNoneAuthSchema(value: Record<string, unknown>): boolean {
  const methods = value.methods;
  return Array.isArray(methods) && methods.every((m) => isRecord(m) && m.type === 'none');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortJson(v)])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const v = value[key];
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${key} is required`);
  return v.trim();
}

function optionalStringField(value: Record<string, unknown>, key: string): string | null {
  const v = value[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function optionalRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const v = value[key];
  return isRecord(v) ? v : null;
}
