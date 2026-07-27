export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /**
   * Standard MCP tool annotations, as declared by the server that owns the
   * tool. The gateway receives these from `tools/list`, caches them, and passes
   * this object through to the worker untouched (gateway/index.ts builds the
   * session-context payload from `McpTool[]`), so `readOnlyHint` is readable
   * here without any new plumbing — the field was simply absent from this type.
   */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/**
 * Is this tool safe for an unattended turn — i.e. did its server explicitly
 * declare it read-only?
 *
 * FAILS CLOSED. A missing annotation, a missing `annotations` object, or an
 * explicit `false` all mean "assume it mutates". This mirrors the proxy's
 * existing approval rule ("Require approval unless we have annotations"): a
 * server that declares nothing is never silently trusted, and a newly added
 * mutating tool is excluded by default rather than exposed until someone
 * remembers to deny it.
 */
export function isReadOnlyMcpTool(tool: McpToolDef): boolean {
  return tool.annotations?.readOnlyHint === true;
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
