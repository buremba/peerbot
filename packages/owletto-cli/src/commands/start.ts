import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { run } from '../lib/process-runner.ts';
import { type RuntimeRootResolution, requireOwlettoRuntimeRoot } from '../lib/repo-root.ts';
import { getTsxInvocation } from '../lib/tsx.ts';

function findDataDir(runtime: RuntimeRootResolution, explicit?: string): string | undefined {
  if (explicit) return explicit;
  // Prefer ./data only for a real repo checkout. Packaged installs should use ~/.owletto/data.
  if (
    runtime.source === 'repo' &&
    existsSync(join(runtime.workspaceRoot, 'db', 'migrations', '00000000000000_baseline.sql'))
  ) {
    return join(runtime.workspaceRoot, 'data');
  }
  // Otherwise ~/.owletto/data (handled by start-local.ts default)
  return undefined;
}

function detectMode(): 'pglite' | 'postgres' {
  if (process.env.DATABASE_URL) return 'postgres';
  return 'pglite';
}

export default defineCommand({
  meta: {
    name: 'start',
    description: 'Start the local Owletto runtime',
  },
  args: {
    port: { type: 'string', description: 'Port to listen on', default: '8787' },
    dataDir: { type: 'string', description: 'Data directory for PGlite' },
  },
  async run({ args }) {
    const runtime = requireOwlettoRuntimeRoot();
    const runCwd = runtime.source === 'repo' ? runtime.workspaceRoot : process.cwd();
    const mode = detectMode();
    const env: Record<string, string | undefined> = {
      PORT: args.port,
    };

    if (mode === 'postgres') {
      const invocation = getTsxInvocation([join(runtime.runtimeRoot, 'src', 'server.ts')]);
      // DATABASE_URL is set — use the regular server against external Postgres
      const result = await run(invocation.cmd, {
        args: invocation.args,
        cwd: runCwd,
        env,
      });
      process.exitCode = result.code;
    } else {
      // Default local mode: embedded Postgres (PGlite) + app server
      const dataDir = findDataDir(runtime, args.dataDir);
      if (dataDir) env.OWLETTO_DATA_DIR = dataDir;

      if (process.env.EMBEDDINGS_SERVICE_URL) {
        env.EMBEDDINGS_SERVICE_URL = process.env.EMBEDDINGS_SERVICE_URL;
      }

      const invocation = getTsxInvocation([join(runtime.runtimeRoot, 'src', 'start-local.ts')]);
      const result = await run(invocation.cmd, {
        args: invocation.args,
        cwd: runCwd,
        env,
      });
      process.exitCode = result.code;
    }
  },
});
