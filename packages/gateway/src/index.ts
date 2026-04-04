#!/usr/bin/env bun

/**
 * Main entry point for Lobu Gateway
 *
 * When run directly (CLI mode): starts the gateway server.
 * When imported as a library (embedded mode): exports Gateway, config builders,
 * and the Hono app factory for mounting on a host server.
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
export { Gateway, type GatewayOptions } from "./gateway-main";
export { CoreServices } from "./services/core-services";
export { InMemoryAgentStore } from "./stores/in-memory-agent-store";

// ── Types ───────────────────────────────────────────────────────────────────

export type {
  AgentAccessStore,
  AgentConfigStore,
  AgentConnectionStore,
  AgentMetadata,
  AgentSettings,
  AgentStore,
} from "@lobu/core";

// ── CLI mode (run directly, not when imported as library) ───────────────────
if (require.main === module) {
  import("./cli");
}
