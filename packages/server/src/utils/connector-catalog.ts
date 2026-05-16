import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { EXTERNAL_RUNTIME_DEPS } from '../../../connector-worker/src/runtime-deps';
import { extractConnectorMetadata } from './connector-compiler';
import logger from './logger';

const require_ = createRequire(import.meta.url);
const SDK_ENTRY = require_.resolve('@lobu/connector-sdk');

const DEFAULT_CONNECTOR_DIR_CANDIDATES = [
  // Published CLI runtime: packages/cli/scripts/build.cjs copies bundled
  // connector source files next to server.bundle.mjs at dist/connectors.
  resolve(import.meta.dirname ?? __dirname, 'connectors'),
  // Local monorepo source and built-server layouts.
  resolve(import.meta.dirname ?? __dirname, '../../../connectors/src'),
  resolve(import.meta.dirname ?? __dirname, '../../connectors'),
  resolve(import.meta.dirname ?? __dirname, '../../../connectors'),
  resolve(import.meta.dirname ?? __dirname, '../../../../../connectors'),
  // Explicit project/runtime roots for dev and custom deployments.
  resolve(process.cwd(), 'packages/connectors/src'),
  resolve(process.cwd(), 'connectors'),
];

// Connectors declare their npm deps via `import x from 'npm:foo@1.2.3'`. This
// plugin strips the prefix so esbuild can resolve the bare package against
// node_modules. When the package isn't installed in the gateway image (e.g.
// heavyweight deps like `baileys` that only the worker pod needs), we mark
// the import as external rather than failing the whole bundle. The bundle
// still emits `import 'baileys'` and the worker — which has those packages
// installed — can run it. Without this, one un-installable npm dep takes
// down the entire connector-catalog path, breaking /api/workers/poll for
// every worker.
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
        // Package isn't installed in this image — externalize so the bundle
        // still produces. Worker runtime supplies the implementation.
        // Log so an actual typo or missing-dep regression is diagnosable
        // rather than silently producing a bundle that crashes at runtime.
        logger.warn(
          { package: bare, importer: args.importer },
          'externalising npm:* import — package not resolvable in gateway image (worker runtime must provide it)'
        );
        return { path: bare, external: true, errors: [], warnings: [] };
      }
      return resolved;
    });
  },
};

type CachedMetadata =
  | {
      mtimeMs: number;
      value: ExtractedConnectorCatalogMetadata | null;
    }
  | undefined;

type ExtractedConnectorCatalogMetadata = {
  key: string;
  name: string;
  description: string | null;
  version: string;
  auth_schema: Record<string, unknown> | null;
  feeds_schema: Record<string, unknown> | null;
  actions_schema: Record<string, unknown> | null;
  options_schema: Record<string, unknown> | null;
  mcp_config: Record<string, unknown> | null;
  openapi_config: Record<string, unknown> | null;
  favicon_domain: string | null;
  required_capability: string | null;
  runtime: Record<string, unknown> | null;
  login_enabled: boolean;
};

interface CatalogConnectorDefinition {
  key: string;
  name: string;
  description: string | null;
  version: string;
  auth_schema: Record<string, unknown> | null;
  feeds_schema: Record<string, unknown> | null;
  actions_schema: Record<string, unknown> | null;
  options_schema: Record<string, unknown> | null;
  favicon_domain: string | null;
  required_capability: string | null;
  runtime: Record<string, unknown> | null;
  status: 'active';
  login_enabled: boolean;
  source_path: string;
  source_uri: string;
  installed: false;
  installable: true;
  catalog_origin: 'catalog';
}

const metadataCache = new Map<string, CachedMetadata>();

function normalizeLocalPath(pathValue: string): string {
  return resolve(pathValue);
}

