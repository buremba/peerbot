import PgBoss from "pg-boss";
import * as Sentry from "@sentry/node";
import {
  MessageQueue,
  type MessagePayload,
  type QueueOptions,
  type QueueStats,
  type JobHandler,
} from "../abstractions/MessageQueue";
import { createLogger } from "../logging";

const logger = createLogger("postgresql-queue");

export interface PostgreSQLQueueConfig {
  connectionString: string;
  retryLimit?: number;
  retryDelay?: number;
  expireInSeconds?: number;
  retentionDays?: number;
  deleteAfterDays?: number;
}

export class PostgreSQLMessageQueue extends MessageQueue {
  private pgBoss: PgBoss;
  private config: PostgreSQLQueueConfig;
  private isConnected = false;

  constructor(config: PostgreSQLQueueConfig) {
    super();
    this.config = config;
    this.pgBoss = new PgBoss({
      connectionString: config.connectionString,
      retryLimit: config.retryLimit || 3,
      retryDelay: config.retryDelay || 30,
      expireInSeconds: config.expireInSeconds || 300,
      retentionDays: config.retentionDays || 7,
      deleteAfterDays: config.deleteAfterDays || 30,
      monitorStateIntervalSeconds: 60,
      maintenanceIntervalSeconds: 30,
      supervise: true,
    });
  }

  async start(): Promise<void> {
    try {
      await this.pgBoss.start();
      this.isConnected = true;
      logger.info("✅ PostgreSQL message queue started successfully");
    } catch (error) {
      logger.error("Failed to start PostgreSQL message queue:", error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      this.isConnected = false;
      await this.pgBoss.stop();
      logger.info("✅ PostgreSQL message queue stopped");
    } catch (error) {
      logger.error("Error stopping PostgreSQL message queue:", error);
      throw error;
    }
  }

  async send(
    queueName: string,
    payload: MessagePayload,
    options?: QueueOptions
  ): Promise<string> {
    if (!this.isConnected) {
      throw new Error("Queue is not connected");
    }

    try {
      const jobId = await this.pgBoss.send(queueName, payload, {
        priority: options?.priority || 0,
        retryLimit: options?.retryLimit || this.config.retryLimit || 3,
        retryDelay: options?.retryDelay || this.config.retryDelay || 30,
        expireInSeconds: options?.expireInSeconds || this.config.expireInSeconds || 300,
        singletonKey: `message-${payload.userId}-${payload.threadId}-${payload.messageId || Date.now()}`,
      });

      logger.info(`Enqueued message job ${jobId} for user ${payload.userId}, thread ${payload.threadId}`);
      return jobId || "job-sent";
    } catch (error) {
      Sentry.captureException(error);
      logger.error(`Failed to enqueue message for user ${payload.userId}:`, error);
      throw error;
    }
  }

  async work(queueName: string, handler: JobHandler): Promise<void> {
    if (!this.isConnected) {
      throw new Error("Queue is not connected");
    }

    await this.pgBoss.work(queueName, async (job: any) => {
      return await Sentry.startSpan(
        {
          name: "postgresql.queue.process_message",
          op: "queue.message_processing",
          attributes: {
            "queue.name": queueName,
            "job.id": job?.id || "unknown",
          },
        },
        async () => {
          // Extract payload from pgboss job format
          let payload: MessagePayload;
          
          if (typeof job === "object" && job !== null) {
            const keys = Object.keys(job);
            const numericKeys = keys.filter((key) => !Number.isNaN(Number(key)));

            if (numericKeys.length > 0) {
              // PgBoss array format
              const firstKey = numericKeys[0];
              const firstJob = firstKey ? job[firstKey] : null;
              if (firstJob?.data) {
                payload = firstJob.data;
              } else {
                throw new Error("Invalid job format: expected job object with data field");
              }
            } else {
              // Normal job format
              payload = job.data || job;
            }
          } else {
            payload = job;
          }

          await handler(payload);
        }
      );
    });
  }

  async createQueue(queueName: string): Promise<void> {
    if (!this.isConnected) {
      throw new Error("Queue is not connected");
    }

    try {
      await this.pgBoss.createQueue(queueName);
      logger.info(`✅ Created/verified queue: ${queueName}`);
    } catch (error) {
      logger.error(`Failed to create queue ${queueName}:`, error);
      throw error;
    }
  }

  async getQueueStats(queueName: string): Promise<QueueStats> {
    try {
      const stats = await this.pgBoss.getQueueSize(queueName);
      return {
        waiting: typeof stats === "number" ? stats : 0,
        active: 0, // PgBoss.getQueueSize only returns waiting count
        completed: 0,
        failed: 0,
      };
    } catch (error) {
      logger.error(`Failed to get queue stats for ${queueName}:`, error);
      return { waiting: 0, active: 0, completed: 0, failed: 0 };
    }
  }

  async updateJobStatus(
    jobId: string,
    status: "pending" | "active" | "completed" | "failed",
    retryCount?: number
  ): Promise<void> {
    // PgBoss handles job status internally, but we can log for debugging
    logger.debug(`Job ${jobId} status updated to: ${status} (retry: ${retryCount || 0})`);
  }

  isHealthy(): boolean {
    return this.isConnected;
  }
}