import { describe, expect, test } from 'bun:test';
import {
  initialize,
  isConnectorRuntimeDependency,
  resolve,
} from '../executor/runtime-dependency-loader.js';

describe('connector runtime dependency loader', () => {
  test('classifies the SDK, SDK subpaths, and external runtime packages', () => {
    expect(isConnectorRuntimeDependency('@lobu/connector-sdk')).toBe(true);
    expect(
      isConnectorRuntimeDependency('@lobu/connector-sdk/define-connector')
    ).toBe(true);
    expect(isConnectorRuntimeDependency('playwright')).toBe(true);
    expect(isConnectorRuntimeDependency('sharp/lib/index.js')).toBe(true);
    expect(isConnectorRuntimeDependency('node:fs')).toBe(false);
    expect(isConnectorRuntimeDependency('connector-owned-package')).toBe(false);
  });

  test('rebases runtime packages to the connector-worker installation', async () => {
    const runtimeAnchorUrl =
      'file:///runtime/node_modules/@lobu/connector-worker/dist/executor/runtime-dependency-loader.js';
    initialize({ runtimeAnchorUrl });

    const calls: Array<{
      specifier: string;
      context: Record<string, unknown>;
    }> = [];
    const nextResolve = async (
      specifier: string,
      context: Record<string, unknown>
    ) => {
      calls.push({ specifier, context });
      return { url: `file:///resolved/${encodeURIComponent(specifier)}` };
    };

    await resolve(
      '@lobu/connector-sdk/define-connector',
      { parentURL: 'file:///unrelated/operator-cwd/connector.mjs' },
      nextResolve
    );
    await resolve(
      'connector-owned-package',
      { parentURL: 'file:///unrelated/operator-cwd/connector.mjs' },
      nextResolve
    );

    expect(calls[0]).toMatchObject({
      specifier: '@lobu/connector-sdk/define-connector',
      context: { parentURL: runtimeAnchorUrl },
    });
    expect(calls[1]).toMatchObject({
      specifier: 'connector-owned-package',
      context: {
        parentURL: 'file:///unrelated/operator-cwd/connector.mjs',
      },
    });
  });
});
