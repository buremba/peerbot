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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
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
        `Unsupported import "${specifier}". ${label} sources must be single-file and may only import from owletto, npm:... specifiers, or published packages.`
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
        owletto: SDK_ENTRY,
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
            'If this source imports local project modules, replace them with owletto or npm: imports.'
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
 * Step 2: Extract metadata from compiled code via subprocess.
 * Spawns a child process to safely instantiate the class and read metadata.
 */
export async function extractMetadata<TMetadata>(
  compiledCode: string,
  config: ExtractConfig
): Promise<TMetadata> {
  const tmpDir = await mkdtemp(join(process.cwd(), config.tmpPrefix));

  try {
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
          reject(new Error(`Metadata extraction failed: ${msg.error}`));
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
                ? `Metadata extraction subprocess exited with code ${code}: ${stderr}`
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
