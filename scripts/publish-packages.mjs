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
import { fileURLToPath, pathToFileURL } from "node:url";

// Anchored to this file, not process.cwd(), so the manifest reads below resolve
// the same way whether the script is run from the repo root or imported by a
// test running from another directory.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const PACKAGES = [
  { dir: "packages/core", transform: transformCorePublish },
  { dir: "packages/plugin-api", transform: transformCorePublish },
  { dir: "packages/plugin-host", transform: transformCorePublish },
  { dir: "packages/connector-sdk", transform: rewriteWorkspaceRefs },
  { dir: "packages/client", transform: rewriteWorkspaceRefs },
  // Publishes the esbuild bundle rather than the tsc output — see
  // transformWorkerPublish for why (#2186).
  { dir: "packages/agent-worker", transform: transformWorkerPublish },
  { dir: "packages/embeddings", transform: rewriteWorkspaceRefs },
  // @lobu/pgvector-embedded is NOT published: it's `private` and ships its
  // prebuilt native binaries inside the @lobu/cli tarball (build.cjs copies it
  // to dist/vendor/pgvector-embedded), so the bundled server resolves it at
  // runtime without a registry fetch. esbuild can't inline the native
  // binaries, hence it stays a runtime sidecar rather than part of
  // server.bundle.mjs.
  // connector-worker precedes cli: @lobu/cli depends on it at runtime, and the
  // blocked-dependency skip below relies on a dependency always being attempted
  // before its dependents. A guard test asserts this ordering holds.
  { dir: "packages/connector-worker", transform: rewriteWorkspaceRefs },
  { dir: "packages/cli", transform: rewriteWorkspaceRefs },
  { dir: "packages/promptfoo-provider", transform: rewriteWorkspaceRefs },
];

// Published package names that don't use the @lobu/ scope. The unscoped
// `lobu` package was retired when the CLI merged into @lobu/cli; the
// allow-list stays in case another unscoped package ever gets added.
const UNSCOPED_ALLOWED_PUBLISHED_NAMES = new Set();

/**
 * Names this script actually publishes, derived from PACKAGES so the two can
 * never drift. A `runtime` dependency on anything outside this set cannot be
 * satisfied by an external consumer.
 */
let cachedPublishedNames;
function publishedPackageNames() {
  if (!cachedPublishedNames) {
    cachedPublishedNames = new Set();
    for (const { dir } of PACKAGES) {
      const pkg = JSON.parse(
        readFileSync(path.join(REPO_ROOT, dir, "package.json"), "utf8")
      );
      if (!pkg.name || pkg.private) {
        throw new Error(
          `${dir} must have a public package name before it can be added to PACKAGES`
        );
      }
      cachedPublishedNames.add(pkg.name);
    }
  }
  return cachedPublishedNames;
}

/**
 * `workspace:*` / `workspace:^` / `workspace:~` references are a Bun/Yarn
 * dev-time feature — they point at the sibling package's current version so
 * we never have to hand-edit versions across packages. npm does not natively
 * rewrite them at publish time, so we do it explicitly here before `npm
 * publish` runs and restore the original package.json afterwards.
 *
 * Runtime dependencies and peer contracts are additionally gated on the
 * target actually being published. Without that gate this function faithfully
 * rewrote `"@lobu/plugin-mcp": "workspace:*"` to the placeholder version that
 * `private: true` packages carry (`0.0.0`) and shipped it in a public manifest
 * — a constraint no future release can satisfy. That is exactly how
 * @lobu/worker@14.3.0 went out with five private dependencies pinned to
 * `0.0.0`, breaking external installs (issue #2186).
 *
 * devDependencies are excluded because consumers do not install them, and a
 * private workspace package is a legitimate dev-only tool.
 */
