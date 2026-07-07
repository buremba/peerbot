import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const PACKAGE_ROOT = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // Anchor vitest to this package so test-db.ts's `process.cwd()`-based
  // migration resolution works the same way whether `vitest` is invoked from
  // the repo root (e.g. via `bunx vitest --config packages/...`) or from
  // inside the package.
  root: PACKAGE_ROOT,
  test: {
    globalSetup: ["./src/__tests__/setup/global-setup.ts"],
    // Integration tests need a DB ready before any test file starts. Unit tests
    // don't touch the DB, so they run fast regardless.
    include: ["src/**/*.test.ts"],
    // bun:test-style unit tests live alongside vitest integration tests — skip
    // those for vitest. They run via `bun test` (see the existing CI command).
    // Anything under `src/gateway/**/__tests__` is bun:test-style (carried over
    // from the merged @lobu/gateway package, plus the caches + queue unit tests).
    exclude: [
      "src/__tests__/unit/**",
      // Opt-in, key-gated live provider smoke — bun:test, run via
      // `make test-providers-live`, never as part of the integration gate.
      "src/__tests__/live-providers/**",
      "src/gateway/**/__tests__/**",
      // Only src/lobu/__tests__ is bun:test (route suites). Nested dirs like
      // src/lobu/stores/__tests__ are vitest-style and must stay visible to
      // vitest — do NOT broaden this back to src/lobu/**/__tests__/**.
      "src/lobu/__tests__/**",
      "src/scheduled/**/__tests__/**",
      "src/workspace/**/__tests__/**",
      // src/tools/admin/__tests__ is bun:test (schedule-delivery suites), run via
      // the same `bun test … src/tools/admin/__tests__` job — keep it off vitest.
      "src/tools/admin/__tests__/**",
      // src/auth/oauth/__tests__ is bun:test (OAuth scope suites), run via the
      // same `bun test … src/auth/oauth/__tests__` job — keep it off vitest.
      "src/auth/oauth/__tests__/**",
      "**/node_modules/**",
      "**/dist/**",
    ],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests share one Postgres. Running multiple files in
    // parallel means one file's `cleanupTestDatabase()` can wipe another file's
    // fixtures mid-run. Serialize files so fixtures stay stable.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // CRITICAL for the shared DB singleton in db/client.ts: with vitest's
    // default `isolate: true`, each test file gets a fresh module registry —
    // so each one re-runs `let dbSingleton = null` and opens its own pool.
    // `idle_timeout: 0` in db/client.ts means those orphaned pools' sockets
    // never close, and 70+ files × 5 connections each blew past the
    // pgvector-image `max_connections=100` with the classic "sorry, too many
    // clients already" error. Sharing the module graph (`isolate: false`)
    // keeps the singleton truly singleton across the whole run.
    isolate: false,
  },
});
