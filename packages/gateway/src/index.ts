/**
 * Library entry point for @lobu/gateway.
 *
 * Exports the Gateway, config builders, and the Hono app factory so the
 * gateway can be embedded inside a host process (e.g. `owletto-backend`).
 * The standalone CLI/server lives in `./cli/index.ts` for callers that want
 * to run the gateway as its own process.
 */

// ── Primary API ─────────────────────────────────────────────────────────────

export { Lobu, type LobuAgentConfig, type LobuConfig } from "./lobu";

// ── Advanced (for custom setups) ────────────────────────────────────────────

export { createGatewayApp, startGatewayServer } from "./cli/gateway";
export {
  type AgentConfig,
  buildGatewayConfig,
  type GatewayConfig,
} from "./config";
export type {
  EmbeddedAuthProvider,
  ProviderCredentialContext,
  RuntimeProviderCredentialLookup,
  RuntimeProviderCredentialResolver,
  RuntimeProviderCredentialResult,
} from "./embedded";
export { Gateway, type GatewayOptions } from "./gateway-main";
export { CoreServices } from "./services/core-services";
export { InMemoryAgentStore } from "./stores/in-memory-agent-store";
export {
  AwsSecretsManagerSecretStore,
  RedisSecretStore,
  SecretStoreRegistry,
  type SecretStore,
  type SecretStoreRegistryOptions,
  type WritableSecretStore,
} from "./secrets";

// ── Types ───────────────────────────────────────────────────────────────────

export type {
  AgentAccessStore,
  AgentConfigStore,
  AgentConnectionStore,
  AgentMetadata,
  AgentSettings,
  AgentStore,
} from "@lobu/core";
