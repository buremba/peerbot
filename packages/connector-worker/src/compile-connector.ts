/**
 * Worker-side connector resolver + compile entry point.
 *
 * Until lobu#771, the gateway compiled connector bundles via esbuild and
 * shipped the ~13 MB output inline in every `/api/workers/poll` response.
 * The gateway pod held all ~29 connector bundles in its compile cache
 * (~384 MB, dominant heap occupant under the 1 GiB limit). For fleet
 * workers (and embedded mode where worker + gateway share a host), the
 * bundled connector .ts source is on disk in both pods — the gateway
 * doesn't need to compile or ship it. The gateway now sends only the
 * `connector_key` and this module compiles locally in the worker process.
 *
 * Device workers (Lobu Mac Bridge, etc.) keep getting `compiled_code`
 * inline — they don't have the connectors directory on disk.
 *
 * The resolver + esbuild bundle pipeline themselves are owned by the
 * shared `./compile` module so the gateway and CLI sides don't drift.
 * This file just supplies the worker-image-specific candidate dirs.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createConnectorCompiler,
  findBundledConnectorFile as findInDirs,
} from './compile/index.js';

// Worker-side resolver for the bundled connectors directory. The gateway's
// resolver targets paths that exist in the gateway image
// (e.g. /app/packages/server/dist/connectors); those paths do not exist
// in the worker image, which has the sources at /app/packages/connectors.
// Each side resolves locally instead of trusting gateway-supplied paths.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const WORKER_CONNECTOR_DIR_CANDIDATES = [
  // Monorepo: workspace package at packages/connector-worker/src/ →
  // packages/connectors/src.
  resolve(HERE, '../../../connectors/src'),
  resolve(HERE, '../../../connectors/dist'),
  resolve(HERE, '../../connectors/src'),
  resolve(HERE, '../../connectors/dist'),
  resolve(HERE, '../connectors/src'),
  // Embedded CLI install (`npx @lobu/cli`): the start-local bundle and the
  // connectors directory ship side-by-side under
  // node_modules/@lobu/cli/dist/. When the bundled connector-worker code is
  // running from that bundle, `HERE` resolves to that same dist dir, so
  // `./connectors` is the layout the CLI build produced
  // (packages/cli/scripts/build.cjs::copyDirIfExists('../connectors/src',
  // 'dist/connectors')). Without this, the embedded worker claims runs and
  // fails them with "did not resolve to a local source file".
  resolve(HERE, 'connectors'),
  resolve(process.cwd(), 'packages/connectors/src'),
  resolve(process.cwd(), 'connectors'),
];

export function findBundledConnectorFile(key: string): string | null {
  return findInDirs(key, WORKER_CONNECTOR_DIR_CANDIDATES);
}

const compiler = createConnectorCompiler();

export const compileConnectorFromFile = compiler.compileConnectorFromFile;
