/**
 * Shared worker poll lifecycle.
 *
 * The full connector worker and the lean device daemon use the same health,
 * polling, concurrency, and graceful-shutdown lifecycle. Run execution stays
 * injected so the device build does not import fleet connector machinery.
 */

import type { PollResponse, WorkerClient } from './client.js';
import { log } from './log.js';

export interface WorkerPollLoopOptions {
  client: WorkerClient;
  pollIntervalMs?: number;
  maxConcurrentJobs?: number;
  execute: (job: PollResponse) => Promise<unknown>;
}

export class WorkerPollLoop {
  private readonly client: WorkerClient;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrentJobs: number;
  private readonly execute: (job: PollResponse) => Promise<unknown>;
  private running = false;
  private activeJobs = 0;

  constructor(options: WorkerPollLoopOptions) {
    this.client = options.client;
    this.pollIntervalMs = options.pollIntervalMs ?? 10000;
    this.maxConcurrentJobs = Math.max(1, options.maxConcurrentJobs ?? 1);
    this.execute = options.execute;
  }

  async start(): Promise<void> {
    if (this.running) {
      log.info('[daemon] Already running');
      return;
    }

    if (!(await this.client.healthCheck())) {
      throw new Error('Backend health check failed');
    }

    log.info('[daemon] Starting worker daemon...');
    this.running = true;
    while (this.running) {
      try {
        await this.pollAndExecute();
      } catch (err) {
        log.info('[daemon] Poll error:', err);
      }
      await this.sleep(this.pollIntervalMs);
    }
    log.info('[daemon] Stopped');
  }

  stop(): void {
    log.info('[daemon] Stopping...');
    this.running = false;
  }

  async waitForActiveJobs(timeoutMs = 30000, pollMs = 500): Promise<boolean> {
    if (this.activeJobs === 0) return true;

    log.debug(`[daemon] Waiting for ${this.activeJobs} active job(s) to finish...`);
    const deadline = Date.now() + timeoutMs;
    while (this.activeJobs > 0 && Date.now() < deadline) {
      await this.sleep(pollMs);
    }

    if (this.activeJobs > 0) {
      log.info(
        `[daemon] Timed out after ${timeoutMs}ms waiting for ${this.activeJobs} active job(s)`
      );
      return false;
    }

    log.debug('[daemon] All active jobs completed');
    return true;
  }

  private async pollAndExecute(): Promise<void> {
    if (this.activeJobs >= this.maxConcurrentJobs) return;

    const job = await this.client.poll();
    if (!job.run_id) {
      const nextPoll = job.next_poll_seconds ?? 30;
      log.debug(`[daemon] No runs available, next poll in ${nextPoll}s`);
      return;
    }

    this.activeJobs++;
    this.execute(job)
      .catch((err) => {
        log.info(`[daemon] Run ${job.run_id} crashed:`, err);
      })
      .finally(() => {
        this.activeJobs--;
      });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function installWorkerPollLoopSignals(loop: WorkerPollLoop): void {
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) {
      console.error(`[daemon] Received ${signal} during shutdown, forcing exit`);
      process.exit(130);
    }
    shuttingDown = true;
    log.info(`\n[daemon] Received ${signal}, shutting down...`);
    loop.stop();
    const allDone = await loop.waitForActiveJobs();
    if (!allDone) log.info('[daemon] Forcing exit with active jobs still running');
    process.exit(allDone ? 0 : 1);
  };

  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.stdin.once('end', () => void gracefulShutdown('EOF'));
  process.stdin.resume();
}

export async function startWorkerPollLoop(
  options: WorkerPollLoopOptions
): Promise<WorkerPollLoop> {
  const loop = new WorkerPollLoop(options);
  installWorkerPollLoopSignals(loop);
  await loop.start();
  return loop;
}
