import { deviceManifestHash, type DeviceConnectorManifest } from '@lobu/connector-sdk';
import { HEADLESS_OS_SHELL_MANIFEST } from '@lobu/connector-worker/daemon/device-manifests';
import { describe, expect, test } from 'vitest';
import {
  classifySelectedConnectorExecution,
  deviceExecutesConnectorNatively,
  type SelectedConnectorDefinition,
} from '../connector-execution-backend';

const manifest: DeviceConnectorManifest = {
  key: 'apple.files',
  version: '1.0.0',
  name: 'Apple Files',
  required_capability: 'os.files',
  runtime: { platforms: ['macos'], execution: 'bridge' },
  auth_schema: { methods: [{ type: 'none' }] },
  feeds_schema: { files: { key: 'files' } },
  actions_schema: { open: { key: 'open' } },
};

const definition: SelectedConnectorDefinition = {
  key: manifest.key,
  version: manifest.version,
  name: manifest.name,
  requiredCapability: manifest.required_capability,
  runtime: manifest.runtime,
  authSchema: manifest.auth_schema,
  feeds: manifest.feeds_schema,
  actions: manifest.actions_schema,
  optionsSchema: manifest.options_schema,
};

const hash = deviceManifestHash(manifest);
const sourcePath = `device-manifest://macos/${manifest.key}@${manifest.version}`;

function classify(overrides: Record<string, unknown> = {}) {
  return classifySelectedConnectorExecution({
    artifact: {
      sourcePath,
      manifestHash: hash,
      compiledCode: null,
      compileConfigHash: null,
      hasSourceCode: false,
    },
    definition,
    connectorKey: manifest.key,
    connectorVersion: manifest.version,
    authorizations: [{
      connectorKey: manifest.key,
      connectorVersion: manifest.version,
      manifestHash: hash,
      sourcePath,
      runtimeExecution: 'bridge',
    }],
    expectedPlatform: 'macos',
    ...overrides,
  });
}

describe('selected connector execution backend', () => {
  test('marks the exact canonical bridge artifact', () => {
    expect(classify()).toEqual({
      manifestBacked: true,
      backend: 'native_bridge',
      manifestHash: hash,
    });
  });

  test('accepts a historical pinned version from durable manifest authorization', () => {
    expect(classify({ definition: null })).toMatchObject({
      manifestBacked: true,
      backend: 'native_bridge',
      manifestHash: hash,
    });
  });

  test('rejects org compiled precedence and forged provenance', () => {
    expect(classify({
      artifact: {
        sourcePath,
        manifestHash: hash,
        compiledCode: 'compiled override',
        compileConfigHash: null,
        hasSourceCode: false,
      },
    }).inconsistency).toContain('non-manifest');
    expect(classify({
      artifact: { sourcePath: sourcePath.replace('apple.files', 'forged'), manifestHash: hash, compiledCode: null, compileConfigHash: null, hasSourceCode: false },
    }).backend).toBeUndefined();
  });

  test('does not infer bridge execution from a connector key alone', () => {
    expect(classify({
      artifact: {
        sourcePath: 'connectors/apple-files.ts',
        manifestHash: null,
        compiledCode: 'compiled connector',
        compileConfigHash: null,
        hasSourceCode: false,
      },
      definition: { ...definition, runtime: { platforms: ['macos'] } },
      authorizations: [],
    })).toEqual({ manifestBacked: false });
  });

  test('active exact non-bridge definition wins over retained bridge authorization', () => {
    expect(classify({
      definition: { ...definition, runtime: { platforms: ['macos'], execution: 'compiled' } },
    })).toEqual({ manifestBacked: true, inconsistency: 'active exact definition is not bridge execution' });
  });

  test('rejects a bridge artifact that is not authorized by the claiming device', () => {
    expect(classify({ authorizations: [] }).inconsistency).toContain('not authorized');
    expect(classify({ authorizations: [] }).backend).toBeUndefined();
  });

  test('rejects a canonical definition whose hash differs from the artifact', () => {
    expect(classify({ definition: { ...definition, name: 'Tampered Name' } }).inconsistency).toContain(
      'canonical definition',
    );
    expect(classify({ definition: { ...definition, name: 'Tampered Name' } }).backend).toBeUndefined();
  });

  test('rejects a manifest artifact from another platform', () => {
    expect(classify({ expectedPlatform: 'chrome-extension' }).inconsistency).toContain(
      'does not match worker platform',
    );
    expect(classify({ expectedPlatform: 'chrome-extension' }).backend).toBeUndefined();
  });

  test('accepts a reconciled bridge definition whose wire manifest omitted auth_schema', () => {
    const omittedAuthManifest = { ...manifest, auth_schema: undefined };
    const omittedAuthHash = deviceManifestHash(omittedAuthManifest);
    const omittedSourcePath = `device-manifest://macos/${manifest.key}@${manifest.version}`;
    expect(classify({
      artifact: {
        sourcePath: omittedSourcePath,
        manifestHash: omittedAuthHash,
        compiledCode: null,
        compileConfigHash: null,
        hasSourceCode: false,
      },
      definition,
      authorizations: [{
        connectorKey: manifest.key,
        connectorVersion: manifest.version,
        manifestHash: omittedAuthHash,
        sourcePath: omittedSourcePath,
        runtimeExecution: 'bridge',
      }],
    })).toEqual({
      manifestBacked: true,
      backend: 'native_bridge',
      manifestHash: omittedAuthHash,
    });
  });
});