function rewriteWorkspaceRefs(pkg) {
  const rewriteSection = (deps, section) => {
    if (!deps) return;
    for (const [name, spec] of Object.entries(deps)) {
      if (
        section !== "devDependencies" &&
        name.startsWith("@lobu/") &&
        !publishedPackageNames().has(name)
      ) {
        throw new Error(
          `${pkg.name} declares ${name} in "${section}", but this script does not publish it.\n` +
            `  An external consumer cannot install ${name}, so the published ${pkg.name} would be broken.\n` +
            "  Fix by either:\n" +
            `    - adding ${name} to PACKAGES (and making it non-private), or\n` +
            `    - bundling ${name} into ${pkg.name}'s build output and removing it from "${section}".`
        );
      }
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
  rewriteSection(pkg.dependencies, "dependencies");
  rewriteSection(pkg.optionalDependencies, "optionalDependencies");
  rewriteSection(pkg.devDependencies, "devDependencies");
  rewriteSection(pkg.peerDependencies, "peerDependencies");
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

/**
 * @lobu/worker publishes the esbuild bundle, not the tsc output.
 *
 * In-repo, this package resolves through the `bun` export condition to
 * `src/index.ts`, and both src/ and the tsc dist/ import five `private: true`
 * plugin packages. Publishing that verbatim is what put six unresolvable
 * dependencies on the registry (#2186): the shipped src/ imports them, the CJS
 * dist/ requires them, and neither can ever resolve for an external consumer.
 *
 * `packages/agent-worker/scripts/build-worker-bundle.mjs` inlines exactly the
 * private plugins into `dist/index.bundle.mjs` (published @lobu packages stay
 * external), so the published entry points are repointed at the bundle here,
 * the private deps are dropped from the manifest, and src/ is no longer
 * shipped. The in-repo manifest keeps `bun`/src so local dev is unaffected —
 * the publish script restores it immediately after publishing.
 *
 * The bundle is ESM on purpose: agent-worker compiles to CommonJS, and
 * @mariozechner/pi-coding-agent is import-only, so a node require() of the CJS
 * dist throws ERR_PACKAGE_PATH_NOT_EXPORTED. That is why src/ was shipped in
 * the first place; the bundle is what finally makes the package Node-loadable.
 */
function transformWorkerPublish(pkg) {
  const BUNDLE = "./dist/index.bundle.mjs";

  pkg.main = BUNDLE;
  pkg.bin = { "lobu-worker": BUNDLE };
  pkg.exports = {
    ".": {
      types: "./dist/index.d.ts",
      import: BUNDLE,
      default: BUNDLE,
    },
    "./package.json": "./package.json",
  };
  // Ship ONLY the bundle and its type declarations. src/ is no longer an entry
  // point, and the sibling tsc output in dist/ still carries the unresolvable
  // `require("@lobu/plugin-mcp")` calls — nothing loads those files once the
  // entry points move to the bundle, but shipping them would still break any
  // consumer reaching a deep path, and leaves the defect visibly in the
  // tarball. Verified by packing the tarball and grepping it.
  // The published type surface is exactly `index.d.ts` (which re-exports only
  // WorkerConfig) plus the `core/types.d.ts` it points at; both are free of
  // private-plugin references. Shipping dist/**/*.d.ts instead would drag in
  // sibling declarations like runtime/plugin-composition.d.ts that
  // `import type ... from "@lobu/plugin-toolkit"` and would fail a consumer's
  // typecheck. Verified by packing the tarball and grepping it.
  pkg.files = [
    "dist/index.bundle.mjs",
    "dist/index.d.ts",
    "dist/core/types.d.ts",
    "!**/*.map",
  ];

  // EVERY @lobu dependency is dropped, not just the private ones: the bundle
  // inlines the whole workspace graph (core and plugin-host included, because
  // they are CommonJS and this bundle is ESM — see build-worker-bundle.mjs).
  // Nothing in the published artifact imports them, so declaring them would
  // make consumers install packages they never load, and would keep the
  // release blocked on @lobu/plugin-api and @lobu/plugin-host being
  // bootstrap-published. Their npm dependencies are hoisted into
  // agent-worker's own manifest, which the bundler enforces.
  for (const section of ["dependencies", "optionalDependencies"]) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (name.startsWith("@lobu/")) delete deps[name];
    }
  }

  return rewriteWorkspaceRefs(pkg);
}

function packageNameFor(dir) {
  try {
    return (
      JSON.parse(
        readFileSync(path.join(REPO_ROOT, dir, "package.json"), "utf8")
      ).name ?? dir
    );
  } catch {
    return dir;
  }
}

/**
 * @lobu runtime and peer dependency names a workspace package will PUBLISH.
 *
 * The publish transform is applied first, because the transformed manifest is
 * what npm receives and therefore what a consumer has to be able to install.
 * Reading the raw on-disk manifest instead would skip @lobu/worker whenever
 * @lobu/core, plugin-api or plugin-host is unavailable — the worker still
 * declares them on disk, but `transformWorkerPublish` deletes every @lobu
 * dependency because the bundle inlines the whole graph. That is precisely the
 * bootstrap wait this change removes.
 *
 * Callers may omit `transform` to ask what the package declares on disk.
 */
function lobuRuntimeDeps(dir, transform) {
  let pkg;
  try {
    pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, dir, "package.json"), "utf8")
    );
  } catch {
    return [];
  }
  // Deliberately outside the catch: the transform runs `rewriteWorkspaceRefs`,
  // which throws when a package declares an @lobu dependency this script does
  // not publish. That is a release-stopping contract break, and swallowing it
  // into an empty list would report the package as depending on nothing —
  // publishing the exact broken manifest the guard exists to stop.
  if (transform) pkg = transform(pkg);
  return [
    ...new Set(
      [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.optionalDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ].filter((name) => name.startsWith("@lobu/"))
    ),
  ];
}

