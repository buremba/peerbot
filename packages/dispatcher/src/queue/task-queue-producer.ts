#!/usr/bin/env bun

import * as Sentry from "@sentry/node";
import PgBoss from "pg-boss";
import {
  createLogger,
  createDatabaseAdapter,
  type DatabaseAdapter,
} from "@peerbot/shared";

const logger = createLogger("dispatcher");

/**
 * Queue producer for dispatching messages to pgboss queues
 * Handles both direct_message and thread_message queues with bot isolation
 */

export interface BotContext {
  botId: string;
  platform: string;
}

export interface WorkerDeploymentPayload {
  userId: string;
  botId: string;
  threadId: string;
  platform: string;
  platformUserId: string;
  messageId: string;
  messageText: string;
  channelId: string;
  platformMetadata: Record<string, any>;
  claudeOptions: Record<string, any>;
  environmentVariables?: Record<string, string>;
  // Routing metadata for thread-specific processing
  routingMetadata?: {
    targetThreadId: string;
    userId: string;
  };
}

export interface ThreadMessagePayload {
  botId: string;
  userId: string;
  threadId: string;
  platform: string;
  channelId: string;
  messageId: string;
  messageText: string;
  platformMetadata: Record<string, any>;
  claudeOptions: Record<string, any>;
  // Routing metadata for thread-specific processing
  routingMetadata?: {
    targetThreadId: string;
    userId: string;
  };
}

export class QueueProducer {
  private pgBoss: PgBoss;
  private database?: DatabaseAdapter;
  private ownsDatabaseAdapter: boolean;
  private isConnected = false;

  constructor(connectionString: string, databaseClient?: DatabaseAdapter) {
    this.pgBoss = new PgBoss(connectionString);
    this.database = databaseClient ?? createDatabaseAdapter(connectionString);
    this.ownsDatabaseAdapter = !databaseClient;
  }

  /**
   * Start the queue producer
   */
  async start(): Promise<void> {
    try {
      await this.pgBoss.start();
      this.isConnected = true;

      // Create the messages queue if it doesn't exist
      await this.pgBoss.createQueue("messages");
      logger.info("✅ Created/verified messages queue");

      logger.info("✅ Queue producer started successfully");
    } catch (error) {
      logger.error("Failed to start queue producer:", error);
      throw error;
    }
  }

  /**
   * Stop the queue producer
   */
  async stop(): Promise<void> {
    try {
      this.isConnected = false;
      await this.pgBoss.stop();
      if (this.database && this.ownsDatabaseAdapter) {
        await this.database.close();
      }
      logger.info("✅ Queue producer stopped");
    } catch (error) {
      logger.error("Error stopping queue producer:", error);
      throw error;
    }
  }

  /**
   * Enqueue any message (direct or thread) to the single 'messages' queue
   * Orchestrator will determine if it needs to create a deployment or route to existing thread
   */
  async enqueueMessage(
    payload: WorkerDeploymentPayload | ThreadMessagePayload,
    options?: {
      priority?: number;
      retryLimit?: number;
      retryDelay?: number;
      expireInSeconds?: number;
    }
  ): Promise<string> {
    if (!this.isConnected) {
      throw new Error("Queue producer is not connected");
    }

    try {
      // All messages go to the single 'messages' queue
      const jobId = await this.pgBoss.send("messages", payload, {
        priority: options?.priority || 0,
        retryLimit: options?.retryLimit || 3,
        retryDelay: options?.retryDelay || 30,
        expireInSeconds: options?.expireInSeconds || 300, // 5 minutes = 300 seconds
        singletonKey: `message-${payload.userId}-${payload.threadId}-${payload.messageId || Date.now()}`, // Prevent duplicates
      });

      // Debug: Check what send() actually returns
      logger.info(
        `pgBoss.send() returned: ${JSON.stringify(jobId)}, type: ${typeof jobId}`
      );
      logger.info(
        `Enqueued message job ${jobId} for user ${payload.userId}, thread ${payload.threadId}`
      );
      return jobId || "job-sent";
    } catch (error) {
      Sentry.captureException(error);
      logger.error(
        `Failed to enqueue message for user ${payload.userId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Update job status using the database function
   */
  async updateJobStatus(
    jobId: string,
    status: "pending" | "active" | "completed" | "failed",
    retryCount?: number
  ): Promise<void> {
    if (!this.database) {
      logger.warn(
        `Cannot update job status for ${jobId} - database pool not available`
      );
      return;
    }

    try {
      await this.database.updateJobStatus(jobId, status, retryCount || null);
      logger.debug(`Updated job ${jobId} status to: ${status}`);
    } catch (error) {
      logger.error(`Failed to update job status for ${jobId}:`, error);
      throw error;
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(queueName: string): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
  }> {
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

  /**
   * Check if producer is connected
   */
  isHealthy(): boolean {
    return this.isConnected;
  }
}
