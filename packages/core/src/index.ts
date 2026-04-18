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
export { findTemplateAgentId } from "./agent-store";
// Agent Settings API response types (for UI consumers)
export type {
  AgentConfigResponse,
  AgentInfo,
  CatalogProvider,
  Connection,
  McpConfig,
  ModelOption,
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
export type { CommandContext, CommandDefinition } from "./command-registry";
// Command registry
export { CommandRegistry } from "./command-registry";
export * from "./constants";
// Errors & logging
export * from "./errors";
// Integration types
export type {
  ProviderRegistryEntry,
  ProvidersConfigFile,
} from "./integration-types";
// lobu.toml zod schema (canonical — used by CLI and gateway)
export {
  type AgentEntry as TomlAgentEntry,
  type ConnectionEntry as TomlConnectionEntry,
  type LobuTomlConfig,
  lobuConfigSchema,
  type McpServerEntry as TomlMcpServerEntry,
  type MemoryEntry as TomlMemoryEntry,
  type NetworkEntry as TomlNetworkEntry,
  type OwlettoMemoryEntry as TomlOwlettoMemoryEntry,
  type ProviderEntry as TomlProviderEntry,
  type ScheduleEntry as TomlScheduleEntry,
  type SkillsEntry as TomlSkillsEntry,
  type ToolsEntry,
  type ToolsEntry as TomlToolsEntry,
  type WorkerEntry as TomlWorkerEntry,
} from "./lobu-toml-schema";
export * from "./logger";
// Module system
export type { ActionButton, ModuleSessionContext } from "./modules";
export * from "./modules";
export type { OtelConfig, Span, Tracer } from "./otel";
// OpenTelemetry tracing
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
export * from "./redis/json-helpers";
export * from "./secret-refs";
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
  DeclaredCredential,
  DeclaredSchedule,
  HistoryMessage,
  InstalledProvider,
  InstructionContext,
  InstructionProvider,
  LogLevel,
  McpOAuthConfig,
  McpServerConfig,
  ModelSelectionMode,
  ModelSelectionState,
  NetworkConfig,
  NixConfig,
  ProviderModelPreferences,
  RegistryEntry,
  ScheduleConcurrency,
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
export { hasCredentialSource } from "./types";

// Utilities
export * from "./utils/encryption";
export * from "./utils/env";
export * from "./utils/json";
export * from "./utils/lock";
export type { McpStatus, McpToolDef } from "./utils/mcp-tool-instructions";
export * from "./utils/network-domains";
export * from "./utils/retry";
export * from "./utils/sanitize";
export * from "./worker/auth";
export type {
  WorkerTransport,
  WorkerTransportConfig,
} from "./worker/transport";
