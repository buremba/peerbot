/**
 * Plugin configuration types for the Lobu OpenClaw plugin.
 */

export interface PluginConfig {
  mcpUrl?: string;
  webUrl?: string;
  token?: string;
  tokenCommand?: string;
  gatewayAuthUrl?: string;
  headers?: Record<string, string>;
  autoRecall?: boolean;
  autoCapture?: boolean;
  recallLimit?: number;
  /**
   * Agent ID the plugin instance is bound to. When set, autoCapture saves
   * stamp `metadata.agent_id` on every event so `search_memory` can scope
   * recall to this agent's own writes. Injected by the Lobu worker from
   * the agent's runtime config; falls back to `process.env.LOBU_AGENT_ID`.
   */
  agentId?: string;
}

export interface ResolvedPluginConfig {
  mcpUrl: string | null;
  webUrl: string | null;
  token: string | null;
  tokenCommand: string | null;
  gatewayAuthUrl: string | null;
  headers: Record<string, string>;
  autoRecall: boolean;
  autoCapture: boolean;
  recallLimit: number;
  agentId: string | null;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResponse {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}
