#!/usr/bin/env bun

/**
 * Main entry point for Lobu Gateway
 *
 * When run directly (CLI mode): starts the gateway server.
 * When imported as a library (embedded mode): exports Gateway, config builders,
 * and the Hono app factory for mounting on a host server.
 */

// ── Public API (embedded mode) ──────────────────────────────────────────────

// Core classes
export { Gateway, type GatewayOptions } from "./gateway-main";
export { CoreServices } from "./services/core-services";

// Agent stores (sub-interfaces + Redis implementation)
export { RedisAgentStore } from "./stores/redis-agent-store";
export { SettingsResolver } from "./services/settings-resolver";
// Re-export store interfaces from core
export type {
  AgentAccessStore,
  AgentConfigStore,
  AgentConnectionStore,
  AgentStore,
  AgentSettings,
  AgentMetadata,
  StoredConnection,
  Grant,
  ChannelBinding,
} from "@lobu/core";

// Hono app factory + HTTP server
export {
  createGatewayApp,
  startGatewayServer,
  type CreateGatewayAppOptions,
} from "./cli/gateway";

// Auth provider (for embedded mode)
export type { AuthProvider } from "./routes/public/settings-auth";

// Configuration
export {
  buildGatewayConfig,
  loadEnvFile,
  buildMemoryPlugins,
  displayGatewayConfig,
  type GatewayConfig,
  type DeepPartial,
} from "./config";

// Session management
export { RedisSessionStore, SessionManager } from "./services/session-manager";

// Platform adapters (for registering platforms in embedded mode)
export { ChatInstanceManager } from "./connections";
export { ApiPlatform } from "./api";

// ── CLI mode (run directly, not when imported as library) ───────────────────
if (require.main === module) {
  import("./cli");
}
