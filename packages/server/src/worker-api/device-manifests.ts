import { authorizeCapabilities, isKnownPlatform } from '@lobu/core';
import {
  deviceManifestHash,
  sortDeviceManifestJson,
  type DeviceConnectorManifest,
} from '@lobu/connector-sdk';
import type { DbClient } from '../db/client';
import type { ConnectorMetadata } from '../utils/connector-compiler';
import {
  isChromeNamespaceConnectorKey,
  isLegacyNativeChromeExtensionConnectorKey,
} from '../utils/connector-execution-placement';
import logger from '../utils/logger';

const MAX_MANIFESTS_PER_POLL = 32;
const MAX_MANIFEST_BYTES = 256 * 1024;

export type { DeviceConnectorManifest } from '@lobu/connector-sdk';
export { deviceManifestHash };

export interface StoredDeviceManifest {
  manifest_hash: string;
  received_at: string;
  manifest: DeviceConnectorManifest;
}

export interface DeviceConnectorSource {
  key: string;
  requiredCapability: string;
  /** Fresh, capable devices advertising the exact manifest selected for this key. */
  advertiserDeviceIds: string[];
  feedKeys: string[];
  metadata: ConnectorMetadata;
  sourcePath: string;
  manifestHash: string;
  definitionManifestHash: string;
}

export interface ManifestClaimAuthorization {
  connectorKey: string;
  connectorVersion: string;
  manifestHash: string;
  /** Hash of the canonical definition projected from this artifact. */
  definitionManifestHash?: string;
  /** Exact artifact provenance; present for manifest-backed claims. */
  sourcePath?: string;
  /** Canonical runtime marker from the validated manifest. */
  runtimeExecution?: DeviceConnectorManifest['runtime']['execution'];
}

export interface DeviceManifestClaimAuthorization extends ManifestClaimAuthorization {
  /** The platform recorded on the device that actually advertised this manifest. */
  sourcePath: string;
}

interface DeviceManifestValidationResult {
  manifests: StoredDeviceManifest[];
  accepted: boolean;
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
    feeds: manifestFeedsForMetadata(manifest),
    actions: manifest.actions_schema ?? null,
    automationEvents: null,
    optionsSchema: manifest.options_schema ?? null,
    faviconDomain: manifest.favicon_domain ?? null,
    mcpConfig: null,
    openapiConfig: null,
    requiredCapability: manifest.required_capability,
    runtime: manifest.runtime as ConnectorMetadata['runtime'],
    // Device connectors execute on the paired device. A manifest that declares
    // actions is asserting it implements them there, so support tracks the
    // presence of an actions schema (#2033 item 2). Device-online is a separate
    // readiness axis handled elsewhere.
    supportsExecute: manifest.actions_schema != null,
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
}): DeviceManifestValidationResult {
  return validateDeviceConnectorManifestsInternal(params, false);
}

