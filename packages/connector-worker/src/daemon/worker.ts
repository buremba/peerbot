/**
 * Worker Daemon
 *
 * Main daemon loop that polls for jobs and executes them.
 */

import type { Env } from '../types.js';
import { type WorkerCapabilities, WorkerClient } from './client.js';
import { type ExecutorConfig, executeRun } from './executor.js';

export interface DaemonConfig {
  apiUrl: string;
  workerId: string;
  workerApiToken?: string;
  capabilities?: WorkerCapabilities;
  pollIntervalMs?: number;
  maxConcurrentJobs?: number;
  executor?: Partial<ExecutorConfig>;
  version?: string;
}

const DEFAULT_CAPABILITIES: WorkerCapabilities = { browser: false };
const DEFAULT_EXECUTOR_TIMEOUT_MS = 600000;

/**
 * Worker Daemon
 *
 * Polls for jobs from the backend and executes them.
 */
export class WorkerDaemon {
  private client: WorkerClient;
  private env: Env;
  private config: Required<
    Omit<
      DaemonConfig,
      'apiUrl' | 'workerId' | 'workerApiToken' | 'capabilities' | 'executor' | 'version'
    >
  > & {
    executor: Partial<ExecutorConfig>;
  };
  private running = false;
  private activeJobs = 0;

  constructor(daemonConfig: DaemonConfig, env: Env) {
    const capabilities = daemonConfig.capabilities ?? DEFAULT_CAPABILITIES;
    this.client = new WorkerClient({
      apiUrl: daemonConfig.apiUrl,
      workerId: daemonConfig.workerId,
      authToken: daemonConfig.workerApiToken ?? env.WORKER_API_TOKEN,
      capabilities,
      version: daemonConfig.version,
    });

    this.env = env;
    this.config = {
      pollIntervalMs: daemonConfig.pollIntervalMs ?? 10000,
      maxConcurrentJobs: daemonConfig.maxConcurrentJobs ?? 1,
      executor: {
        timeoutMs: DEFAULT_EXECUTOR_TIMEOUT_MS,
        ...(daemonConfig.executor ?? {}),
      },
    };
  }

  /**
   * Start the daemon
   */
  async start(): Promise<void> {
    if (this.running) {
      console.error('[daemon] Already running');
      return;
    }

    // Health check
    const healthy = await this.client.healthCheck();
    if (!healthy) {
      throw new Error('Backend health check failed');
    }

    console.error('[daemon] Starting worker daemon...');
    this.running = true;

    // Main poll loop
    while (this.running) {
      try {
        await this.pollAndExecute();
      } catch (err) {
        console.error('[daemon] Poll error:', err);
      }

      // Wait before next poll
      await this.sleep(this.config.pollIntervalMs);
    }

    console.error('[daemon] Stopped');
  }

  /**
   * Stop the daemon
   */
  stop(): void {
    console.error('[daemon] Stopping...');
    this.running = false;
  }

  /**
   * Wait for all active jobs to finish, with a timeout.
   * Returns true if all jobs completed, false if timed out.
   */
  async waitForActiveJobs(timeoutMs = 30000, pollMs = 500): Promise<boolean> {
    if (this.activeJobs === 0) return true;

    console.error(`[daemon] Waiting for ${this.activeJobs} active job(s) to finish...`);
    const deadline = Date.now() + timeoutMs;

    while (this.activeJobs > 0 && Date.now() < deadline) {
      await this.sleep(pollMs);
    }

    if (this.activeJobs > 0) {
      console.error(
        `[daemon] Timed out after ${timeoutMs}ms waiting for ${this.activeJobs} active job(s)`
      );
      return false;
    }

    console.error('[daemon] All active jobs completed');
    return true;
  }

  /**
   * Poll for a job and execute it
   */
  private async pollAndExecute(): Promise<void> {
    // Skip if at max capacity
    if (this.activeJobs >= this.config.maxConcurrentJobs) {
      return;
    }

    // Poll for job
    const job = await this.client.poll();

    // No run available
    if (!job.run_id) {
      const nextPoll = job.next_poll_seconds ?? 30;
      console.error(`[daemon] No runs available, next poll in ${nextPoll}s`);
      return;
    }

    // Execute run (fire-and-forget so the poll loop can claim more jobs in parallel)
    this.activeJobs++;
    executeRun(this.client, job, this.env, this.config.executor)
      .catch((err) => {
        console.error(`[daemon] Run ${job.run_id} crashed:`, err);
      })
      .finally(() => {
        this.activeJobs--;
      });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Start the worker daemon
 */
export async function startDaemon(config: DaemonConfig, env: Env): Promise<WorkerDaemon> {
  const daemon = new WorkerDaemon(config, env);

  const gracefulShutdown = async (signal: string) => {
    console.error(`\n[daemon] Received ${signal}, shutting down...`);
    daemon.stop();
    const allDone = await daemon.waitForActiveJobs();
    if (!allDone) {
      console.error('[daemon] Forcing exit with active jobs still running');
    }
    process.exit(allDone ? 0 : 1);
  };

  // Handle shutdown signals
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  await daemon.start();
  return daemon;
}
