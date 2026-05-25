#!/usr/bin/env node
/**
 * @lobu/worker CLI
 *
 * CLI entry point for the worker package.
 *
 * Commands:
 *   daemon - Start worker daemon (polls backend for jobs)
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { startDaemon } from './daemon/index.js';
import { buildConnectorWorkerEnv } from './env.js';
import { assertExternalDepsResolvable } from './runtime-deps.js';

function printUsage(): void {
  console.log(`
@lobu/worker - Self-hosted worker for Lobu - connectors and embedding generation

Usage:
  connector-worker <command> [options]

Commands:
  daemon    Start worker daemon (polls backend for jobs)

Options:
  --api-url <url>    Backend API URL (required)
  --worker-id <id>   Worker ID (default: auto-generated UUID)
  --version <ver>    Worker version (default: 1.0.0)
  --help             Show this help message

Environment Variables:
  API_URL            Backend API URL
  WORKER_ID          Worker ID
  GITHUB_TOKEN       GitHub API token (for GitHub feed)
  GOOGLE_MAPS_API_KEY Google Maps API key
  X_USERNAME         X/Twitter username
  X_PASSWORD         X/Twitter password
  X_EMAIL            X/Twitter email
  EMBEDDINGS_SERVICE_URL Embeddings service URL (if set, uses service; otherwise local)
  WORKER_API_TOKEN  Optional bearer token for /api/workers/* authentication

Examples:
  # Worker daemon
  connector-worker daemon --api-url https://api.example.com
`);
}

function parseArgs(args: string[]): { command: string; options: Record<string, string> } {
  const command = args[0] || '';
  const options: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        options[key] = value;
        i++;
      } else {
        options[key] = 'true';
      }
    }
  }

  return { command, options };
}

// Connector-runtime env whitelist now lives in `./env.ts` so the in-process
// embedded worker can import it without pulling in `bin.ts`'s top-level
// `main()` execution.
const buildEnv = buildConnectorWorkerEnv;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, options } = parseArgs(args);

  if (!command || command === '--help' || options.help) {
    printUsage();
    process.exit(0);
  }

  const apiUrl = options['api-url'] || process.env.API_URL;
  if (!apiUrl) {
    console.error('Error: --api-url or API_URL environment variable is required');
    process.exit(1);
  }

  const workerId =
    options['worker-id'] || process.env.WORKER_ID || `worker-${randomUUID().slice(0, 8)}`;
  const version = options.version || '1.0.0';

  switch (command) {
    case 'daemon': {
      // Crash loud at boot if the runtime image is missing any connector
      // external dep, instead of letting every feed silently fail with
      // "Missing npm dependency: X" hours later.
      assertExternalDepsResolvable(createRequire(import.meta.url).resolve);
      console.error(`[cli] Starting worker daemon (ID: ${workerId}, API: ${apiUrl})`);
      const env = buildEnv();
      const maxConcurrentJobs = process.env.WORKER_MAX_CONCURRENT_JOBS
        ? Math.max(1, Number.parseInt(process.env.WORKER_MAX_CONCURRENT_JOBS, 10))
        : undefined;
      await startDaemon(
        {
          apiUrl,
          workerId,
          version,
          workerApiToken: process.env.WORKER_API_TOKEN,
          capabilities: {},
          ...(Number.isFinite(maxConcurrentJobs) ? { maxConcurrentJobs } : {}),
        },
        env
      );
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
