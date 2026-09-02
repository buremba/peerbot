/**
 * Isolate-lane eligibility of a compiled connector bundle.
 *
 * A bundle built with `ISOLATE_LANE_BUILD_OPTIONS` inlines every dependency
 * except Node builtins, which esbuild leaves as bare `require()` calls because
 * `platform: 'node'` marks them external. An isolate has no module loader, so
 * a surviving builtin `require` is the fail-closed signal that the connector
 * needs the process lane. The compiler reports it from the esbuild metafile;
 * this scan is the same check for bundles that arrive already compiled (the
 * gateway ships `compiled_code` to device workers), so the executor can refuse
 * at init with the builtin named instead of failing at the connector's first
 * call.
 */

import { builtinModules } from 'node:module';

const BUILTINS = new Set(builtinModules);

export function isNodeBuiltinSpecifier(specifier: string): boolean {
  return specifier.startsWith('node:') || BUILTINS.has(specifier);
}

/**
 * Matches `require("x")` and esbuild's `__require("x")` shim with a string
 * literal argument. Relative and package specifiers are ignored: only a Node
 * builtin makes the bundle ineligible, and a runtime-provided package that
 * survived as a bare require is caught at load by the guest's throwing
 * `require`.
 */
const REQUIRE_CALL_RE = /(?:^|[^\w$.])(?:__)?require\(\s*(["'])([^"'\\\n]+)\1\s*\)/g;

/** Node builtins a bundle still requires, `node:` prefix stripped, sorted. */
export function findIsolateIneligibleBuiltins(code: string): string[] {
  const found = new Set<string>();
  for (const match of code.matchAll(REQUIRE_CALL_RE)) {
    const specifier = match[2];
    if (isNodeBuiltinSpecifier(specifier)) found.add(specifier.replace(/^node:/, ''));
  }
  return [...found].sort();
}

/** Thrown before any isolate work when a bundle needs a Node process. */
export class IsolateLaneIneligibleError extends Error {
  readonly builtins: string[];

  constructor(builtins: string[], label?: string) {
    const subject = label ? `Connector '${label}'` : 'Connector bundle';
    super(
      `${subject} requires Node builtin${builtins.length === 1 ? '' : 's'} ` +
        `[${builtins.join(', ')}] and cannot run on the isolate lane; route it to the process lane.`
    );
    this.name = 'IsolateLaneIneligibleError';
    this.builtins = builtins;
  }
}

/** Throw `IsolateLaneIneligibleError` when `code` still requires a Node builtin. */
export function assertIsolateEligible(code: string, label?: string): void {
  const builtins = findIsolateIneligibleBuiltins(code);
  if (builtins.length > 0) throw new IsolateLaneIneligibleError(builtins, label);
}