function markUnavailablePackage(name, dependencies, unavailableNames) {
  const missingDeps = dependencies.filter((dependency) =>
    unavailableNames.has(dependency)
  );
  if (missingDeps.length === 0) return;
  unavailableNames.add(name);
  return { name, missingDeps };
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
  //
  // A package whose own @lobu dependency was blocked is SKIPPED rather than
  // published: shipping it would put a manifest on the registry pointing at a
  // version that does not exist. PACKAGES is in dependency order, so a blocked
  // dependency is always seen before its dependents.
  const blocked = [];
  const unavailableNames = new Set();
  const skipped = [];
  for (const pkg of PACKAGES) {
    const skippedPackage = markUnavailablePackage(
      packageNameFor(pkg.dir),
      lobuRuntimeDeps(pkg.dir, pkg.transform),
      unavailableNames
    );
    if (skippedPackage) {
      skipped.push(skippedPackage);
      console.error(
        `  ✗ ${skippedPackage.name}: skipped — depends on unpublished ${skippedPackage.missingDeps.join(", ")}`
      );
      continue;
    }
    try {
      await publishPackage(pkg, otp);
    } catch (error) {
      if (error instanceof FirstPublishBlockedError) {
        blocked.push(error);
        unavailableNames.add(error.pkgName);
        console.error(
          `  ✗ ${error.pkgName}: never-published; needs a one-time bootstrap (see below)`
        );
        continue;
      }
      throw error;
    }
  }

  if (skipped.length > 0) {
    console.error(
      [
        "",
        `Skipped ${skipped.length} package(s) whose dependencies were not published:`,
        ...skipped.map(
          (s) => `  - ${s.name} (needs ${s.missingDeps.join(", ")})`
        ),
        "",
        "These were NOT published on purpose. An unavailable @lobu runtime or",
        "peer dependency leaves external installs broken or incomplete (issue",
        "#2186). Bootstrap the blocked packages below, then re-run; this release",
        "is incomplete until then.",
      ].join("\n")
    );
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
  }

  if (blocked.length > 0 || skipped.length > 0) {
    process.exitCode = 1;
    return;
  }

  console.log("\nDone.");
}

// Only run when invoked as a script. Without this guard, importing the module
// (as the guard tests do) would start a real publish.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export { rewriteWorkspaceRefs };

/** Internals exposed for the guard tests; not part of any published surface. */
export const __testing = {
  PACKAGES,
  lobuRuntimeDeps,
  markUnavailablePackage,
  packageNameFor,
};
