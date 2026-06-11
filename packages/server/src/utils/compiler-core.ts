/**
 * Shared compiler infrastructure for connector compilation.
 *
 * Two-step process:
 * 1. esbuild compilation (safe, pure text transform — no code execution):
 *    - Validates imports, rewrites npm: specifiers, bundles via esbuild
 *    - Produces compiled_code + compiled_code_hash (SHA-256)
 *
 * 2. Metadata extraction (isolated subprocess):
 *    - Writes compiled JS to temp file
 *    - Forks subprocess with custom runner code
 *    - Returns metadata to the caller
 */

import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { EXTERNAL_RUNTIME_DEPS } from '@lobu/connector-worker/compile';
import { type BuildOptions, build } from 'esbuild';
import logger from './logger';

const require = createRequire(import.meta.url);
const SDK_ENTRY = require.resolve('@lobu/connector-sdk');

export interface CompileResult {
  compiledCode: string;
  compiledCodeHash: string;
}

interface CompileConfig {
  /** Prefix for temp directory names, e.g. '.connector-compile-' */
  tmpPrefix: string;
  /** Label for log/error messages, e.g. 'ConnectorCompiler' */
  label: string;
  /** esbuild overrides beyond the shared defaults */
  buildOptions: Partial<BuildOptions>;
}

interface ExtractConfig {
  /** Prefix for temp directory names, e.g. '.connector-meta-' */
  tmpPrefix: string;
  /** JS code that runs in the subprocess to extract metadata (see runners in each compiler) */
  runnerCode: string;
}

function validateSupportedImports(sourceCode: string, label: string): void {
  const importSpecifiers = new Set<string>();
  const staticImportRe = /\b(?:import|export)\s[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/g;
  const sideEffectImportRe = /\bimport\s+['"]([^'"]+)['"]/g;

  for (const regex of [staticImportRe, sideEffectImportRe]) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(sourceCode)) !== null) {
      importSpecifiers.add(match[1]);
    }
  }

  for (const specifier of importSpecifiers) {
    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('@/')) {
      throw new Error(
        `Unsupported import "${specifier}". ${label} sources must be single-file and may only import from lobu, npm:... specifiers, or published packages.`
      );
    }
  }
}

