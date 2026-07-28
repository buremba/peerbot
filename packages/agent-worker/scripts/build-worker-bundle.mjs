#!/usr/bin/env node
/**
 * Bundle the @lobu/worker entrypoint into a standalone ESM file for publishing.
 *
 * Why this exists: @lobu/worker depends on five `private: true` workspace
 * packages (plugin-conversations, plugin-mcp, plugin-media, plugin-memory,
 * plugin-toolkit). Those are never published, but `tsc` only transpiles — it
 * leaves bare `require("@lobu/plugin-mcp")` calls in dist/ and the imports in
 * the shipped src/. @lobu/worker@14.3.0 therefore went to the registry
 * depending on packages that do not exist there, 404ing `npx @lobu/cli@latest`
 * for every external consumer (#2186). Inlining them at build time is what
 * makes the published package installable while keeping them private.
 *
 * Why ESM and not a patched dist/: the CJS dist is a genuine dead end.
 * agent-worker compiles with "module": "CommonJS", and
 * @mariozechner/pi-coding-agent is `type: module` exposing only an `import`
 * condition, so a node-loaded require() of dist/index.js throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED. That is why the package shipped src/ plus a
 * `bun` exports condition at all — the server resolves `src/index.ts` in
 * preference to dist (see packages/server/src/gateway/config/index.ts). This
 * bundle replaces that src/ entry with something Node itself can load.
 *
 * Resolution conditions: 'bun' first, so workspace packages resolve to their TS
 * source rather than a CJS dist barrel. esbuild compiles the TS inline.
 *
 * External vs inlined:
 *   - EVERY @lobu workspace package is inlined, published ones included.
 *     Keeping @lobu/core external seemed better (one shared copy) but does not
 *     work — see the note at the resolver below. Inlining them all also means
 *     the published manifest declares no @lobu dependencies at all, so the
 *     release no longer waits on plugin-api/plugin-host being bootstrapped.
 *   - Every npm dependency stays external, loaded from node_modules at runtime,
 *     and must be declared by this package — enforced at the bottom of this file.
 */

import esbuild from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");

const result = await esbuild.build({
  absWorkingDir: pkgDir,
  entryPoints: [join(pkgDir, "src/index.ts")],
  outfile: join(pkgDir, "dist/index.bundle.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  conditions: ["bun", "import", "module", "default"],
  sourcemap: true,
  metafile: true,
  logLevel: "info",
  plugins: [
    {
      name: "inline-lobu-workspace",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === "entry-point") return null;
          const id = args.path;
          // Relative/absolute imports are part of this package — bundle them.
          if (id.startsWith(".") || id.startsWith("/")) return null;
          // ALL @lobu workspace packages are inlined, published ones included.
          //
          // Leaving @lobu/core external looked right (one shared copy from
          // node_modules) but does not work: core, plugin-api and plugin-host
          // are CommonJS, this bundle is ESM, and Node cannot reliably bind
          // named imports across that boundary — a clean install died with
          // "Named export 'sanitizeSuggestionPrompts' not found. The requested
          // module '@lobu/core' is a CommonJS module". This is the same
          // ESM↔CJS interop trap documented in
          // packages/server/scripts/build-server-bundle.mjs (#430), and the
          // same resolution: bundle the workspace graph, keep only npm
          // dependencies external.
          if (id.startsWith("@lobu/")) return null;
          return { external: true };
        });
      },
    },
  ],
  // esbuild emits require() calls when inlining CJS-flavoured workspace source;
  // ESM output has no require, so provide one. Per-module __filename/__dirname
  // shims are emitted by esbuild itself, so don't add them here.
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
});

// The publish transform ships exactly these declaration files as the package's
// entire type surface. tsc is incremental: after `rm -rf dist` a stale
// tsconfig.tsbuildinfo makes it exit 0 having emitted nothing, which would
// publish a bundle with no types at all and no error anywhere. Assert they
// exist rather than trusting tsc's exit code (fix: delete tsconfig.tsbuildinfo).
for (const decl of ["dist/index.d.ts", "dist/core/types.d.ts"]) {
  if (!existsSync(join(pkgDir, decl))) {
    console.error(
      `\n[build-worker-bundle] FAILED: ${decl} missing — tsc emitted no declarations.\n` +
        "  This is usually a stale tsconfig.tsbuildinfo after dist/ was deleted.\n" +
        "  Fix: rm packages/agent-worker/tsconfig.tsbuildinfo && bun run build"
    );
    process.exit(1);
  }
}

// Select the JS output explicitly — outputs also contains the .map entry, and
// picking [0] silently read the sourcemap's (empty) import list instead, which
// made this check pass unconditionally.
const jsOutput = Object.entries(result.metafile.outputs).find(([file]) =>
  file.endsWith(".mjs")
)?.[1];
if (!jsOutput) {
  console.error("\n[build-worker-bundle] FAILED: no .mjs output in metafile");
  process.exit(1);
}
const imports = jsOutput.imports ?? [];
// No @lobu specifier may survive: the published manifest declares none, so any
// that remained would be unresolvable for a consumer — the exact shape of
// #2186. This is stricter than checking only the private ones, and it is what
// lets the publish transform drop every @lobu dependency safely.
const leaked = [
  ...new Set(imports.map((i) => i.path).filter((p) => p.startsWith("@lobu/"))),
];
if (leaked.length > 0) {
  console.error(
    `\n[build-worker-bundle] FAILED: @lobu imports survived bundling: ${leaked.join(", ")}\n` +
      "  The published manifest declares no @lobu dependencies, so these would not resolve."
  );
  process.exit(1);
}

// Every external the bundle keeps must be declared by THIS package, because
// that is all a consumer installs. Inlining a private plugin pulls its own
// dependencies into our import graph without pulling its manifest: bundling
// plugin-media silently added `form-data`, which is declared by plugin-media
// but was not a dependency of @lobu/worker, so a clean install imported the
// bundle and died with ERR_MODULE_NOT_FOUND. Caught by installing the packed
// tarball in an empty directory; this check makes it a build failure instead.
const pkgManifest = JSON.parse(
  readFileSync(join(pkgDir, "package.json"), "utf8")
);
const declared = new Set([
  ...Object.keys(pkgManifest.dependencies ?? {}),
  ...Object.keys(pkgManifest.peerDependencies ?? {}),
]);
const externals = [
  ...new Set(
    imports
      .filter((i) => i.external)
      .map((i) => i.path)
      .filter((p) => !p.startsWith("node:"))
      // Bare specifier → package name (@scope/name or name).
      .map((p) =>
        p.startsWith("@") ? p.split("/").slice(0, 2).join("/") : p.split("/")[0]
      )
  ),
].sort();
const undeclared = externals.filter((p) => !declared.has(p));
if (undeclared.length > 0) {
  console.error(
    `\n[build-worker-bundle] FAILED: the bundle imports packages ${pkgManifest.name} does not declare: ${undeclared.join(", ")}\n` +
      "  A consumer installing this package would hit ERR_MODULE_NOT_FOUND.\n" +
      "  Add them to dependencies (they most likely come from an inlined private plugin)."
  );
  process.exit(1);
}

console.log(
  `\n[build-worker-bundle] ok — ${externals.length} external(s), all declared: ${externals.join(", ")}`
);
