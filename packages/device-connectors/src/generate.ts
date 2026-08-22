import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sortDeviceManifestJson } from "@lobu/connector-sdk";
import { macDeviceConnectorManifests } from "./mac.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = resolve(
  packageRoot,
  "generated/macos-device-connector-manifests.json"
);
const artifact = `${JSON.stringify(sortDeviceManifestJson(macDeviceConnectorManifests))}\n`;

if (process.argv.includes("--check")) {
  const current = readFileSync(artifactPath, "utf8");
  if (current !== artifact) {
    throw new Error(`generated artifact is stale: ${artifactPath}`);
  }
  for (const manifest of macDeviceConnectorManifests) {
    if (Object.hasOwn(manifest, "manifest_hash")) {
      throw new Error(`hash leaked into wire manifest '${manifest.key}'`);
    }
  }
  console.log(`generated artifact is current: ${artifactPath}`);
} else {
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, artifact);
  console.log(`generated ${artifactPath}`);
}
