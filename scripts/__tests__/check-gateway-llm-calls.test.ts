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

  /**
   * Regression: the comment stripper used to run `/\/\/.*$/`, which matches the
   * `//` in `https://`. That truncated the line to `fetch("https:` and let the
   * most obvious hand-rolled call — a hardcoded vendor URL — through untouched.
   */
  it("fails on a literal https:// completions URL", () => {
    create(
      `export async function probe() {\n` +
        `  return fetch("https://api.example.test/chat/completions", { method: "POST" });\n` +
        `}\n`
    );
    expect(runGuard()).toBe(1);
  });

  /**
   * Regression: the guard used to inspect single physical lines, but
   * prettier/biome split any call over the print width — so the most likely
   * real-world shape put `fetch(` and the URL on different lines, and no line
   * held both. The merged gate returned exit 0 on exactly these two fixtures
   * (verified against origin/main before `statementText()` landed).
   */
  it("fails on a formatter-split completions fetch", () => {
    create(
      `export async function probe(u: string) {\n` +
        `  return fetch(\n` +
        `    \`\${u}/chat/completions\`,\n` +
        `    { method: "POST" },\n` +
        `  );\n` +
        `}\n`
    );
    expect(runGuard()).toBe(1);
  });

  it("fails on a formatter-split vendor SDK import", () => {
    create(
      `import {\n` +
        `  Anthropic,\n` +
        `} from "@anthropic-ai/sdk";\n` +
        `export default Anthropic;\n`
    );
    expect(runGuard()).toBe(1);
  });

  it("ignores comments inside formatter-split statements", () => {
    create(
      `import {\n` +
        `  // This local adapter is intentionally not "openai".\n` +
        `  request,\n` +
        `} from "./request";\n` +
        `export async function probe(url: string) {\n` +
        `  return fetch(\n` +
        `    url, // This does not call /chat/completions.\n` +
        `    { method: "GET" },\n` +
        `  );\n` +
        `}\n`
    );
    expect(runGuard()).toBe(0);
  });

  it("still ignores prose that merely mentions a completions path", () => {
    create(
      `// Historical note: this used to POST to /chat/completions directly.\n` +
        `export const probe = 1;\n`
    );
    expect(runGuard()).toBe(0);
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
