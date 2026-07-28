/**
 * The gateway-LLM guard is only worth having if it actually fails on the
 * violations it was written to catch. A guard that has quietly stopped
 * catching them is worse than no guard, because a green run reads as proof.
 *
 * (The sibling naming guard needed four revisions before it caught its own
 * fixtures — see check-exposed-surface-naming.test.ts.)
 *
 * These write a scratch file into the real scanned tree, run the guard as a
 * subprocess, and assert the exit code — the same signal `make pre-pr` and CI
 * act on. Every fixture file is removed in afterEach.
 */

import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/check-gateway-llm-calls.mjs");
/** Inside packages/server/src, which is the tree the guard scans. */
const PROBE = join(REPO_ROOT, "packages/server/src/gateway/guard-probe.ts");

const created: string[] = [];

function create(contents: string): void {
  created.push(PROBE);
  writeFileSync(PROBE, contents);
}

function runGuard(): number {
  return Bun.spawnSync(["node", GUARD], { cwd: REPO_ROOT }).exitCode;
}

afterEach(() => {
  for (const file of created.splice(0)) rmSync(file, { force: true });
});

describe("check-gateway-llm-calls", () => {
  it("passes on the clean tree", () => {
    expect(runGuard()).toBe(0);
  });

  it("fails on a hand-rolled chat/completions fetch", () => {
    create(
      `export async function probe(baseUrl: string) {\n` +
        `  return fetch(\`\${baseUrl}/chat/completions\`, { method: "POST" });\n` +
        `}\n`
    );
    expect(runGuard()).toBe(1);
  });

  it("fails on a per-feature credential triple", () => {
    create(
      `const PROBE_API_KEY = process.env.PROBE_API_KEY;\n` +
        `const PROBE_BASE_URL = process.env.PROBE_BASE_URL;\n` +
        `const PROBE_MODEL = process.env.PROBE_MODEL;\n` +
        `export const probe = { PROBE_API_KEY, PROBE_BASE_URL, PROBE_MODEL };\n`
    );
    expect(runGuard()).toBe(1);
  });

  it("fails on a vendor SDK import outside the allowlisted client", () => {
    create(
      `import Anthropic from "@anthropic-ai/sdk";\nexport default Anthropic;\n`
    );
    expect(runGuard()).toBe(1);
  });

  it("fails on the /v1/messages and /responses paths too", () => {
    create(
      `export async function probe(u: string) {\n` +
        `  await fetch(\`\${u}/v1/messages\`, { method: "POST" });\n` +
        `  return fetch(\`\${u}/responses\`, { method: "POST" });\n` +
        `}\n`
    );
    expect(runGuard()).toBe(1);
  });

  it("honours a gateway-llm-ok suppression on the flagged line", () => {
    create(
      `export async function probe(u: string) {\n` +
        `  // gateway-llm-ok: fixture — asserts the escape hatch still works.\n` +
        `  return fetch(\`\${u}/chat/completions\`, { method: "POST" });\n` +
        `}\n`
    );
    expect(runGuard()).toBe(0);
  });
});
