/**
 * `@lobu/connector-sdk/device-manifest-hash` — the one device-manifest helper
 * that needs `node:crypto`. Kept out of `device-manifest.ts` so the package
 * root (which re-exports the manifest types and authoring helpers) stays
 * loadable inside a V8 isolate. Only the server verifies manifest hashes.
 */
import { createHash } from 'node:crypto';
import { canonicalDeviceManifestJson, type DeviceConnectorManifest } from './device-manifest.js';

/** SHA-256 of the canonical manifest payload; the wire manifest stays hashless. */
export function deviceManifestHash(manifest: DeviceConnectorManifest): string {
  return createHash('sha256').update(canonicalDeviceManifestJson(manifest)).digest('hex');
}
