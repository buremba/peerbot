/**
 * Shared types for internal worker-facing routes.
 */

/**
 * Hono context type for routes authenticated via worker JWT tokens.
 * Covers all fields used across internal route handlers.
 */
export type WorkerContext = {
  Variables: {
    worker: {
      userId: string;
      conversationId: string;
      channelId: string;
      teamId?: string;
      agentId?: string;
      deploymentName: string;
      platform?: string;
      connectionId?: string;
    };
  };
};
