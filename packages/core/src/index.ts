#!/usr/bin/env bun

// Shared exports for @lobu/core consumers (gateway, worker, external tools)

export type { CommandContext, CommandDefinition } from "./command-registry";
// Command registry
export { CommandRegistry } from "./command-registry";
export * from "./constants";
// Errors & logging
export * from "./errors";
export * from "./logger";

// Module system
export type {
  ActionButton,
  ModuleSessionContext,
  ProviderUpstreamConfig,
} from "./modules";
export * from "./modules";
export type { OtelConfig, Span, Tracer } from "./otel";
// OpenTelemetry tracing (Tempo integration)
export {
  createChildSpan,
  createRootSpan,
  createSpan,
  flushTracing,
  getCurrentSpan,
  getTraceparent,
  getTracer,
  initTracing,
  runInSpanContext,
  SpanKind,
  SpanStatusCode,
  shutdownTracing,
  withChildSpan,
  withSpan,
} from "./otel";
// Plugin types
export type {
  PluginConfig,
  PluginManifest,
  PluginSlot,
  PluginsConfig,
  ProviderRegistration,
} from "./plugin-types";
// Redis & worker helpers
export * from "./redis/base-store";
// Observability
export { getSentry, initSentry } from "./sentry";
export { extractTraceId, generateTraceId } from "./trace";
// Core types
export type {
  AgentMcpConfig,
  AgentOptions,
  AuthProfile,
  CliBackendConfig,
  ConversationMessage,
  HistoryMessage,
  InstalledProvider,
  InstructionContext,
  InstructionProvider,
  LogLevel,
  McpServerConfig,
  NetworkConfig,
  NixConfig,
  SessionContext,
  SkillConfig,
  SkillsConfig,
  SuggestedPrompt,
  ThreadResponsePayload,
  ToolsConfig,
  UserSuggestion,
} from "./types";

// Utilities
export * from "./utils/encryption";
export * from "./utils/env";
export * from "./utils/json";
export * from "./utils/lock";
export type { McpToolDef } from "./utils/mcp-tool-instructions";
export { buildMcpToolInstructions } from "./utils/mcp-tool-instructions";
export * from "./utils/retry";
export * from "./utils/sanitize";
export * from "./worker/auth";
export type {
  WorkerTransport,
  WorkerTransportConfig,
} from "./worker/transport";
