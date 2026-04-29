/**
 * In-process Lobu gateway barrel.
 *
 * Exports the Gateway, config builders, and the Hono app factory used by
 * `src/lobu/gateway.ts` to mount the gateway inside owletto-backend. The
 * standalone CLI lives in `./cli/index.ts` for callers that want to run the
 * gateway as its own process.
 */

// ── Primary API ─────────────────────────────────────────────────────────────

export { Lobu, type LobuAgentConfig, type LobuConfig } from "./lobu.js";

// ── Advanced (for custom setups) ────────────────────────────────────────────

export { createGatewayApp, startGatewayServer } from "./cli/gateway.js";
export {
  type AgentConfig,
  buildGatewayConfig,
  type GatewayConfig,
} from "./config/index.js";
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
