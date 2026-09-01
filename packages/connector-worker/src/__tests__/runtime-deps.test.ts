import { describe, expect, test } from 'bun:test';
import workerPackage from '../../package.json';
import { RUNTIME_PROVIDED_PACKAGES } from '../runtime-deps.js';

describe('connector runtime dependency packaging', () => {
  test('the worker declares every package its compiled connectors load at runtime', () => {
    const dependencies = new Set(Object.keys(workerPackage.dependencies ?? {}));
    expect(RUNTIME_PROVIDED_PACKAGES).toContain('@lobu/connector-sdk');
    expect(RUNTIME_PROVIDED_PACKAGES.filter((name) => !dependencies.has(name))).toEqual([]);
  });
});
