import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sortDeviceManifestJson } from "@lobu/connector-sdk";
import type { DeviceConnectorManifest } from "@lobu/connector-sdk";
import { headlessDeviceConnectorManifests } from "./headless.js";
import { macDeviceConnectorManifests } from "./mac.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * One authored contract, one artifact per endpoint that ships it. Both are
 * generated from the same definitions so a connector declared for two
 * platforms serializes to identical bytes, and therefore to the identical
 * manifest hash the gateway elects on.
 *
 * The headless artifact lands inside `@lobu/connector-worker` rather than being
 * imported from here: that package is published to npm and installed by the
 * CLI, while this one is private, so a runtime dependency edge would not
 * resolve for an installed daemon. `--check` in CI is what keeps the copy
 * honest.
 */
const artifacts: Array<{
  path: string;
  manifests: readonly DeviceConnectorManifest[];
}> = [
  {
    path: resolve(
      packageRoot,
      "generated/macos-device-connector-manifests.json"
    ),
    manifests: macDeviceConnectorManifests,
  },
  {
    path: resolve(
      packageRoot,
      "../connector-worker/src/daemon/generated/headless-device-connector-manifests.json"
    ),
    manifests: headlessDeviceConnectorManifests,
  },
];

const check = process.argv.includes("--check");
for (const { path, manifests } of artifacts) {
  const artifact = `${JSON.stringify(sortDeviceManifestJson(manifests))}\n`;
  if (check) {
    const current = readFileSync(path, "utf8");
    if (current !== artifact) {
      throw new Error(`generated artifact is stale: ${path}`);
    }
    for (const manifest of manifests) {
      if (Object.hasOwn(manifest, "manifest_hash")) {
        throw new Error(`hash leaked into wire manifest '${manifest.key}'`);
      }
    }
    console.log(`generated artifact is current: ${path}`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, artifact);
    console.log(`generated ${path}`);
  }
}
