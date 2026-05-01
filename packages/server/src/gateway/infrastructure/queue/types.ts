/**
 * Message queue interface and payload types for lobu
 * Implemented by RunsQueue over the Postgres `public.runs` substrate.
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
  /** Optional `runs.action_key` value — the task lane uses this to encode the
   *  task name so admin/ops queries can filter without unpacking JSON. */
  actionKey?: string;
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

export type JobHandler<T = any> = (job: QueueJob<T>) => Promise<void>;

/**
 * Abstract message queue interface.
 * Implementations: RunsQueue (Postgres `public.runs` + SKIP LOCKED).
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
   * Subscribe to a queue and process jobs.
   * @param startPaused - If true, worker is created but won't process jobs until resumeWorker() is called.
   */
  work<T>(
    queueName: string,
    handler: JobHandler<T>,
    options?: { startPaused?: boolean }
  ): Promise<void>;

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
}

// ============================================================================
// Payload Types
// ============================================================================

// `ThreadResponsePayload` is defined once in `@lobu/core` and re-exported
// from this package's queue index for convenience. It is shared by workers
// and platform renderers, so keeping a single source of truth is essential.
export type { ThreadResponsePayload } from "@lobu/core";
