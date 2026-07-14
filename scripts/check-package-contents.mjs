#!/usr/bin/env node
// Package-content guard: fail if any publishable workspace package would ship
// internal/dev artifacts (tests or sourcemaps) in its npm tarball.
//
// Publishing regressions (a `files` glob that pulls in `src`, a `tsconfig` that
// compiles `**/*.test.ts` into `dist`, a recursive `cpSync` that copies a test
// tree, or dangling `.js.map`/`.d.ts.map` files) are invisible in code review
// and only surface as bloated tarballs. This runs `npm pack --dry-run --json`
// — the exact file selection `npm publish` uses — for every non-private package
// and asserts none of the packed files are tests or sourcemaps, and every
// explicit package export resolves to a file present in the tarball.
//
// Run after building packages. A package whose `files` declares `dist` but
// packs no `dist/` entries fails hard — an unbuilt tarball would otherwise
// pass trivially, silently skipping the very artifact this guards:
//   bun run build:packages && node scripts/check-package-contents.mjs
//
// Exit 0 = clean, 1 = a tarball contains a disallowed file, has a missing
// explicit export target, declares an empty `dist`, or packing failed.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const PACKAGES_DIR = path.join(REPO_ROOT, "packages");

// Internal test material: any __tests__ path segment, or a *.test.* / *.spec.*
// basename.
const TEST_PATH = /(^|\/)__tests__\//;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
// Sourcemaps: dev-only debug artifacts. They point at `src` that most packages
// don't ship, so they're dead weight in the tarball. Covers .js/.cjs/.mjs and
// .d.ts/.d.cts/.d.mts maps.
const SOURCEMAP = /\.[cm]?js\.map$|\.d\.[cm]?ts\.map$/;

// Narrow allowlist for public compatibility files that legitimately match the
// patterns above. Keep empty unless a genuinely-public export requires it;
// entries are exact tarball-relative paths (npm prefixes them with `package/`).
const ALLOWLIST = new Set([]);

// Return why a packed file shouldn't ship, or null if it's fine.
function disallowedReason(file) {
  if (ALLOWLIST.has(file)) return null;
  if (TEST_PATH.test(file) || TEST_FILE.test(path.basename(file)))
    return "test";
  if (SOURCEMAP.test(file)) return "sourcemap";
  return null;
}

function publishablePackageDirs() {
  const dirs = [];
  for (const name of readdirSync(PACKAGES_DIR)) {
    const pkgPath = path.join(PACKAGES_DIR, name, "package.json");
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue; // not a package dir
    }
    if (pkg.private === true) continue;
    dirs.push({
      name: pkg.name ?? name,
      dir: path.join(PACKAGES_DIR, name),
      declaresDist: (pkg.files ?? []).includes("dist"),
      exports: pkg.exports,
    });
  }
  return dirs.sort((a, b) => a.name.localeCompare(b.name));
}

// Collect exact relative targets from an exports map. Wildcard targets are
// intentionally skipped because validating their substitutions requires the
// corresponding wildcard keys and is outside this guard's current scope.
function explicitExportTargets(exports) {
  const targets = new Set();
  function visit(value, condition) {
    // The publish transform strips monorepo-only Bun source conditions before
    // npm publish. Validate the conditions that are present in the tarball.
    if (condition === "bun") return;
    if (typeof value === "string") {
      if (value.startsWith("./") && !value.includes("*")) {
        targets.add(value.slice(2));
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) visit(item, key);
    }
  }
  visit(exports);
  return [...targets].sort();
}

function packedFiles(dir) {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `npm pack failed in ${dir} (exit ${result.status}): ${result.stderr}`
    );
  }
  // `npm pack --dry-run --json` prints a one-element array whose `files[].path`
  // are tarball-relative (no `package/` prefix).
  const parsed = JSON.parse(result.stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return (entry?.files ?? []).map((f) => f.path);
}

let failed = false;
for (const { name, dir, declaresDist, exports } of publishablePackageDirs()) {
  let files;
  try {
    files = packedFiles(dir);
  } catch (err) {
    console.error(`✗ ${name}: ${err.message}`);
    failed = true;
    continue;
  }
  // A declared-but-empty `dist` means the package wasn't built before the
  // check — the pack list is missing exactly the artifacts under guard, so
  // "clean" would be meaningless. Fail loudly instead of passing trivially.
  if (declaresDist && !files.some((f) => f.startsWith("dist/"))) {
    failed = true;
    console.error(
      `✗ ${name}: \`files\` declares \`dist\` but the tarball packs no ` +
        "dist/ entries — build the package before running this check."
    );
    continue;
  }
  const packed = new Set(files);
  const missingExports = explicitExportTargets(exports).filter(
    (target) => !packed.has(target)
  );
  if (missingExports.length > 0) {
    failed = true;
    console.error(
      `✗ ${name}: ${missingExports.length} explicit export target(s) missing ` +
        "from the tarball:"
    );
    for (const target of missingExports) console.error(`    ${target}`);
  }
  const offenders = files
    .map((f) => ({ f, reason: disallowedReason(f) }))
    .filter((o) => o.reason);
  if (offenders.length > 0) {
    failed = true;
    console.error(
      `✗ ${name}: ${offenders.length} disallowed file(s) in tarball:`
    );
    for (const { f, reason } of offenders)
      console.error(`    [${reason}] ${f}`);
  } else if (missingExports.length === 0) {
    console.log(`✓ ${name}: clean (${files.length} files packed)`);
  }
}

if (failed) {
  console.error(
    "\nPublishable tarballs must not contain __tests__/, *.test.*, *.spec.*, " +
      "or sourcemap (*.{js,cjs,mjs}.map / *.d.{ts,cts,mts}.map) files. Every " +
      "explicit export target must be packed, and a package declaring `dist` " +
      "in `files` must be built before this check."
  );
  process.exit(1);
}
console.log("\nAll publishable tarballs are free of internal/dev artifacts.");
