#!/usr/bin/env node

// Bumps version, builds, and publishes all @lobu packages to npm.
//
// Usage: node scripts/publish-packages.mjs [patch|minor|major|<explicit-version>]
//
// Publishes directly from each package directory. Per-package in-place
// package.json transforms are applied before `npm publish` and reverted
// immediately after in a try/finally, so a crashed publish never leaves the
// working tree dirty. Already-published versions are skipped so a partial
// failure can be retried without bumping the version.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = process.cwd();

const PACKAGES = [
  { dir: "packages/core", transform: transformCorePublish },
  { dir: "packages/connector-sdk", transform: rewriteWorkspaceRefs },
  { dir: "packages/agent-worker", transform: rewriteWorkspaceRefs },
  { dir: "packages/cli", transform: rewriteWorkspaceRefs },
  { dir: "packages/openclaw-plugin", transform: rewriteWorkspaceRefs },
  { dir: "packages/connectors", transform: rewriteWorkspaceRefs },
  { dir: "packages/connector-worker", transform: rewriteWorkspaceRefs },
  { dir: "packages/embeddings", transform: rewriteWorkspaceRefs },
  { dir: "packages/owletto-sdk", transform: rewriteWorkspaceRefs },
  { dir: "packages/owletto-connectors", transform: rewriteWorkspaceRefs },
  { dir: "packages/owletto-worker", transform: rewriteWorkspaceRefs },
  { dir: "packages/owletto-embeddings", transform: rewriteWorkspaceRefs },
  { dir: "packages/owletto-openclaw", transform: rewriteWorkspaceRefs },
];

const RENAMED_PACKAGE_DEPRECATIONS = [
  ["@lobu/owletto-sdk", "@lobu/connector-sdk", "packages/owletto-sdk"],
  [
    "@lobu/owletto-connectors",
    "@lobu/connectors",
    "packages/owletto-connectors",
  ],
  ["@lobu/owletto-worker", "@lobu/connector-worker", "packages/owletto-worker"],
  [
    "@lobu/owletto-embeddings",
    "@lobu/embeddings",
    "packages/owletto-embeddings",
  ],
  [
    "@lobu/owletto-openclaw",
    "@lobu/openclaw-plugin",
    "packages/owletto-openclaw",
  ],
];

// Published package names that don't use the @lobu/ scope. The unscoped
// `owletto` package was retired when the CLI merged into @lobu/cli; the
// allow-list stays in case another unscoped package ever gets added.
const UNSCOPED_ALLOWED_PUBLISHED_NAMES = new Set();

/**
 * `workspace:*` / `workspace:^` / `workspace:~` references are a Bun/Yarn
 * dev-time feature — they point at the sibling package's current version so
 * we never have to hand-edit versions across packages. npm does not natively
 * rewrite them at publish time, so we do it explicitly here before `npm
 * publish` runs and restore the original package.json afterwards.
 */
function rewriteWorkspaceRefs(pkg) {
  const rewriteSection = (deps) => {
    if (!deps) return;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
      if (
        !name.startsWith("@lobu/") &&
        !UNSCOPED_ALLOWED_PUBLISHED_NAMES.has(name)
      ) {
        throw new Error(
          `Unexpected workspace ref outside @lobu scope: ${name}@${spec}`
        );
      }
      deps[name] = workspacePackageVersion(name);
    }
  };
  rewriteSection(pkg.dependencies);
  rewriteSection(pkg.devDependencies);
  rewriteSection(pkg.peerDependencies);
  return pkg;
}

let cachedRootVersion;
function rootVersion() {
  if (!cachedRootVersion) {
    const rootPkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
    );
    cachedRootVersion = rootPkg.version;
  }
  return cachedRootVersion;
}

let cachedWorkspaceVersions;
function workspaceVersions() {
  if (!cachedWorkspaceVersions) {
    cachedWorkspaceVersions = new Map();
    const packagesDir = path.join(REPO_ROOT, "packages");
    for (const dir of readdirSync(packagesDir)) {
      const pkgPath = path.join(packagesDir, dir, "package.json");
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name && pkg.version) {
          cachedWorkspaceVersions.set(pkg.name, pkg.version);
        }
      } catch {
        // Not a workspace package.
      }
    }
  }
  return cachedWorkspaceVersions;
}

function workspacePackageVersion(name) {
  const version = workspaceVersions().get(name);
  if (!version) {
    throw new Error(`No workspace package found for ${name}`);
  }
  return version;
}

