/**
 * Guard: every `config/providers.json` entry must declare where its model
 * catalog comes from.
 *
 * Curated model lists remain in providers.json; the build-time models.dev
 * snapshot enriches those approved IDs with model metadata. That only works
 * when the join mapping is present and current.
 *
 * So each provider entry must do exactly one of:
 *   - declare `modelsDevId` — the models.dev key its models are joined from; or
 *   - declare `modelsDevExempt: true` — an explicit "no models.dev catalog
 *     exists for this upstream" (custom / self-hosted / private endpoints).
 *
 * Both are checked further:
 *   - a declared `modelsDevId` must RESOLVE in the committed snapshot, so a
 *     rename upstream fails here instead of silently dropping metadata;
 *   - an exempt entry must NOT also set `modelsDevId` (contradictory).
 *
 * Note `modelsDevId` is deliberately MANY-TO-ONE: Lobu names by product where
 * models.dev names by vendor, so `chatgpt` (subscription) and `openai` (API
 * key) both map to models.dev's `openai`. Duplicates are NOT an error.
 *
 * Run: `bun scripts/check-models-dev-coverage.ts`
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelsDevSnapshot, ProvidersConfigFile } from "@lobu/core";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const PROVIDERS_JSON = resolve(REPO_ROOT, "config/providers.json");
const SNAPSHOT_JSON = resolve(REPO_ROOT, "config/models-dev-snapshot.json");
const LICENSE_FILE = resolve(REPO_ROOT, "config/models-dev-LICENSE");

const violations: string[] = [];

const providersConfig = JSON.parse(
  readFileSync(PROVIDERS_JSON, "utf-8")
) as ProvidersConfigFile;

// The snapshot is a committed build artifact; without it we can still check
// that the mapping FIELD is present, just not that it resolves.
const snapshot: ModelsDevSnapshot | null = existsSync(SNAPSHOT_JSON)
  ? (JSON.parse(readFileSync(SNAPSHOT_JSON, "utf-8")) as ModelsDevSnapshot)
  : null;
if (!snapshot) {
  violations.push(
    "config/models-dev-snapshot.json is missing — regenerate it with " +
      "`bun run scripts/gen-models-dev-snapshot.ts`"
  );
}
const licenseText = existsSync(LICENSE_FILE)
  ? readFileSync(LICENSE_FILE, "utf-8")
  : "";
if (
  !licenseText.includes("Copyright (c) 2025 models.dev") ||
  !licenseText.includes(
    "The above copyright notice and this permission notice shall be included"
  )
) {
  violations.push(
    "config/models-dev-LICENSE is missing or incomplete — the generated " +
      "snapshot must ship with the upstream MIT notice"
  );
}

for (const entry of providersConfig.providers) {
  for (const provider of entry.providers ?? []) {
    const { modelsDevId, modelsDevExempt } = provider;

    if (modelsDevExempt && modelsDevId) {
      violations.push(
        `${entry.id}: sets BOTH modelsDevExempt and modelsDevId ` +
          `("${modelsDevId}") — pick one. Exempt means no models.dev catalog exists.`
      );
      continue;
    }

    if (modelsDevExempt) continue;

    if (!modelsDevId) {
      violations.push(
        `${entry.id}: no "modelsDevId". Add the models.dev provider key its ` +
          `models are joined from (see https://models.dev/api.json), or set ` +
          `"modelsDevExempt": true if this upstream genuinely has no models.dev entry.`
      );
      continue;
    }

    if (!snapshot) continue;

    // The snapshot is keyed by LOBU id, so a mapping edited without
    // regenerating would still match a stale entry by that id and pass. Compare
    // the recorded join key to catch exactly that drift.
    const recorded = snapshot.joinedFrom?.[entry.id];
    if (recorded !== modelsDevId) {
      violations.push(
        `${entry.id}: modelsDevId is "${modelsDevId}" but the snapshot was ` +
          `generated from "${recorded ?? "(nothing)"}". Regenerate with ` +
          "`bun run scripts/gen-models-dev-snapshot.ts`."
      );
      continue;
    }

    // A declared mapping that produces no models means the upstream key was
    // renamed/removed — model details would silently disappear in prod.
    if (!snapshot.providers[entry.id]?.length) {
      violations.push(
        `${entry.id}: modelsDevId "${modelsDevId}" resolved to NO models in ` +
          `config/models-dev-snapshot.json. The upstream key was likely renamed ` +
          `or removed — check https://models.dev/api.json and re-run ` +
          `\`bun run scripts/gen-models-dev-snapshot.ts\`.`
      );
    }
  }
}

if (violations.length > 0) {
  console.error(
    `check-models-dev-coverage: ${violations.length} problem(s) in config/providers.json:\n`
  );
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error(
    "\nProvider model metadata comes from the build-time models.dev snapshot. " +
      "Every entry must declare that source or explicitly opt out."
  );
  process.exit(1);
}

const mapped = providersConfig.providers.filter((e) =>
  (e.providers ?? []).some((p) => p.modelsDevId)
).length;
const exempt = providersConfig.providers.filter((e) =>
  (e.providers ?? []).some((p) => p.modelsDevExempt)
).length;
console.log(
  `check-models-dev-coverage: clean — ${mapped} provider(s) mapped to models.dev, ${exempt} exempt.`
);
