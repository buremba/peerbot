import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from './errors.ts';

const BASELINE_PATH = join('db', 'migrations', '00000000000000_baseline.sql');

function findOwlettoRepoRoot(start: string): string | null {
  let dir = resolve(start);

  while (true) {
    if (existsSync(join(dir, BASELINE_PATH))) {
      return dir;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function resolveOwlettoRepoRoot(): string | null {
  const fromCwd = findOwlettoRepoRoot(process.cwd());
  if (fromCwd) return fromCwd;

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return findOwlettoRepoRoot(moduleDir);
}

function findPackagedRuntimeRoot(start: string): string | null {
  let dir = resolve(start);

  while (true) {
    const runtimeRoot = join(dir, 'runtime');
    if (existsSync(join(runtimeRoot, BASELINE_PATH))) {
      return runtimeRoot;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export interface RuntimeRootResolution {
  runtimeRoot: string;
  workspaceRoot: string;
  source: 'repo' | 'packaged';
}

function resolveOwlettoRuntimeRoot(): RuntimeRootResolution | null {
  const repoRoot = resolveOwlettoRepoRoot();
  if (repoRoot) {
    const backendRoot = join(repoRoot, 'packages', 'owletto-backend');
    if (existsSync(join(backendRoot, 'src', 'server.ts'))) {
      return { runtimeRoot: backendRoot, workspaceRoot: repoRoot, source: 'repo' };
    }
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const packagedRoot = findPackagedRuntimeRoot(moduleDir);
  if (packagedRoot) {
    return { runtimeRoot: packagedRoot, workspaceRoot: packagedRoot, source: 'packaged' };
  }

  return null;
}

export function requireOwlettoRuntimeRoot(): RuntimeRootResolution {
  const runtimeRoot = resolveOwlettoRuntimeRoot();
  if (runtimeRoot) return runtimeRoot;

  throw new CliError(
    'Owletto runtime files were not found. Run from an Owletto repo checkout or reinstall the `owletto` package.'
  );
}
