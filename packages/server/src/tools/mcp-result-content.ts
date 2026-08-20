import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const MCP_RESULT_CONTENT = Symbol('lobu.mcp-result-content');

type McpResultContentBlock = CallToolResult['content'][number];

type ResultWithMcpContent = {
  [MCP_RESULT_CONTENT]?: McpResultContentBlock[];
};

/**
 * Attach host-only MCP content blocks without making them part of the tool's
 * structured result, formatted text, audit payload, or output-schema contract.
 */
export function attachMcpResultContent<T extends object>(
  result: T,
  content: McpResultContentBlock[]
): T {
  if (content.length === 0) return result;
  Object.defineProperty(result, MCP_RESULT_CONTENT, {
    value: content,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

export function getMcpResultContent(result: unknown): McpResultContentBlock[] | undefined {
  if (!result || typeof result !== 'object') return undefined;
  return (result as ResultWithMcpContent)[MCP_RESULT_CONTENT];
}
