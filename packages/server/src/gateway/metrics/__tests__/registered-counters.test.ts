/**
 * `incrementCounter` fails SILENTLY: an unregistered name logs a warning and
 * returns, so the metric never reaches /metrics and any alert built on it is
 * dead on arrival. Nothing at build time catches the mismatch — a counter can
 * be incremented on a hot path for months while reading as "no events".
 *
 * This walks every `incrementCounter("literal")` call in the server source
 * (either quote style) and asserts the name was registered, so adding a
 * counter without registering it fails here instead of in production silence.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
// Importing the module runs its own initializeMetrics() (prometheus.ts:282).
import { getMetricsText } from "../prometheus";

const SRC_ROOT = join(import.meta.dir, "../../..");
// Both quote styles: server sources are biome-excluded and mix ' and ", so a
// double-quote-only pattern silently skipped whole files (poll.ts,
// with-retry.ts, task-scheduler.ts, check-stalled-executions.ts).
const CALL_RE = /incrementCounter\(\s*["']([a-z_0-9]+)["']/g;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

function usedCounterNames(): string[] {
  const names = new Set<string>();
  for (const file of walk(SRC_ROOT)) {
    if (file.includes("__tests__")) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(CALL_RE)) names.add(m[1]!);
  }
  return [...names].sort();
}

describe("prometheus counter registration", () => {
  test("every incremented counter is registered", () => {
    const exported = getMetricsText();
    const used = usedCounterNames();

    // Guard the guard: a regex that silently matches nothing would make this
    // test vacuously green.
    expect(used.length).toBeGreaterThan(0);

    const unregistered = used.filter((name) => !exported.includes(name));
    expect(unregistered).toEqual([]);
  });
});
