/**
 * Plugin configuration types for the Owletto OpenClaw plugin.
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
