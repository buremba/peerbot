import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createConnectorCompiler,
  findBundledConnectorFile as findInDirs,
} from '@lobu/connector-worker/compile';
import { extractConnectorMetadata } from './connector-compiler';
import logger from './logger';

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

const connectorCompiler = createConnectorCompiler({
  onUnresolvedNpm: ({ bareSpecifier, importer }) => {
    // Package isn't installed in this image — externalize so the bundle
    // still produces. Worker runtime supplies the implementation.
    // Log so an actual typo or missing-dep regression is diagnosable
    // rather than silently producing a bundle that crashes at runtime.
    logger.warn(
      { package: bareSpecifier, importer },
      'externalising npm:* import — package not resolvable in gateway image (worker runtime must provide it)'
    );
  },
});

type CachedMetadata =
  | {
      mtimeMs: number;
      value: ExtractedConnectorCatalogMetadata | null;
    }
  | undefined;

export type ExtractedConnectorCatalogMetadata = {
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
  const found = findInDirs(key, DEFAULT_CONNECTOR_DIR_CANDIDATES);
  bundledFileCache.set(key, found);
  return found;
}

// Derive the persisted source_path (relative to the bundled-connectors
// catalog dir) for a file resolved by findBundledConnectorFile. Used by
// auto-install / device-reconcile so subdir-grouped connectors
// (`browser/evaluate.ts`) round-trip correctly through
// `connectorSourcePathToUri`. Falls back to basename if the file lives
// outside every known candidate (shouldn't happen in practice, but keeps
// the call site simple).
export function bundledConnectorSourcePath(filePath: string): string {
  for (const dir of DEFAULT_CONNECTOR_DIR_CANDIDATES) {
    if (filePath.startsWith(`${dir}/`)) {
      return relative(dir, filePath);
    }
  }
  return relative(resolve(filePath, '..'), filePath);
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

// `compileConnectorFromFile` is owned by `@lobu/connector-worker/compile`
// (LRU-capped at 8 entries, keyed by file mtime, identical to the previous
// implementation that lived here — see lobu#771 for the cap rationale).
// Re-exported here so existing server callers keep their import paths.
export const compileConnectorFromFile = connectorCompiler.compileConnectorFromFile;

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

const CATALOG_MANIFEST_VERSION = 1;

/**
 * Filename of the build-time catalog manifest written next to the bundled
 * connector sources (see `scripts/build-connector-catalog-manifest.ts`). It maps
 * each connector file (path relative to the catalog dir, POSIX separators) to its
 * already-extracted metadata, so the runtime can serve the bundled catalog
 * WITHOUT compiling ~35 connectors on demand. That cold per-pod scan (esbuild +
 * a forked subprocess per connector, run serially) overran the request timeout
 * on freshly-rolled, CPU-limited prod replicas and returned 503 to the "Add a
 * connection" picker, which then rendered an empty "No connectors found".
 *
 * Files NOT covered by the manifest (custom `CONNECTOR_CATALOG_URIS` dirs, a
 * missing/stale/corrupt manifest) still fall back to on-demand compilation, so
 * the dynamic runtime path is fully preserved.
 */
export const CATALOG_MANIFEST_FILENAME = '.catalog-manifest.json';

export interface CatalogManifest {
  version: number;
  // null = file carries no ConnectorRuntime class (utility/index file). Recorded
  // so the runtime doesn't recompile it just to rediscover it's not a connector.
  entries: Record<string, ExtractedConnectorCatalogMetadata | null>;
}

// mtime-keyed so a regenerated manifest (dev) is picked up, and a known-bad
// manifest isn't re-warned on every request.
const manifestCache = new Map<
  string,
  { mtimeMs: number; entries: CatalogManifest['entries'] | null }
>();

// Manifests are keyed by POSIX-relative path so a manifest built on Linux (CI)
// matches lookups on any runtime OS; mismatches simply fall back to compilation.
function toPosixRelative(dirPath: string, filePath: string): string {
  return relative(dirPath, filePath).split(sep).join('/');
}

async function loadCatalogManifest(dirPath: string): Promise<CatalogManifest['entries'] | null> {
  const manifestPath = join(dirPath, CATALOG_MANIFEST_FILENAME);
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(manifestPath)).mtimeMs;
  } catch {
    return null; // no manifest → on-demand compilation path
  }

  const cached = manifestCache.get(manifestPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.entries;

  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf-8')) as CatalogManifest;
    if (parsed?.version !== CATALOG_MANIFEST_VERSION || typeof parsed.entries !== 'object') {
      manifestCache.set(manifestPath, { mtimeMs, entries: null });
      return null;
    }
    manifestCache.set(manifestPath, { mtimeMs, entries: parsed.entries });
    return parsed.entries;
  } catch (error) {
    logger.warn(
      {
        manifest_path: manifestPath,
        error: error instanceof Error ? error.message : String(error),
      },
      'Ignoring unreadable connector catalog manifest; falling back to on-demand compilation'
    );
    manifestCache.set(manifestPath, { mtimeMs, entries: null });
    return null;
  }
}

