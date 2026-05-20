/**
 * Ensure a connector project's npm dependencies are installed before the CLI
 * compiles its connectors. esbuild bundles a connector's imports relative to
 * the connector file's directory, so the project's own `node_modules` (next to
 * `package.json`) must exist. We run `bun install --ignore-scripts` when stale:
 * `--ignore-scripts` keeps install-time supply-chain surface off the user's
 * machine — packages that need build scripts (native bindings) belong in
 * `runtime.nix.packages`, not bundled npm.
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// Per-process memo so `lobu apply` installs each project root at most once.
const ensuredRoots = new Set<string>();

/**
 * Find the connector's project root — the nearest ancestor with `lobu.toml`.
 * Anchoring on `lobu.toml` (not any ancestor `package.json`) is what stops a
 * connector inside a monorepo from resolving to the monorepo's root
 * package.json and triggering a wrong-directory install.
 */
export function findProjectRoot(fromFile: string): string | null {
  let dir = dirname(fromFile);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, "lobu.toml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function installIsStale(root: string): boolean {
  const nodeModules = join(root, "node_modules");
  if (!existsSync(nodeModules)) return true;
  const lock = join(root, "bun.lock");
  if (!existsSync(lock)) return false; // deps present, no lockfile to compare against
  try {
    return statSync(lock).mtimeMs > statSync(nodeModules).mtimeMs;
  } catch {
    return false;
  }
}

function hasBun(): boolean {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Install the connector project's deps if missing/stale. No-op when the
 * connector has no `package.json` (no declared npm deps to bundle).
 */
export function ensureProjectDepsInstalled(
  connectorFilePath: string,
  log: (message: string) => void
): void {
  const root = findProjectRoot(connectorFilePath);
  if (!root || ensuredRoots.has(root)) return;
  // No package.json at the project root → the connector declares no npm deps
  // (the SDK is runtime-provided/externalized), so there's nothing to install.
  if (!existsSync(join(root, "package.json"))) {
    ensuredRoots.add(root);
    return;
  }
  if (!installIsStale(root)) {
    ensuredRoots.add(root);
    return;
  }
  if (!hasBun()) {
    throw new Error(
      `Connector dependencies in ${root} need installing, but \`bun\` is not on PATH. ` +
        `Run \`bun install\` in ${root}, or install bun (https://bun.sh).`
    );
  }
  log(`Installing connector dependencies in ${root}...`);
  execFileSync("bun", ["install", "--ignore-scripts"], {
    cwd: root,
    stdio: "inherit",
  });
  ensuredRoots.add(root);
}
