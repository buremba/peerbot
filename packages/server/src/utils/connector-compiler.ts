/**
 * Connector Compiler — thin wrapper over compiler-core.ts
 *
 * Provides connector-specific esbuild config (node20, CJS banner)
 * and metadata extraction (finds ConnectorRuntime subclass with sync()+execute()).
 */

import { EXTERNAL_RUNTIME_DEPS } from '@lobu/connector-worker/compile';
import type { ConnectorAgentTooling } from '@lobu/connector-sdk';
import { type CompileResult, compileSource, extractMetadata } from './compiler-core';
import { isReservedConnectorKey } from './reserved';

export interface ConnectorMetadata {
  key: string;
  name: string;
  description?: string;
  version: string;
  /** `'data'` (default/absent) vs `'integration'` (pure app/auth, no feeds/sync). */
  kind?: 'data' | 'integration' | null;
  authSchema: Record<string, unknown> | null;
  /** Declarative inbound-webhook schema (signing scheme + routing), if any. */
  webhook: Record<string, unknown> | null;
  feeds: Record<string, unknown> | null;
  actions: Record<string, unknown> | null;
  behaviorEvents: Array<Record<string, unknown>> | null;
  optionsSchema: Record<string, unknown> | null;
  faviconDomain?: string | null;
  mcpConfig?: Record<string, unknown> | null;
  openapiConfig?: Record<string, unknown> | null;
  requiredCapability?: string | null;
  runtime?: {
    platforms: Array<'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'chrome-extension'>;
    scopes?: string[];
  } | null;
  /**
   * What a connection of this connector contributes to the AGENT sandbox (nix
   * packages, credential-backed env vars, egress domains). Persisted verbatim to
   * `connector_definitions.agent_tooling`; the deployment resolver reads it from
   * there, never from connector code.
   */
  agentTooling?: ConnectorAgentTooling | null;
  /**
   * Whether the concrete runtime class OVERRIDES `execute()` (i.e. owns its own
   * `execute` on its prototype rather than inheriting the base class's rejecting
   * default). This is the capability signal readiness uses so it agrees with
   * execution — a connector that declares actions but never overrides execute()
   * would otherwise report "ready" and then throw "Actions not supported"
   * (#2033 item 2). Computed once at compile time. Absent for metadata sources
   * with no local runtime (e.g. MCP-proxy connectors) — persisted as NULL,
   * treated as "assume supported".
   */
  supportsExecute?: boolean;
}

const CONNECTOR_RUNNER_CODE = `
import { pathToFileURL } from 'node:url';

async function main() {
  try {
    const mod = await import(pathToFileURL(process.argv[2]).href);

    let RuntimeClass = null;
    for (const key of Object.keys(mod)) {
      const val = mod[key];
      if (
        typeof val === 'function' &&
        val.prototype &&
        typeof val.prototype.sync === 'function' &&
        typeof val.prototype.execute === 'function'
      ) {
        RuntimeClass = val;
        break;
      }
    }

    if (!RuntimeClass && mod.default) {
      const val = mod.default;
      if (
        typeof val === 'function' &&
        val.prototype &&
        typeof val.prototype.sync === 'function' &&
        typeof val.prototype.execute === 'function'
      ) {
        RuntimeClass = val;
      }
    }

    if (!RuntimeClass) {
      throw new Error(
        'No ConnectorRuntime class found in compiled code. Expected a class with sync() and execute() methods.'
      );
    }

    const instance = new RuntimeClass();
    const def = instance.definition;

    if (!def || typeof def !== 'object') {
      throw new Error('ConnectorRuntime class must expose a definition property.');
    }

    // Capability probe (#2033 item 2): does the concrete class OVERRIDE execute()?
    // The base ConnectorRuntime defines execute() (which rejects), so
    // \`typeof prototype.execute === 'function'\` is always true and can't tell an
    // override from the inherited default. An OWN \`execute\` on the class's own
    // prototype means the connector actually implements execution.
    const supportsExecute =
      Object.getOwnPropertyNames(RuntimeClass.prototype).includes('execute');

    const metadata = {
      key: def.key || null,
      name: def.name || null,
      description: def.description || null,
      version: def.version || null,
      kind: def.kind || null,
      authSchema: def.authSchema || null,
      webhook: def.webhook || null,
      feeds: def.feeds || null,
      actions: def.actions || null,
      behaviorEvents: def.behaviorEvents || null,
      optionsSchema: def.optionsSchema || null,
      faviconDomain: def.faviconDomain || null,
      mcpConfig: def.mcpConfig || null,
      openapiConfig: def.openapiConfig || null,
      requiredCapability: def.requiredCapability || null,
      runtime: def.runtime || null,
      agentTooling: def.agentTooling || null,
      supportsExecute,
    };

    process.send({ success: true, metadata });
  } catch (error) {
    process.send({ success: false, error: error.message });
  }
}

main();
`;

const CJS_SHIM_BANNER = `import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);`;

export async function compileConnectorSource(sourceCode: string): Promise<CompileResult> {
  // Idempotence: a pre-compiled upload keeps its artifact in source_code, and
  // normalizing it under the current compile config routes back through here.
  // Without stripping our own shim first, esbuild's banner would declare
  // __createRequire a second time and the artifact dies at import.
  const input = sourceCode.startsWith(CJS_SHIM_BANNER)
    ? sourceCode.slice(CJS_SHIM_BANNER.length)
    : sourceCode;
  return compileSource(input, {
    tmpPrefix: '.connector-compile-',
    label: 'ConnectorCompiler',
    buildOptions: {
      target: 'node20',
      banner: {
        js: CJS_SHIM_BANNER,
      },
      // Only externalize deps that genuinely can't be bundled (native binaries,
      // runtime install steps). Bundle everything else so connector artifacts
      // stay self-contained and survive runtime image drift.
      external: [...EXTERNAL_RUNTIME_DEPS],
    },
  });
}

export async function extractConnectorMetadata(compiledCode: string): Promise<ConnectorMetadata> {
  return extractMetadata<ConnectorMetadata>(compiledCode, {
    tmpPrefix: '.connector-meta-',
    runnerCode: CONNECTOR_RUNNER_CODE,
  });
}

/**
 * Assert that extracted connector metadata carries the required identity
 * fields. Throws with the canonical message used across the install paths.
 */
export function validateConnectorMetadata(metadata: ConnectorMetadata): void {
  if (!metadata.key || !metadata.name || !metadata.version) {
    throw new Error('Connector must have key, name, and version.');
  }
  // The web app routes `/connectors/<key>/<connectionId>` against a catch-all
  // param, and static sibling segments (CONNECTOR_SUBROUTE_SEGMENTS) win the
  // match. A connector installed under one of those names would have every
  // connection page it owns shadowed by an unrelated route — reject the
  // install rather than ship a connector whose pages are unreachable.
  if (isReservedConnectorKey(metadata.key)) {
    throw new Error(
      `Connector key '${metadata.key}' is reserved by a /connectors/ route. Pick another key.`
    );
  }
}
