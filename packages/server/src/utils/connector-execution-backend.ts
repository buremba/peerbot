import { deviceManifestHash, type DeviceConnectorManifest } from '@lobu/connector-sdk';

export type SelectedConnectorExecutionBackend = 'native_bridge';

export interface SelectedConnectorArtifact {
  sourcePath: string | null | undefined;
  manifestHash: string | null | undefined;
  compiledCode: string | null | undefined;
  compileConfigHash: string | null | undefined;
  sourceCode: string | null | undefined;
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
  sourcePath?: string;
  runtimeExecution?: unknown;
}

export interface SelectedConnectorExecution {
  manifestBacked: boolean;
  backend?: SelectedConnectorExecutionBackend;
  manifestHash?: string;
  inconsistency?: string;
}

/**
 * Classify the exact artifact selected by the poll query. A bridge marker is
 * emitted only when the selected artifact is hash-attested by this device and
 * its canonical definition is bridge-owned. The artifact source path is part
 * of the authorization, so an organization override cannot silently replace a
 * shared bridge artifact with compiled code or another device's manifest.
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
  const definitionBridge = definitionRuntime?.execution === 'bridge';
  const authorization = params.authorizations.find(
    (entry) =>
      entry.connectorKey === params.connectorKey &&
      entry.connectorVersion === params.connectorVersion &&
      entry.manifestHash === params.artifact.manifestHash &&
      entry.sourcePath === params.artifact.sourcePath,
  );
  const authorizedBridge = authorization?.runtimeExecution === 'bridge';
  // An active exact definition is authoritative. Retained authorization may
  // only select a historical pinned version when no exact definition exists.
  const bridgeCandidate = params.definition ? definitionBridge : authorizedBridge;

  if (!bridgeCandidate) return { manifestBacked };
  if (!params.definition && !authorization) {
    return { manifestBacked, inconsistency: 'bridge artifact has no canonical definition or manifest authorization' };
  }
  if (!manifestBacked) {
    return { manifestBacked, inconsistency: 'bridge-marked definition selected a non-manifest artifact' };
  }
  if (params.artifact.compiledCode || params.artifact.compileConfigHash || params.artifact.sourceCode) {
    return { manifestBacked, inconsistency: 'bridge-marked artifact contains compiled or source code' };
  }
  if (!authorization) {
    return { manifestBacked, inconsistency: 'selected bridge artifact is not authorized by the claiming device' };
  }
  const parsedSource = parseManifestSourcePath(params.artifact.sourcePath);
  if (!parsedSource) {
    return { manifestBacked, inconsistency: 'bridge-marked artifact has an invalid manifest source path' };
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
  if (params.definition && definitionBridge) {
    const manifest = definitionToManifest(params.definition, definitionRuntime!);
    if (deviceManifestHash(manifest) !== params.artifact.manifestHash) {
      return { manifestBacked, inconsistency: 'canonical definition does not match the selected manifest hash' };
    }
  }

  return { manifestBacked, backend: 'native_bridge', manifestHash: params.artifact.manifestHash };
}

export function parseManifestSourcePath(
  sourcePath: string | null | undefined,
): { platform: string; key: string; version: string } | null {
  if (!sourcePath) return null;
  const match = /^device-manifest:\/\/([^/]+)\/([^@/]+)@(.+)$/.exec(sourcePath);
  if (!match) return null;
  return { platform: match[1]!, key: match[2]!, version: match[3]! };
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
    auth_schema: (definition.authSchema ?? { methods: [{ type: 'none' }] }) as Record<string, unknown>,
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
    !artifact.sourceCode
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
