#!/usr/bin/env node
/**
 * Directory-structure gate.
 *
 * Two structural regressions cost real navigation time in this repo and are
 * both cheap to detect mechanically. Neither is a style preference; each one
 * is a shape that made a module unfindable until somebody went looking.
 *
 * RULE 1 — a directory may not share its parent's name.
 *   `packages/server/src/gateway/gateway/` held `class WorkerGateway` (1,256
 *   lines) in an `index.ts`. The path segment repeats, so the name carries no
 *   information, and the file that mattered most in the dispatch path could not
 *   be found by filename. Renaming it cost minutes; finding it cost sessions.
 *
 * RULE 2 — a `<name>.ts` sitting beside a `<name>/` must be the SMALLER half.
 *   That pairing is this repo's extraction idiom: the file becomes a thin
 *   re-exporting facade and the directory holds the implementation
 *   (`manage_connections.ts` at 140 lines over `manage_connections/` at 4,229;
 *   `get_content.ts` at 20 over 3,289). It only reads as intentional when the
 *   directory won. `manage_operations.ts` sat at 3,488 lines beside a 627-line
 *   directory for months — an extraction that was started, abandoned, and
 *   indistinguishable from the finished ones by shape alone.
 *
 *   The rule applies only once the directory carries real weight (>= 300 lines).
 *   Below that the pair is usually a small types or helper folder next to an
 *   unrelated module (`core/src/types.ts` beside `core/src/types/`), not a
 *   stalled extraction, and forcing a comparison there produces noise.
 *
 * Scope: `packages/<pkg>/src` for workspace packages, excluding tests,
 * generated output, and the owletto submodule (separate repo, separate rules).
 *
 * Usage: bun scripts/check-directory-structure.mjs
 * Exit 0 = clean, 1 = violations found.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const PACKAGES_DIR = "packages";

/** Packages whose src tree this gate does not govern. */
const EXCLUDED_PACKAGES = new Set([
  "owletto", // git submodule: separate repo, separate conventions
  "client", // generated SDK surface (src/generated/**) is tool-authored
  "node_modules",
]);

/** Directory names skipped anywhere in the walk. */
const SKIPPED_DIRS = new Set([
  "__tests__",
  "node_modules",
  "dist",
  "generated",
  "templates",
]);

/** A sibling directory below this many lines is too small to be a stalled extraction. */
const EXTRACTION_WEIGHT_THRESHOLD = 300;

function isSourceFile(name) {
  return (
    (name.endsWith(".ts") || name.endsWith(".tsx")) &&
    !name.endsWith(".test.ts") &&
    !name.endsWith(".test.tsx") &&
    !name.endsWith(".spec.ts") &&
    !name.endsWith(".d.ts")
  );
}

function countLines(filePath) {
  return readFileSync(filePath, "utf8").split("\n").length;
}

/** Total source lines directly in `dir` and below, skipping SKIPPED_DIRS. */
function countTreeLines(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      total += countTreeLines(join(dir, entry.name));
    } else if (isSourceFile(entry.name)) {
      total += countLines(join(dir, entry.name));
    }
  }
  return total;
}

function walk(dir, violations) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // package without a src tree
  }

  const dirNames = new Set(
    entries.filter((e) => e.isDirectory()).map((e) => e.name)
  );

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIPPED_DIRS.has(entry.name)) continue;

    const childPath = join(dir, entry.name);

    // RULE 1: a directory may not repeat its parent's name.
    if (entry.name === basename(dir)) {
      violations.push({
        rule: 1,
        path: childPath,
        detail:
          `directory "${entry.name}/" repeats its parent's name, so the path ` +
          `segment carries no information. Name it for what it holds.`,
      });
    }

    walk(childPath, violations);
  }

  // RULE 2: `<name>.ts` beside `<name>/` must be the smaller half.
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!isSourceFile(entry.name)) continue;

    const stem = entry.name.replace(/\.tsx?$/, "");
    if (!dirNames.has(stem)) continue;
    if (SKIPPED_DIRS.has(stem)) continue;

    const filePath = join(dir, entry.name);
    const dirPath = join(dir, stem);
    const dirLines = countTreeLines(dirPath);
    if (dirLines < EXTRACTION_WEIGHT_THRESHOLD) continue;

    const fileLines = countLines(filePath);
    if (fileLines > dirLines) {
      violations.push({
        rule: 2,
        path: filePath,
        detail:
          `${fileLines} lines sits beside ${stem}/ at ${dirLines} lines. ` +
          `A <name>.ts next to a <name>/ is this repo's extraction facade — ` +
          `the directory should hold the implementation. Finish the ` +
          `extraction or fold the directory back in.`,
      });
    }
  }
}

function main() {
  const violations = [];

  let packages;
  try {
    packages = readdirSync(PACKAGES_DIR, { withFileTypes: true });
  } catch {
    console.error(
      `check-directory-structure: no ${PACKAGES_DIR}/ directory; run from the repo root.`
    );
    process.exit(1);
  }

  for (const pkg of packages) {
    if (!pkg.isDirectory()) continue;
    if (EXCLUDED_PACKAGES.has(pkg.name)) continue;

    const srcDir = join(PACKAGES_DIR, pkg.name, "src");
    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch {
      continue;
    }
    walk(srcDir, violations);
  }

  if (violations.length === 0) {
    console.log("check-directory-structure: clean");
    process.exit(0);
  }

  console.error(
    `check-directory-structure: ${violations.length} violation(s)\n`
  );
  for (const v of violations) {
    console.error(`  [rule ${v.rule}] ${v.path}`);
    console.error(`              ${v.detail}\n`);
  }
  process.exit(1);
}

main();
