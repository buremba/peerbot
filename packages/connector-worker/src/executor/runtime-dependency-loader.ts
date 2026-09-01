/**
 * Runtime dependency resolver for compiled connector modules.
 *
 * Compiled connectors are staged in private OS temp directories so the runtime
 * never writes into an installed package or requires a writable launch cwd.
 * Bare imports in those modules must nevertheless resolve from the
 * connector-worker installation. The ESM hook and staged node_modules facade
 * provide that rebase for both ESM imports and CommonJS require().
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import { createRequire, register } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { RUNTIME_PROVIDED_PACKAGES } from '../runtime-deps.js';

type ResolveContext = {
  parentURL?: string;
  [key: string]: unknown;
};

type ResolveResult = {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
  [key: string]: unknown;
};

type NextResolve = (
  specifier: string,
  context: ResolveContext
) => Promise<ResolveResult>;

let runtimeAnchorUrl: string | undefined;
let registered = false;
const runtimeRequire = createRequire(import.meta.url);
const packageRootCache = new Map<string, string | null>();

export function isConnectorRuntimeDependency(specifier: string): boolean {
  return RUNTIME_PROVIDED_PACKAGES.some(
    (root) => specifier === root || specifier.startsWith(`${root}/`)
  );
}

/**
 * Find the installed package root for a runtime-provided bare specifier.
 * Accepting both the declared package name and a direct node_modules child
 * covers workspace symlinks as well as npm aliases such as patched Playwright
 * packages whose package.json name differs from the requested specifier.
 */
function resolveRuntimePackageRoot(pkgName: string): string | null {
  let entry: string;
  try {
    entry = runtimeRequire.resolve(pkgName);
  } catch {
    return null;
  }

  let dir = dirname(entry);
  for (let depth = 0; depth < 30; depth++) {
    const packageJsonPath = join(dir, 'package.json');
    if (existsSync(packageJsonPath)) {
      const parent = dirname(dir);
      const underNodeModules =
        basename(parent) === 'node_modules' ||
        (basename(parent).startsWith('@') &&
          basename(dirname(parent)) === 'node_modules');
      if (underNodeModules) return dir;

      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
          name?: string;
        };
        if (pkg.name === pkgName) return dir;
      } catch {
        // Invalid package metadata cannot identify this directory as the root.
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Stage a private node_modules facade beside a compiled connector module.
 * Node's ESM loader hook does not affect createRequire()/CommonJS resolution,
 * so both current and previously persisted bundles need these package links.
 */
export async function stageConnectorRuntimeDependencies(
  tempDir: string
): Promise<void> {
  for (const pkgName of RUNTIME_PROVIDED_PACKAGES) {
    if (!packageRootCache.has(pkgName)) {
      packageRootCache.set(pkgName, resolveRuntimePackageRoot(pkgName));
    }
    const root = packageRootCache.get(pkgName);
    if (!root) {
      throw new Error(
        `Connector runtime is missing required package '${pkgName}'. ` +
          `It must resolve from @lobu/connector-worker's installed dependency graph; ` +
          `reinstall the matching runtime artifact before advertising connector capabilities.`
      );
    }

    const linkPath = join(tempDir, 'node_modules', pkgName);
    await mkdir(dirname(linkPath), { recursive: true });
    // Junctions avoid elevated symlink privileges on Windows and are ignored
    // as a special type on POSIX, where the target remains an absolute link.
    await symlink(root, linkPath, 'junction');
  }
}

/** Receive the connector-worker module URL in the isolated loader thread. */
export function initialize(data: unknown): void {
  const anchor =
    data && typeof data === 'object'
      ? (data as { runtimeAnchorUrl?: unknown }).runtimeAnchorUrl
      : undefined;
  if (typeof anchor !== 'string' || anchor.length === 0) {
    throw new Error('connector runtime dependency loader received no anchor URL');
  }
  runtimeAnchorUrl = anchor;
}

/**
 * Resolve runtime-provided connector dependencies as though the import
 * originated inside connector-worker. Delegating to Node's next resolver keeps
 * package export conditions (including import-only SDK subpaths) intact.
 */
export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve
): Promise<ResolveResult> {
  if (!runtimeAnchorUrl || !isConnectorRuntimeDependency(specifier)) {
    return nextResolve(specifier, context);
  }
  return nextResolve(specifier, {
    ...context,
    parentURL: runtimeAnchorUrl,
  });
}

/**
 * Install the resolver once in this process before importing a compiled
 * connector. Bun's source-mode resolver already runs from the workspace graph;
 * the loader is for the Node runtime used by published packages and images.
 */
export function registerConnectorRuntimeDependencyLoader(): void {
  if (
    registered ||
    typeof (process.versions as { bun?: string }).bun === 'string'
  ) {
    return;
  }
  register(import.meta.url, {
    parentURL: import.meta.url,
    data: { runtimeAnchorUrl: import.meta.url },
  });
  registered = true;
}
