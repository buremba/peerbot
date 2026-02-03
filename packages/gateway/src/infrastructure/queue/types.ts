/**
 * Message queue interface and payload types for peerbot
 * Supports multiple queue backends (currently Redis via BullMQ)
 */

// ============================================================================
// Queue Types
// ============================================================================

export interface QueueJob<T = any> {
  id: string;
  data: T;
  name?: string;
}

export interface QueueOptions {
  priority?: number;
  retryLimit?: number;
  retryDelay?: number;
  expireInSeconds?: number;
  singletonKey?: string;
  /** Delay in milliseconds before the job is processed */
  delayMs?: number;
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

export type JobHandler<T = any> = (job: QueueJob<T>) => Promise<void>;

/**
 * Abstract message queue interface
 * Implementations: RedisQueue (BullMQ)
 */
export interface IMessageQueue {
  /**
   * Start the queue (connect to backend)
   */
  start(): Promise<void>;

  /**
   * Stop the queue (disconnect from backend)
   */
  stop(): Promise<void>;

  /**
   * Create a queue if it doesn't exist
   */
  createQueue(queueName: string): Promise<void>;

  /**
   * Send a message to a queue
   */
  send<T>(queueName: string, data: T, options?: QueueOptions): Promise<string>;

  /**
   * Subscribe to a queue and process jobs
   */
  work<T>(queueName: string, handler: JobHandler<T>): Promise<void>;

  /**
   * Pause a queue worker (stops processing jobs)
   */
  pauseWorker(queueName: string): Promise<void>;

  /**
   * Resume a queue worker (starts processing jobs)
   */
  resumeWorker(queueName: string): Promise<void>;

  /**
   * Get detailed queue statistics
   */
  getQueueStats(queueName: string): Promise<QueueStats>;

  /**
   * Check if queue is healthy/connected
   */
  isHealthy(): boolean;

  /**
   * Get underlying Redis client for general-purpose Redis operations
   * Used for application state storage (sessions, cache, etc.)
   */
  getRedisClient(): any;
}

// ============================================================================
// Payload Types
// ============================================================================

/**
 * Shared payload contract for worker → platform thread responses.
 * Ensures gateway consumers and workers stay type-aligned.
 */
export interface ThreadResponsePayload {
  messageId: string;
  channelId: string;
  threadId: string;
  userId: string;
  teamId: string;
  platform?: string; // Platform identifier (slack, whatsapp, api, etc.) for multi-platform routing
  content?: string; // Used only for ephemeral messages (OAuth/auth flows)
  delta?: string;
  isFullReplacement?: boolean;
  processedMessageIds?: string[];
  error?: string;
  timestamp: number;
  originalMessageId?: string;
  moduleData?: Record<string, unknown>;
  botResponseId?: string;
  ephemeral?: boolean;
  statusUpdate?: {
    elapsedSeconds: number;
    state: string;
  };
  platformMetadata?: Record<string, unknown>; // Platform-specific metadata (e.g., sessionId for API)

  // Exec-specific response fields (for jobType === "exec")
  execId?: string; // Exec job ID for response routing
  execStream?: "stdout" | "stderr"; // Which stream this delta is from
  execExitCode?: number; // Process exit code (sent on completion)
}
