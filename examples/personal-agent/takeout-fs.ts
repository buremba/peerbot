/**
 * Filesystem-backed takeout readers.
 *
 * Split out of `takeout-utils.ts` so that module stays pure. Connector code is
 * compiled with `ISOLATE_LANE_BUILD_OPTIONS` and executed inside a V8 isolate —
 * the only execution lane there is. esbuild leaves Node builtins as bare
 * `require()` calls, and `assertIsolateEligible` refuses the whole bundle when
 * one survives. So a single `node:fs` import anywhere in a connector's module
 * graph makes EVERY feed of that connector unloadable, live ones included.
 *
 * That is exactly what broke LinkedIn: its live browser feeds import this
 * package's ancestor transitively and were rejected before the browser was ever
 * dispatched (Lobu#3392). Keeping the filesystem here — imported only by
 * connectors that are entirely filesystem-backed — means a mixed connector can
 * import the pure parsing helpers without inheriting `fs`/`path`.
 *
 * This module is the same shape as the SDK's own split: `file-source.ts`
 * exports types from the isolate-safe root while the `node:fs` implementations
 * live behind `@lobu/connector-sdk/sources`.
 *
 * Importing this does not itself provide a device execution backend. The live
 * connector never imports this module; local import callers must supply the
 * reader explicitly. Capability advertisement alone is not proof of support.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { LocalTakeoutConfig } from "./takeout-utils.ts";

export function assertDirectory(
  config: LocalTakeoutConfig,
  label: string
): string {
  const dir = config.takeout_dir;
  if (!dir) {
    throw new Error(`Missing takeout_dir for ${label}.`);
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`${label} takeout directory does not exist: ${dir}`);
  }
  return dir;
}

export function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function readJsArray<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    return JSON.parse(text.slice(start, end + 1)) as T[];
  } catch {
    return [];
  }
}

export function listFiles(
  root: string,
  predicate: (filePath: string) => boolean
): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
      } else if (entry.isFile() && predicate(filePath)) {
        out.push(filePath);
      }
    }
  };
  visit(root);
  return out.sort();
}