export function getDefaultConnectorCatalogDir(): string {
  for (const candidate of DEFAULT_CONNECTOR_DIR_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return DEFAULT_CONNECTOR_DIR_CANDIDATES[0];
}

function getDefaultConnectorCatalogUri(): string {
  return pathToFileURL(getDefaultConnectorCatalogDir()).toString();
}

// Bundled connector files don't appear/disappear at runtime, and this is now
// consulted on every feed sync / worker poll — memoise the lookup.
const bundledFileCache = new Map<string, string | null>();

export function findBundledConnectorFile(key: string): string | null {
  const cached = bundledFileCache.get(key);
  if (cached !== undefined) return cached;
  const fileName = `${key.replace(/\./g, '_')}.ts`;
  let found: string | null = null;
  for (const candidate of DEFAULT_CONNECTOR_DIR_CANDIDATES) {
    const filePath = resolve(candidate, fileName);
    if (existsSync(filePath)) {
      found = filePath;
      break;
    }
  }
  bundledFileCache.set(key, found);
  return found;
}

export function normalizeFileSourceUri(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (!trimmed.includes('://')) {
    return pathToFileURL(normalizeLocalPath(trimmed)).toString();
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'file:') {
    return null;
  }

  return pathToFileURL(normalizeLocalPath(fileURLToPath(parsed))).toString();
}

export function resolveFileSourcePath(value: string): string | null {
  const normalized = normalizeFileSourceUri(value);
  if (!normalized) return null;
  return fileURLToPath(normalized);
}

export function getConfiguredConnectorCatalogUris(rawUris?: string): string[] {
  const configured = rawUris
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!configured || configured.length === 0) {
    return [getDefaultConnectorCatalogUri()];
  }

  const normalized = new Set<string>();

  for (const entry of configured) {
    const uri = normalizeFileSourceUri(entry);
    if (!uri) {
      logger.warn({ catalog_uri: entry }, 'Ignoring unsupported connector catalog URI');
      continue;
    }
    normalized.add(uri);
  }

  return [...normalized];
}

// Compiling a connector spawns esbuild; on the hot paths (feed sync, worker
// poll) the same bundled .ts file is recompiled repeatedly. Cache the output
// keyed by file mtime so a recompile only happens when the source actually
// changes. Process restart (= deploy, = SDK rebuild) clears it.
//
// LRU-capped: each entry is the full compiled bundle (~13 MB today, smaller
// once non-essential transitive deps are externalized — see
// EXTERNAL_RUNTIME_DEPS). Before the cap, prod was seeing the cache hold
// every connector's bundle indefinitely (~29 × 13 MB = 384 MB resident, the
// dominant heap occupant under the 1 GiB pod limit; see lobu#771 postmortem
// for the heap-snapshot trail). The cap keeps the cache to the working set
// of recently-used connectors and lets V8 reclaim the rest.
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
      // Move to end of insertion order = mark as most-recently-used.
      touchCacheEntry(filePath, cached);
      return cached.code;
    }
  } catch {
    // stat failed — fall through and let the build surface the real error.
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
      alias: { lobu: SDK_ENTRY, '@lobu/connector-sdk': SDK_ENTRY },
      banner: {
        js: `import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);`,
      },
      plugins: [npmSpecifierPlugin],
      // Single source of truth: EXTERNAL_RUNTIME_DEPS in
      // packages/connector-worker/src/runtime-deps.ts. Only natives /
      // runtime-installed deps belong there (playwright ships browsers via
      // `npx playwright install`). Pure JS deps (pino, link-preview-js) must be
      // bundled — externalising them previously caused every connector run to
      // fail with "Cannot find package 'pino'" because the worker image didn't
      // ship them.
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

async function extractConnectorCatalogMetadata(
  filePath: string
): Promise<ExtractedConnectorCatalogMetadata | null> {
  const fileStat = await stat(filePath);
  const cached = metadataCache.get(filePath);

  if (cached && cached.mtimeMs === fileStat.mtimeMs) {
    return cached.value;
  }

  try {
    const compiledCode = await compileConnectorFromFile(filePath);
    const metadata = await extractConnectorMetadata(compiledCode);

    if (!metadata.key || !metadata.name || !metadata.version) {
      metadataCache.set(filePath, { mtimeMs: fileStat.mtimeMs, value: null });
      return null;
    }

    const value = {
      key: metadata.key,
      name: metadata.name,
      description: metadata.description ?? null,
      version: metadata.version,
      auth_schema: metadata.authSchema ?? null,
      feeds_schema: metadata.feeds ?? null,
      actions_schema: metadata.actions ?? null,
      options_schema: metadata.optionsSchema ?? null,
      mcp_config: metadata.mcpConfig ?? null,
      openapi_config: metadata.openapiConfig ?? null,
      favicon_domain: metadata.faviconDomain ?? null,
      required_capability: metadata.requiredCapability ?? null,
      runtime: (metadata.runtime as Record<string, unknown> | undefined) ?? null,
      login_enabled: false,
    } satisfies ExtractedConnectorCatalogMetadata;

    metadataCache.set(filePath, { mtimeMs: fileStat.mtimeMs, value });
    return value;
  } catch (error) {
    logger.warn(
      { file_path: filePath, error: error instanceof Error ? error.message : String(error) },
      'Skipping connector catalog entry after metadata extraction failed'
    );
    metadataCache.set(filePath, { mtimeMs: fileStat.mtimeMs, value: null });
    return null;
  }
}

export async function listCatalogConnectorDefinitions(
  rawUris?: string
): Promise<CatalogConnectorDefinition[]> {
  const definitions: CatalogConnectorDefinition[] = [];
  const seenKeys = new Set<string>();

  for (const catalogUri of getConfiguredConnectorCatalogUris(rawUris)) {
    const dirPath = resolveFileSourcePath(catalogUri);
    if (!dirPath) continue;

    let dirStat;
    try {
      dirStat = await stat(dirPath);
    } catch {
      logger.warn({ catalog_uri: catalogUri }, 'Skipping missing connector catalog directory');
      continue;
    }

    if (!dirStat.isDirectory()) {
      logger.warn(
        { catalog_uri: catalogUri },
        'Skipping connector catalog URI that is not a directory'
      );
      continue;
    }

    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile()) continue;
      if (extname(entry.name) !== '.ts' || entry.name.endsWith('.d.ts')) continue;

      const filePath = resolve(dirPath, entry.name);
      const metadata = await extractConnectorCatalogMetadata(filePath);
      if (!metadata || seenKeys.has(metadata.key)) continue;

      seenKeys.add(metadata.key);
      definitions.push({
        key: metadata.key,
        name: metadata.name,
        description: metadata.description,
        version: metadata.version,
        auth_schema: metadata.auth_schema,
        feeds_schema: metadata.feeds_schema,
        actions_schema: metadata.actions_schema,
        options_schema: metadata.options_schema,
        favicon_domain: metadata.favicon_domain,
        required_capability: metadata.required_capability,
        runtime: metadata.runtime,
        status: 'active',
        login_enabled: metadata.login_enabled,
        source_path: basename(filePath),
        source_uri: pathToFileURL(filePath).toString(),
        installed: false,
        installable: true,
        catalog_origin: 'catalog',
      });
    }
  }

  return definitions.sort((a, b) => a.name.localeCompare(b.name));
}

