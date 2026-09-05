/**
 * Builds the agent-session guest bundle.
 *
 * The guest is Lobu's own code, not organization-supplied source, so it is
 * bundled once per worker process and reused for every turn. It goes through
 * the SAME `ISOLATE_LANE_BUILD_OPTIONS` a connector does — one set of esbuild
 * options, one eligibility rule — plus three alias rules that drop the provider
 * SDKs this lane never selects.
 *
 * Why the aliases are exactly these three: `@google/genai` resolves to its Node
 * build and drags google-auth-library, gaxios, ws, node-fetch, agent-base,
 * https-proxy-agent, proxy-agent, debug and supports-color in with it, and
 * `@aws-sdk/client-bedrock-runtime` drags the Bedrock path. Stubbing those two
 * roots removes every Node builtin from the bundle but one: pi-ai reads
 * `/proc/self/environ` through `node:fs` when it detects Bun with an empty
 * `process.env`. That single importer loses `fs`; every other module keeps it,
 * so a bare `require('fs')` anywhere else still survives into the bundle and
 * `assertIsolateEligible` still rejects it.
 */

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISOLATE_LANE_BUILD_OPTIONS } from '../compile/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** esbuild namespace for the aliased-away provider SDKs. */
const STUB_NAMESPACE = 'lobu-agent-guest-stub';

/**
 * The compiled guest entry. `tsc` emits `guest-entry.js` next to this module;
 * under `tsx` only the TypeScript source exists, and esbuild takes either.
 */
function guestEntryPath(): string {
  const compiled = join(HERE, 'guest-entry.js');
  return existsSync(compiled) ? compiled : join(HERE, 'guest-entry.ts');
}

let cached: Promise<string> | null = null;

async function buildAgentGuest(): Promise<string> {
  const result = await build({
    ...ISOLATE_LANE_BUILD_OPTIONS,
    entryPoints: [guestEntryPath()],
    bundle: true,
    write: false,
    minify: false,
    sourcemap: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'agent-guest-alias',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^(@google\/genai|@aws-sdk\/client-bedrock-runtime)(\/.*)?$/ }, (args) => ({
            path: args.path,
            namespace: STUB_NAMESPACE,
          }));
          pluginBuild.onResolve({ filter: /^(node:)?fs$/ }, (args) =>
            /pi-ai[/\\]dist[/\\]env-api-keys\.js$/.test(args.importer)
              ? { path: args.path, namespace: STUB_NAMESPACE }
              : undefined
          );
          pluginBuild.onLoad({ filter: /.*/, namespace: STUB_NAMESPACE }, () => ({
            contents: 'module.exports = {};',
            loader: 'js',
          }));
        },
      },
    ],
  });
  const code = result.outputFiles?.[0]?.text;
  if (!code) throw new Error('the agent guest bundle built to nothing');
  return code;
}

/**
 * The guest bundle for this process. Built on the first turn and kept: it is
 * the same bytes for every agent, and rebuilding it per turn would cost about a
 * second of the turn's own budget.
 */
export function agentGuestBundle(): Promise<string> {
  cached ??= buildAgentGuest().catch((error) => {
    // A failed build must not poison every later turn with the same rejection.
    cached = null;
    throw error;
  });
  return cached;
}