function validateDeviceConnectorManifestsInternal(
  params: {
    platform: string | null;
    capabilities: readonly string[];
    manifests: unknown;
  },
  allowLegacyMissingOperations: boolean
): DeviceManifestValidationResult {
  const { platform, manifests } = params;
  if (!Array.isArray(manifests)) return { manifests: [], accepted: false };
  if (!platform || !isKnownPlatform(platform)) return { manifests: [], accepted: false };
  if (manifests.length > MAX_MANIFESTS_PER_POLL) {
    logger.warn({ platform, count: manifests.length }, '[device-manifests] too many manifests; dropping payload');
    return { manifests: [], accepted: false };
  }
  const encodedBytes = Buffer.byteLength(JSON.stringify(manifests), 'utf8');
  if (encodedBytes > MAX_MANIFEST_BYTES) {
    logger.warn({ platform, encodedBytes }, '[device-manifests] manifest payload too large; dropping payload');
    return { manifests: [], accepted: false };
  }

  const seen = new Set<string>();
  const valid: StoredDeviceManifest[] = [];
  let accepted = true;
  for (const raw of manifests) {
    try {
      const manifest = normalizeManifest(raw, allowLegacyMissingOperations);
      if (seen.has(manifest.key)) continue;
      seen.add(manifest.key);

      if (!connectorKeyAllowedForPlatform(platform, manifest.key)) {
        throw new Error(`connector key '${manifest.key}' is not allowed for platform '${platform}'`);
      }
      if (
        platform === 'chrome-extension' &&
        isLegacyNativeChromeExtensionConnectorKey(manifest.key) &&
        manifest.required_capability !== 'browser.scripting'
      ) {
        throw new Error(
          `chrome-extension connector '${manifest.key}' requires required_capability 'browser.scripting'`
        );
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
      accepted = false;
      logger.warn(
        { platform, err: err instanceof Error ? err.message : String(err) },
        '[device-manifests] dropped invalid manifest'
      );
    }
  }
  return { manifests: valid, accepted };
}

export async function getDeviceManifestSourcesForUser(params: {
  sql: DbClient;
  userId: string;
  connectorKey?: string;
}): Promise<DeviceConnectorSource[]> {
  const rows = (await params.sql`
    SELECT id, platform, capabilities, connector_manifests
    FROM device_workers
    WHERE user_id = ${params.userId}
      AND last_seen_at > now() - '7 days'::interval
      AND (
        ${params.connectorKey == null}
        OR connector_manifests ? ${params.connectorKey ?? ''}
      )
  `) as unknown as Array<{
    id: string;
    platform: string | null;
    capabilities: unknown;
    connector_manifests: unknown;
  }>;

  type ManifestCandidate = {
    stored: StoredDeviceManifest;
    deviceId: string;
    platform: string | null;
  };
  const candidates: ManifestCandidate[] = [];
  const liveCapabilities = new Map<string, Set<string>>();
  const winners = new Map<string, StoredDeviceManifest>();
  for (const row of rows) {
    liveCapabilities.set(
      row.id,
      new Set(Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [])
    );
    const map = isRecord(row.connector_manifests) ? row.connector_manifests : {};
    for (const value of Object.values(map)) {
      const stored = parseStoredManifest(value);
      if (!stored) continue;
      candidates.push({ stored, deviceId: row.id, platform: row.platform });
      const existing = winners.get(stored.manifest.key);
      if (!existing || compareManifestWinner(stored, existing) > 0) {
        winners.set(stored.manifest.key, stored);
      }
    }
  }

  return [...winners.values()].flatMap((stored) => {
    const exactCandidates = candidates.filter(
      (candidate) =>
        candidate.stored.manifest.key === stored.manifest.key &&
        candidate.stored.manifest.version === stored.manifest.version &&
        candidate.stored.manifest_hash === stored.manifest_hash
    );
    const advertiserCandidates = exactCandidates.filter(
      (candidate) =>
        liveCapabilities.get(candidate.deviceId)?.has(stored.manifest.required_capability) === true
    );
    // Provenance must describe the platform that actually validated and
    // advertised this manifest. `runtime.platforms` is a compatibility set, not
    // an ordered ownership declaration; using element zero can misroute a valid
    // Chrome manifest whose Chrome entry appears later in the array. Prefer a
    // currently capable advertiser, then fall back to an exact stored advertiser
    // so inventory remains stable while a permission is temporarily revoked.
    const sourceCandidate = (
      advertiserCandidates.length > 0 ? advertiserCandidates : exactCandidates
    )
      .filter(
        (candidate): candidate is ManifestCandidate & { platform: string } =>
          typeof candidate.platform === 'string' &&
          stored.manifest.runtime.platforms.includes(candidate.platform)
      )
      .sort(
        (a, b) => a.platform.localeCompare(b.platform) || a.deviceId.localeCompare(b.deviceId)
      )[0];
    if (!sourceCandidate) {
      logger.warn(
        { connectorKey: stored.manifest.key, connectorVersion: stored.manifest.version },
        '[device-manifests] exact manifest has no valid advertising platform'
      );
      return [];
    }

    return [
      {
        key: stored.manifest.key,
        requiredCapability: stored.manifest.required_capability,
        advertiserDeviceIds: advertiserCandidates
          .map((candidate) => candidate.deviceId)
          .sort(),
        feedKeys: manifestFeedKeys(stored.manifest),
        metadata: deviceManifestToConnectorMetadata(stored.manifest),
        sourcePath: `device-manifest://${sourceCandidate.platform}/${stored.manifest.key}@${stored.manifest.version}`,
        manifestHash: stored.manifest_hash,
        definitionManifestHash: projectedDefinitionManifestHash(stored.manifest),
      },
    ];
  });
}

/**
 * Return every validated manifest identity advertised by one exact device.
 * This deliberately does not apply winner selection: a device may retain a
 * historical version while another device advertises the current winner.
 */
export async function getDeviceManifestClaimAuthorizationsForDevice(params: {
  sql: DbClient;
  userId: string;
  deviceId: string;
}): Promise<DeviceManifestClaimAuthorization[]> {
  const rows = (await params.sql`
    SELECT platform, capabilities, connector_manifests
    FROM device_workers
    WHERE id = ${params.deviceId}::uuid
      AND user_id = ${params.userId}
      AND last_seen_at > now() - '7 days'::interval
    LIMIT 1
  `) as unknown as Array<{
    platform: string | null;
    capabilities: unknown;
    connector_manifests: unknown;
  }>;
  const row = rows[0];
  if (!row || !row.platform || !isKnownPlatform(row.platform)) return [];

  const capabilities = Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [];
  const map = isRecord(row.connector_manifests) ? row.connector_manifests : {};
  const authorizations = new Map<string, DeviceManifestClaimAuthorization>();
  for (const value of Object.values(map)) {
    const stored = parseStoredManifest(value);
    if (!stored || !capabilities.includes(stored.manifest.required_capability)) continue;

    // Revalidate the persisted payload before using it as claim authority. The
    // row may predate manifest hashes, and connector_manifests is durable input
    // rather than an authorization primitive by itself.
    const validation = validateDeviceConnectorManifestsInternal(
      {
        platform: row.platform,
        capabilities,
        manifests: [stored.manifest],
      },
      true
    );
    const validated = validation.manifests[0];
    if (!validation.accepted || !validated || validated.manifest_hash !== stored.manifest_hash) {
      continue;
    }

    const authorization: DeviceManifestClaimAuthorization = {
      connectorKey: validated.manifest.key,
      connectorVersion: validated.manifest.version,
      manifestHash: validated.manifest_hash,
      definitionManifestHash: projectedDefinitionManifestHash(validated.manifest),
      sourcePath: `device-manifest://${row.platform}/${validated.manifest.key}@${validated.manifest.version}`,
      runtimeExecution: validated.manifest.runtime.execution,
    };
    authorizations.set(
      `${authorization.connectorKey}\u0000${authorization.connectorVersion}\u0000${authorization.manifestHash}`,
      authorization
    );
  }
  return [...authorizations.values()];
}

/**
 * Lazily attest pre-hash manifest artifacts only from a validated manifest
 * currently advertised by the authorized device. Shared hashless artifacts
 * are intentionally not mutated: an org-scoped exact row must exist before a
 * retained artifact can become claimable.
 */
export async function attestDeviceManifestArtifacts(params: {
  sql: DbClient;
  organizationId: string;
  authorizations: DeviceManifestClaimAuthorization[];
}): Promise<void> {
  for (const authorization of params.authorizations) {
    await params.sql`
      UPDATE connector_versions
      SET compiled_code_hash = ${authorization.manifestHash}
      WHERE organization_id = ${params.organizationId}
        AND connector_key = ${authorization.connectorKey}
        AND version = ${authorization.connectorVersion}
        AND compiled_code_hash IS NULL
        AND compiled_code IS NULL
        AND compile_config_hash IS NULL
        AND source_code IS NULL
        AND source_path = ${authorization.sourcePath}
    `;
  }
}

export function storedManifestMap(valid: StoredDeviceManifest[]): Record<string, StoredDeviceManifest> {
  return Object.fromEntries(valid.map((entry) => [entry.manifest.key, entry]));
}

function normalizeManifest(raw: unknown, allowLegacyMissingOperations = false): DeviceConnectorManifest {
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
  const feedsSchema = optionalRecord(raw, 'feeds_schema') ?? {};
  validateFeedOperations(feedsSchema, allowLegacyMissingOperations);
  rejectRemovedEntityLinks(feedsSchema);
  const actionsSchema = optionalRecord(raw, 'actions_schema');
  rejectReservedActionKeys(actionsSchema);
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
    feeds_schema: feedsSchema,
    actions_schema: actionsSchema,
    options_schema: optionalRecord(raw, 'options_schema'),
    manifest_hash: optionalStringField(raw, 'manifest_hash'),
  };
}

