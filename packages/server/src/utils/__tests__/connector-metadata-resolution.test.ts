/**
 * Reproducer for #1181: the gateway's bundled-connector install path compiles
 * a connector with `@lobu/connector-sdk` externalized, then extracts metadata
 * in a subprocess from a temp dir under `process.cwd()`. When the server runs
 * inside a user project with no node_modules (fresh `lobu init` + `lobu run`),
 * the bundle's bare SDK import used to fail with
 * `Cannot find package '@lobu/connector-sdk'` because resolution only walked
 * UP from the temp dir. `extractMetadata` now stages a node_modules inside the
 * temp dir, symlinking the runtime-provided packages as the server resolves
 * them — so extraction succeeds regardless of the project's node_modules.
 *
 * Vitest (not the bun unit lane) on purpose: the extraction subprocess is a
 * `fork()` of the test runtime, and under bun the child would auto-install
 * the missing SDK from npm, silently masking the regression. Prod and the
 * embedded `lobu run` both run under node, which vitest matches.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectorCompiler } from '@lobu/connector-worker/compile';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { formatMetadataExtractionError } from '../compiler-core';
import { extractConnectorMetadata } from '../connector-compiler';

const CONNECTOR_SOURCE = `
import { ConnectorRuntime } from '@lobu/connector-sdk';

export default class MetaResolutionProbeConnector extends ConnectorRuntime {
  definition = {
    key: 'meta_resolution_probe',
    name: 'Metadata Resolution Probe',
    description: 'Synthetic connector for the #1181 extraction reproducer.',
    version: '0.0.1',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {},
  };

  async sync() {
    return { events: [], checkpoint: null, metadata: { items_found: 0, items_skipped: 0 } };
  }
}
`;

describe('extractConnectorMetadata in a project dir without node_modules', () => {
  const originalCwd = process.cwd();
  let sourceDir: string;
  let emptyProjectDir: string;

  beforeAll(() => {
    sourceDir = mkdtempSync(join(tmpdir(), 'lobu-1181-src-'));
    // Stands in for a fresh `lobu init` project: no node_modules anywhere up
    // the OS tmpdir ancestry.
    emptyProjectDir = mkdtempSync(join(tmpdir(), 'lobu-1181-proj-'));
  });

  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(emptyProjectDir, { recursive: true, force: true });
  });

  test('extracts metadata from an SDK-externalized bundle', async () => {
    const connectorPath = join(sourceDir, 'meta_resolution_probe.ts');
    writeFileSync(connectorPath, CONNECTOR_SOURCE);

    // Same compiler the gateway's bundled-connector install path uses:
    // leaves `@lobu/connector-sdk` as a bare external import in the bundle.
    const { compileConnectorFromFile } = createConnectorCompiler();
    const compiled = await compileConnectorFromFile(connectorPath);
    expect(compiled).toContain('@lobu/connector-sdk');

    process.chdir(emptyProjectDir);
    try {
      const metadata = await extractConnectorMetadata(compiled);
      expect(metadata.key).toBe('meta_resolution_probe');
      expect(metadata.name).toBe('Metadata Resolution Probe');
      expect(metadata.version).toBe('0.0.1');
    } finally {
      process.chdir(originalCwd);
    }
  }, 30_000);
});

describe('formatMetadataExtractionError', () => {
  test('appends install guidance when the connector SDK is unresolvable', () => {
    const raw =
      "Cannot find package '@lobu/connector-sdk' imported from /tmp/proj/.connector-meta-XXXX/source.mjs";
    const formatted = formatMetadataExtractionError(raw);
    expect(formatted).toContain('Metadata extraction failed:');
    expect(formatted).toContain(raw);
    expect(formatted).toContain('npm install');
    expect(formatted).toContain('bun install');
    expect(formatted).toContain('@lobu/connector-sdk');
  });

  test('handles the bare `lobu` alias specifier too', () => {
    const formatted = formatMetadataExtractionError(
      "Cannot find package 'lobu' imported from /tmp/x/source.mjs"
    );
    expect(formatted).toContain('npm install');
  });

  test('leaves unrelated errors untouched', () => {
    const formatted = formatMetadataExtractionError(
      'No ConnectorRuntime class found in compiled code.'
    );
    expect(formatted).toBe(
      'Metadata extraction failed: No ConnectorRuntime class found in compiled code.'
    );
    expect(formatted).not.toContain('npm install');
  });

  test('does not misfire on other missing packages', () => {
    const formatted = formatMetadataExtractionError(
      "Cannot find package 'left-pad' imported from /tmp/x/source.mjs"
    );
    expect(formatted).not.toContain('npm install');
  });
});
