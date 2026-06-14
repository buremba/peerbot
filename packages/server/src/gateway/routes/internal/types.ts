import type { WorkerTokenData } from "@lobu/core";

/**
 * Shared types for internal worker-facing routes.
 */

/**
 * Hono context type for routes authenticated via worker JWT tokens.
 * Covers all fields used across internal route handlers.
 */
export type WorkerContext = {
  Variables: {
    worker: WorkerTokenData;
  };
};
