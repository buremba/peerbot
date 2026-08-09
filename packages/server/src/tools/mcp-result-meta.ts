const MCP_RESULT_META = Symbol('lobu.mcp-result-meta');

type ResultWithMcpMeta = {
  [MCP_RESULT_META]?: Record<string, unknown>;
};

/**
 * Attach host-only MCP result metadata without making it part of the tool's
 * structured result, formatted text, audit payload, or output-schema contract.
 */
export function attachMcpResultMeta<T extends object>(
  result: T,
  meta: Record<string, unknown>
): T {
  Object.defineProperty(result, MCP_RESULT_META, {
    value: meta,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

export function getMcpResultMeta(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== 'object') return undefined;
  return (result as ResultWithMcpMeta)[MCP_RESULT_META];
}