// Strip the `.bun` export conditionals that point at `./src/...`. They exist
// only for in-monorepo dev ergonomics (bun resolves source directly), and
// would 404 in the published tarball since `src/` is not shipped. Also
// rewrites any workspace refs (no-op today, defensive for future additions).
function transformCorePublish(pkg) {
  const exports = pkg.exports;
  if (exports && typeof exports === "object") {
    for (const entry of Object.values(exports)) {
      if (entry && typeof entry === "object" && "bun" in entry) {
        delete entry.bun;
      }
    }
  }
  return rewriteWorkspaceRefs(pkg);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${cmd} ${args.join(" ")} (exit ${result.status})`
    );
  }
}

function isVersionPublished(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === version;
}

function isPackagePublished(name) {
  const result = spawnSync("npm", ["view", name, "name"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === name;
}

function publishArgs(otp) {
  const args = ["publish", "--access", "public"];
  if (otp) args.push(`--otp=${otp}`);
  return args;
}

function deprecateArgs(packageSpec, message, otp) {
  const args = ["deprecate", packageSpec, message];
  if (otp) args.push(`--otp=${otp}`);
  return args;
}

function packageVersion(dir) {
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, dir, "package.json"), "utf8")
  );
  return pkg.version;
}

function deprecateRenamedPackages(otp) {
  for (const [oldName, newName] of RENAMED_PACKAGE_DEPRECATIONS) {
    if (!isPackagePublished(oldName)) {
      console.log(`  → ${oldName} not on npm, skipping deprecation`);
      continue;
    }
    const message = `Renamed to ${newName}. Please install ${newName} instead.`;
    // Deprecate every published version of the old name (npm accepts `@*` as
    // "all versions"). Without this, anyone pinned to an older version never
    // sees the rename notice — only freshly resolved installs do.
    console.log(`  → deprecating ${oldName}@*`);
    run("npm", deprecateArgs(`${oldName}@*`, message, otp));
  }
}

async function publishPackage({ dir, transform }, otp) {
  const absDir = path.join(REPO_ROOT, dir);
  const pkgPath = path.join(absDir, "package.json");
  const originalText = await readFile(pkgPath, "utf8");
  const pkg = JSON.parse(originalText);

  if (isVersionPublished(pkg.name, pkg.version)) {
    console.log(`  → ${pkg.name}@${pkg.version} already on npm, skipping`);
    return;
  }

  let mutated = false;
  try {
    if (transform) {
      const transformed = transform(JSON.parse(originalText));
      await writeFile(
        pkgPath,
        `${JSON.stringify(transformed, null, 2)}\n`,
        "utf8"
      );
      mutated = true;
    }

    console.log(`  → publishing ${pkg.name}@${pkg.version}`);
    run("npm", publishArgs(otp), { cwd: absDir });
  } finally {
    if (mutated) {
      await writeFile(pkgPath, originalText, "utf8");
    }
  }
}

function parseArgs(argv) {
  // Positional bump: patch | minor | major | <explicit-version> | skip
  // Flags: --otp=<code>, --skip-build, --skip-bump
  const positional = [];
  const flags = { otp: process.env.NPM_OTP, skipBuild: false, skipBump: false };
  for (const arg of argv) {
    if (arg.startsWith("--otp=")) {
      flags.otp = arg.slice("--otp=".length);
    } else if (arg === "--skip-build") {
      flags.skipBuild = true;
    } else if (arg === "--skip-bump") {
      flags.skipBump = true;
    } else {
      positional.push(arg);
    }
  }
  return { bump: positional[0] ?? "patch", ...flags };
}

async function main() {
  const { bump, otp, skipBuild, skipBump } = parseArgs(process.argv.slice(2));

  if (skipBump) {
    console.log("\n[1/4] Skipping version bump (--skip-bump)");
  } else {
    console.log(`\n[1/4] Bumping version (${bump})`);
    run("node", ["scripts/bump-version.mjs", bump]);
  }

  if (skipBuild) {
    console.log("\n[2/4] Skipping build (--skip-build)");
  } else {
    console.log("\n[2/4] Building packages");
    run("bun", ["run", "build:packages"]);
    run("bun", ["run", "build:owletto"]);
  }

  console.log("\n[3/4] Publishing to npm");
  if (otp) {
    console.log("  (using --otp from command line or $NPM_OTP)");
  }
  for (const pkg of PACKAGES) {
    await publishPackage(pkg, otp);
  }

  console.log("\n[4/4] Deprecating renamed compatibility packages");
  deprecateRenamedPackages(otp);

  console.log("\nDone.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
