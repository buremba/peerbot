/**
 * MCP Tool Approval Policy
 *
 * Uses MCP protocol tool annotations to determine whether a tool call
 * requires explicit user approval (grant) before execution.
 *
 * Per the MCP spec, the default assumption is destructiveHint=true,
 * so tools without annotations require approval (conservative default).
 */

interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Determine if a tool call requires user approval based on its annotations.
 *
 * Returns false (no approval needed) when:
 *   - readOnlyHint is explicitly true
 *   - destructiveHint is explicitly false
 *
 * Returns true (approval required) otherwise, including when:
 *   - No annotations provided (conservative default)
 *   - destructiveHint is true (default per MCP spec)
 */
export function requiresToolApproval(
  annotations?: McpToolAnnotations
): boolean {
  if (!annotations) return true;
  if (annotations.readOnlyHint === true) return false;
  if (annotations.destructiveHint === false) return false;
  return true;
}
