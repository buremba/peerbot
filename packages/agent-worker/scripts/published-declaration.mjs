/**
 * Generate the single self-contained declaration shipped beside the published
 * @lobu/worker bundle.
 *
 * The published manifest declares no @lobu dependencies, so shipping tsc's
 * dist/core/types.d.ts verbatim left `import type { WorkerTransport } from
 * "@lobu/core"` dangling and every consumer's tsc failed with TS2307. Only
 * WorkerConfig is exported from the entry and it does not reference
 * @lobu/core — that import serves sibling interfaces outside the public
 * surface — so the declaration is rebuilt from just that type.
 *
 * Kept pure and separate from build-worker-bundle.mjs so the publish gate can
 * exercise it without a built dist/: the gate runs in a lint job that never
 * builds, and reading the emitted artifact there failed with ENOENT.
 */

const WORKER_CONFIG = /export interface WorkerConfig \{[\s\S]*?\n\}/;

/**
 * @param {string} typesSource Contents of the module declaring WorkerConfig.
 * @returns {string} The declaration to write next to the bundle.
 * @throws If WorkerConfig is absent, or references an @lobu package.
 */
export function buildPublishedDeclaration(typesSource) {
  const workerConfig = typesSource.match(WORKER_CONFIG)?.[0];
  if (!workerConfig) {
    throw new Error(
      "could not extract WorkerConfig. The published type surface is generated " +
        "from it; check whether it was renamed."
    );
  }
  if (/@lobu\//.test(workerConfig)) {
    throw new Error(
      "generated declaration references an @lobu package. The published " +
        "manifest declares none, so a consumer's tsc would fail with TS2307."
    );
  }
  return `${workerConfig}\n`;
}
