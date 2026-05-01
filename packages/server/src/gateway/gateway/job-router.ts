#!/usr/bin/env bun

import { createLogger } from "@lobu/core";
import type { IMessageQueue } from "../infrastructure/queue/index.js";
import type { WorkerConnectionManager } from "./connection-manager.js";

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
    private connectionManager: WorkerConnectionManager
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
    // Start paused so jobs aren't consumed before the SSE connection is live.
    // The caller must call resumeWorker() after SSE connects.
    await this.queue.work(
      queueName,
      async (job: unknown) => {
        await this.handleJob(deploymentName, job);
      },
      { startPaused: true }
    );

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
   * Handle a job from the queue and route it to the worker.
   *
   * Sends the job via SSE and waits for a delivery receipt from the worker.
   * If the worker doesn't acknowledge within the timeout, the job is retried
   * by BullMQ. This prevents jobs from being silently lost when sent to a
   * stale SSE connection (e.g., after a container dies without cleanly closing TCP).
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

    const sent = this.connectionManager.sendSSE(
      connection.writer,
      "job",
      jobPayload
    );
    if (!sent) {
      logger.warn(
        `SSE write failed for job ${jobId} to ${deploymentName}, will retry`
      );
      throw new Error("SSE write failed - worker connection may be dead");
    }
    this.connectionManager.touchConnection(deploymentName);

    // Wait for delivery receipt from worker. If the SSE connection is stale
    // (container dead but TCP not yet closed), the worker will never ack and
    // BullMQ will retry the job after the timeout.
    await this.awaitDeliveryReceipt(jobId, deploymentName);
  }

  /**
   * Wait for the worker to acknowledge receipt of a job.
   * Rejects after timeout so BullMQ retries the job.
   */
  private awaitDeliveryReceipt(
    jobId: string,
    deploymentName: string
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingJobs.delete(jobId);
        logger.warn(
          `Job ${jobId} delivery receipt timeout - worker ${deploymentName} may be dead`
        );
        reject(
          new Error(
            `Delivery receipt timeout for job ${jobId} - worker may be dead`
          )
        );
      }, 5000); // 5 second timeout for delivery receipt

      this.pendingJobs.set(jobId, {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        },
        timeout,
        jobId,
      });
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
