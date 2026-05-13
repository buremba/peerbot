/**
 * SDK manifest enumeration. Lives in its own module so `runScript` can value-
 * import it without pulling `client-sdk.ts`'s full auth/db chain into the test
 * runtime — the run-script-runtime.test.ts CI guard depends on this.
 */

import { METHOD_METADATA } from "./method-metadata";

export type SDKMode = "read" | "full";

type SDKManifest = { topLevel: string[]; byNamespace: Record<string, string[]> };

// METHOD_METADATA is a static module constant, so there are only four distinct
// manifests (mode × allowCrossOrg). Memoize them so each sandbox call is a Map
// lookup instead of a ~545-entry walk + allocations.
const manifestCache = new Map<string, SDKManifest>();

function buildSDKManifest(
  mode: SDKMode,
  allowCrossOrg: boolean,
): SDKManifest {
  const topLevel = ["query", "log"];
  if (allowCrossOrg) topLevel.unshift("org");

  const byNamespace: Record<string, string[]> = {};
  for (const [path, meta] of Object.entries(METHOD_METADATA)) {
    const dot = path.indexOf(".");
    if (dot === -1) continue;
    if (mode === "read" && meta.access !== "read") continue;
    const ns = path.slice(0, dot);
    (byNamespace[ns] ??= []).push(path.slice(dot + 1));
  }
  return { topLevel, byNamespace };
}

export function enumerateSDKManifest(
  mode: SDKMode,
  options?: { allowCrossOrg?: boolean },
): SDKManifest {
  const allowCrossOrg = options?.allowCrossOrg !== false;
  const key = `${mode}:${allowCrossOrg ? "1" : "0"}`;
  let manifest = manifestCache.get(key);
  if (!manifest) {
    manifest = buildSDKManifest(mode, allowCrossOrg);
    manifestCache.set(key, manifest);
  }
  return manifest;
}
