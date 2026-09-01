import { deviceManifestHash, type DeviceConnectorManifest } from '@lobu/connector-sdk';
import { EXECUTION_BACKENDS, type ExecutionBackend } from '@lobu/core/contracts/worker/protocol';

export type SelectedConnectorExecutionBackend = ExecutionBackend;

export interface SelectedConnectorArtifact {
  sourcePath: string | null | undefined;
  manifestHash: string | null | undefined;
  compiledCode: string | null | undefined;
  compileConfigHash: string | null | undefined;
  hasSourceCode: boolean;
}

export interface SelectedConnectorDefinition {
  key: string;
  version: string;
  name: string;
  description?: string | null;
  faviconDomain?: string | null;
  requiredCapability: string | null | undefined;
  runtime: unknown;
  authSchema: unknown;
  feeds: unknown;
  actions: unknown;
  optionsSchema: unknown;
}

export interface AuthorizedManifestIdentity {
  connectorKey: string;
  connectorVersion: string;
  manifestHash: string;
  definitionManifestHash?: string;
  sourcePath?: string;
  runtimeExecution?: DeviceConnectorManifest['runtime']['execution'];
}

export interface SelectedConnectorExecution {
  manifestBacked: boolean;
  backend?: SelectedConnectorExecutionBackend;
  manifestHash?: string;
  inconsistency?: string;
}

/**
 * Classify the exact artifact selected by the poll query. A device-owned
 * backend marker is emitted only when the selected artifact is hash-attested
 * by this device and its canonical definition declares that backend. The
 * artifact source path is part of the authorization, so an organization
 * override cannot silently replace a shared bridge artifact with compiled code
 * or another device's manifest.
 */
export function classifySelectedConnectorExecution(params: {
  artifact: SelectedConnectorArtifact;
  definition: SelectedConnectorDefinition | null;
  connectorKey: string;
  connectorVersion: string | null;
  authorizations: readonly AuthorizedManifestIdentity[];
  expectedPlatform?: string | null;
}): SelectedConnectorExecution {
  const manifestBacked = isManifestArtifact(params.artifact);
  const definitionRuntime = asRecord(params.definition?.runtime);
  const definitionExecution = definitionRuntime?.execution;
  const definitionDeviceExecution =
    definitionExecution === 'bridge' || definitionExecution === 'daemon_builtin'
      ? definitionExecution
      : undefined;
  const definitionExecutionDeclared =
    definitionRuntime !== null && Object.hasOwn(definitionRuntime, 'execution');
  const authorization = params.authorizations.find(
    (entry) =>
      entry.connectorKey === params.connectorKey &&
      entry.connectorVersion === params.connectorVersion &&
      entry.manifestHash === params.artifact.manifestHash &&
      entry.sourcePath === params.artifact.sourcePath,
  );
  const authorizedDeviceExecution = authorization?.runtimeExecution;
  // An active exact definition is authoritative. Retained authorization may
  // only select a historical pinned version when no exact definition exists.
  // Legacy metadata-only definitions remain ordinary manifest-backed device
  // work; an explicit unsupported execution value is a contradictory artifact
  // selection and must terminalize the already-claimed run.
  if (params.definition && !definitionDeviceExecution) {
    return manifestBacked && definitionExecutionDeclared
      ? {
          manifestBacked,
          inconsistency: 'active exact definition declares an unsupported execution backend',
        }
      : { manifestBacked };
  }
  const deviceExecution = definitionDeviceExecution ?? authorizedDeviceExecution;

  if (!deviceExecution) return { manifestBacked };
  if (!params.definition && !authorization) {
    return { manifestBacked, inconsistency: 'device-owned artifact has no canonical definition or manifest authorization' };
  }
  if (!manifestBacked) {
    return { manifestBacked, inconsistency: 'device-owned definition selected a non-manifest artifact' };
  }
  if (params.artifact.compiledCode || params.artifact.compileConfigHash || params.artifact.hasSourceCode) {
    return { manifestBacked, inconsistency: 'device-owned artifact contains compiled or source code' };
  }
  if (!authorization) {
    return { manifestBacked, inconsistency: 'selected device-owned artifact is not authorized by the claiming device' };
  }
  if (authorization.runtimeExecution !== deviceExecution) {
    return { manifestBacked, inconsistency: 'claiming device advertised a different execution backend' };
  }
  const parsedSource = parseManifestSourcePath(params.artifact.sourcePath);
  if (!parsedSource) {
    return { manifestBacked, inconsistency: 'device-owned artifact has an invalid manifest source path' };
  }
  if (params.expectedPlatform && parsedSource.platform !== params.expectedPlatform) {
    return {
      manifestBacked,
      inconsistency: `manifest artifact platform '${parsedSource.platform}' does not match worker platform '${params.expectedPlatform}'`,
    };
  }
  if (parsedSource.key !== params.connectorKey || parsedSource.version !== params.connectorVersion) {
    return {
      manifestBacked,
      inconsistency: 'manifest artifact identity does not match the pinned connector version',
    };
  }
  if (!authorization.sourcePath || authorization.sourcePath !== params.artifact.sourcePath) {
    return { manifestBacked, inconsistency: 'manifest artifact provenance is not exact' };
  }
  if (!params.artifact.manifestHash || authorization.manifestHash !== params.artifact.manifestHash) {
    return { manifestBacked, inconsistency: 'manifest artifact hash is not authorized' };
  }

  // An active exact definition can be checked against the durable hash. For a
  // historical pinned version, the validated device manifest is the canonical
  // definition retained by the authorization and the same hash check has
  // already happened during manifest reconciliation.
  if (params.definition && definitionDeviceExecution) {
    const hashes = definitionManifestHashes(params.definition, definitionRuntime!);
    if (
      !hashes.has(params.artifact.manifestHash) &&
      (!authorization.definitionManifestHash ||
        !hashes.has(authorization.definitionManifestHash))
    ) {
      return { manifestBacked, inconsistency: 'canonical definition does not match the selected manifest hash' };
    }
  }

  return {
    manifestBacked,
    backend: deviceExecution === 'bridge' ? 'native_bridge' : EXECUTION_BACKENDS.daemonBuiltin,
    manifestHash: params.artifact.manifestHash,
  };
}

