import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { extractConnectorMetadata } from './connector-compiler';
import logger from './logger';

const require_ = createRequire(import.meta.url);
const SDK_ENTRY = require_.resolve('@lobu/owletto-sdk');

const DEFAULT_CONNECTOR_DIR_CANDIDATES = [
  resolve(import.meta.dirname ?? __dirname, '../../../owletto-connectors/src'),
  resolve(import.meta.dirname ?? __dirname, '../../connectors'),
  resolve(import.meta.dirname ?? __dirname, '../../../connectors'),
  resolve(import.meta.dirname ?? __dirname, '../../../../../connectors'),
  resolve(process.cwd(), 'packages/owletto-connectors/src'),
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

export function findBundledConnectorFile(key: string): string | null {
  const filePath = resolve(getDefaultConnectorCatalogDir(), `${key.replace(/\./g, '_')}.ts`);
  return existsSync(filePath) ? filePath : null;
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

export async function compileConnectorFromFile(filePath: string): Promise<string> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'owletto-connector-'));
  const outPath = join(tmpDir, 'out.mjs');

  try {
    await build({
      entryPoints: [filePath],
      outfile: outPath,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      alias: { owletto: SDK_ENTRY, '@lobu/owletto-sdk': SDK_ENTRY },
      banner: {
        js: `import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);`,
      },
      plugins: [npmSpecifierPlugin],
      // Must mirror EXTERNAL_RUNTIME_DEPS in packages/owletto-worker/src/runtime-deps.ts.
      // Only natives / runtime-installed deps (playwright ships browsers via
      // `npx playwright install`) belong here. Pure JS deps (pino, link-preview-js)
      // must be bundled — externalising them previously caused every connector
      // run to fail with "Cannot find package 'pino'" because the worker image
      // didn't ship them.
      external: ['playwright', 'sharp', 'jimp'],
      write: true,
      minify: false,
      sourcemap: false,
    });

    return await readFile(outPath, 'utf-8');
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
