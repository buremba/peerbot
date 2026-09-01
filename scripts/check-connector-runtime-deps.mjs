#!/usr/bin/env node
/**
 * Tripwire: assert that every dep declared in RUNTIME_PROVIDED_PACKAGES is
 * present in the worker package.json. Catches "added a dep to the
 * compiler's external list but forgot to install it in the runtime
 * image" — the failure mode that silently broke the Reddit automation
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

const sdkMatch = runtimeDepsSource.match(
  /CONNECTOR_SDK_RUNTIME_DEP\s*=\s*['"]([^'"]+)['"]\s*as\s+const/
);
const externalMatch = runtimeDepsSource.match(
  /EXTERNAL_RUNTIME_DEPS\s*=\s*\[([^\]]+)\]\s*as\s+const/
);
if (!sdkMatch || !externalMatch) {
  console.error(
    "Could not parse connector runtime dependencies from packages/connector-worker/src/runtime-deps.ts"
  );
  process.exit(2);
}
const external = externalMatch[1]
  .split(",")
  .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
  .filter(Boolean);
const declared = [sdkMatch[1], ...external];

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
    `❌ RUNTIME_PROVIDED_PACKAGES includes deps that are NOT in packages/connector-worker/package.json:\n` +
      missing.map((d) => `  - ${d}`).join("\n") +
      `\n\nEither add them as worker dependencies, or stop providing/externalizing them at runtime\n` +
      `(packages/connector-worker/src/runtime-deps.ts).`
  );
  process.exit(1);
}

console.log(
  `✅ RUNTIME_PROVIDED_PACKAGES (${declared.join(", ")}) all installed in worker package.json`
);
