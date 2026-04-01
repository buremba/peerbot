#!/usr/bin/env bun

/**
 * Main entry point for Lobu Gateway
 *
 * When run directly (CLI mode): starts the gateway server.
 * When imported as a library (embedded mode): exports Gateway, config builders,
 * and the Hono app factory for mounting on a host server.
 */

// ── Public API (embedded mode) ──────────────────────────────────────────────

// Re-export store interfaces from core
export type {
  AgentAccessStore,
  AgentConfigStore,
  AgentConnectionStore,
  AgentMetadata,
  AgentSettings,
  AgentStore,
  ChannelBinding,
  Grant,
  StoredConnection,
} from "@lobu/core";
export { ApiPlatform } from "./api";
// Hono app factory + HTTP server
export {
  type CreateGatewayAppOptions,
  createGatewayApp,
  startGatewayServer,
} from "./cli/gateway";
// Configuration
export {
  buildGatewayConfig,
  buildMemoryPlugins,
  type DeepPartial,
  displayGatewayConfig,
  type GatewayConfig,
  loadEnvFile,
} from "./config";
// Platform adapters (for registering platforms in embedded mode)
export { ChatInstanceManager } from "./connections";
// Core classes
export { Gateway, type GatewayOptions } from "./gateway-main";

// Auth provider (for embedded mode)
export type { AuthProvider } from "./routes/public/settings-auth";
export { CoreServices } from "./services/core-services";

// Session management
export { RedisSessionStore, SessionManager } from "./services/session-manager";
export { SettingsResolver } from "./services/settings-resolver";
// Agent stores (sub-interfaces + Redis implementation)
export { RedisAgentStore } from "./stores/redis-agent-store";

// ── CLI mode (run directly, not when imported as library) ───────────────────
if (require.main === module) {
  import("./cli");
}
