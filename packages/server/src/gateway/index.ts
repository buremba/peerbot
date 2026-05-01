/**
 * In-process Lobu gateway barrel.
 *
 * Exports the Gateway, config builders, and the Hono app factory used by
 * `src/lobu/gateway.ts` to mount the gateway inside server. The
 * standalone CLI lives in `./cli/index.ts` for callers that want to run the
 * gateway as its own process.
 */

export { createGatewayApp, startGatewayServer } from "./cli/gateway.js";
export { OAuthClient } from "./auth/oauth/client.js";
export { CLAUDE_PROVIDER } from "./auth/oauth/providers.js";
export { createAuthProfileLabel } from "./auth/settings/auth-profiles-manager.js";
export { ApiPlatform, type ApiPlatformConfig } from "./api/index.js";
export {
  ChatInstanceManager,
  ChatResponseBridge,
} from "./connections/index.js";
export type {
  ConnectionSettings,
  PlatformAdapterConfig,
  PlatformConnection,
} from "./connections/index.js";
export {
  type AgentConfig,
  buildGatewayConfig,
  type GatewayConfig,
} from "./config/index.js";
export { Orchestrator } from "./orchestration/index.js";
export type {
  EmbeddedAuthProvider,
  ProviderCredentialContext,
  RuntimeProviderCredentialLookup,
  RuntimeProviderCredentialResolver,
  RuntimeProviderCredentialResult,
} from "./embedded.js";
export { Gateway, type GatewayOptions } from "./gateway-main.js";
export {
  type CreateThreadForAgentArgs,
  type CreateThreadForAgentResult,
  createThreadForAgent,
  type EnqueueAgentMessageArgs,
  type EnqueueAgentMessageResult,
  enqueueAgentMessage,
} from "./services/agent-threads.js";
export { CoreServices } from "./services/core-services.js";
export {
  WatcherRunTracker,
  type WatcherRunHandle,
  type WatcherRunResult,
} from "./watchers/run-tracker.js";
export { InMemoryAgentStore } from "./stores/in-memory-agent-store.js";
export {
  AwsSecretsManagerSecretStore,
  SecretStoreRegistry,
  type SecretStore,
  type SecretStoreRegistryOptions,
  type WritableSecretStore,
} from "./secrets/index.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type {
  AgentAccessStore,
  AgentConfigStore,
  AgentConnectionStore,
  AgentMetadata,
  AgentSettings,
  AgentStore,
} from "@lobu/core";
