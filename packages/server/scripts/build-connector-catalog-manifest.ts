/**
 * Build-time generator for the connector catalog manifest.
 *
 * Compiles every bundled connector once (esbuild + a forked metadata-extract
 * subprocess each) and writes the result to dist/connectors/.catalog-manifest.json.
 * The server then serves the bundled connector catalog by reading this file
 * instead of recompiling every connector on demand — the cold per-pod scan that
 * overran the request timeout and returned 503 on the "Add a connection" picker
 * under prod's CPU limits (empty "No connectors found").
 *
 * Runs after build-server-bundle.mjs (which copies the sources into
 * dist/connectors). Executed under `bun` so it can import the TS catalog code.
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_MANIFEST_FILENAME,
  generateCatalogManifest,
} from '../src/utils/connector-catalog';

const here = dirname(fileURLToPath(import.meta.url));
const connectorsDir = join(here, '..', 'dist', 'connectors');

if (!existsSync(connectorsDir)) {
  console.warn(
    `[catalog-manifest] ${connectorsDir} missing; skipping (run build:server first).`
  );
  process.exit(0);
}

const start = Date.now();
const manifest = await generateCatalogManifest(connectorsDir);
const manifestPath = join(connectorsDir, CATALOG_MANIFEST_FILENAME);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

const total = Object.keys(manifest.entries).length;
const connectors = Object.values(manifest.entries).filter(Boolean).length;
console.log(
  `\n=== connector catalog manifest: ${connectors} connectors / ${total} files -> ${manifestPath} (${Date.now() - start}ms)`
);
