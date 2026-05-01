#!/usr/bin/env node
/**
 * Bundle src/server.ts into a single ESM file for production runtime.
 *
 * Why: prod runs under Node so isolated-vm (V8 native addon) loads. Running
 * the TS source through tsx exposes Node's CJS↔ESM lexer interop with
 * @lobu/core's CJS dist (#430 history). Bundling resolves all workspace
 * imports at build time, so Node only ever sees the bundle's own ESM
 * surface plus a small set of npm externals it can load from node_modules.
 *
 * Resolution conditions: 'bun' first, so workspace packages resolve to
 * their TS source (./src/index.ts via the package.json `bun` condition)
 * instead of their CJS dist. esbuild compiles the TS inline.
 *
 * External: bare specifiers stay external (loaded from node_modules at
 * runtime). Published `@lobu/cli` declares those runtime dependencies
 * directly so Node's resolver finds them from the CLI install. Native addons
 * (isolated-vm) and packages with require-in-the-middle hooks (Sentry,
 * OpenTelemetry, pino) MUST stay external to keep their runtime hooks working.
 */

import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');

const result = await esbuild.build({
  absWorkingDir: pkgDir,
  entryPoints: ['src/server.ts'],
  bundle: true,
  outfile: 'dist/server.bundle.mjs',
  platform: 'node',
  target: 'node22',
  format: 'esm',
  conditions: ['bun', 'import', 'module', 'default'],
  // Bundle only @lobu/* workspace packages and relative imports. Everything
  // else stays external.
  plugins: [
    {
      name: 'external-non-workspace',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === 'entry-point') return null;
          const id = args.path;
          if (id.startsWith('.') || id.startsWith('/')) return null;
          if (id.startsWith('@lobu/')) return null;
          return { external: true };
        });
      },
    },
  ],
  // CJS-style require() shim for any leftover require() calls in bundled
  // code (esbuild emits these when it inlines CJS-flavoured workspace src).
  // Don't inject __filename/__dirname here — esbuild emits per-module shims
  // when bundled CJS source references them; top-level shims would collide.
  banner: {
    js: `import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);`,
  },
  sourcemap: true,
  metafile: true,
  logLevel: 'info',
});

const output = Object.entries(result.metafile.outputs).find(([file]) =>
  file.endsWith('dist/server.bundle.mjs'),
)?.[1];
const bytes = output?.bytes ?? 0;
console.log(
  `\n=== bundle ready: dist/server.bundle.mjs (${(bytes / 1024 / 1024).toFixed(2)} MB)`,
);
console.log(`    warnings: ${result.warnings.length}, errors: ${result.errors.length}`);
