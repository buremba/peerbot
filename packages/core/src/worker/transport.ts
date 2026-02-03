/**
 * Worker Transport Interface
 * Defines how workers communicate with the gateway (platform-agnostic)
 *
 * This abstraction allows different transport implementations:
 * - HTTP (current implementation)
 * - WebSocket (for real-time bidirectional communication)
 * - gRPC (for high-performance scenarios)
 * - Message Queue (for asynchronous processing)
 */

/**
 * Transport interface for worker-to-gateway communication
 */
export interface WorkerTransport {
  /**
   * Set the job ID for this worker session
   * Used to correlate responses with the originating request
   */
  setJobId(jobId: string): void;

  /**
   * Set module-specific data to be included in responses
   * Allows modules to attach metadata to worker responses
   */
  setModuleData(moduleData: Record<string, unknown>): void;

  /**
   * Send a streaming delta to the gateway
   *
   * @param delta - The content delta to send
   * @param isFullReplacement - If true, replaces entire content; if false, appends
   * @param isFinal - If true, indicates this is the final delta
   */
  sendStreamDelta(
    delta: string,
    isFullReplacement?: boolean,
    isFinal?: boolean
  ): Promise<void>;

  /**
   * Signal that the worker has completed processing
   * Optionally includes a final delta
   *
   * @param finalDelta - Optional final content delta
   */
  signalDone(finalDelta?: string): Promise<void>;

  /**
   * Signal successful completion without additional content
   */
  signalCompletion(): Promise<void>;

  /**
   * Signal that an error occurred during processing
   *
   * @param error - The error that occurred
   */
  signalError(error: Error): Promise<void>;

  /**
   * Send a status update to the gateway
   * Used for long-running operations to show progress
   *
   * @param elapsedSeconds - Time elapsed since operation started
   * @param state - Current state description (e.g., "processing", "waiting for API")
   */
  sendStatusUpdate(elapsedSeconds: number, state: string): Promise<void>;
}

/**
 * Configuration for creating a worker transport
 */
export interface WorkerTransportConfig {
  /** Gateway URL for sending responses */
  gatewayUrl: string;

  /** Authentication token for worker */
  workerToken: string;

  /** User ID who initiated the request */
  userId: string;

  /** Channel/conversation ID */
  channelId: string;

  /** Thread ID for organizing messages */
  threadId: string;

  /** Original message timestamp/ID */
  originalMessageTs: string;

  /** Bot's response message timestamp/ID (if exists) */
  botResponseTs?: string;

  /** Team/workspace ID (required for all platforms) */
  teamId: string;

  /** Platform identifier (slack, whatsapp, api, etc.) */
  platform?: string;

  /** IDs of messages already processed (for deduplication) */
  processedMessageIds?: string[];
}