/** A bundled connector that runs on a device worker rather than the cloud fleet. */
export interface BundledDeviceConnector {
  /** Connector key, e.g. `apple.screen_time`. */
  key: string;
  /** Worker capability the device must advertise to run it, e.g. `screentime`. */
  requiredCapability: string;
  /** Feed keys declared by the bundled source. Used to heal partially-wired installs. */
  feedKeys: string[];
}

/**
 * Bundled connectors that are device-bound: they declare both a `runtime` block
 * and a `requiredCapability` gate, which together mean "only a device worker
 * advertising that capability can run me" (e.g. apple.screen_time on the Lobu
 * Lobu for Mac). The gateway auto-wires these into a user's personal org when a
 * device advertises the capability — nothing about which connectors those are
 * is hardcoded; it's derived from the connector definitions in the catalog.
 */
export async function getBundledDeviceConnectors(): Promise<BundledDeviceConnector[]> {
  const defs = await listCatalogConnectorDefinitions();
  return defs
    .filter((d) => d.runtime != null && typeof d.required_capability === 'string')
    .map((d) => ({
      key: d.key,
      requiredCapability: d.required_capability as string,
      // Exclude `userManaged` feeds — they require per-instance config the
      // auto-wire flow can't supply (e.g. local.directory.files needs a
      // folder_id from the Mac app). The Mac app creates them explicitly.
      feedKeys:
        d.feeds_schema && typeof d.feeds_schema === 'object' && !Array.isArray(d.feeds_schema)
          ? Object.entries(d.feeds_schema as Record<string, { userManaged?: boolean }>)
              .filter(([, def]) => !def?.userManaged)
              .map(([key]) => key)
          : [],
    }));
}
