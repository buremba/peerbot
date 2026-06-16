import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignore: [
    // Submodule — cleaned up via its own repo / PR.
    "packages/owletto/**",
    // Codegen output (openapi-ts). Not hand-maintained; it intentionally emits
    // a superset of helpers, so "unused export" noise here is expected.
    "packages/client/src/generated/**",
  ],
  // Bun-style "npm:foo@x" import specifiers used by connectors.
  ignoreUnresolved: ["^npm:"],
  workspaces: {
    // Connector source files are loaded by file path
    // (scripts/lobu/install-connectors.ts), not imported as modules.
    "packages/connectors": {
      entry: ["src/*.ts", "src/**/*.test.ts", "src/__tests__/**/*.ts"],
    },
    "packages/connector-worker": {
      // package.json bin/main point at compiled dist/, so knip can't map them
      // back to source — list the real source entries here.
      entry: [
        "src/bin.ts",
        "src/daemon/index.ts",
        "src/compile-connector.ts",
        // child-runner is fork()ed by absolute path, not imported.
        "src/executor/child-runner.ts",
        "src/**/*.test.ts",
        "integration-tests/**/*.test.ts",
      ],
      ignoreDependencies: [
        // Loaded via dynamic specifier in src/index.ts.
        "@lobu/worker",
      ],
    },
    "packages/embeddings": {
      // main points at dist/; the source entries are index, the standalone
      // embeddings server, and (reached transitively) openai/embedding-utils,
      // listed because src/ holds stale compiled .js siblings that confuse the
      // resolver.
      entry: [
        "src/index.ts",
        "src/server.ts",
        "src/openai.ts",
        "src/embedding-utils.ts",
        "src/**/*.test.ts",
      ],
    },
    "packages/connector-sdk": {
      entry: ["src/**/*.test.ts", "src/__tests__/**/*.ts"],
    },
    "packages/server": {
      entry: [
        // Main server boot (package main points at compiled dist/, so knip
        // can't map it back to source).
        "src/server.ts",
        // Sentry preload (node --import) and embedded-Postgres boot.
        "src/instrument.ts",
        "src/embedded-runtime.ts",
        "src/utils/assert-node-version.ts",
        // Embedded server boot path; previously also used by `lobu start`
        // before the CLI merge collapsed everything onto `lobu run`.
        "src/start-local.ts",
        // Reached via cross-workspace import from scripts/lobu/sync-local.ts.
        "src/lib/feed-sync.ts",
        // Dynamically imported at runtime by reaction-executor.
        "src/tools/admin/notify.ts",
        // Test suites run in CI (vitest + bun:test).
        "src/**/*.test.ts",
        "src/**/__tests__/**/*.ts",
        // esbuild bundler invoked as `node scripts/build-server-bundle.mjs`.
        "scripts/**/*.mjs",
      ],
      ignoreDependencies: [
        // Loaded via dynamic _require() in execute-data-sources.ts.
        "node-sql-parser",
        // Activated by `vitest --coverage`.
        "@vitest/coverage-v8",
      ],
    },
    "packages/landing": {
      entry: [
        // Cloudflare Pages functions — file-based routing (every file under
        // functions/ is a route entry, not an imported module).
        "functions/**/*.ts",
        // Wired through a custom Astro plugin in astro.config.mjs.
        "src/settings-mock/mock-api.ts",
        "src/settings-mock/mock-context.tsx",
        // Starlight customCss — referenced from astro.config.mjs.
        "src/styles/starlight-shared.css",
        "src/styles/starlight-theme.css",
      ],
      ignoreDependencies: [
        "@preact/signals",
        // Resolved via Astro alias (`@providers-config`).
        "@providers-config",
      ],
    },
    "packages/cli": {
      entry: [
        // Tests run via `bun test packages/cli` in CI (nested __tests__ dirs).
        "src/**/*.test.ts",
        "src/**/__tests__/**/*.ts",
        // Ambient module declaration for node:sqlite (used by memory browser-auth).
        "src/types/node-sqlite.d.ts",
        // Public config DSL — `defineAgent`/`defineConfig`/`defineConnector`/…
        // are imported by USER `lobu.config.ts` files outside this repo, so
        // knip can't see the consumers. As entry files their exports are
        // treated as the package's external API and not reported unused.
        "src/config/index.ts",
        "src/config/define.ts",
        "src/config/secret.ts",
        // Build helper invoked as `node scripts/build.cjs`.
        "scripts/build.cjs",
      ],
    },
    ".": {
      entry: [
        // CLI/utility scripts.
        "scripts/**/*.{ts,mjs,js}",
        // Example projects are loaded by file path at apply time and double as
        // the consumers of the public config DSL — treat them as entries so
        // knip follows them instead of flagging them (and the DSL) as unused.
        "examples/**/lobu.config.ts",
        "examples/**/*.connector.ts",
        "examples/**/*.reaction.ts",
        "examples/**/*.eval.ts",
        "examples/**/evals/**/*.ts",
        "examples/**/skills/**/*.ts",
      ],
    },
  },
};

export default config;
