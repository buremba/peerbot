import type { AgentErrorContext } from "../types";

/**
 * Worker Transport Interface
 * Defines how workers communicate with the gateway (platform-agnostic).
 * Current implementation: HTTP.
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
   * @param error - The error that occurred. Its message is relayed verbatim as
   *                the user-facing body for provider errors.
   * @param errorCode - Classified `AgentErrorCode` (see @lobu/core errors); the
   *                    renderer uses it only to select the CTA link.
   * @param context - Non-secret provider/model targeting for the error CTA.
   */
  signalError(
    error: Error,
    errorCode?: string,
    context?: AgentErrorContext
  ): Promise<void>;

  /**
   * Send a status update to the gateway
   * Used for long-running operations to show progress
   *
   * @param elapsedSeconds - Time elapsed since operation started
   * @param state - Current state description (e.g., "processing", "waiting for API")
   */
  sendStatusUpdate(elapsedSeconds: number, state: string): Promise<void>;

  /**
   * Send a structured event to the gateway for SSE clients.
   * Used for testable side effects like confirmed file uploads.
   */
  sendCustomEvent(name: string, data: Record<string, unknown>): Promise<void>;
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

  /** Conversation ID for organizing messages */
  conversationId: string;

  /** Original message timestamp/ID */
  originalMessageTs: string;

  /** Bot's response message timestamp/ID (if exists) */
  botResponseTs?: string;

  /** Team/workspace ID (required for all platforms) */
  teamId: string;

  /** Platform identifier (slack, whatsapp, api, etc.) */
  platform?: string;

  /** Platform-specific metadata needed for response routing */
  platformMetadata?: Record<string, unknown>;

  /** IDs of messages already processed (for deduplication) */
  processedMessageIds?: string[];
}
