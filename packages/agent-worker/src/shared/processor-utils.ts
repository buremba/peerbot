import { getToolDisplayConfig } from "./tool-display-config";

/**
 * Format MCP-style tool names: prefix__server__tool -> prefix.server.tool
 */
function formatMcpToolName(toolName: string): string {
  const match = toolName.match(/^([^_]+)__([^_]+)__(.+)$/);
  if (!match) return toolName;
  const [, prefix, server, tool] = match;
  return `${prefix}.${server}.${tool}`;
}

/**
 * Format tool execution for user-friendly display in bullet lists.
 * Shared across agent processors.
 */
export function formatToolExecution(
  toolName: string,
  params: Record<string, unknown>,
  verboseLogging: boolean
): string | null {
  if (!verboseLogging) return null;

  const config = getToolDisplayConfig(toolName);
  const displayName = config ? toolName : formatMcpToolName(toolName);
  const emoji = config?.emoji ?? "🔧";

  const inputStr =
    Object.keys(params).length > 0
      ? `\n\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\``
      : "";
  return `└ ${emoji} **${displayName}**${inputStr}`;
}
