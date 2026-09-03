import { readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { flattenConnectorSourceFromFile } from '@lobu/connector-worker/compile';
import { describe, expect, test } from 'bun:test';
import { compileConnectorSource } from '../connector-compiler';

/**
 * #2042 — every bundled catalog connector, in the form install paths persist
 * as `source_code` (the flattened single-file snapshot), must compile under
 * the SAME source-text compiler production uses for stored connector rows
 * (`compileConnectorSource`), not only the from-file bundler. The Gmail
 * outage happened because a catalog snapshot carried a relative import that
 * the from-file path bundles fine but the source-text path (DB-stored source,
 * recompile-on-config-drift) rejects — so the reviewed catalog shipped source
 * that could not run in its own production compiler.
 */

const CONNECTORS_DIR = resolve(import.meta.dir, '../../../../connectors/src');

async function collectConnectorSources(): Promise<string[]> {
  const files: string[] = [];
  const top = await readdir(CONNECTORS_DIR, { withFileTypes: true });
  for (const entry of top.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = join(CONNECTORS_DIR, entry.name);
    if (entry.isFile()) {
      if (extname(entry.name) !== '.ts' || entry.name.endsWith('.d.ts')) continue;
      files.push(entryPath);
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name.startsWith('_')) continue;
      for (const sub of (await readdir(entryPath, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name)
      )) {
        if (!sub.isFile()) continue;
        if (extname(sub.name) !== '.ts' || sub.name.endsWith('.d.ts')) continue;
        files.push(join(entryPath, sub.name));
      }
    }
  }
  return files;
}

describe('catalog connectors compile under the production source-text compiler (#2042)', () => {
  test(
    'every bundled connector source compiles standalone',
    async () => {
      const files = await collectConnectorSources();
      expect(files.length).toBeGreaterThan(10);

      const failures: string[] = [];
      for (const filePath of files) {
        if (filePath.endsWith('os_shell.ts')) continue; // Daemon builtin, not an isolate connector
        try {
          const snapshot = await flattenConnectorSourceFromFile(filePath);
          await compileConnectorSource(snapshot);
        } catch (err) {
          failures.push(`${filePath}: ${(err as Error).message}`);
        }
      }

      expect(failures).toEqual([]);
    },
    { timeout: 240_000 }
  );
});
