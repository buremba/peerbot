/**
 * SDK manifest enumeration. Lives in its own module so `runScript` can value-
 * import it without pulling `client-sdk.ts`'s full auth/db chain into the test
 * runtime — the run-script-runtime.test.ts CI guard depends on this.
 */

import { METHOD_METADATA } from "./method-metadata";

export type SDKMode = "read" | "full";

export function enumerateSDKManifest(
  mode: SDKMode,
  options?: { allowCrossOrg?: boolean },
): { topLevel: string[]; byNamespace: Record<string, string[]> } {
  const topLevel = ["query", "log"];
  if (options?.allowCrossOrg !== false) topLevel.unshift("org");

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
