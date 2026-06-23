/**
 * Build-time generator for LOBU catalog manifests (`dist/catalogs/*.json`).
 * Runs after the connector source bundle + `.catalog-manifest.json` so
 * `generateConnectorsManifest` can read pre-extracted metadata cheaply.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateConnectorsManifest,
  generateSkillsManifest,
} from '../src/catalog/generate-defaults';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'dist', 'catalogs');

await mkdir(outDir, { recursive: true });

const start = Date.now();
const [connectors, skills] = await Promise.all([
  generateConnectorsManifest(),
  generateSkillsManifest(),
]);

await Promise.all([
  writeFile(join(outDir, 'connectors.json'), `${JSON.stringify(connectors, null, 2)}\n`, 'utf-8'),
  writeFile(join(outDir, 'skills.json'), `${JSON.stringify(skills, null, 2)}\n`, 'utf-8'),
]);

console.log(
  `\n=== catalog manifests: ${connectors.entries.length} connectors, ${skills.entries.length} skills -> ${outDir} (${Date.now() - start}ms)`
);