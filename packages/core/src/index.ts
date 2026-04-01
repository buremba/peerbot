#!/usr/bin/env bun

// Shared exports for @lobu/core consumers (gateway, worker, external tools)

export * from "./agent-policy";
// Agent store interface (unified storage abstraction)
export type {
  AgentAccessStore,
  AgentConfigStore,
  AgentConnectionStore,
  AgentMetadata,
  AgentSettings,
  AgentStore,
  ChannelBinding,
  ConnectionSettings,
  Grant,
  StoredConnection,
} from "./agent-store";
export type { CommandContext, CommandDefinition } from "./command-registry";
// Command registry
export { CommandRegistry } from "./command-registry";
export * from "./constants";
// Errors & logging
export * from "./errors";
// Integration types
export type {
  SystemSkillEntry,
  SystemSkillsConfigFile,
} from "./integration-types";
export * from "./logger";
// Module system
export type { ActionButton, ModuleSessionContext } from "./modules";
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
// Config-driven provider types
export type {
  ConfigProviderMeta,
  ProviderConfigEntry,
} from "./provider-config-types";
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
  RegistryEntry,
  SessionContext,
  SkillConfig,
  SkillMcpServer,
  SkillsConfig,
  SuggestedPrompt,
  ThinkingLevel,
  ThreadResponsePayload,
  ToolsConfig,
  UserSuggestion,
} from "./types";

// Platform constants
export const SUPPORTED_PLATFORMS = [
  "telegram",
  "slack",
  "discord",
  "whatsapp",
  "teams",
] as const;
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

// Agent Settings API response types (for UI consumers)
export type {
  AgentConfigResponse,
  AgentInfo,
  CatalogProvider,
  Connection,
  McpConfig,
  ModelOption,
  ModelSelectionState,
  PermissionGrant,
  PrefillMcp,
  PrefillSkill,
  ProviderInfo,
  ProviderState,
  ProviderStatus,
  Schedule,
  SettingsSnapshot,
  Skill,
  SkillMcpServerInfo,
} from "./api-types";

// Utilities
export * from "./utils/encryption";
export * from "./utils/env";
export * from "./utils/json";
export * from "./utils/lock";
export type { McpToolDef } from "./utils/mcp-tool-instructions";
export * from "./utils/retry";
export * from "./utils/sanitize";
export * from "./worker/auth";
export type {
  WorkerTransport,
  WorkerTransportConfig,
} from "./worker/transport";
