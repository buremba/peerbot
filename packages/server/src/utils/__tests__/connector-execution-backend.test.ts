import { deviceManifestHash, type DeviceConnectorManifest } from '@lobu/connector-sdk';
import { describe, expect, test } from 'vitest';
import {
  classifySelectedConnectorExecution,
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
      sourceCode: null,
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
        sourceCode: null,
      },
    }).inconsistency).toContain('non-manifest');
    expect(classify({
      artifact: { sourcePath: sourcePath.replace('apple.files', 'forged'), manifestHash: hash, compiledCode: null, compileConfigHash: null, sourceCode: null },
    }).backend).toBeUndefined();
  });

  test('does not infer bridge execution from a connector key alone', () => {
    expect(classify({
      artifact: {
        sourcePath: 'connectors/apple-files.ts',
        manifestHash: null,
        compiledCode: 'compiled connector',
        compileConfigHash: null,
        sourceCode: null,
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

  test('does not let retained bridge authorization override an active exact non-bridge definition', () => {
    expect(classify({
      definition: { ...definition, runtime: { platforms: ['macos'], execution: 'compiled' } },
    })).toEqual({ manifestBacked: true });
  });
});
