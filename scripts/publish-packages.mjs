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
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = process.cwd();

const PACKAGES = [
  { dir: "packages/core", transform: transformCorePublish },
  { dir: "packages/cli-core", transform: rewriteWorkspaceRefs },
  { dir: "packages/gateway", transform: rewriteWorkspaceRefs },
  { dir: "packages/worker", transform: rewriteWorkspaceRefs },
  { dir: "packages/cli", transform: rewriteWorkspaceRefs },
  { dir: "packages/owletto-sdk", transform: rewriteWorkspaceRefs },
  { dir: "packages/owletto-openclaw", transform: rewriteWorkspaceRefs },
  { dir: "packages/owletto-cli", transform: rewriteWorkspaceRefs },
];

// Published package names that don't use the @lobu/ scope. Kept as a small
// allow-list so rewriteWorkspaceRefs can still reject unexpected workspace
// references slipping into published package.jsons.
const UNSCOPED_ALLOWED_PUBLISHED_NAMES = new Set(["owletto"]);

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
      // All workspace packages are version-locked to the root version by
      // bump-version.mjs, so the current root version is the right target.
      deps[name] = rootVersion();
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

function publishArgs(otp) {
  const args = ["publish", "--access", "public"];
  if (otp) args.push(`--otp=${otp}`);
  return args;
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
    console.log("\n[1/3] Skipping version bump (--skip-bump)");
  } else {
    console.log(`\n[1/3] Bumping version (${bump})`);
    run("node", ["scripts/bump-version.mjs", bump]);
  }

  if (skipBuild) {
    console.log("\n[2/3] Skipping build (--skip-build)");
  } else {
    console.log("\n[2/3] Building packages");
    run("bun", ["run", "build:packages"]);
    run("bun", ["run", "build:owletto"]);
  }

  console.log("\n[3/3] Publishing to npm");
  if (otp) {
    console.log("  (using --otp from command line or $NPM_OTP)");
  }
  for (const pkg of PACKAGES) {
    await publishPackage(pkg, otp);
  }

  console.log("\nDone.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
