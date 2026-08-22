#!/usr/bin/env bun

import packageJson from '../package.json' with { type: 'json' };
import type { AgentKind } from '@lobu/core/contracts/worker/device-automation';
import {
  MAC_DEVICE_DAEMON_PROTOCOL,
  macDeviceDaemonMetadata,
  runMacDeviceDaemon,
  validateMacDeviceDaemonOptions,
} from './daemon/mac-device-daemon.js';

const VERSION = packageJson.version;

function printHelp(): void {
  process.stdout.write(`lobu-device-daemon ${VERSION}

Usage:
  lobu-device-daemon [options]

Runs the lean macOS device daemon. It advertises no native connector
capabilities and executes only device Automations through local agent CLIs.

Options:
  --api-url <url>             Worker API origin (or API_URL)
  --worker-id <id>            Device identity (default: macos:<hostname>)
  --poll-interval-ms <ms>     Poll interval (default: 10000)
  --max-concurrent-jobs <n>   Maximum active Automations (default: 1)
  --default-agent-kind <kind> Agent fallback for Automations without a kind
  --supervised-stdio         Treat stdin EOF as a supervised-parent shutdown
  --no-poll                   Validate the executable without contacting a server
  --debug                     Enable poll and heartbeat diagnostics
  --help                      Show this help
  --version                   Print machine-readable version metadata

Required for polling:
  WORKER_API_TOKEN=owl_pat_... (durable device token)

Protocol: ${MAC_DEVICE_DAEMON_PROTOCOL}
`);
}

function parseArgs(args: string[]): Record<string, string | true> {
  const options: Record<string, string | true> = {};
  const known = new Set([
    'api-url',
    'worker-id',
    'poll-interval-ms',
    'max-concurrent-jobs',
    'default-agent-kind',
    'supervised-stdio',
    'no-poll',
    'debug',
    'help',
    'version',
  ]);
  const valued = new Set([
    'api-url',
    'worker-id',
    'poll-interval-ms',
    'max-concurrent-jobs',
    'default-agent-kind',
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument '${arg}'`);
    const key = arg.slice(2);
    if (!key) throw new Error('empty option name');
    if (!known.has(key)) throw new Error(`unknown option '--${key}'`);
    const next = args[index + 1];
    if (valued.has(key)) {
      if (!next || next.startsWith('--')) throw new Error(`--${key} requires a value`);
      options[key] = next;
      index++;
    } else if (next && !next.startsWith('--')) {
      throw new Error(`--${key} does not accept a value`);
    } else {
      options[key] = true;
    }
  }
  return options;
}

function option(options: Record<string, string | true>, key: string): string | undefined {
  const value = options[key];
  if (value === true) throw new Error(`--${key} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const raw = parseArgs(args);
  if (raw.help) {
    printHelp();
    return;
  }
  if (raw.version) {
    if (raw.version !== true) throw new Error('--version does not accept a value');
    process.stdout.write(`${JSON.stringify(macDeviceDaemonMetadata(VERSION))}\n`);
    return;
  }

  const noPoll = raw['no-poll'] === true;
  const apiUrl = option(raw, 'api-url') ?? process.env.API_URL;
  const workerId = option(raw, 'worker-id') ?? process.env.WORKER_ID;
  const pollInterval = option(raw, 'poll-interval-ms') ?? process.env.WORKER_POLL_INTERVAL_MS;
  const maxConcurrent =
    option(raw, 'max-concurrent-jobs') ?? process.env.WORKER_MAX_CONCURRENT_JOBS;
  const defaultAgentKind = option(raw, 'default-agent-kind');
  const supervisedStdio = raw['supervised-stdio'] === true;
  const debug = raw.debug === true;
  if (raw.debug !== undefined && !debug) throw new Error('--debug does not accept a value');
  if (raw['no-poll'] !== undefined && !noPoll) {
    throw new Error('--no-poll does not accept a value');
  }
  if (raw['supervised-stdio'] !== undefined && !supervisedStdio) {
    throw new Error('--supervised-stdio does not accept a value');
  }

  const options = {
    apiUrl,
    workerId,
    workerApiToken: process.env.WORKER_API_TOKEN,
    version: VERSION,
    ...(pollInterval ? { pollIntervalMs: Number(pollInterval) } : {}),
    ...(maxConcurrent ? { maxConcurrentJobs: Number(maxConcurrent) } : {}),
    ...(defaultAgentKind ? { defaultAgentKind: defaultAgentKind as AgentKind } : {}),
    debug,
    noPoll,
    supervisedStdio,
  };
  if (pollInterval) {
    if (!/^[1-9]\d*$/.test(pollInterval)) {
      throw new Error(`--poll-interval-ms must be a positive integer (got '${pollInterval}')`);
    }
    options.pollIntervalMs = Number(pollInterval);
  }
  if (maxConcurrent) {
    if (!/^[1-9]\d*$/.test(maxConcurrent)) {
      throw new Error(`--max-concurrent-jobs must be a positive integer (got '${maxConcurrent}')`);
    }
    options.maxConcurrentJobs = Number(maxConcurrent);
  }
  validateMacDeviceDaemonOptions(options);
  if (noPoll) {
    process.stdout.write(`${JSON.stringify(macDeviceDaemonMetadata(VERSION))}\n`);
    return;
  }
  await runMacDeviceDaemon(options);
}

main().catch((error) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
