/**
 * Single source of truth for npm packages that connector code may import but
 * which we deliberately do NOT bundle into the compiled connector artifact.
 *
 * These deps must be installed in every runtime that executes compiled
 * connectors — the server container that hosts in-process feed sync,
 * and the connector-worker daemon that runs out-of-process. They appear in:
 *
 *   - `server/src/utils/connector-compiler.ts` `external` list
 *     (esbuild leaves the imports as bare specifiers in the bundle)
 *   - `packages/connector-worker/package.json` dependencies (so the runtime can
 *     resolve them)
 *   - `assertExternalDepsResolvable()` (boot-time check that crashes loud
 *     instead of failing silently per-feed)
 *
 * Rule of thumb: only externalize deps that genuinely can't be bundled —
 * native binaries (`sharp`, `jimp`) or runtime install steps
 * (`playwright` ships browsers via `npx playwright install`). Pure JS deps
 * like `pino` or `link-preview-js` should be bundled instead, even if it
 * costs a few hundred KB per connector — bundling eliminates the entire
 * class of "compiled connector references X but X isn't installed in the
 * worker image" outages.
 */
export const EXTERNAL_RUNTIME_DEPS = ['playwright', 'sharp', 'jimp'] as const;

export type ExternalRuntimeDep = (typeof EXTERNAL_RUNTIME_DEPS)[number];

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
  for (const dep of EXTERNAL_RUNTIME_DEPS) {
    try {
      resolve(dep);
    } catch {
      missing.push(dep);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Connector runtime is missing required npm packages: ${missing.join(', ')}. ` +
        `These are declared in EXTERNAL_RUNTIME_DEPS (packages/connector-worker/src/runtime-deps.ts) ` +
        `and must be installed in every runtime that executes compiled connectors. ` +
        `Add them to packages/connector-worker/package.json and rebuild the runtime image.`
    );
  }
}
