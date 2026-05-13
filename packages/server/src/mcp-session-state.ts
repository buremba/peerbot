/**
 * Leaf module for the in-memory MCP transport session map's test-only
 * clear hook. Hoisted out of `mcp-handler.ts` so the test cleanup path
 * (`cleanupTestDatabase`) can clear it without statically importing
 * `mcp-handler.ts` — that file loads the entire tool registry, which
 * transitively pulls in `@lobu/connector-sdk`. Gateway-only `bun:test`
 * suites that don't have the workspace `dist/` built need the clear
 * without paying that import cost.
 *
 * The map itself is owned here so this module stays dep-free; the typed
 * lifecycle (insert / lookup / close transport) is implemented in
 * `mcp-handler.ts` against this same Map instance.
 */

// Loosely-typed on purpose — see the typed wrappers in `mcp-handler.ts`.
// Keeping this file dep-free is the whole point.
export const mcpSessionMap = new Map<string, unknown>();

/** Test-only: clear the in-memory MCP transport session map. */
export function clearInMemoryMcpSessionsForTests(): void {
  mcpSessionMap.clear();
}
