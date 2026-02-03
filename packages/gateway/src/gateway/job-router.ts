#!/usr/bin/env bun

import { createLogger } from "@peerbot/core";
import type { IMessageQueue } from "../infrastructure/queue";
import type { ISessionManager } from "../session";
import type { WorkerConnectionManager } from "./connection-manager";

const logger = createLogger("worker-job-router");

interface PendingJob {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  jobId: string;
}

/**
 * Routes jobs from queues to workers via SSE connections
 * Manages job acknowledgments and timeouts
 */
export class WorkerJobRouter {
  private pendingJobs: Map<string, PendingJob> = new Map(); // In-memory timeouts only

  constructor(
    private queue: IMessageQueue,
    private connectionManager: WorkerConnectionManager,
    _sessionManager: ISessionManager
  ) {}

  /**
   * Register a worker to receive jobs from its deployment queue
   * Each worker listens on its own queue: thread_message_{deploymentName}
   *
   * Note: This is idempotent - BullMQ's queue.work() handles duplicate registrations gracefully.
   * Safe to call multiple times (e.g., on worker reconnection or gateway restart).
   */
  async registerWorker(deploymentName: string): Promise<void> {
    const queueName = `thread_message_${deploymentName}`;

    // Create queue if it doesn't exist
    await this.queue.createQueue(queueName);

    // Register job handler (idempotent - BullMQ handles duplicates)
    await this.queue.work(queueName, async (job: unknown) => {
      await this.handleJob(deploymentName, job);
    });

    logger.info(`Registered worker for queue ${queueName}`);
  }

  /**
   * Pause the BullMQ worker when SSE connection is lost
   * This prevents jobs from being processed when worker can't receive them
   */
  async pauseWorker(deploymentName: string): Promise<void> {
    const queueName = `thread_message_${deploymentName}`;
    await this.queue.pauseWorker(queueName);
    logger.info(
      `Paused job processing for ${deploymentName} - worker disconnected`
    );
  }

  /**
   * Resume the BullMQ worker when SSE connection is established
   * Jobs will now be processed and sent to the worker
   */
  async resumeWorker(deploymentName: string): Promise<void> {
    const queueName = `thread_message_${deploymentName}`;
    await this.queue.resumeWorker(queueName);
    logger.info(
      `Resumed job processing for ${deploymentName} - worker connected`
    );
  }

  /**
   * Handle a job from the queue and route it to the worker
   *
   * Jobs are sent immediately without blocking the queue, allowing multiple messages
   * to reach the worker's MessageBatcher for proper batching during active sessions.
   */
  private async handleJob(deploymentName: string, job: unknown): Promise<void> {
    const connection = this.connectionManager.getConnection(deploymentName);

    if (!connection) {
      logger.warn(
        `No connection for deployment ${deploymentName}, job will be retried`
      );
      throw new Error("Worker not connected");
    }

    // Extract job data and ID
    const jobData = (job as { data?: unknown }).data;
    const jobId =
      (job as { id?: string }).id ||
      `job-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // Send job to worker via SSE with jobId wrapped in payload
    const jobPayload =
      typeof jobData === "object" && jobData !== null
        ? { payload: jobData, jobId: jobId }
        : { payload: { data: jobData }, jobId: jobId };

    this.connectionManager.sendSSE(connection.writer, "job", jobPayload);
    this.connectionManager.touchConnection(deploymentName);

    // Track job for monitoring but don't block queue
    this.trackJobTimeout(jobId, deploymentName);

    logger.debug(`Job ${jobId} sent to worker ${deploymentName}`);
  }

  /**
   * Track job timeout for monitoring without blocking queue processing
   */
  private trackJobTimeout(jobId: string, deploymentName: string): void {
    const timeout = setTimeout(
      () => {
        const pending = this.pendingJobs.get(jobId);
        if (pending) {
          logger.warn(
            `Job ${jobId} timeout - worker ${deploymentName} may be stuck or overwhelmed`
          );
          this.pendingJobs.delete(jobId);
        }
      },
      1 * 60 * 1000
    ); // 1 minute timeout for monitoring

    this.pendingJobs.set(jobId, {
      resolve: () => {
        // No-op, we don't block on acknowledgment
      },
      reject: () => {
        // No-op
      },
      timeout,
      jobId,
    });
  }

  /**
   * Acknowledge job completion from worker
   * Called when worker sends HTTP response
   */
  acknowledgeJob(jobId: string): void {
    const pendingJob = this.pendingJobs.get(jobId);
    if (pendingJob) {
      clearTimeout(pendingJob.timeout);
      pendingJob.resolve(undefined);
      this.pendingJobs.delete(jobId);
      logger.debug(`Job ${jobId} acknowledged`);
    } else {
      logger.warn(`Received acknowledgment for unknown job ${jobId}`);
    }
  }

  /**
   * Get number of pending jobs
   */
  getPendingJobCount(): number {
    return this.pendingJobs.size;
  }

  /**
   * Shutdown job router
   */
  shutdown(): void {
    // Reject all pending jobs
    for (const [jobId, pendingJob] of this.pendingJobs.entries()) {
      clearTimeout(pendingJob.timeout);
      pendingJob.reject(new Error("Job router shutting down"));
      logger.debug(`Rejected pending job ${jobId} due to shutdown`);
    }
    this.pendingJobs.clear();
  }
}
