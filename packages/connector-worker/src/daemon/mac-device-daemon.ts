import { hostname } from 'node:os';
import {
  AGENT_KINDS,
  type AgentKind,
} from '@lobu/core/contracts/worker/device-automation';
import type { PollResponse } from '@lobu/core/contracts/worker/protocol';
import { executeAutomationRun, type AutomationExecutorConfig } from './automation.js';
import { resolveRunnableAgentKinds } from './agent-binaries.js';
import {
  MutableWorkerAdvertisementProvider,
  WorkerClient,
  type WorkerCapabilities,
} from './client.js';
import { installWorkerPollLoopSignals, WorkerPollLoop } from './poll-loop.js';
import { setDebug } from './log.js';
import { NativeBridgeClient } from './native-bridge/client.js';
import { executeNativeBridgeRun } from './native-bridge/executor.js';

export const MAC_DEVICE_DAEMON_PROTOCOL = 'device-daemon/v1';
export const MAC_DEVICE_PLATFORM = 'macos';
const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const WORKER_PAT_PATTERN = /^owl_pat_[A-Za-z0-9_-]{32}$/;
const DEFAULT_POLL_INTERVAL_MS = 10000;
const DEFAULT_MAX_CONCURRENT_JOBS = 1;
const NATIVE_BRIDGE_SHUTDOWN_TIMEOUT_MS = 5000;

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
  supervisedStdio?: boolean;
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

export function selectMacDeviceDaemonAgentKind(
  runnableAgentKinds: readonly AgentKind[],
  explicitAgentKind?: AgentKind
): AgentKind | undefined {
  if (explicitAgentKind !== undefined) {
    if (!runnableAgentKinds.includes(explicitAgentKind)) {
      throw new Error(
        `--default-agent-kind '${explicitAgentKind}' is not runnable on this machine (available: ${runnableAgentKinds.join(', ') || 'none'})`
      );
    }
    return explicitAgentKind;
  }
  return runnableAgentKinds[0];
}

export function createMacDeviceDaemonShutdown(
  controller: AbortController,
  loop: WorkerPollLoop,
  bridge?: NativeBridgeClient,
  shutdownTimeoutMs = NATIVE_BRIDGE_SHUTDOWN_TIMEOUT_MS
): () => Promise<void> {
  return async () => {
    controller.abort();
    loop.stop();
    if (!bridge) return;

    let shutdownError: unknown;
    try {
      const shutdownResults = await withTimeout(
        Promise.allSettled([bridge.cancelActiveRuns(), bridge.shutdown()]),
        shutdownTimeoutMs,
        'native bridge cancellation and shutdown',
      );
      const rejected = shutdownResults.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') shutdownError = rejected.reason;
    } catch (error) {
      shutdownError = error;
    }
    try {
      const allJobsFinished = await loop.waitForActiveJobs();
      if (!allJobsFinished && !shutdownError) {
        shutdownError = new Error('native bridge active jobs did not finish before shutdown');
      }
    } catch (error) {
      shutdownError ??= error;
    }
    // The app may close the transport as soon as it has acknowledged the
    // shutdown frame, so keep the writer alive until active jobs observe
    // their terminal failures.
    bridge.close(new Error('native bridge daemon shutdown'));
    if (shutdownError) throw shutdownError;
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(resolve, reject).finally(() => {
      if (timer) clearTimeout(timer);
    });
  });
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
  if (!workerApiToken || !WORKER_PAT_PATTERN.test(workerApiToken)) {
    throw new Error(
      'device mode requires WORKER_API_TOKEN in the form owl_pat_<32 base64url characters>; session OAuth tokens are not durable'
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

export function createMacDeviceDaemon(
  options: MacDeviceDaemonOptions,
  dependencies: {
    advertisementProvider?: MutableWorkerAdvertisementProvider;
    bridge?: NativeBridgeClient;
  } = {}
): WorkerPollLoop {
  const validated = validateMacDeviceDaemonOptions(options);
  if (validated.noPoll) throw new Error('cannot create a polling daemon with --no-poll');

  const runnableAgentKinds = resolveRunnableAgentKinds();
  const defaultAgentKind = selectMacDeviceDaemonAgentKind(
    runnableAgentKinds,
    validated.defaultAgentKind
  );
  const shutdownController = new AbortController();
  const nativeBridge = dependencies.bridge;

  const client = new WorkerClient({
    apiUrl: validated.apiUrl,
    workerId: validated.workerId,
    authToken: validated.workerApiToken,
    capabilities: { 'automations.execute': true } satisfies WorkerCapabilities,
    version: validated.version,
    platform: MAC_DEVICE_PLATFORM,
    agentKinds: runnableAgentKinds,
    ...(dependencies.advertisementProvider
      ? { advertisementProvider: dependencies.advertisementProvider }
      : {}),
  });
  const automationConfig: AutomationExecutorConfig = {
    heartbeatIntervalMs: 30000,
    timeoutMs: 600000,
    ...(defaultAgentKind ? { defaultAgentKind } : {}),
    requireRunScopedSession: true,
    shutdownSignal: shutdownController.signal,
  };
  const loop = new WorkerPollLoop({
    client,
    pollIntervalMs: validated.pollIntervalMs,
    maxConcurrentJobs: validated.maxConcurrentJobs,
    execute: async (job) => {
      if (job.run_type === 'automation') {
        return executeAutomationRun(client, job, automationConfig);
      }
      if (job.execution_backend === 'native_bridge') {
        if (!nativeBridge) {
          return rejectUnsupportedRun(client, job);
        }
        return executeNativeBridgeRun(client, nativeBridge, job);
      }
      return rejectUnsupportedRun(client, job);
    },
  });
  installWorkerPollLoopSignals(
    loop,
    createMacDeviceDaemonShutdown(shutdownController, loop, nativeBridge),
    {
    stdinEof: validated.supervisedStdio === true,
    }
  );
  return loop;
}

export async function runMacDeviceDaemon(options: MacDeviceDaemonOptions): Promise<void> {
  setDebug(options.debug === true);
  const validated = validateMacDeviceDaemonOptions(options);
  if (validated.noPoll) return;
  if (validated.supervisedStdio) {
    const advertisementProvider = new MutableWorkerAdvertisementProvider({
      capabilities: {},
      manifests: [],
      generation: 0,
    });
    const bridge = new NativeBridgeClient(
      process.stdin,
      process.stdout,
      advertisementProvider,
      validated.workerId,
      validated.version,
    );
    // The app is the authority for the worker identity and its current
    // connector generation. No health check or poll happens until this
    // handshake has validated both sides and echoed the nonce.
    await bridge.handshake();
    const loop = createMacDeviceDaemon(validated, { advertisementProvider, bridge });
    // createMacDeviceDaemon installs the signal handlers. The bridge's
    // pending native requests are cancelled by the loop's normal shutdown
    // path before its bounded active-job wait.
    await loop.start();
    return;
  }
  await createMacDeviceDaemon(validated).start();
}
