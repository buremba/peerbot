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
  { dir: "packages/plugin-api", transform: transformCorePublish },
  { dir: "packages/plugin-host", transform: transformCorePublish },
  { dir: "packages/connector-sdk", transform: rewriteWorkspaceRefs },
  { dir: "packages/client", transform: rewriteWorkspaceRefs },
  { dir: "packages/agent-worker", transform: rewriteWorkspaceRefs },
  { dir: "packages/embeddings", transform: rewriteWorkspaceRefs },
  // @lobu/pgvector-embedded is NOT published: it's `private` and ships its
  // prebuilt native binaries inside the @lobu/cli tarball (build.cjs copies it
  // to dist/vendor/pgvector-embedded), so the bundled server resolves it at
  // runtime without a registry fetch. esbuild can't inline the native
  // binaries, hence it stays a runtime sidecar rather than part of
  // server.bundle.mjs.
  { dir: "packages/cli", transform: rewriteWorkspaceRefs },
  { dir: "packages/connector-worker", transform: rewriteWorkspaceRefs },
  { dir: "packages/promptfoo-provider", transform: rewriteWorkspaceRefs },
];

// Published package names that don't use the @lobu/ scope. The unscoped
// `lobu` package was retired when the CLI merged into @lobu/cli; the
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

/**
 * Marker error for a package npm won't let us create. On the very first
 * publish of a scoped package, npm returns `E404 / PUT ... Not found` (it
 * masks 403 as 404 for scoped names). This happens when the CI npm token is a
 * granular access token whose package allow-list can't cover a name that does
 * not exist yet — a chicken-and-egg the token cannot break on its own. We
 * collect these and fail once at the end with the manual-bootstrap steps,
 * rather than aborting mid-loop and hiding the other new packages.
 */
class FirstPublishBlockedError extends Error {
  constructor(name, dir) {
    super(name);
    this.name = "FirstPublishBlockedError";
    this.pkgName = name;
    this.dir = dir;
  }
}

/**
 * Publish a package, capturing output so we can classify a first-publish 404.
 * Non-404 failures still hard-fail (real errors must stop the release). The
 * package's source dir is carried on the marker error so the bootstrap message
 * prints the real path — package dir and npm name diverge (e.g. dir
 * `agent-worker` publishes as `@lobu/worker`).
 */
function runPublish(name, dir, args, opts = {}) {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(combined);
  if (result.status === 0) return;

  const is404 =
    /\bE404\b/.test(combined) ||
    /\b404 Not Found - PUT\b/.test(combined) ||
    /could not be found or you do not have permission/.test(combined);
  if (is404) {
    throw new FirstPublishBlockedError(name, dir);
  }
  throw new Error(
    `Command failed: npm ${args.join(" ")} (exit ${result.status})`
  );
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
    runPublish(pkg.name, dir, publishArgs(otp), { cwd: absDir });
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
    run("bun", ["run", "build:lobu"]);
  }

  console.log("\n[3/4] Publishing to npm");
  if (otp) {
    console.log("  (using --otp from command line or $NPM_OTP)");
  }
  // Collect packages npm refuses to create on their first publish so the whole
  // fleet still gets attempted; a single new package must not hide the others.
  const blocked = [];
  for (const pkg of PACKAGES) {
    try {
      await publishPackage(pkg, otp);
    } catch (error) {
      if (error instanceof FirstPublishBlockedError) {
        blocked.push(error);
        console.error(
          `  ✗ ${error.pkgName}: never-published; needs a one-time bootstrap (see below)`
        );
        continue;
      }
      throw error;
    }
  }

  if (blocked.length > 0) {
    console.error(
      [
        "",
        `\nnpm refused the first publish of ${blocked.length} new package(s):`,
        ...blocked.map((e) => `  - ${e.pkgName}`),
        "",
        "npm returns E404 on the first publish of a scoped package when the CI",
        "NPM_TOKEN is a granular access token: its package allow-list cannot name",
        "a package that does not exist yet. Break the chicken-and-egg with a",
        "one-time manual bootstrap by an npm org owner, then CI takes over:",
        "",
        "  1. Locally, authenticated as an @lobu owner (classic automation token",
        "     or an interactive login with 2FA — NOT the CI granular token):",
        ...blocked.map(
          (e) =>
            `       (cd packages/${e.dir.replace(/^packages\//, "")} && npm publish --access public)`
        ),
        "  2. Add each newly-created package to the CI granular token's",
        "     allow-list (npmjs.com → Access Tokens), OR register it as a",
        "     Trusted Publisher (npmjs.com → package → Settings → Publishing",
        "     access → GitHub Actions: .github/workflows/publish-packages.yml).",
        "  3. Re-run this workflow; the package now exists and CI publishes it.",
        "",
        "Until then these packages are absent from npm, so any published package",
        "that depends on them (e.g. @lobu/agent-worker → @lobu/plugin-api) will",
        "fail `npm install` for external consumers.",
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nDone.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
