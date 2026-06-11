/**
 * Ensure a connector project's npm dependencies are installed before the CLI
 * compiles its connectors. esbuild bundles a connector's imports relative to
 * the connector file's directory, so the project's own `node_modules` (next to
 * `package.json`) must exist. We install when stale, preferring `bun` (faster,
 * if the user has it) and falling back to `npm` (always present with Node) so
 * the lobu CLI never forces a bun install on the user's machine.
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
 * Find the connector's project root — the nearest ancestor with
 * `lobu.config.ts`. Anchoring on `lobu.config.ts` (not any ancestor
 * `package.json`) is what stops a connector inside a monorepo from resolving to
 * the monorepo's root package.json and triggering a wrong-directory install.
 */
export function findProjectRoot(fromFile: string): string | null {
  let dir = dirname(fromFile);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, "lobu.config.ts"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The project is "stale" if `node_modules` is missing or its mtime is older
 * than whichever lockfile the project uses (`bun.lock` for a bun-based project,
 * `package-lock.json` for an npm-based one). Honouring both means switching
 * installers between runs doesn't trigger spurious reinstalls.
 */
function installIsStale(root: string): boolean {
  const nodeModules = join(root, "node_modules");
  if (!existsSync(nodeModules)) return true;
  for (const lockName of ["bun.lock", "package-lock.json"]) {
    const lock = join(root, lockName);
    if (!existsSync(lock)) continue;
    try {
      if (statSync(lock).mtimeMs > statSync(nodeModules).mtimeMs) return true;
    } catch {
      // unreadable lockfile — treat as fresh rather than reinstall on every run
    }
  }
  return false;
}

function hasOnPath(bin: string): boolean {
  try {
    // `env: process.env` is node's default; passed explicitly because bun
    // otherwise resolves the binary against the STARTUP environment's PATH,
    // ignoring runtime changes (which the tests rely on to stage fakes).
    execFileSync(bin, ["--version"], { stdio: "ignore", env: process.env });
    return true;
  } catch {
    return false;
  }
}

const bunInstaller = { cmd: "bun", args: ["install", "--ignore-scripts"] };
const npmInstaller = {
  cmd: "npm",
  args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
};

/**
 * Pick an installer for the user's project. Honour an existing lockfile so we
 * don't mix `bun.lock` and `package-lock.json` for the same project, then fall
 * back to whatever's available — bun is faster when present, npm is always
 * available because Node ships it. The lobu CLI never requires bun on the
 * user's machine.
 */
function pickInstaller(root: string): { cmd: string; args: string[] } {
  const hasNpmLock = existsSync(join(root, "package-lock.json"));
  if (hasNpmLock) return npmInstaller;
  const hasBunLock = existsSync(join(root, "bun.lock"));
  const bunAvailable = hasOnPath("bun");
  if (hasBunLock && bunAvailable) return bunInstaller;
  if (bunAvailable) return bunInstaller;
  return npmInstaller;
}

/**
 * Run the project's dependency install in `root` with the picked installer
 * (bun if available, else npm; `--ignore-scripts` always). Throws when the
 * install fails or the installer binary is missing — callers decide whether
 * that's fatal (`lobu apply` compile path) or a warning (`lobu init`).
 */
export function installProjectDeps(
  root: string,
  opts: {
    /** "inherit" streams installer output to the terminal; "pipe" keeps it quiet. */
    stdio?: "inherit" | "pipe";
  } = {}
): { installer: string } {
  const installer = pickInstaller(root);
  // `env: process.env` — see hasOnPath for why it's passed explicitly.
  execFileSync(installer.cmd, installer.args, {
    cwd: root,
    stdio: opts.stdio ?? "inherit",
    env: process.env,
  });
  return { installer: installer.cmd };
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
  log(`Installing connector dependencies in ${root}...`);
  installProjectDeps(root, { stdio: "inherit" });
  ensuredRoots.add(root);
}
