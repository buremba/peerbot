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
import { isKnownPlatform } from '@lobu/core';
import { startDaemon } from './daemon/index.js';
import { DEVICE_MANIFESTS_BY_PLATFORM } from './daemon/device-manifests.js';
import { buildConnectorWorkerEnv } from './env.js';
import { assertExternalDepsResolvable } from './compile/index.js';
import { printSelfCheckResult, runConnectorRuntimeSelfCheck } from './self-check/index.js';

function printUsage(): void {
  console.log(`
@lobu/worker - Self-hosted worker for Lobu - connectors and embedding generation

Usage:
  connector-worker <command> [options]

Commands:
  daemon       Start worker daemon (polls backend for jobs)
  self-check   Run the connector-runtime parity self-check (artifact/packaging
               assertions only; no network/DB). Exits non-zero on failure.

Options:
  --api-url <url>    Backend API URL (required for daemon)
  --worker-id <id>   Worker ID (required in device mode; fleet default: UUID)
  --version <ver>    Worker version (default: 1.0.0)
  --platform <name>  Run as a device worker on this host platform (e.g. macos, headless)
                     instead of a cloud-fleet worker. Requires a durable
                     personal access token in WORKER_API_TOKEN — mint one with
                     \`lobu token create --raw\`. Note \`lobu whoami --json\`
                     returns a session OAuth token that expires within 24h;
                     device mode rejects it at startup.
  --capabilities <a,b>  Comma-separated capabilities to advertise (device mode),
                     e.g. os.files. The server drops anything the platform's
                     allowlist does not grant.
  --label <name>     Human-readable device name shown on the Devices page
  --json             (self-check) Emit machine-readable JSON to stdout
  --help             Show this help message

Environment Variables:
  API_URL            Backend API URL
  WORKER_ID          Worker ID
  GITHUB_TOKEN       GitHub API token (for GitHub feed)
  GOOGLE_MAPS_API_KEY Google Maps API key
  EMBEDDINGS_SERVICE_URL Embeddings service URL (if set, uses service; otherwise local)
  WORKER_API_TOKEN  Bearer token for /api/workers/* authentication (device
                    mode requires a durable owl_pat_ personal access token)
  WORKER_PLATFORM   Host platform (same as --platform)
  WORKER_CAPABILITIES Comma-separated capabilities (same as --capabilities)
  WORKER_LABEL      Human-readable device name (same as --label)

Examples:
  # Worker daemon
  connector-worker daemon --api-url https://api.example.com

  # Local device worker serving filesystem connectors (local takeout archives)
  WORKER_API_TOKEN=owl_pat_... connector-worker daemon \\
    --api-url https://app.lobu.ai --platform macos \\
    --worker-id "macos:$(hostname -s)" --capabilities os.files \\
    --label "$(hostname -s)"

  # Connector-runtime parity self-check (CI smoke gate)
  connector-worker self-check --json
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

  // Self-check needs no backend — handle it before the --api-url requirement.
  // This is one of the two parity entrypoints (the other is the CLI's
  // `lobu connector runtime-self-check`); both call the SAME
  // runConnectorRuntimeSelfCheck() so the worker image and the built CLI assert
  // the identical compile + SubprocessExecutor invariant.
  if (command === 'self-check') {
    const result = await runConnectorRuntimeSelfCheck({ surface: 'worker' });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printSelfCheckResult(result);
    }
    process.exit(result.ok ? 0 : 1);
  }

  const apiUrl = options['api-url'] || process.env.API_URL;
  if (!apiUrl) {
    console.error('Error: --api-url or API_URL environment variable is required');
    process.exit(1);
  }

  const configuredWorkerId = (options['worker-id'] || process.env.WORKER_ID)?.trim() || undefined;
  const version = options.version || '1.0.0';

  switch (command) {
    case 'daemon': {
      const platform = (options.platform || process.env.WORKER_PLATFORM)?.trim() || undefined;
      const label = (options.label || process.env.WORKER_LABEL)?.trim() || undefined;
      const declared = (options.capabilities || process.env.WORKER_CAPABILITIES || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (platform && !isKnownPlatform(platform)) {
        console.error(`Error: unknown device platform '${platform}'`);
        process.exit(1);
      }
      if (declared.length > 0 && !platform) {
        console.error(
          'Error: --capabilities requires --platform so the server can authorize the device capability set'
        );
        process.exit(1);
      }
      if (platform && !configuredWorkerId) {
        console.error('Error: --worker-id or WORKER_ID is required in device mode');
        process.exit(1);
      }
      // A device daemon runs for weeks; its bearer is snapshotted once at
      // startup and never refreshed. `lobu whoami --json` returns
      // `workerToken ?? accessToken`, so a user without a durable agent token
      // silently gets the OAuth SESSION token — which expires in 24h. The
      // daemon would then poll 401 forever and every scheduled os.files run
      // would stop with no failure anywhere the user looks.
      //
      // Fail closed at boot instead: refuse anything that is not a durable PAT
      // rather than accept a credential guaranteed to die. Fleet workers are
      // unaffected — they authenticate with a long-lived WORKER_API_TOKEN and
      // never take this branch.
      if (platform && !process.env.WORKER_API_TOKEN?.startsWith('owl_pat_')) {
        console.error(
          'Error: device mode requires a durable personal access token in WORKER_API_TOKEN.\n' +
            "       `lobu whoami --json` falls back to your session's OAuth access token, which\n" +
            '       expires within 24h and would leave this daemon polling 401 indefinitely.\n' +
            '       Mint a device token and pass it as WORKER_API_TOKEN (expects an owl_pat_ prefix).'
        );
        process.exit(1);
      }

      // Fleet workers advertise the DB-egress contract by default. Device
      // workers advertise only their declared, server-authorized capabilities.
      const capabilities: Record<string, boolean> = platform
        ? Object.fromEntries(declared.map((name) => [name, true]))
        : { db_egress_hardening: true };
      const workerId = configuredWorkerId ?? `worker-${randomUUID().slice(0, 8)}`;

      // Crash loud at boot if the runtime image is missing a connector dep.
      assertExternalDepsResolvable(createRequire(import.meta.url).resolve);
      console.error(`[cli] Starting worker daemon (ID: ${workerId}, API: ${apiUrl})`);
      const env = buildEnv();
      const maxConcurrentJobs = process.env.WORKER_MAX_CONCURRENT_JOBS
        ? Math.max(1, Number.parseInt(process.env.WORKER_MAX_CONCURRENT_JOBS, 10))
        : undefined;
      if (platform) {
        console.error(
          `[cli] device mode: platform=${platform} capabilities=${declared.join(',') || '(none)'}`
        );
      }
      await startDaemon(
        {
          apiUrl,
          workerId,
          version,
          workerApiToken: process.env.WORKER_API_TOKEN,
          capabilities,
          ...(platform ? { platform } : {}),
          ...(label ? { label } : {}),
          // Device manifests to register on poll (headless declares os.shell).
          ...(platform ? { manifests: DEVICE_MANIFESTS_BY_PLATFORM[platform] ?? [] } : {}),
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