describe('device manifests served by connector-worker rather than a bridge', () => {
  const headless = HEADLESS_OS_SHELL_MANIFEST as unknown as DeviceConnectorManifest;
  const headlessDefinition: SelectedConnectorDefinition = {
    key: headless.key,
    version: headless.version,
    name: headless.name,
    requiredCapability: headless.required_capability,
    runtime: headless.runtime,
    authSchema: headless.auth_schema,
    feeds: headless.feeds_schema,
    actions: headless.actions_schema,
    optionsSchema: headless.options_schema,
  };
  const headlessHash = deviceManifestHash(headless);
  const headlessSourcePath = `device-manifest://headless/${headless.key}@${headless.version}`;

  function classifyHeadless(overrides: Record<string, unknown> = {}) {
    return classifySelectedConnectorExecution({
      artifact: {
        sourcePath: headlessSourcePath,
        manifestHash: headlessHash,
        compiledCode: null,
        compileConfigHash: null,
        hasSourceCode: false,
      },
      definition: headlessDefinition,
      connectorKey: headless.key,
      connectorVersion: headless.version,
      authorizations: [{
        connectorKey: headless.key,
        connectorVersion: headless.version,
        manifestHash: headlessHash,
        sourcePath: headlessSourcePath,
      }],
      expectedPlatform: 'headless',
      ...overrides,
    });
  }

  test('the shipped headless os.shell manifest declares no bridge execution', () => {
    expect(headless.runtime).not.toHaveProperty('execution');
  });

  test('classifies headless os.shell as manifest-backed but not native_bridge', () => {
    expect(classifyHeadless()).toEqual({ manifestBacked: true });
  });

  test('stays non-bridge even when the device authorization claims bridge execution', () => {
    expect(classifyHeadless({
      authorizations: [{
        connectorKey: headless.key,
        connectorVersion: headless.version,
        manifestHash: headlessHash,
        sourcePath: headlessSourcePath,
        runtimeExecution: 'bridge',
      }],
    })).toEqual({ manifestBacked: true });
  });
});

describe('deviceExecutesConnectorNatively', () => {
  const base = {
    isUserScopedWorker: true,
    hasStoredCompiledCode: false,
    gatewayHasLocalSource: true,
    isNativeBridgeRun: false,
    manifestBacked: false,
    deviceAdvertisesRequiredCapability: false,
  };

  test('a native-bridge run needs no bundle', () => {
    expect(deviceExecutesConnectorNatively({ ...base, isNativeBridgeRun: true })).toBe(true);
  });

  test('manifest-backed alone does not mean native execution', () => {
    expect(deviceExecutesConnectorNatively({ ...base, manifestBacked: true })).toBe(false);
  });

  test('advertising the required capability does not mean native execution', () => {
    expect(
      deviceExecutesConnectorNatively({ ...base, deviceAdvertisesRequiredCapability: true })
    ).toBe(false);
  });

  test('manifest-backed plus the capability gate still needs the bundle', () => {
    expect(
      deviceExecutesConnectorNatively({
        ...base,
        manifestBacked: true,
        deviceAdvertisesRequiredCapability: true,
      })
    ).toBe(false);
  });

  test('keeps a legacy manifest device-executed when the gateway has no code to send', () => {
    expect(
      deviceExecutesConnectorNatively({
        ...base,
        gatewayHasLocalSource: false,
        manifestBacked: true,
      })
    ).toBe(true);
  });

  test('keeps a legacy capability-only device-executed when the gateway has no code to send', () => {
    expect(
      deviceExecutesConnectorNatively({
        ...base,
        gatewayHasLocalSource: false,
        deviceAdvertisesRequiredCapability: true,
      })
    ).toBe(true);
  });

  test('does not invent native execution without a bridge, manifest, or capability claim', () => {
    expect(
      deviceExecutesConnectorNatively({ ...base, gatewayHasLocalSource: false })
    ).toBe(false);
  });

  test('stored compiled code always ships inline, even for a bridge run', () => {
    expect(
      deviceExecutesConnectorNatively({
        ...base,
        isNativeBridgeRun: true,
        hasStoredCompiledCode: true,
      })
    ).toBe(false);
  });

  test('a fleet worker resolves locally and is never treated as native', () => {
    expect(
      deviceExecutesConnectorNatively({
        ...base,
        isUserScopedWorker: false,
        isNativeBridgeRun: true,
      })
    ).toBe(false);
  });
});
