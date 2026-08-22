import { hostname } from 'node:os';
import {
  AGENT_KINDS,
  type AgentKind,
} from '@lobu/core/contracts/worker/device-automation';
import type { PollResponse } from '@lobu/core/contracts/worker/protocol';
import { executeAutomationRun, type AutomationExecutorConfig } from './automation.js';
import { WorkerClient, type WorkerCapabilities } from './client.js';
import { installWorkerPollLoopSignals, WorkerPollLoop } from './poll-loop.js';
import { setDebug } from './log.js';

export const MAC_DEVICE_DAEMON_PROTOCOL = 'device-daemon/v1';
export const MAC_DEVICE_PLATFORM = 'macos';
const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DEFAULT_POLL_INTERVAL_MS = 10000;
const DEFAULT_MAX_CONCURRENT_JOBS = 1;

export interface MacDeviceDaemonOptions {
  apiUrl?: string;
  workerId?: string;
  workerApiToken?: string;
  version: string;
  pollIntervalMs?: number;
  maxConcurrentJobs?: number;
  defaultAgentKind?: AgentKind;
  debug?: boolean;
  noPoll?: boolean;
}

export interface MacDeviceDaemonMetadata {
  name: 'lobu-device-daemon';
  version: string;
  protocol: typeof MAC_DEVICE_DAEMON_PROTOCOL;
  platform: typeof MAC_DEVICE_PLATFORM;
  artifact: 'standalone-bun-macho-arm64';
}

export function macDeviceDaemonMetadata(version: string): MacDeviceDaemonMetadata {
  return {
    name: 'lobu-device-daemon',
    version,
    protocol: MAC_DEVICE_DAEMON_PROTOCOL,
    platform: MAC_DEVICE_PLATFORM,
    artifact: 'standalone-bun-macho-arm64',
  };
}

function defaultWorkerId(): string {
  const shortHostname = hostname().split('.')[0] || hostname();
  return `${MAC_DEVICE_PLATFORM}:${shortHostname}`;
}

function validateNumber(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got '${value}')`);
  }
  return value;
}

function validateAgentKind(value: AgentKind | undefined): AgentKind | undefined {
  if (value === undefined) return undefined;
  if (!(AGENT_KINDS as readonly string[]).includes(value)) {
    throw new Error(`invalid --default-agent-kind '${value}' (expected ${AGENT_KINDS.join(', ')})`);
  }
  return value;
}

export function validateMacDeviceDaemonOptions(
  options: MacDeviceDaemonOptions
): Required<Pick<MacDeviceDaemonOptions, 'apiUrl' | 'workerId' | 'workerApiToken'>> &
  Omit<MacDeviceDaemonOptions, 'apiUrl' | 'workerId' | 'workerApiToken'> {
  const workerId = options.workerId?.trim() || defaultWorkerId();
  if (!WORKER_ID_PATTERN.test(workerId)) {
    throw new Error(
      `invalid --worker-id '${workerId}': expected 1-128 characters of letters, digits, dot, underscore, colon or hyphen`
    );
  }
  const pollIntervalMs = validateNumber(options.pollIntervalMs, '--poll-interval-ms');
  const maxConcurrentJobs = validateNumber(
    options.maxConcurrentJobs,
    '--max-concurrent-jobs'
  );
  const defaultAgentKind = validateAgentKind(options.defaultAgentKind);

  const apiUrl = options.apiUrl?.trim();
  if (apiUrl) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(apiUrl);
    } catch {
      throw new Error(`invalid --api-url '${apiUrl}': expected an absolute http(s) URL`);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`invalid --api-url '${apiUrl}': expected an http(s) URL`);
    }
  }

  if (options.noPoll) {
    return {
      ...options,
      apiUrl: apiUrl ?? '',
      workerId,
      workerApiToken: options.workerApiToken?.trim() ?? '',
      ...(pollIntervalMs ? { pollIntervalMs } : {}),
      ...(maxConcurrentJobs ? { maxConcurrentJobs } : {}),
      ...(defaultAgentKind ? { defaultAgentKind } : {}),
    };
  }

  if (!apiUrl) throw new Error('--api-url or API_URL is required unless --no-poll is set');

  const workerApiToken = options.workerApiToken?.trim();
  if (!workerApiToken?.startsWith('owl_pat_')) {
    throw new Error(
      'device mode requires WORKER_API_TOKEN with an owl_pat_ prefix; session OAuth tokens are not durable'
    );
  }

  return {
    ...options,
    apiUrl,
    workerId,
    workerApiToken,
    pollIntervalMs: pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxConcurrentJobs: maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS,
    ...(defaultAgentKind ? { defaultAgentKind } : {}),
  };
}

function rejectUnsupportedRun(client: WorkerClient, job: PollResponse): Promise<void> {
  const message = `macOS device daemon does not execute run_type '${job.run_type ?? 'unknown'}'; no native connector capabilities are advertised`;
  if (job.run_id == null) return Promise.resolve();
  if (job.run_type === 'action') {
    return client.completeAction({
      run_id: job.run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: message,
    });
  }
  if (job.run_type === 'auth') {
    return client.completeAuth({
      run_id: job.run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: message,
    });
  }
  if (job.run_type === 'automation') {
    return client.completeAutomation(job.run_id, {
      worker_id: client.id,
      output: '',
      error: message,
      duration_ms: 0,
      exit_reason: 'error_message',
    }).then(() => undefined);
  }
  return client.complete({
    run_id: job.run_id,
    worker_id: client.id,
    status: 'failed',
    error_message: message,
    items_collected: 0,
  });
}

export function createMacDeviceDaemon(options: MacDeviceDaemonOptions): WorkerPollLoop {
  const validated = validateMacDeviceDaemonOptions(options);
  if (validated.noPoll) throw new Error('cannot create a polling daemon with --no-poll');

  const client = new WorkerClient({
    apiUrl: validated.apiUrl,
    workerId: validated.workerId,
    authToken: validated.workerApiToken,
    capabilities: {} satisfies WorkerCapabilities,
    version: validated.version,
    platform: MAC_DEVICE_PLATFORM,
  });
  const automationConfig: AutomationExecutorConfig = {
    heartbeatIntervalMs: 30000,
    timeoutMs: 600000,
    ...(validated.defaultAgentKind ? { defaultAgentKind: validated.defaultAgentKind } : {}),
  };
  const loop = new WorkerPollLoop({
    client,
    pollIntervalMs: validated.pollIntervalMs,
    maxConcurrentJobs: validated.maxConcurrentJobs,
    execute: async (job) => {
      if (job.run_type === 'automation') {
        return executeAutomationRun(client, job, automationConfig);
      }
      return rejectUnsupportedRun(client, job);
    },
  });
  installWorkerPollLoopSignals(loop);
  return loop;
}

export async function runMacDeviceDaemon(options: MacDeviceDaemonOptions): Promise<void> {
  setDebug(options.debug === true);
  const validated = validateMacDeviceDaemonOptions(options);
  if (validated.noPoll) return;
  await createMacDeviceDaemon(validated).start();
}
