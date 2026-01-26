#!/usr/bin/env bun

// Shared exports for @peerbot/core consumers (gateway, worker, external tools)

export * from "./constants";
// Constants
export { DEFAULTS, REDIS_KEYS, TIME } from "./constants";

// Errors & logging
export * from "./errors";
export * from "./logger";

// Module system
export type { ActionButton, ModuleSessionContext } from "./modules";
export * from "./modules";
// Redis & worker helpers
export * from "./redis/base-store";
// Observability
export { getSentry, initSentry } from "./sentry";
export { extractTraceId, generateTraceId, hasTraceId } from "./trace";
// Core types
export type {
  AgentOptions,
  ConversationMessage,
  FieldSchema,
  InstructionContext,
  InstructionProvider,
  InteractionOptions,
  InteractionType,
  LogLevel,
  PendingInteraction,
  SessionContext,
  SuggestedPrompt,
  ThreadResponsePayload,
  UserInteraction,
  UserInteractionResponse,
  UserSuggestion,
} from "./types";

// Utilities
export * from "./utils/encryption";
export * from "./utils/env";
export * from "./utils/error-handler";
export * from "./utils/json";
export * from "./utils/lock";
export * from "./utils/retry";
export * from "./utils/sanitize";
export * from "./worker/auth";
export type {
  WorkerTransport,
  WorkerTransportConfig,
} from "./worker/transport";
