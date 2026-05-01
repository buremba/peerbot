import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findBundledConnectorFile,
  getConfiguredConnectorCatalogUris,
  normalizeFileSourceUri,
} from '../connector-catalog';
import { connectorSourcePathToUri } from '../connector-definition-install';

describe('connector-catalog helpers', () => {
  it('uses the bundled connectors directory when no env value is provided', () => {
    const uris = getConfiguredConnectorCatalogUris(undefined);

    expect(uris).toHaveLength(1);
    expect(uris[0].startsWith('file://')).toBe(true);
    const dir = fileURLToPath(uris[0]);
    expect(existsSync(dir)).toBe(true);
    // Path may be packages/connectors/src or any other repo-local
    // candidate; just assert it resolves to a real directory containing
    // connector definitions.
    expect(existsSync(`${dir}/google_gmail.ts`)).toBe(true);
  });

  it('normalizes both bare paths and file URIs', () => {
    const cwdPath = `${process.cwd()}/connectors`;
    const normalizedPath = normalizeFileSourceUri(cwdPath);
    const normalizedUri = normalizeFileSourceUri(`file://${cwdPath}`);

    expect(normalizedPath).toBeTruthy();
    expect(normalizedUri).toBeTruthy();
    expect(normalizedPath).toBe(normalizedUri);
  });

  it('derives a file source_uri for bundled connector source paths', () => {
    const bundledConnectorFile = findBundledConnectorFile('google.gmail');

    expect(bundledConnectorFile).toBeTruthy();
    expect(connectorSourcePathToUri('google_gmail.ts')).toBe(
      normalizeFileSourceUri(bundledConnectorFile!)
    );
  });

  it('returns null for non-local source paths that cannot be resolved', () => {
    expect(connectorSourcePathToUri('github.com/example/connector.ts')).toBeNull();
  });
});
