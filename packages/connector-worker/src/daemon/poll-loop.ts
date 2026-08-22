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

export type WorkerPollLoopExit = (code: number) => void;

export interface WorkerPollLoopSignalOptions {
  /** Only a supervised parent/child launch treats stdin EOF as shutdown. */
  stdinEof?: boolean;
}

export function shouldHandleWorkerPollLoopStdinEof(
  options: WorkerPollLoopSignalOptions = {}
): boolean {
  return options.stdinEof === true;
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
      let nextDelayMs: number | undefined;
      try {
        nextDelayMs = await this.pollAndExecute();
      } catch (err) {
        log.info('[daemon] Poll error:', err);
      }
      await this.sleep(nextDelayMs ?? this.pollIntervalMs);
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

  private async pollAndExecute(): Promise<number | undefined> {
    if (this.activeJobs >= this.maxConcurrentJobs) return undefined;

    const job = await this.client.poll();
    if (!job.run_id) {
      const nextPoll = job.next_poll_seconds ?? 30;
      log.debug(`[daemon] No runs available, next poll in ${nextPoll}s`);
      return Number.isFinite(nextPoll) && nextPoll > 0 ? nextPoll * 1000 : 1000;
    }

    this.activeJobs++;
    Promise.resolve()
      .then(() => this.execute(job))
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

export function createWorkerPollLoopShutdownHandler(
  loop: WorkerPollLoop,
  onShutdown: () => void = () => loop.stop(),
  exit: WorkerPollLoopExit = process.exit
): (signal: string) => Promise<void> {
  let shuttingDown = false;
  return async (signal: string) => {
    if (shuttingDown) {
      console.error(`[daemon] Received ${signal} during shutdown, forcing exit`);
      exit(130);
      return;
    }
    shuttingDown = true;
    log.info(`\n[daemon] Received ${signal}, shutting down...`);
    onShutdown();
    const allDone = await loop.waitForActiveJobs();
    if (!allDone) log.info('[daemon] Forcing exit with active jobs still running');
    exit(allDone ? 0 : 1);
  };
}

export function installWorkerPollLoopSignals(
  loop: WorkerPollLoop,
  onShutdown: () => void = () => loop.stop(),
  options: WorkerPollLoopSignalOptions = { stdinEof: false }
): void {
  const gracefulShutdown = createWorkerPollLoopShutdownHandler(loop, onShutdown);
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  if (shouldHandleWorkerPollLoopStdinEof(options)) {
    process.stdin.once('end', () => void gracefulShutdown('EOF'));
    process.stdin.resume();
  }
}

export async function startWorkerPollLoop(
  options: WorkerPollLoopOptions
): Promise<WorkerPollLoop> {
  const loop = new WorkerPollLoop(options);
  installWorkerPollLoopSignals(loop);
  await loop.start();
  return loop;
}
