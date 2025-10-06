/**
 * Abstract message queue interface for cross-platform message handling
 * Supports PostgreSQL/PgBoss, Redis, SQS, and other queue providers
 */

export interface MessagePayload {
  botId: string;
  userId: string;
  threadId: string;
  platform: string;
  channelId: string;
  messageId: string;
  messageText: string;
  platformMetadata: Record<string, any>;
  claudeOptions: Record<string, any>;
  routingMetadata?: {
    targetThreadId: string;
    userId: string;
  };
}

export interface QueueOptions {
  priority?: number;
  retryLimit?: number;
  retryDelay?: number;
  expireInSeconds?: number;
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

export interface JobHandler {
  (payload: MessagePayload): Promise<void>;
}

export abstract class MessageQueue {
  /**
   * Start the message queue
   */
  abstract start(): Promise<void>;

  /**
   * Stop the message queue and clean up resources
   */
  abstract stop(): Promise<void>;

  /**
   * Send a message to a queue
   */
  abstract send(
    queueName: string,
    payload: MessagePayload,
    options?: QueueOptions
  ): Promise<string>;

  /**
   * Listen to a queue and process messages with the provided handler
   */
  abstract work(queueName: string, handler: JobHandler): Promise<void>;

  /**
   * Create a queue if it doesn't exist
   */
  abstract createQueue(queueName: string): Promise<void>;

  /**
   * Get queue statistics
   */
  abstract getQueueStats(queueName: string): Promise<QueueStats>;

  /**
   * Update job status (optional - not all providers support this)
   */
  async updateJobStatus?(
    jobId: string,
    status: "pending" | "active" | "completed" | "failed",
    retryCount?: number
  ): Promise<void>;

  /**
   * Check if the queue is healthy and ready
   */
  abstract isHealthy(): boolean;
}