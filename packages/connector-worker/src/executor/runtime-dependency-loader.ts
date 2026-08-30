/**
 * Runtime dependency resolver for compiled connector modules.
 *
 * Compiled connectors are staged under the daemon's current working directory
 * so the runtime never writes into an installed package. Bare imports in those
 * modules must nevertheless resolve from the connector-worker installation,
 * not from whatever directory the operator happened to launch `lobu daemon`
 * in. Node's module loader supports that exact rebase without copying or
 * bundling a second SDK graph.
 */

import { register } from 'node:module';
import { EXTERNAL_RUNTIME_DEPS } from '../runtime-deps.js';

const RUNTIME_DEPENDENCY_ROOTS = [
  '@lobu/connector-sdk',
  ...EXTERNAL_RUNTIME_DEPS,
] as const;

type ResolveContext = {
  parentURL?: string;
  [key: string]: unknown;
};

type ResolveResult = {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
  [key: string]: unknown;
};

type NextResolve = (
  specifier: string,
  context: ResolveContext
) => Promise<ResolveResult>;

let runtimeAnchorUrl: string | undefined;
let registered = false;

export function isConnectorRuntimeDependency(specifier: string): boolean {
  return RUNTIME_DEPENDENCY_ROOTS.some(
    (root) => specifier === root || specifier.startsWith(`${root}/`)
  );
}

/** Receive the connector-worker module URL in the isolated loader thread. */
export function initialize(data: unknown): void {
  const anchor =
    data && typeof data === 'object'
      ? (data as { runtimeAnchorUrl?: unknown }).runtimeAnchorUrl
      : undefined;
  if (typeof anchor !== 'string' || anchor.length === 0) {
    throw new Error('connector runtime dependency loader received no anchor URL');
  }
  runtimeAnchorUrl = anchor;
}

/**
 * Resolve runtime-provided connector dependencies as though the import
 * originated inside connector-worker. Delegating to Node's next resolver keeps
 * package export conditions (including import-only SDK subpaths) intact.
 */
export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve
): Promise<ResolveResult> {
  if (!runtimeAnchorUrl || !isConnectorRuntimeDependency(specifier)) {
    return nextResolve(specifier, context);
  }
  return nextResolve(specifier, {
    ...context,
    parentURL: runtimeAnchorUrl,
  });
}

/**
 * Install the resolver once in this process before importing a compiled
 * connector. Bun's source-mode resolver already runs from the workspace graph;
 * the loader is for the Node runtime used by published packages and images.
 */
export function registerConnectorRuntimeDependencyLoader(): void {
  if (
    registered ||
    typeof (process.versions as { bun?: string }).bun === 'string'
  ) {
    return;
  }
  register(import.meta.url, {
    parentURL: import.meta.url,
    data: { runtimeAnchorUrl: import.meta.url },
  });
  registered = true;
}
