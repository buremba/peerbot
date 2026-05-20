/**
 * Shared connector compile pipeline.
 *
 * Three packages (`@lobu/connector-worker` itself, `@lobu/cli`, and
 * `@lobu/server`) each used to ship their own near-identical copies of:
 *
 *   - `findBundledConnectorFile(key)` — walks a list of candidate dirs
 *     trying both filename conventions (`browser.evaluate → browser/evaluate.ts`
 *     and `chrome.tabs → chrome_tabs.ts`).
 *   - `compileConnectorFromFile(filePath)` — esbuild bundle with the
 *     `npm:` specifier plugin, the `lobu` / `@lobu/connector-sdk` aliases,
 *     `EXTERNAL_RUNTIME_DEPS` externalised, and an mtime-keyed LRU cache.
 *   - The `npm:` specifier resolver plugin.
 *   - The `EXTERNAL_RUNTIME_DEPS` constant.
 *
 * Three copies meant three "keep these in sync" comments and three places
 * to fix every esbuild-flag or candidate-dir change. This module is the
 * one place that owns those mechanics; each caller supplies its own
 * candidate-dir list (and optional warn hook) since those are genuinely
 * environment-specific (gateway pod vs worker pod vs npm-installed CLI).
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, type Plugin } from 'esbuild';
import { EXTERNAL_RUNTIME_DEPS } from '../runtime-deps.js';

export { assertExternalDepsResolvable, EXTERNAL_RUNTIME_DEPS } from '../runtime-deps.js';

// Strict regex for connector_key: lowercase letters/digits, optional dots
// for namespacing, underscores for word separators. Defense-in-depth even
// though keys come from a trusted DB column — we're about to use the value
// to construct a filesystem path.
const CONNECTOR_KEY_RE = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/;

/**
 * Resolve a connector_key to a `.ts` source file under one of the supplied
 * candidate directories.
 *
 * Tries two filename conventions in order:
 *   - subdirectory layout: `browser.evaluate` → `browser/evaluate.ts`
 *     (lets us group related primitives without renaming the key);
 *   - flat-with-underscores: `chrome.tabs` → `chrome_tabs.ts`
 *     (existing convention).
 *
 * Returns the absolute path of the first match, or `null` if none exists.
 * Performs no caching of its own — callers that hit this on a hot path
 * (gateway worker-poll, CLI compile loop) can layer their own memo on
 * top, since the right TTL depends on whether they expect new connector
 * files to appear at runtime.
 */
export function findBundledConnectorFile(
  key: string,
  candidateDirs: readonly string[]
): string | null {
  if (!CONNECTOR_KEY_RE.test(key)) return null;
  const candidates = [
    `${key.replace(/\./g, '/')}.ts`,
    `${key.replace(/\./g, '_')}.ts`,
  ];
  for (const dir of candidateDirs) {
    for (const fileName of candidates) {
      const filePath = resolve(dir, fileName);
      // Belt-and-braces: the resolved path must stay under the candidate
      // dir. CONNECTOR_KEY_RE already forbids `..`, but the regex doesn't
      // know about our path-joining choices.
      if (!filePath.startsWith(`${dir}/`)) continue;
      if (existsSync(filePath)) return filePath;
    }
  }
  return null;
}

/**
 * Resolve the `@lobu/connector-sdk` module entry from this module's
 * perspective. Used as the esbuild `alias` target so connector code that
 * imports `from 'lobu'` or `from '@lobu/connector-sdk'` resolves to the
 * same physical file the runtime will import — avoiding the
 * `instanceof ConnectorRuntime` cross-realm trap.
 */
function resolveSdkEntry(): string {
  const require_ = createRequire(import.meta.url);
  return require_.resolve('@lobu/connector-sdk');
}

