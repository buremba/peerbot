import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignore: [
    // Submodule — cleaned up via its own repo / PR.
    "packages/owletto-web/**",
    // Bundled into owletto-cli at build time; not a separate workspace.
    "packages/owletto-cli/runtime/**",
  ],
  ignoreBinaries: [
    // Used in Makefile / k8s scripts but not declared as a workspace dep.
    "helm",
  ],
  // Bun-style "npm:foo@x" import specifiers used by connectors.
  ignoreUnresolved: ["^npm:"],
  workspaces: {
    // Connector source files are loaded by file path
    // (scripts/owletto/install-connectors.ts), not imported as modules.
    "packages/owletto-connectors": {
      entry: ["src/*.ts"],
    },
    // Chrome MV3 extension — entries come from manifest.json + vite.config.ts.
    "packages/owletto-extension": {
      entry: [
        "src/background/service-worker.ts",
        "src/content/index.ts",
        "src/sidebar/main.tsx",
        "src/popup/main.tsx",
        "src/offscreen/worker.ts",
        "src/callback/callback.ts",
      ],
    },
    "packages/owletto-embeddings": {
      // src/openai.ts and src/embedding-utils.ts are reached transitively from
      // server.ts (the package "main"); listing embedding-utils explicitly
      // because src/ contains stale compiled .js siblings that confuse knip's
      // resolver.
      entry: ["src/openai.ts", "src/embedding-utils.ts"],
    },
    "packages/owletto-worker": {
      // child-runner is fork()ed by absolute path, not imported.
      entry: ["src/executor/child-runner.ts"],
      ignoreDependencies: [
        // Loaded via dynamic specifier in src/index.ts.
        "@lobu/worker",
      ],
    },
    "packages/owletto-backend": {
      entry: [
        // Embedded server boot path used by owletto-cli `start`.
        "src/start-local.ts",
        // Reached via cross-workspace import from scripts/owletto/sync-local.ts.
        "src/lib/feed-sync.ts",
        // Dynamically imported at runtime by reaction-executor.
        "src/tools/admin/notify.ts",
        // Benchmark suite — entries are scripts in scripts/owletto/.
        "src/benchmarks/memory/runner.ts",
        "src/benchmarks/memory/adapters/*.ts",
        "src/benchmarks/memory/public-datasets/*.ts",
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
        // Cloudflare Pages middleware — file-based routing.
        "functions/_middleware.ts",
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
    "packages/owletto-cli": {
      entry: [
        // Ambient module declaration; not imported.
        "src/node-sqlite.ts",
        // bun:test files in src/lib/.
        "src/**/*.test.ts",
      ],
    },
    "packages/cli": {
      entry: [
        // Tests in __tests__/ run via `bun test packages/cli` in CI.
        "src/__tests__/**/*.test.ts",
      ],
    },
    ".": {
      entry: [
        // CLI/utility scripts.
        "scripts/**/*.{ts,mjs,js}",
      ],
    },
  },
};

export default config;