/**
 * Whether the claiming device implements this connector itself, so the gateway
 * may omit `compiled_code` from the poll response.
 *
 * A device-owned run (native bridge or daemon builtin) always qualifies.
 * Legacy device manifests and capability-only clients also remain
 * device-executed when the gateway has no code it could deliver. When bundled
 * or stored code exists, manifest backing and capability advertisement are
 * authorization signals only; they do not establish that the device implements
 * the connector.
 */
export function deviceExecutesConnectorNatively(params: {
  isUserScopedWorker: boolean;
  hasStoredCompiledCode: boolean;
  gatewayHasLocalSource: boolean;
  isDeviceOwnedRun: boolean;
  manifestBacked: boolean;
  deviceAdvertisesRequiredCapability: boolean;
}): boolean {
  return (
    params.isUserScopedWorker &&
    !params.hasStoredCompiledCode &&
    (params.isDeviceOwnedRun ||
      (!params.gatewayHasLocalSource &&
        (params.manifestBacked || params.deviceAdvertisesRequiredCapability)))
  );
}

export function parseManifestSourcePath(
  sourcePath: string | null | undefined,
): { platform: string; key: string; version: string } | null {
  if (!sourcePath) return null;
  const match = /^device-manifest:\/\/([^/]+)\/([^@/]+)@(.+)$/.exec(sourcePath);
  if (!match) return null;
  return { platform: match[1]!, key: match[2]!, version: match[3]! };
}

function definitionManifestHashes(
  definition: SelectedConnectorDefinition,
  runtime: Record<string, unknown>,
): Set<string> {
  const manifest = definitionToManifest(definition, runtime);
  const hashes = new Set([deviceManifestHash(manifest)]);
  if (isInjectedNoneAuthSchema(manifest.auth_schema)) {
    const withoutAuth = { ...manifest };
    delete withoutAuth.auth_schema;
    hashes.add(deviceManifestHash(withoutAuth));
  }
  return hashes;
}

function isInjectedNoneAuthSchema(value: unknown): boolean {
  const schema = asRecord(value);
  if (!schema || Object.keys(schema).length !== 1) return false;
  const methods = schema.methods;
  if (!Array.isArray(methods) || methods.length !== 1) return false;
  const method = asRecord(methods[0]);
  return method !== null && Object.keys(method).length === 1 && method.type === 'none';
}

function definitionToManifest(
  definition: SelectedConnectorDefinition,
  runtime: Record<string, unknown>,
): DeviceConnectorManifest {
  return {
    key: definition.key,
    version: definition.version,
    name: definition.name,
    description: definition.description,
    favicon_domain: definition.faviconDomain,
    required_capability: definition.requiredCapability ?? '',
    runtime: runtime as DeviceConnectorManifest['runtime'],
    ...(definition.authSchema == null
      ? {}
      : { auth_schema: definition.authSchema as Record<string, unknown> }),
    feeds_schema: asRecord(definition.feeds) ?? {},
    actions_schema: asRecord(definition.actions),
    options_schema: asRecord(definition.optionsSchema),
  };
}

function isManifestArtifact(artifact: SelectedConnectorArtifact): boolean {
  return (
    parseManifestSourcePath(artifact.sourcePath) !== null &&
    !artifact.compiledCode &&
    !artifact.compileConfigHash &&
    !artifact.hasSourceCode
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
