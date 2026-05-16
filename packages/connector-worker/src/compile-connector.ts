/**
 * Worker-side connector compiler.
 *
 * Until lobu#771's perf brainstorm, the gateway compiled connector bundles
 * via esbuild and shipped the ~13 MB output inline in every `/api/workers/poll`
 * response. The gateway pod held all ~29 connector bundles in its
 * compile cache (~384 MB, dominant heap occupant under the 1 GiB limit;
 * see lobu#771 for the heap-snapshot trail).
 *
 * For fleet workers (and embedded mode where worker + gateway share a host),
 * the bundled connector .ts source is on disk in both pods — the gateway
 * doesn't need to compile or ship it. The gateway now sends
 * `connector_source_path` (the absolute path that `findBundledConnectorFile`
 * resolved) and this module compiles locally in the worker process.
 *
 * Device workers (Lobu Mac Bridge, etc.) keep getting `compiled_code` inline
 * — they don't have the connectors directory on disk.
 *
 * This file mirrors the server's `utils/connector-catalog.ts` compile pipeline.
 * Kept here (rather than shared) so the connector-worker package doesn't take
 * a runtime dep on the server package's bundle layout.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { EXTERNAL_RUNTIME_DEPS } from './runtime-deps.js';

// Worker-side resolver for the bundled connectors directory. The gateway's
// `findBundledConnectorFile` resolves to paths that exist in the gateway
// image (e.g. /app/packages/server/dist/connectors); those paths do not
// exist in the worker image, which has the sources at
// /app/packages/connectors. Each side resolves locally instead of trusting
// gateway-supplied absolute paths.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const WORKER_CONNECTOR_DIR_CANDIDATES = [
  resolve(HERE, '../../../connectors/src'),
  resolve(HERE, '../../../connectors/dist'),
  resolve(HERE, '../../connectors/src'),
  resolve(HERE, '../../connectors/dist'),
  resolve(HERE, '../connectors/src'),
  resolve(process.cwd(), 'packages/connectors/src'),
  resolve(process.cwd(), 'connectors'),
];

// Strict regex for connector_key: lowercase letters/digits, optional dots
// for namespacing, underscores for word separators. Defense-in-depth even
// though keys come from a trusted DB column — we're about to use the value
// to construct a filesystem path.
const CONNECTOR_KEY_RE = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/;

export function findBundledConnectorFile(key: string): string | null {
  if (!CONNECTOR_KEY_RE.test(key)) return null;
  const fileName = `${key.replace(/\./g, '_')}.ts`;
  for (const candidate of WORKER_CONNECTOR_DIR_CANDIDATES) {
    const filePath = resolve(candidate, fileName);
    // Belt-and-braces: assert the resolved path stays under the candidate
    // dir even though CONNECTOR_KEY_RE already forbids the dangerous chars.
    if (!filePath.startsWith(`${candidate}/`)) continue;
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

const require_ = createRequire(import.meta.url);
const SDK_ENTRY = require_.resolve('@lobu/connector-sdk');

// Connectors declare runtime npm deps via `import x from 'npm:foo@1.2.3'`.
// Strip the prefix so esbuild resolves the bare name against node_modules;
// when the package isn't installed here, mark it external so the bundle
// still emits. The worker image is expected to provide it.
const npmSpecifierPlugin: Plugin = {
  name: 'npm-specifier',
  setup(b) {
    b.onResolve({ filter: /^npm:/ }, async (args) => {
      const bare = args.path
        .slice(4)
        .replace(/^(@[^/]+\/[^/@]+)@[^/]*/, '$1')
        .replace(/^([^/@]+)@[^/]*/, '$1');
      const resolved = await b.resolve(bare, {
        resolveDir: args.resolveDir,
        kind: args.kind,
      });
      if (resolved.errors.length > 0) {
        return { path: bare, external: true, errors: [], warnings: [] };
      }
      return resolved;
    });
  },
};

// LRU-capped cache. Worker daemon is long-lived; one entry per recently-used
// connector. See the matching cache in
// `packages/server/src/utils/connector-catalog.ts` for the cap rationale.
const COMPILED_FILE_CACHE_MAX = 8;
const compiledFileCache = new Map<string, { mtimeMs: number; code: string }>();

function touchCacheEntry(filePath: string, entry: { mtimeMs: number; code: string }): void {
  compiledFileCache.delete(filePath);
  compiledFileCache.set(filePath, entry);
  while (compiledFileCache.size > COMPILED_FILE_CACHE_MAX) {
    const oldest = compiledFileCache.keys().next().value;
    if (oldest === undefined) break;
    compiledFileCache.delete(oldest);
  }
}

export async function compileConnectorFromFile(filePath: string): Promise<string> {
  let mtimeMs: number | null = null;
  try {
    mtimeMs = (await stat(filePath)).mtimeMs;
    const cached = compiledFileCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      touchCacheEntry(filePath, cached);
      return cached.code;
    }
  } catch {
    // stat failed — let the build surface the real error.
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'lobu-connector-worker-'));
  const outPath = join(tmpDir, 'out.mjs');

  try {
    await build({
      entryPoints: [filePath],
      outfile: outPath,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      alias: { lobu: SDK_ENTRY, '@lobu/connector-sdk': SDK_ENTRY },
      banner: {
        js: `import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);`,
      },
      plugins: [npmSpecifierPlugin],
      external: [...EXTERNAL_RUNTIME_DEPS],
      write: true,
      minify: false,
      sourcemap: false,
    });

    const code = await readFile(outPath, 'utf-8');
    if (mtimeMs !== null) touchCacheEntry(filePath, { mtimeMs, code });
    return code;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
