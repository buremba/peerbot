import { describe, expect, it } from 'bun:test';
import { createIsolateConnectorCompiler } from '../compile/index.js';
import { IsolateLaneIneligibleError } from '../isolate/eligibility.js';

const MINIMAL_CONNECTOR = `
import { ConnectorRuntime } from '@lobu/connector-sdk';

export default class TestConnector extends ConnectorRuntime {
  definition = {
    key: 'test_connector',
    name: 'Test Connector',
    version: '1.0.0',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {},
  };
}
`;

const INELIGIBLE_CONNECTOR = `
import { ConnectorRuntime } from '@lobu/connector-sdk';
import * as fs from 'node:fs';

export default class IneligibleConnector extends ConnectorRuntime {
  definition = {
    key: 'ineligible',
    name: 'Ineligible',
    version: '1.0.0',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {},
  };
}
`;

describe('createIsolateConnectorCompiler from source', () => {
  it('bundles pure-JS connector source into CJS for isolate lane', async () => {
    const compiler = createIsolateConnectorCompiler();
    const code = await compiler.compileConnectorForIsolateFromSource(MINIMAL_CONNECTOR);
    expect(code).toContain('TestConnector');
    // Verifies CJS output
    expect(code).toContain('module.exports');
    // Does not have top-level import
    expect(code).not.toMatch(/^import\s+/m);
  });

  it('rejects source that imports Node builtins with IsolateLaneIneligibleError', async () => {
    const compiler = createIsolateConnectorCompiler();
    let error: any;
    try {
      await compiler.compileConnectorForIsolateFromSource(INELIGIBLE_CONNECTOR);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(IsolateLaneIneligibleError);
    expect(error.builtins).toEqual(['fs']);
  });
});
