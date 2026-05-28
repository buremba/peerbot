/**
 * Worker compiles connector bundles locally; gateway sends only the
 * `connector_key`. Device workers (e.g. Mac Bridge) still receive
 * `compiled_code` inline when they don't have the connectors directory on disk.
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
