/**
 * Redis-based message queue implementation using BullMQ
 */

import { createLogger } from "@lobu/core";
import { type JobsOptions, Queue, type QueueEvents, Worker } from "bullmq";
import Redis from "ioredis";
import type {
  IMessageQueue,
  JobHandler,
  QueueJob,
  QueueOptions,
  QueueStats,
} from "./types";

const logger = createLogger("redis-queue");

export interface RedisQueueConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  maxRetriesPerRequest?: number;
}

export class RedisQueue implements IMessageQueue {
  private config: RedisQueueConfig;
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();
  private pendingWorkers: Set<string> = new Set(); // Workers created with autorun:false, not yet started
  private queueEvents: Map<string, QueueEvents> = new Map();
  private isConnected = false;
  private redisClient?: Redis;

  constructor(config: RedisQueueConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    // Create shared Redis client for all queues and workers
    this.redisClient = new Redis({
      host: this.config.host,
      port: this.config.port,
      password: this.config.password,
      db: this.config.db,
      maxRetriesPerRequest: null, // Required by BullMQ
    });

    this.isConnected = true;
    logger.debug("Redis queue started");
  }

  async stop(): Promise<void> {
    this.isConnected = false;

    // Close all workers first
    for (const [name, worker] of this.workers.entries()) {
      try {
        worker.removeAllListeners();
        await worker.close();
        logger.debug(`Closed worker for queue: ${name}`);
      } catch (error) {
        logger.error(`Error closing worker ${name}:`, error);
      }
    }

    // Close all queue events
    for (const [name, events] of this.queueEvents.entries()) {
      try {
        await events.close();
        logger.debug(`Closed events for queue: ${name}`);
      } catch (error) {
        logger.error(`Error closing events ${name}:`, error);
      }
    }

    // Close all queues
    for (const [name, queue] of this.queues.entries()) {
      try {
        await queue.close();
        logger.debug(`Closed queue: ${name}`);
      } catch (error) {
        logger.error(`Error closing queue ${name}:`, error);
      }
    }

    this.workers.clear();
    this.queueEvents.clear();
    this.queues.clear();

    // Close the shared Redis client
    if (this.redisClient) {
      await this.redisClient.quit();
      this.redisClient = undefined;
    }

    logger.debug("Redis queue stopped");
  }

  async createQueue(queueName: string): Promise<void> {
    if (!this.queues.has(queueName)) {
      if (!this.redisClient) {
        throw new Error("Redis client not initialized. Call start() first.");
      }

      // Pass the shared Redis client to BullMQ
      const queue = new Queue(queueName, {
        connection: this.redisClient,
      });

      this.queues.set(queueName, queue);
      logger.debug(`Created queue: ${queueName}`);
    }
  }

  async send<T>(
    queueName: string,
    data: T,
    options?: QueueOptions
  ): Promise<string> {
    if (!this.isConnected) {
      throw new Error("Queue is not connected");
    }

    // Ensure queue exists
    await this.createQueue(queueName);
    const queue = this.queues.get(queueName);

    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    // Convert options to BullMQ format
    const jobOptions: JobsOptions = {
      priority: options?.priority,
      attempts: options?.retryLimit ?? 3,
      backoff: options?.retryDelay
        ? {
            type: "fixed",
            delay: options.retryDelay * 1000, // Convert to milliseconds
          }
        : undefined,
      removeOnComplete: {
        age: 3600, // 1 hour
        count: 1000,
      },
      removeOnFail: {
        age: 24 * 3600, // 24 hours
        count: 5000,
      },
      delay: options?.delayMs,
    };

    // Handle expiration
    if (options?.expireInSeconds) {
      jobOptions.removeOnComplete = {
        age: options.expireInSeconds,
        count: 1000,
      };
    }

    // Handle singleton (deduplication)
    if (options?.singletonKey) {
      jobOptions.jobId = options.singletonKey;
    }

    const job = await queue.add(queueName, data, jobOptions);
    logger.debug(`Enqueued job ${job.id} to queue ${queueName}`);

    return job.id || "unknown";
  }

