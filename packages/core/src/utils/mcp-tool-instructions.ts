export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Enriched MCP server status delivered to workers in the session-context
 * payload. Built by the gateway; consumed by the worker to render setup
 * instructions, gate tool registration, and drive embedded-mode CLIs.
 */
export interface McpStatus {
  id: string;
  name: string;
  requiresAuth: boolean;
  requiresInput: boolean;
  authenticated: boolean;
  configured: boolean;
}
