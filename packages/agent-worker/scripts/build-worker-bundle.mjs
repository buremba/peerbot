#!/usr/bin/env node
/**
 * Bundle the @lobu/worker entrypoint into a standalone ESM file for publishing.
 *
 * Why: @lobu/worker imports `private: true` workspace packages, and `tsc` only
 * transpiles — so both the tsc dist/ and the shipped src/ carried bare
 * `@lobu/plugin-*` specifiers that no consumer can resolve (#2186). Inlining
 * them keeps those packages private and the published one installable.
 *
 * Why ESM: agent-worker compiles to CommonJS and @mariozechner/pi-coding-agent
 * is import-only, so a node require() of the CJS dist throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED — which is why src/ was shipped at all. This
 * bundle is the first entry point Node itself can load.
 *
 * EVERY @lobu package is inlined (see the resolver note below); every npm
 * dependency stays external and must be declared here, enforced at the bottom.
 */

import esbuild from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
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
          // Published @lobu packages are inlined too, not just the private
          // ones: they are CommonJS and this bundle is ESM, so leaving them
          // external made a clean install die on "Named export
          // 'sanitizeSuggestionPrompts' not found". Same ESM↔CJS trap and same
          // fix as packages/server/scripts/build-server-bundle.mjs (#430).
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

// tsc is incremental: after `rm -rf dist` a stale tsconfig.tsbuildinfo makes it
// exit 0 having emitted nothing, which would publish a typeless bundle with no
// error anywhere. Don't trust tsc's exit code — check the files.
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
// No @lobu specifier may survive: the published manifest declares none, so a
// leftover would be unresolvable — the exact shape of #2186.
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

// Every external must be declared by THIS package — that is all a consumer
// installs. Inlining pulls in the inlined package's own dependencies without
// its manifest (plugin-media brought `form-data`), so a clean install died with
// ERR_MODULE_NOT_FOUND. This turns that into a build failure.
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
      // Node builtins are not npm packages. The resolver above externalises
      // every bare specifier, so an unprefixed `path`/`fs`/`crypto` anywhere in
      // the inlined graph would otherwise be reported as an undeclared
      // dependency. isBuiltin covers both spellings and subpaths
      // (`fs`, `node:fs`, `node:fs/promises`).
      .filter((p) => !isBuiltin(p))
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
