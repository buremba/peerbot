/**
 * Response renderer interface for platform-specific message rendering.
 * Each platform implements this interface to handle thread responses
 * in a platform-appropriate way (streaming, buffering, formatting).
 */

import type { ThreadResponsePayload } from "../infrastructure/queue/types.js";

/**
 * Interface for rendering thread responses to a specific platform.
 * Implementations handle platform-specific concerns like:
 * - Streaming vs buffered messages
 * - Rich formatting (Slack blocks) vs plain text (WhatsApp)
 * - Status indicators (thread status vs typing)
 */
export interface ResponseRenderer {
  /**
   * Handle streaming delta content.
   * Platforms that support streaming (Slack) update messages in real-time.
   * Platforms without streaming (WhatsApp) buffer content for later delivery.
   *
   * @param payload - The thread response payload containing delta content
   * @param sessionKey - Unique key for this response session (userId:messageId)
   * @returns Message ID/timestamp if a message was created/updated, null otherwise
   */
  handleDelta?(
    payload: ThreadResponsePayload,
    sessionKey: string
  ): Promise<string | null>;

  /**
   * Handle completion of response processing.
   * Called when all content has been processed (processedMessageIds is set).
   * Should finalize any streams, send buffered content, clear status indicators.
   *
   * @param payload - The thread response payload
   * @param sessionKey - Unique key for this response session
   */
  handleCompletion(
    payload: ThreadResponsePayload,
    sessionKey: string
  ): Promise<void>;

  /**
   * Handle error response.
   * Display error in platform-appropriate format.
   *
   * @param payload - The thread response payload containing error
   * @param sessionKey - Unique key for this response session
   */
  handleError(
    payload: ThreadResponsePayload,
    sessionKey: string
  ): Promise<void>;

  /**
   * Handle status updates (heartbeat with elapsed time).
   * Used to show "is running...", progress indicators, etc.
   *
   * @param payload - The thread response payload with statusUpdate field
   */
  handleStatusUpdate?(payload: ThreadResponsePayload): Promise<void>;

  /**
   * Handle ephemeral messages (visible only to specific user).
   * Used for OAuth/auth flows, temporary notifications.
   *
   * @param payload - The thread response payload with ephemeral content
   */
  handleEphemeral?(payload: ThreadResponsePayload): Promise<void>;

  /**
   * Stop any active streams for a conversation.
   * Called when an interaction is created to prevent messages appearing
   * after the interaction prompt.
   *
   * @param userId - User ID
   * @param conversationId - Conversation identifier
   */
  stopStreamForConversation?(
    userId: string,
    conversationId: string
  ): Promise<void>;
}