function validateFeedOperations(
  feedsSchema: Record<string, unknown>,
  allowLegacyMissingOperations: boolean
): void {
  for (const [feedKey, feedDefinition] of Object.entries(feedsSchema)) {
    if (!isRecord(feedDefinition)) throw new Error(`feeds_schema.${feedKey} must be an object`);
    const operations = feedDefinition.operations;
    // Manifests persisted before feed operations became required described
    // sync-only feeds. Keep their original JSON shape so its artifact hash
    // remains valid; new poll payloads still use the strict public validator.
    if (operations === undefined && allowLegacyMissingOperations) continue;
    if (
      !Array.isArray(operations) ||
      operations.length === 0 ||
      !operations.every((operation) => operation === 'sync' || operation === 'read') ||
      new Set(operations).size !== operations.length
    ) {
      throw new Error(`feeds_schema.${feedKey}.operations must contain unique sync/read values`);
    }
  }
}

/**
 * Namespace the gateway reserves for its own device-protocol action keys (e.g.
 * a source read). A manifest may not claim one: the server
 * dispatches these keys itself, so a connector declaring the same string would
 * shadow a protocol seam with a public operation.
 */
export const RESERVED_ACTION_KEY_PREFIX = '__lobu_';

function rejectReservedActionKeys(actionsSchema: Record<string, unknown> | null): void {
  if (!actionsSchema) return;
  for (const actionKey of Object.keys(actionsSchema)) {
    if (actionKey.startsWith(RESERVED_ACTION_KEY_PREFIX)) {
      throw new Error(
        `actions_schema key '${actionKey}' uses the reserved '${RESERVED_ACTION_KEY_PREFIX}' prefix`
      );
    }
  }
}

