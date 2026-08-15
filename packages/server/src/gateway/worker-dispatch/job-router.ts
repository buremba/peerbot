#!/usr/bin/env bun

import { createLogger } from "@lobu/core";
import type { IMessageQueue } from "../infrastructure/queue/index.js";
import {
  attachFreshRunJobToken,
  getPendingAgentRunInput,
  listPendingAgentRunInputs,
  type PendingAgentRunInput,
  type PendingAgentRunInputRef,
} from "../orchestration/agent-run-input.js";
import type { WorkerConnectionManager } from "./connection-manager.js";
import {
  type DispatchRecycler,
  gateDispatchOnStaleness,
  type LiveTurnProbe,
  type OlderTurnProbe,
  type TurnTerminalizer,
} from "./dispatch-recycle.js";

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
  /**
   * Claim-side recycle seam (the DeploymentManager in production). Optional:
   * unwired (tests, partial boots) means the gate is skipped and jobs deliver
   * exactly as before the gate existed.
   */
  private dispatchRecycler?: DispatchRecycler;
  private probeLiveTurn?: LiveTurnProbe;
  private terminalizeTurn?: TurnTerminalizer;
  private probeOlderTurn?: OlderTurnProbe;

  constructor(
    private queue: IMessageQueue,
    private connectionManager: WorkerConnectionManager,
    private loadPendingInputs: (
      deploymentName: string
    ) => Promise<PendingAgentRunInput[]> = listPendingAgentRunInputs,
    private loadPendingInput: (
      ref: PendingAgentRunInputRef
    ) => Promise<PendingAgentRunInput | null> = getPendingAgentRunInput,
  ) {}

  /**
   * Wire the deployment manager into the dispatch-time staleness gate. Called
   * from the composition root alongside `setDeploymentActivityTracker` — the
   * router and the orchestrator are built separately.
   */
  setDispatchRecycler(
    recycler: DispatchRecycler,
    probeLiveTurn?: LiveTurnProbe,
    terminalizeTurn?: TurnTerminalizer,
    probeOlderTurn?: OlderTurnProbe
  ): void {
    this.dispatchRecycler = recycler;
    this.probeLiveTurn = probeLiveTurn;
    this.terminalizeTurn = terminalizeTurn;
    this.probeOlderTurn = probeOlderTurn;
  }

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

    const pendingInputs = await this.loadPendingInputs(deploymentName);
    for (const input of pendingInputs) {
      const payload = { ...input.payload, __lobuDurableReplay: true as const };
      delete payload.runJobToken;
      await this.queue.send(queueName, payload, {
        // Genuine-failure budget only: a replayed input claimed while the
        // reconnected worker is stale/mid-turn is deferred by the dispatch
        // gate via `StaleWorkerError`, which the queue reschedules WITHOUT
        // consuming an attempt (isDeferralError) — waiting never burns this.
        retryLimit: 3,
        retryDelay: 2,
        priority: 10,
      });
    }
    if (pendingInputs.length > 0) {
      logger.info(
        `Replayed ${pendingInputs.length} durable agent input(s) for ${deploymentName}`,
      );
    }

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
    // Extract job data and ID
    const jobData = (job as { data?: unknown }).data;

    // Claim-side recycle gate: never deliver onto a worker whose connector
    // lease is dying or whose tooling no longer matches the org's connections.
    // Runs BEFORE the connection lookup — a recycle replaces the connection.
    // Deliberately un-caught: a throw here (deferral, recycle, or a genuine
    // failure) keeps the job undelivered and the queue retries it (fail
    // closed). Delivering on error would hand the turn to a sandbox holding a
    // dead or wrong credential, which is the defect this gate exists to stop.
    if (this.dispatchRecycler) {
      const decision = await gateDispatchOnStaleness({
        deploymentName,
        // RunsQueue job ids are the numeric runs-row id; NaN (absent/foreign
        // id) skips the FIFO fence inside the gate.
        jobRunId: Number((job as { id?: string }).id),
        jobData,
        recycler: this.dispatchRecycler,
        probeLiveTurn: this.probeLiveTurn,
        terminalizeTurn: this.terminalizeTurn,
        probeOlderTurn: this.probeOlderTurn,
      });
      // "drop": the gate terminalized the turn (recycle rebuild failed) —
      // returning completes the held job so it cannot resurface as a zombie.
      if (decision === "drop") return;
    }

    const connection = this.connectionManager.getConnection(deploymentName);

    if (!connection) {
      logger.warn(
        `No connection for deployment ${deploymentName}, job will be retried`
      );
      throw new Error("Worker not connected");
    }
    const jobId =
      (job as { id?: string }).id ||
      `job-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    let deliveryData = jobData;
    if (jobData && typeof jobData === "object") {
      const replay = jobData as Record<string, unknown>;
      if (
        replay.__lobuDurableReplay === true &&
        !(typeof replay.runJobToken === "string" && replay.runJobToken.length > 0) &&
        typeof replay.organizationId === "string" &&
        typeof replay.messageId === "string" &&
        typeof replay.runId === "number" &&
        Number.isInteger(replay.runId) &&
        replay.runId > 0
      ) {
        const pendingInput = await this.loadPendingInput({
          organizationId: replay.organizationId,
          deploymentName,
          messageId: replay.messageId,
          runId: replay.runId,
        });
        if (!pendingInput) {
          throw new Error(
            `Durable agent input missing for replayed run ${replay.runId}`,
          );
        }
        deliveryData = attachFreshRunJobToken(pendingInput);
      }
    }

    // Send job to worker via SSE with jobId wrapped in payload
    const jobPayload =
      typeof deliveryData === "object" && deliveryData !== null
        ? { payload: deliveryData, jobId: jobId }
        : { payload: { data: deliveryData }, jobId: jobId };

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