  async work<T>(
    queueName: string,
    handler: JobHandler<T>,
    options?: { startPaused?: boolean }
  ): Promise<void> {
    if (!this.isConnected) {
      throw new Error("Queue is not connected");
    }

    // Ensure queue exists
    await this.createQueue(queueName);

    // Close existing worker if one already exists for this queue
    const existingWorker = this.workers.get(queueName);
    if (existingWorker) {
      existingWorker.removeAllListeners();
      await existingWorker.close();
      this.workers.delete(queueName);
      this.pendingWorkers.delete(queueName);
      logger.debug(`Closed existing worker for queue: ${queueName}`);
    }

    if (!this.redisClient) {
      throw new Error("Redis client not initialized. Call start() first.");
    }

    const startPaused = options?.startPaused ?? false;

    const worker = new Worker(
      queueName,
      async (job) => {
        logger.debug(`Processing job ${job.id} from queue ${queueName}`);

        const queueJob: QueueJob<T> = {
          id: job.id || "unknown",
          data: job.data as T,
          name: job.name,
        };

        await handler(queueJob);
      },
      {
        connection: this.redisClient,
        concurrency: 1, // Process one job at a time per worker
        ...(startPaused ? { autorun: false } : {}),
      }
    );

    // Add event listeners for worker
    worker.on("completed", (job) => {
      logger.debug(`Job ${job.id} completed in queue ${queueName}`);
    });

    worker.on("failed", (job, err) => {
      logger.error(`Job ${job?.id} failed in queue ${queueName}:`, err);

      // Move to dead letter queue after all retries exhausted
      if (job && job.attemptsMade >= (job.opts?.attempts ?? 3)) {
        this.moveToDeadLetterQueue(queueName, job).catch((dlqErr) => {
          logger.error(`Failed to move job ${job.id} to DLQ:`, dlqErr);
        });
      }
    });

    this.workers.set(queueName, worker);
    if (startPaused) {
      this.pendingWorkers.add(queueName);
    }
    logger.debug(
      `Created worker for queue: ${queueName}${startPaused ? " (paused)" : ""}`
    );
  }

  /**
   * Move a failed job to the dead letter queue for later investigation/reprocessing
   */
  private async moveToDeadLetterQueue(
    sourceQueue: string,
    job: any
  ): Promise<void> {
    const dlqName = `${sourceQueue}:dlq`;
    await this.createQueue(dlqName);
    const dlq = this.queues.get(dlqName);
    if (!dlq) return;

    await dlq.add(
      dlqName,
      {
        originalQueue: sourceQueue,
        originalJobId: job.id,
        data: job.data,
        failedReason: job.failedReason,
        attemptsMade: job.attemptsMade,
        movedAt: new Date().toISOString(),
      },
      {
        removeOnComplete: { age: 7 * 24 * 3600, count: 10000 }, // Keep DLQ jobs for 7 days
        removeOnFail: false, // Never auto-remove DLQ failures
      }
    );

    logger.info(
      `Moved failed job ${job.id} from ${sourceQueue} to DLQ ${dlqName}`
    );
  }

  async pauseWorker(queueName: string): Promise<void> {
    const worker = this.workers.get(queueName);
    if (!worker) {
      logger.warn(
        `Cannot pause worker for queue ${queueName} - worker not found`
      );
      return;
    }

    if (worker.isPaused()) {
      logger.debug(`Worker for queue ${queueName} is already paused`);
      return;
    }

    await worker.pause();
    logger.debug(`Paused worker for queue ${queueName}`);
  }

  async resumeWorker(queueName: string): Promise<void> {
    const worker = this.workers.get(queueName);
    if (!worker) {
      logger.warn(
        `Cannot resume worker for queue ${queueName} - worker not found`
      );
      return;
    }

    // First-time start: worker was created with autorun:false and never started
    if (this.pendingWorkers.has(queueName)) {
      this.pendingWorkers.delete(queueName);
      worker.run();
      logger.debug(`Started worker for queue ${queueName} (first run)`);
      return;
    }

    if (!worker.isPaused()) {
      logger.debug(`Worker for queue ${queueName} is already running`);
      return;
    }

    worker.resume();
    logger.debug(`Resumed worker for queue ${queueName}`);
  }

  /**
   * Get detailed queue statistics
   */
  async getQueueStats(queueName: string): Promise<QueueStats> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      return { waiting: 0, active: 0, completed: 0, failed: 0 };
    }

    const counts = await queue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed"
    );

    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
    };
  }

  isHealthy(): boolean {
    return this.isConnected;
  }

  /**
   * Get underlying Redis client for general-purpose Redis operations
   * Returns the shared IORedis client used by all queues and workers
   */
  getRedisClient(): any {
    if (!this.redisClient) {
      throw new Error("Redis client not initialized. Call start() first.");
    }
    return this.redisClient;
  }
}
