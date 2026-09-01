import { createHash } from 'node:crypto';

/**
 * Single source of truth for npm packages that connector code may import but
 * which the connector runtime provides instead of bundling into each compiled
 * connector artifact.
 *
 * These deps must be installed in every runtime that executes compiled
 * connectors — the server container that hosts in-process feed sync,
 * and the connector-worker daemon that runs out-of-process. They appear in:
 *
 *   - `packages/connector-worker/src/compile/index.ts` (`@lobu/connector-sdk`
 *     is externalized by the SDK plugin; the rest use esbuild's `external` list)
 *   - `packages/connector-worker/package.json` dependencies (so the runtime can
 *     resolve them)
 *   - `assertExternalDepsResolvable()` (boot-time check that crashes loud
 *     instead of failing silently per-feed)
 *
 * Rule of thumb: besides the shared connector SDK, only externalize deps that
 * genuinely can't be bundled —
 * native binaries (`sharp`, `jimp`) or runtime install steps
 * (`playwright` ships browsers via `npx playwright install`). Pure JS deps
 * like `pino` or `link-preview-js` should be bundled instead, even if it
 * costs a few hundred KB per connector — bundling eliminates the entire
 * class of "compiled connector references X but X isn't installed in the
 * worker image" outages.
 */
/** Native/browser dependencies externalized through esbuild's `external` option. */
export const EXTERNAL_RUNTIME_DEPS = ['playwright', 'sharp', 'jimp'] as const;

/** Shared framework externalized by the connector SDK esbuild plugin. */
const CONNECTOR_SDK_RUNTIME_DEP = '@lobu/connector-sdk' as const;

/** Every bare package specifier a compiled connector expects the runtime to supply. */
export const RUNTIME_PROVIDED_PACKAGES = [
  CONNECTOR_SDK_RUNTIME_DEP,
  ...EXTERNAL_RUNTIME_DEPS,
] as const;

/**
 * Bump when the compile pipeline changes in a way that makes previously
 * compiled artifacts unsafe to execute (esbuild banner/target/plugin
 * semantics). Changes to EXTERNAL_RUNTIME_DEPS are picked up automatically
 * via the fingerprint below.
 */
const COMPILE_PIPELINE_VERSION = 1;

/** Fingerprint of the compile configuration that produced an artifact. */
export function computeCompileConfigHash(external: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ pipeline: COMPILE_PIPELINE_VERSION, external }))
    .digest('hex');
}

/**
 * Fingerprint of the CURRENT compile configuration. Stored on
 * `connector_versions.compile_config_hash` next to every persisted
 * `compiled_code`; an artifact whose stored fingerprint doesn't match is
 * stale (e.g. compiled when `pino` was still externalized) and must be
 * recompiled instead of executed.
 */
export const COMPILE_CONFIG_HASH = computeCompileConfigHash(EXTERNAL_RUNTIME_DEPS);

/**
 * Verify that every external runtime dep is resolvable from the current
 * process. Call this once at startup of any service that executes compiled
 * connectors. Throws (so the process crashes) instead of letting individual
 * feed runs fail with `Missing npm dependency: X`.
 */
export function assertExternalDepsResolvable(
  resolve: (specifier: string) => void
): void {
  const missing: string[] = [];
  for (const dep of RUNTIME_PROVIDED_PACKAGES) {
    try {
      resolve(dep);
    } catch {
      missing.push(dep);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Connector runtime is missing required npm packages: ${missing.join(', ')}. ` +
        `These are declared in RUNTIME_PROVIDED_PACKAGES (packages/connector-worker/src/runtime-deps.ts) ` +
        `and must be installed in every runtime that executes compiled connectors. ` +
        `Add them to packages/connector-worker/package.json and rebuild the runtime image.`
    );
  }
}
