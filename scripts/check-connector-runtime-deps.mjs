#!/usr/bin/env node
/**
 * Tripwire: assert that every dep declared in EXTERNAL_RUNTIME_DEPS is
 * present in the worker package.json. Catches "added a dep to the
 * compiler's external list but forgot to install it in the runtime
 * image" — the failure mode that silently broke the Reddit watcher
 * for a week.
 *
 * Run in CI; exits non-zero on drift.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const runtimeDepsSource = readFileSync(
  join(repoRoot, "packages/connector-worker/src/runtime-deps.ts"),
  "utf-8"
);

const match = runtimeDepsSource.match(
  /EXTERNAL_RUNTIME_DEPS\s*=\s*\[([^\]]+)\]\s*as\s+const/
);
if (!match) {
  console.error(
    "Could not parse EXTERNAL_RUNTIME_DEPS from packages/connector-worker/src/runtime-deps.ts"
  );
  process.exit(2);
}
const declared = match[1]
  .split(",")
  .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
  .filter(Boolean);

const workerPkg = JSON.parse(
  readFileSync(
    join(repoRoot, "packages/connector-worker/package.json"),
    "utf-8"
  )
);
const installedDeps = new Set(Object.keys(workerPkg.dependencies ?? {}));

const missing = declared.filter((dep) => !installedDeps.has(dep));

if (missing.length > 0) {
  console.error(
    `❌ EXTERNAL_RUNTIME_DEPS includes deps that are NOT in packages/connector-worker/package.json:\n` +
      missing.map((d) => `  - ${d}`).join("\n") +
      `\n\nEither add them as worker dependencies, or remove them from EXTERNAL_RUNTIME_DEPS\n` +
      `(packages/connector-worker/src/runtime-deps.ts) so they get bundled into the connector artifact.`
  );
  process.exit(1);
}

console.log(
  `✅ EXTERNAL_RUNTIME_DEPS (${declared.join(", ")}) all installed in worker package.json`
);
