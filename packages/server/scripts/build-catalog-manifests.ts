/**
 * Build-time generator for LOBU catalog manifests (`dist/catalogs/*.json`).
 * Compiles bundled connectors once and writes unified manifest files consumed
 * at runtime via `LOBU_CATALOG_URIS` (and vendored into the CLI tarball).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateConnectorsManifest,
  generateSkillsManifest,
  generateWatchersManifest,
} from '../src/catalog/generate-defaults';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'dist', 'catalogs');

await mkdir(outDir, { recursive: true });

const start = Date.now();
const [connectors, skills] = await Promise.all([
  generateConnectorsManifest(),
  generateSkillsManifest(),
]);
const watchers = generateWatchersManifest();

await Promise.all([
  writeFile(join(outDir, 'connectors.json'), `${JSON.stringify(connectors, null, 2)}\n`, 'utf-8'),
  writeFile(join(outDir, 'skills.json'), `${JSON.stringify(skills, null, 2)}\n`, 'utf-8'),
  writeFile(join(outDir, 'watchers.json'), `${JSON.stringify(watchers, null, 2)}\n`, 'utf-8'),
]);

console.log(
  `\n=== catalog manifests: ${connectors.entries.length} connectors, ${skills.entries.length} skills, ${watchers.entries.length} watchers -> ${outDir} (${Date.now() - start}ms)`
);