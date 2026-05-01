/**
 * Connector Compiler — thin wrapper over compiler-core.ts
 *
 * Provides connector-specific esbuild config (node20, CJS banner)
 * and metadata extraction (finds ConnectorRuntime subclass with sync()+execute()).
 */

import { EXTERNAL_RUNTIME_DEPS } from '../../../connector-worker/src/runtime-deps';
import { type CompileResult, compileSource, extractMetadata } from './compiler-core';

export interface ConnectorMetadata {
  key: string;
  name: string;
  description?: string;
  version: string;
  authSchema: Record<string, unknown> | null;
  feeds: Record<string, unknown> | null;
  actions: Record<string, unknown> | null;
  optionsSchema: Record<string, unknown> | null;
  faviconDomain?: string | null;
  mcpConfig?: Record<string, unknown> | null;
  openapiConfig?: Record<string, unknown> | null;
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

    const metadata = {
      key: def.key || null,
      name: def.name || null,
      description: def.description || null,
      version: def.version || null,
      authSchema: def.authSchema || null,
      feeds: def.feeds || null,
      actions: def.actions || null,
      optionsSchema: def.optionsSchema || null,
      faviconDomain: def.faviconDomain || null,
      mcpConfig: def.mcpConfig || null,
      openapiConfig: def.openapiConfig || null,
    };

    process.send({ success: true, metadata });
  } catch (error) {
    process.send({ success: false, error: error.message });
  }
}

main();
`;

export async function compileConnectorSource(sourceCode: string): Promise<CompileResult> {
  return compileSource(sourceCode, {
    tmpPrefix: '.connector-compile-',
    label: 'ConnectorCompiler',
    buildOptions: {
      target: 'node20',
      banner: {
        js: `import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);`,
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
