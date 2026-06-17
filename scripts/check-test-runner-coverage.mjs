#!/usr/bin/env node
// Guard against the silent-skip test class (issue #1238).
//
// packages/server uses two test runners side by side:
//   - vitest runs every `src/**/*.test.ts` EXCEPT the globs in
//     vitest.config.ts `exclude`.
//   - bun:test runs the trees enumerated as `bun test <path>` args in
//     .github/workflows/ci.yml and scripts/review.sh.
//
// Both selectors are path-based and hand-maintained, so they drift: a test
// file added in a tree no bun job covers AND excluded from vitest runs in NO
// runner — and a skipped test is indistinguishable from a passing one (both
// green). This script makes that drift a hard failure.
//
// Runner capabilities are asymmetric:
//   - vitest CANNOT run a file that imports `bun:test` (Node has no such module
//     — the run errors).
//   - `bun test` runs both: it natively runs `bun:test` files and shims the
//     `vitest` import, so it executes vitest-style files too.
//
// Fatal invariant (keyed on each file's runner import):
//   bun:test file -> MUST be excluded from vitest (else vitest errors importing
//                    bun:test) AND MUST be under a bun root (else runs nowhere)
//   vitest file   -> MUST run somewhere: visible to vitest OR under a bun root
// A vitest file that is both visible to vitest AND under a bun root merely
// double-runs — reported as a warning, not a failure.
//
// No deps, no DB, no build — pure static analysis over the repo.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = join(REPO_ROOT, "packages/server");

// bun:test files that are intentionally NOT in any gate (key-gated opt-in smoke,
// run via `make test-providers-live`). They must still be hidden from vitest.
const ALLOW_UNGATED = ["src/__tests__/live-providers/"];

/** Convert a vitest-style glob (only `*`/`**` are used) to an anchored RegExp. */
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // `**/` matches any number of leading dirs
        } else {
          re += ".*"; // trailing/standalone `**`
        }
      } else {
        re += "[^/]*"; // single `*` stays within a path segment
      }
    } else if (".+?^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Pull the quoted string entries out of the vitest.config.ts `exclude: [...]`. */
function parseVitestExcludes() {
  const src = readFileSync(join(SERVER_DIR, "vitest.config.ts"), "utf8");
  const block = src.match(/exclude:\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error("could not locate vitest exclude array");
  return [...block[1].matchAll(/["']([^"']+)["']/g)]
    .map((m) => m[1])
    .filter((p) => p.startsWith("src/")) // ignore node_modules/dist noise
    .map(globToRegExp);
}

/**
 * Extract server-relative test path roots from a shell/yaml file. Recognizes
 * two forms:
 *   - literal `bun test <path>` invocations, and
 *   - `find <path> -type d -name __tests__` loops, which run every __tests__
 *     dir under <path> in its own process (so <path> is fully covered).
 * Comments are stripped first so a line like `# don't bun test src/foo` can
 * never register a phantom root that masks a real "runs nowhere" violation.
 */
function parseBunRoots(file) {
  const text = readFileSync(join(REPO_ROOT, file), "utf8");
  const roots = new Set();
  for (const raw of text.split("\n")) {
    // Drop a comment tail: `#` at line start or preceded by whitespace. Keeps
    // any leading code (none of our command paths contain a literal `#`).
    const line = raw.replace(/(^|\s)#.*$/, "$1");
    const isBunTest = /\bbun test\b/.test(line);
    const findMatch = line.match(
      /\bfind\s+(?:packages\/server\/)?(src\/[A-Za-z0-9_./-]+)\s+-type\s+d\s+-name\s+__tests__/
    );
    if (findMatch) roots.add(findMatch[1]);
    if (!isBunTest) continue;
    for (const m of line.matchAll(
      /(?:packages\/server\/)?(src\/[A-Za-z0-9_./-]+)/g
    )) {
      roots.add(m[1]);
    }
  }
  return [...roots];
}

/** Recursively collect every *.test.ts under packages/server/src. */
function collectTestFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectTestFiles(full, out);
    else if (entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const vitestExcludes = parseVitestExcludes();
const bunRoots = [
  ...new Set([
    ...parseBunRoots(".github/workflows/ci.yml"),
    ...parseBunRoots("scripts/review.sh"),
  ]),
];

const isExcludedFromVitest = (rel) => vitestExcludes.some((re) => re.test(rel));
const isUnderBunRoot = (rel) =>
  bunRoots.some((root) => rel === root || rel.startsWith(`${root}/`));

const violations = [];
const warnings = [];

// A bun root that is a prefix of another bun root means the inner tree runs in
// two separate 'bun test' invocations (e.g. src/gateway ⊃
// src/gateway/infrastructure/queue) — wasted CI time. Flag every such pair.
for (const inner of bunRoots) {
  for (const outer of bunRoots) {
    if (inner !== outer && inner.startsWith(`${outer}/`)) {
      warnings.push(
        `bun roots overlap: '${inner}' is nested under '${outer}' — its tests run twice across both 'bun test' invocations`
      );
    }
  }
}
for (const abs of collectTestFiles(join(SERVER_DIR, "src"))) {
  const rel = relative(SERVER_DIR, abs).split("\\").join("/"); // src/...-relative
  const text = readFileSync(abs, "utf8");
  const isBun = /from\s+["']bun:test["']/.test(text);
  const inVitest = !isExcludedFromVitest(rel);
  const inBun = isUnderBunRoot(rel);
  const ungatedOk = ALLOW_UNGATED.some((p) => rel.startsWith(p));

  if (isBun) {
    if (inVitest)
      violations.push(
        `${rel}: bun:test file is NOT excluded from vitest — vitest errors importing bun:test (add a vitest.config.ts exclude)`
      );
    if (!inBun && !ungatedOk)
      violations.push(
        `${rel}: bun:test file runs in NO runner — add its tree to a 'bun test' job (ci.yml + review.sh)`
      );
  } else if (!inVitest && !inBun && !ungatedOk) {
    violations.push(
      `${rel}: vitest file runs in NO runner — it is excluded from vitest and under no 'bun test' root`
    );
  } else if (inVitest && inBun) {
    warnings.push(
      `${rel}: runs under BOTH vitest and a 'bun test' root (redundant)`
    );
  }
}

if (warnings.length) {
  console.error(
    `\n⚠ test-runner coverage warnings (${warnings.length}, non-fatal):`
  );
  for (const w of warnings) console.error(`  - ${w}`);
}

if (violations.length) {
  console.error(
    `\n✗ test-runner coverage gate failed (${violations.length}):\n`
  );
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    `\nbun roots: ${bunRoots.join(", ")}\n` +
      "Every packages/server *.test.ts must run in at least one runner (vitest or a\n" +
      "'bun test' job). See scripts/check-test-runner-coverage.mjs.\n"
  );
  process.exit(1);
}

console.log(
  "✓ test-runner coverage: every packages/server test file runs in at least one runner"
);