function rejectRemovedEntityLinks(feedsSchema: Record<string, unknown>): void {
  for (const [feedKey, feedDefinition] of Object.entries(feedsSchema)) {
    if (!isRecord(feedDefinition) || !isRecord(feedDefinition.eventKinds)) continue;
    for (const [eventKind, eventDefinition] of Object.entries(feedDefinition.eventKinds)) {
      if (isRecord(eventDefinition) && Object.hasOwn(eventDefinition, 'entityLinks')) {
        throw new Error(
          `feeds_schema.${feedKey}.eventKinds.${eventKind}.entityLinks was removed; use attributions`
        );
      }
    }
  }
}

function parseStoredManifest(raw: unknown): StoredDeviceManifest | null {
  if (!isRecord(raw) || !isRecord(raw.manifest)) return null;
  if (typeof raw.manifest_hash !== 'string' || typeof raw.received_at !== 'string') return null;
  try {
    const manifest = normalizeManifest(raw.manifest, true);
    if (deviceManifestHash(manifest) !== raw.manifest_hash) return null;
    manifest.manifest_hash = raw.manifest_hash;
    return { manifest_hash: raw.manifest_hash, received_at: raw.received_at, manifest };
  } catch {
    return null;
  }
}

function manifestFeedsForMetadata(manifest: DeviceConnectorManifest): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(manifest.feeds_schema ?? {}).map(([feedKey, feedDefinition]) => {
      if (isRecord(feedDefinition) && feedDefinition.operations === undefined) {
        return [
          feedKey,
          {
            ...feedDefinition,
            operations: feedDefinition.virtual === true ? ['read'] : ['sync'],
          },
        ];
      }
      return [feedKey, feedDefinition];
    })
  );
}

function projectedDefinitionManifestHash(manifest: DeviceConnectorManifest): string {
  return deviceManifestHash({
    ...manifest,
    feeds_schema: manifestFeedsForMetadata(manifest),
  });
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

// Device-connector keys the platform's bridge is allowed to register. A key
// outside this list rejects the WHOLE poll payload (see `accepted` above), so a
// new on-device connector must land here in the same change that ships its
// manifest — `os.shell` is the Mac shell connector (owletto#669), whose
// `os.shell` capability is already allowlisted in `@lobu/core`.
function connectorKeyAllowedForPlatform(platform: string, key: string): boolean {
  if (platform === 'macos') {
    return (
      key.startsWith('apple.') ||
      key === 'local.directory' ||
      key === 'whatsapp.local' ||
      key === 'os.shell'
    );
  }
  if (platform === 'chrome-extension') {
    // Compatibility cutover: the extension intentionally keeps the legacy
    // internal key so the existing connection/feed/event identity survives.
    // This is the sole non-chrome namespace admitted for Chrome; validation
    // above additionally binds it to browser.scripting.
    return (
      isChromeNamespaceConnectorKey(key) || isLegacyNativeChromeExtensionConnectorKey(key)
    );
  }
  // Headless devices (servers/VMs/pods, the herdr box) serve the shell
  // connector: bundled `os.shell` executes `bash -lc` and returns structured
  // output. Keep this list tight - nothing browser/OS-UI based.
  if (platform === 'headless') {
    return key === 'os.shell';
  }
  return false;
}

function isNoneAuthSchema(value: Record<string, unknown>): boolean {
  const methods = value.methods;
  return Array.isArray(methods) && methods.every((m) => isRecord(m) && m.type === 'none');
}

// Exported for callers needing the same canonical form the manifest hash uses
// (device-reconcile compares stored vs incoming definition metadata with it).
export const sortJson = sortDeviceManifestJson;

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
