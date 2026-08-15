/**
 * The published `@lobu/worker` runs under **node**, not bun.
 *
 * `dist/index.bundle.mjs` is ESM, and node's ESM has no ambient `__filename`.
 * Bun's ESM *does* define it, so every in-repo path (tests, `make dev`,
 * `scripts/cli-smoke.sh`) is green while `npx @lobu/cli` crashes on the first
 * agent turn with `ReferenceError: __filename is not defined`.
 *
 * Nothing else in CI can see this: the gateway picks the worker entrypoint by
 * file extension (`gateway/config/index.ts` → `src/index.ts` in-repo,
 * `dist/index.bundle.mjs` installed) and `buildWorkerInvocation`
 * (`orchestration/deployment-manager.ts`) spawns `.ts` under bun and `.mjs`
 * under node. In-repo we only ever take the bun path.
 *
 * So this test reproduces the shipped shape directly: bundle the module with
 * the same esbuild settings `scripts/build-worker-bundle.mjs` uses, then run it
 * under a real `node` binary.
 */

import { describe, expect, test } from "bun:test";
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL("../..", import.meta.url));

/** Resolve a real `node` (the test runner itself is bun). */
function findNode(): string | null {
  const which = spawnSync("which", ["node"], { encoding: "utf8" });
  const path = which.stdout?.trim();
  return which.status === 0 && path ? path : null;
}

describe("egress-fetch under node ESM (the published worker's runtime)", () => {
  test("buildEgressFetch spawns the egress worker without a ReferenceError", () => {
    const node = findNode();
    if (!node) {
      throw new Error(
        "no `node` on PATH — this test asserts node-ESM semantics and cannot be skipped silently"
      );
    }

    // Emit inside the package, not $TMPDIR: `createRequire(...).resolve`
    // walks up from the bundle's own directory, exactly as it does from the
    // installed `dist/index.bundle.mjs`. A temp dir would fail on `undici`
    // for reasons that have nothing to do with what is under test.
    const dir = mkdtempSync(join(pkgDir, ".egress-esm-"));
    try {
      const bundle = join(dir, "egress.mjs");

      // Same knobs as scripts/build-worker-bundle.mjs. The banner is the one
      // esbuild needs for inlined CJS `require()` — note it does NOT define
      // `__filename`, which is exactly the gap under test.
      esbuild.buildSync({
        absWorkingDir: pkgDir,
        entryPoints: [join(pkgDir, "src/embedded/egress-fetch.ts")],
        outfile: bundle,
        bundle: true,
        platform: "node",
        target: "node22",
        format: "esm",
        conditions: ["bun", "import", "module", "default"],
        banner: {
          js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
        },
      });

      // `buildEgressFetch` spawns the shared egress worker eagerly whenever a
      // proxy is configured — the branch a scaffolded project always takes,
      // because `lobu init` writes WORKER_ALLOWED_DOMAINS and the gateway
      // turns that into HTTP_PROXY for the worker.
      const driver = join(dir, "driver.mjs");
      writeFileSync(
        driver,
        [
          `import { buildEgressFetch } from ${JSON.stringify(bundle)};`,
          "class NetworkAccessDenied extends Error {",
          "  constructor(url, reason) { super(`${url}: ${reason}`); }",
          "}",
          "buildEgressFetch(NetworkAccessDenied);",
          'console.log("EGRESS_OK");',
          "process.exit(0);",
        ].join("\n")
      );

      const run = spawnSync(node, [driver], {
        cwd: pkgDir,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, HTTP_PROXY: "http://127.0.0.1:1" },
      });

      const output = `${run.stdout || ""}${run.stderr || ""}`;
      expect(output).not.toContain("__filename is not defined");
      expect(output).not.toContain("ReferenceError");
      expect(run.stdout || "").toContain("EGRESS_OK");
      expect(run.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
