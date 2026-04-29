#!/usr/bin/env node
/**
 * @owletto/worker CLI
 *
 * CLI entry point for the worker package.
 *
 * Commands:
 *   daemon - Start worker daemon (polls backend for jobs)
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { startDaemon } from './daemon/index.js';
import { assertExternalDepsResolvable } from './runtime-deps.js';
import type { Env } from './types.js';

function printUsage(): void {
  console.log(`
@owletto/worker - Self-hosted worker for Owletto - connectors and embedding generation

Usage:
  owletto-worker <command> [options]

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
  owletto-worker daemon --api-url https://api.example.com
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

function buildEnv(): Env {
  return {
    ENVIRONMENT: process.env.ENVIRONMENT || 'production',
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
    X_USERNAME: process.env.X_USERNAME,
    X_PASSWORD: process.env.X_PASSWORD,
    X_EMAIL: process.env.X_EMAIL,
    X_2FA_SECRET: process.env.X_2FA_SECRET,
    X_COOKIES: process.env.X_COOKIES,
    REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID,
    REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET,
    REDDIT_USER_AGENT: process.env.REDDIT_USER_AGENT,
    WORKER_API_TOKEN: process.env.WORKER_API_TOKEN,
  };
}

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
          capabilities: {
            browser: true,
          },
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
