/**
 * Build-time generator for LOBU catalog manifests (`dist/catalogs/*.json`).
 * Compiles bundled connectors once and writes unified manifest files consumed
 * at runtime via `LOBU_CATALOG_URIS` (and vendored into the CLI tarball).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateConnectorsManifest,
  generateSkillsManifest,
  generateBehaviorsManifest,
} from '../src/catalog/generate-defaults';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'dist', 'catalogs');

await mkdir(outDir, { recursive: true });
await rm(join(outDir, 'watchers.json'), { force: true });

const start = Date.now();
const [connectors, skills] = await Promise.all([
  generateConnectorsManifest(),
  generateSkillsManifest(),
]);
const behaviors = generateBehaviorsManifest();

await Promise.all([
  writeFile(join(outDir, 'connectors.json'), `${JSON.stringify(connectors, null, 2)}\n`, 'utf-8'),
  writeFile(join(outDir, 'skills.json'), `${JSON.stringify(skills, null, 2)}\n`, 'utf-8'),
  writeFile(join(outDir, 'behaviors.json'), `${JSON.stringify(behaviors, null, 2)}\n`, 'utf-8'),
]);

console.log(
  `\n=== catalog manifests: ${connectors.entries.length} connectors, ${skills.entries.length} skills, ${behaviors.entries.length} Behaviors -> ${outDir} (${Date.now() - start}ms)`
);