interface NpmSpecifierPluginOptions {
  /**
   * Called when a `npm:foo@1.2.3` import resolves to a package that's not
   * installed in the current environment. The plugin externalises the
   * import (so the bundle still emits) and the runtime must supply it.
   * Use this hook to log / surface the externalisation.
   */
  onUnresolved?: (info: { bareSpecifier: string; importer: string }) => void;
}

/**
 * esbuild plugin that strips the `npm:` prefix from connector imports
 * (`import x from 'npm:foo@1.2.3'`) and resolves the bare specifier
 * against node_modules. When the package isn't installed in the build
 * environment, externalises so the bundle still produces — the runtime
 * is expected to provide it.
 */
export function createNpmSpecifierPlugin(options?: NpmSpecifierPluginOptions): Plugin {
  return {
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
          options?.onUnresolved?.({ bareSpecifier: bare, importer: args.importer });
          return { path: bare, external: true, errors: [], warnings: [] };
        }
        return resolved;
      });
    },
  };
}

interface CompileOptions {
  /**
   * Max entries kept in the mtime-keyed LRU. Each entry is the full
   * compiled bundle (~13 MB today, smaller as transitive deps are
   * externalised). Cap default 8 keeps memory bounded; pass a smaller
   * value in memory-constrained environments.
   * @default 8
   */
  cacheMax?: number;
  /**
   * Override the `@lobu/connector-sdk` entry esbuild aliases against.
   * Defaults to the SDK resolved from this module's `require.resolve`.
   * Overriding is only useful when the caller knows of a more
   * appropriate physical file (e.g. a server bundle that wants to point
   * back at a sibling dist file).
   */
  sdkEntry?: string;
  /**
   * Hook fired when `npm:` specifiers fail to resolve and the import is
   * externalised. Forwarded to `createNpmSpecifierPlugin`.
   */
  onUnresolvedNpm?: NpmSpecifierPluginOptions['onUnresolved'];
}

const DEFAULT_CACHE_MAX = 8;

/**
 * Compile a single connector source file to an ESM bundle string,
 * suitable for the executor's subprocess `import()` step.
 *
 * The returned bundle:
 *   - is ESM (`format: 'esm'`, `target: 'node20'`);
 *   - aliases `lobu` and `@lobu/connector-sdk` to the SDK entry so
 *     connectors targeting either specifier resolve to the same module;
 *   - has a banner injecting a CJS-compatible `require` shim;
 *   - externalises `EXTERNAL_RUNTIME_DEPS` (native deps + Playwright);
 *   - is mtime-cached: a repeat call with the same `filePath` whose
 *     mtime hasn't changed returns the cached bundle without hitting
 *     esbuild.
 */
export function createConnectorCompiler(options?: CompileOptions) {
  const cacheMax = options?.cacheMax ?? DEFAULT_CACHE_MAX;
  const sdkEntry = options?.sdkEntry ?? resolveSdkEntry();
  const compiledFileCache = new Map<string, { mtimeMs: number; code: string }>();
  const plugin = createNpmSpecifierPlugin({ onUnresolved: options?.onUnresolvedNpm });

  function touchCacheEntry(filePath: string, entry: { mtimeMs: number; code: string }): void {
    compiledFileCache.delete(filePath);
    compiledFileCache.set(filePath, entry);
    while (compiledFileCache.size > cacheMax) {
      const oldest = compiledFileCache.keys().next().value;
      if (oldest === undefined) break;
      compiledFileCache.delete(oldest);
    }
  }

  async function compileConnectorFromFile(filePath: string): Promise<string> {
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

    const tmpDir = await mkdtemp(join(tmpdir(), 'lobu-connector-'));
    const outPath = join(tmpDir, 'out.mjs');

    try {
      await build({
        entryPoints: [filePath],
        outfile: outPath,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        alias: { lobu: sdkEntry, '@lobu/connector-sdk': sdkEntry },
        banner: {
          js: `import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);`,
        },
        plugins: [plugin],
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

  return { compileConnectorFromFile };
}
