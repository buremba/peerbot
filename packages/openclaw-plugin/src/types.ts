/**
 * Plugin configuration types for the Lobu OpenClaw plugin.
 */

export interface MemoryWikiCompatConfig {
  /** Enable OpenClaw memory-wiki compatible tools backed by Lobu MCP primitives. */
  enabled?: boolean;
  /**
   * Per-fanout timeout (ms) for SDK-backed wiki tool calls (`wiki_status`,
   * `wiki_search` corpus=all|wiki, `wiki_get`). When a single fanout exceeds
   * this budget, the slow side is dropped and the tool returns partial results
   * with a `degraded`/`timeouts` marker rather than blocking the whole call.
   * Defaults to 30000 (well under Cloudflare's 100s edge timeout). Clamped to
   * [1000, 90000].
   */
  fanoutTimeoutMs?: number;
}

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
  /** Spike/compat mode: register wiki_* and memory_* aliases without changing Lobu MCP. */
  memoryWikiCompat?: boolean | MemoryWikiCompatConfig;
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
  memoryWikiCompat: {
    enabled: boolean;
    fanoutTimeoutMs: number;
  };
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