function rewriteNpmSpecifierImports(sourceCode: string): string {
  return sourceCode.replace(/(['"])npm:([^'"]+)\1/g, (_full, quote, specifier) => {
    const resolved = resolveNpmSpecifier(specifier);
    return `${quote}${resolved}${quote}`;
  });
}

function resolveNpmSpecifier(specifier: string): string {
  const scoped = specifier.startsWith('@');
  const match = scoped
    ? specifier.match(/^(?<pkg>@[^/]+\/[^/@]+)(?:@(?<version>[^/]+))?(?<subpath>\/.*)?$/)
    : specifier.match(/^(?<pkg>[^/@]+)(?:@(?<version>[^/]+))?(?<subpath>\/.*)?$/);

  if (!match?.groups?.pkg) {
    throw new Error(
      `Invalid npm: import specifier "npm:${specifier}". Expected npm:package@version or npm:@scope/package@version.`
    );
  }

  const pkg = match.groups.pkg;
  const subpath = match.groups.subpath ?? '';
  return `${pkg}${subpath}`;
}

export function computeCodeHash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Step 1: Compile TypeScript source to JavaScript.
 * Pure text transform via esbuild — no code execution.
 */
export async function compileSource(
  sourceCode: string,
  config: CompileConfig
): Promise<CompileResult> {
  const tmpDir = await mkdtemp(join(process.cwd(), config.tmpPrefix));

  try {
    const inputPath = join(tmpDir, 'source.ts');
    const outputPath = join(tmpDir, 'source.mjs');
    validateSupportedImports(sourceCode, config.label);
    const normalizedSource = rewriteNpmSpecifierImports(sourceCode);

    await writeFile(inputPath, normalizedSource, 'utf-8');

    const buildOptions: BuildOptions = {
      entryPoints: [inputPath],
      outfile: outputPath,
      bundle: true,
      format: 'esm',
      platform: 'node',
      alias: {
        lobu: SDK_ENTRY,
        '@lobu/connector-sdk': SDK_ENTRY,
      },
      write: true,
      minify: false,
      sourcemap: false,
      ...config.buildOptions,
    };

    try {
      try {
        await build(buildOptions);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('The service is no longer running')) {
          logger.warn(`[${config.label}] esbuild service stopped unexpectedly; retrying once...`);
          await build(buildOptions);
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          `${config.label} compilation failed: ${error.message}. ` +
            'If this source imports local project modules, replace them with lobu or npm: imports.'
        );
      }
      throw error;
    }

    const compiledCode = await readFile(outputPath, 'utf-8');
    const compiledCodeHash = computeCodeHash(compiledCode);

    return { compiledCode, compiledCodeHash };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Bare specifiers the compiled bundle may import at load time: the connector
 * SDK (always externalized by `createConnectorCompiler`) plus the
 * EXTERNAL_RUNTIME_DEPS (native/binary deps esbuild leaves external).
 */
const RUNTIME_PROVIDED_PACKAGES: readonly string[] = [
  '@lobu/connector-sdk',
  ...EXTERNAL_RUNTIME_DEPS,
];

/**
 * Resolve the on-disk package root for a bare specifier, as THIS process (the
 * server, which always has the SDK installed) resolves it. Walks up from the
 * resolved entry file and accepts a directory when its package.json declares
 * the package's name (covers workspace layouts where require.resolve
 * realpath's through a symlink to e.g. `packages/connector-sdk`, outside any
 * node_modules) or when it sits directly under a node_modules dir (covers
 * npm-aliased installs like `playwright` → patchright, whose package.json
 * name differs from the specifier).
 */
function resolvePackageRoot(pkgName: string): string | null {
  let entry: string;
  try {
    entry = require.resolve(pkgName);
  } catch {
    return null;
  }
  let dir = dirname(entry);
  for (let i = 0; i < 30; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      const parent = dirname(dir);
      const underNodeModules =
        basename(parent) === 'node_modules' ||
        (basename(parent).startsWith('@') && basename(dirname(parent)) === 'node_modules');
      if (underNodeModules) return dir;
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
          name?: string;
        };
        if (pkg.name === pkgName) return dir;
      } catch {
        // unreadable/invalid package.json — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const packageRootCache = new Map<string, string | null>();

/**
 * Stage a `node_modules` inside the extraction temp dir with symlinks to the
 * runtime-provided packages, resolved from the server's own installation.
 *
 * Why: the temp dir lives under `process.cwd()`, which for an embedded
 * `lobu run` is the USER'S project directory. The compiled bundle imports
 * `@lobu/connector-sdk` as a bare (externalized) specifier, so Node resolves
 * it by walking up from the temp dir — which only worked when the server's
 * installation happened to be an ancestor. A fresh `lobu init` project has no
 * node_modules, so the first bundled-connector install failed with
 * `Cannot find package '@lobu/connector-sdk'` (#1181). Symlinks (not
 * NODE_PATH) because ESM resolution ignores NODE_PATH entirely. Packages that
 * don't resolve from the server are skipped — the subprocess then falls back
 * to the ancestor walk exactly as before.
 */
async function stageRuntimeProvidedPackages(tmpDir: string): Promise<void> {
  for (const pkgName of RUNTIME_PROVIDED_PACKAGES) {
    if (!packageRootCache.has(pkgName)) {
      packageRootCache.set(pkgName, resolvePackageRoot(pkgName));
    }
    const root = packageRootCache.get(pkgName);
    if (!root) continue;
    const linkPath = join(tmpDir, 'node_modules', pkgName);
    try {
      await mkdir(dirname(linkPath), { recursive: true });
      // 'junction' only matters on Windows (ignored elsewhere); junctions
      // don't need elevated privileges there.
      await symlink(root, linkPath, 'junction');
    } catch (err) {
      logger.warn({ pkgName, err }, 'Failed to stage runtime-provided package for extraction');
    }
  }
}

/**
 * Map a raw extraction failure to an actionable message. Safety net for
 * environments where staging didn't cover resolution: a missing connector SDK
 * means the project's npm deps were never installed, so say exactly that.
 */
export function formatMetadataExtractionError(rawError: string): string {
  const base = `Metadata extraction failed: ${rawError}`;
  if (/Cannot find (?:package|module) '(?:@lobu\/connector-sdk|lobu)'/.test(rawError)) {
    return (
      `${base}. The connector SDK could not be resolved from the project — ` +
      'run `npm install` (or `bun install`) in the project directory to install ' +
      '@lobu/connector-sdk, then retry.'
    );
  }
  return base;
}

/**
 * Step 2: Extract metadata from compiled code via subprocess.
 * Spawns a child process to safely instantiate the class and read metadata.
 */
export async function extractMetadata<TMetadata>(
  compiledCode: string,
  config: ExtractConfig
): Promise<TMetadata> {
  const tmpDir = await mkdtemp(join(process.cwd(), config.tmpPrefix));

  try {
    await stageRuntimeProvidedPackages(tmpDir);
    const codePath = join(tmpDir, 'source.mjs');
    const runnerPath = join(tmpDir, 'runner.mjs');

    await writeFile(codePath, compiledCode, 'utf-8');
    await writeFile(runnerPath, config.runnerCode, 'utf-8');

    const metadata = await new Promise<TMetadata>((resolve, reject) => {
      const child = fork(runnerPath, [codePath], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--max-old-space-size=256'],
        timeout: 30000,
      });

      let resolved = false;
      let stderrOutput = '';

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      child.on('message', (msg: any) => {
        resolved = true;
        if (msg.success) {
          resolve(msg.metadata);
        } else {
          reject(new Error(formatMetadataExtractionError(String(msg.error))));
        }
      });

      child.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Metadata extraction subprocess error: ${err.message}`));
        }
      });

      child.on('exit', (code) => {
        if (!resolved) {
          resolved = true;
          const stderr = stderrOutput.trim();
          reject(
            new Error(
              stderr
                ? formatMetadataExtractionError(`subprocess exited with code ${code}: ${stderr}`)
                : `Metadata extraction subprocess exited with code ${code}`
            )
          );
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.kill('SIGKILL');
          reject(new Error('Metadata extraction timed out after 30s'));
        }
      }, 30000);
    });

    return metadata;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