/**
 * Two-level scan of a catalog directory for connector source files. Shared by
 * the runtime loader and the build-time manifest generator so the manifest
 * covers exactly the set the runtime would scan. One level deep so primitive
 * groupings like `browser/*.ts` are discovered alongside top-level service
 * connectors; connectors don't currently nest deeper.
 */
async function collectConnectorSourceFiles(dirPath: string): Promise<string[]> {
  const candidatePaths: string[] = [];
  const topEntries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of topEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = resolve(dirPath, entry.name);
    if (entry.isFile()) {
      if (extname(entry.name) !== '.ts' || entry.name.endsWith('.d.ts')) continue;
      candidatePaths.push(entryPath);
      continue;
    }
    if (entry.isDirectory()) {
      // Skip private / non-connector folders. `__tests__` ships test files that
      // import `bun:test`, which esbuild can't resolve; any leading-underscore
      // name is by convention not a connector grouping.
      if (entry.name === '__tests__' || entry.name.startsWith('_')) continue;
      try {
        const subEntries = await readdir(entryPath, { withFileTypes: true });
        for (const sub of subEntries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!sub.isFile()) continue;
          if (extname(sub.name) !== '.ts' || sub.name.endsWith('.d.ts')) continue;
          candidatePaths.push(resolve(entryPath, sub.name));
        }
      } catch {
        // Subdir unreadable — skip silently; don't fail the whole catalog.
      }
    }
  }
  return candidatePaths;
}

// Manifest hit → precomputed metadata (may be null = known non-connector, skip).
// Manifest miss → compile + extract on demand (custom catalog dirs, or a bundled
// file the manifest doesn't cover). Preserves the dynamic runtime path.
async function resolveConnectorCatalogMetadata(
  filePath: string,
  dirPath: string,
  manifest: CatalogManifest['entries'] | null
): Promise<ExtractedConnectorCatalogMetadata | null> {
  if (manifest) {
    const rel = toPosixRelative(dirPath, filePath);
    if (Object.hasOwn(manifest, rel)) return manifest[rel];
  }
  return extractConnectorCatalogMetadata(filePath);
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

    const manifest = await loadCatalogManifest(dirPath);
    const candidatePaths = await collectConnectorSourceFiles(dirPath);

    for (const filePath of candidatePaths) {
      const metadata = await resolveConnectorCatalogMetadata(filePath, dirPath, manifest);
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
        // Preserve subdirectory in source_path so worker resolvers can
        // find `browser/evaluate.ts` etc. without colliding on basename.
        source_path: relative(dirPath, filePath),
        source_uri: pathToFileURL(filePath).toString(),
        installed: false,
        installable: true,
        catalog_origin: 'catalog',
      });
    }
  }

  return definitions.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build-time: compile every bundled connector once and capture its metadata so
 * the runtime serves the catalog without on-demand compilation. Non-connector
 * files are stored as `null` so they aren't recompiled at runtime. Invoked by
 * `scripts/build-connector-catalog-manifest.ts`.
 */
export async function generateCatalogManifest(dirPath: string): Promise<CatalogManifest> {
  const entries: CatalogManifest['entries'] = {};
  for (const filePath of await collectConnectorSourceFiles(dirPath)) {
    entries[toPosixRelative(dirPath, filePath)] = await extractConnectorCatalogMetadata(filePath);
  }
  return { version: CATALOG_MANIFEST_VERSION, entries };
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
