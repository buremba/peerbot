/**
 * Tiny standalone module for the test-only MCP session cache.
 *
 * Kept separate from `test-helpers.ts` so that `test-db.ts` can clear the
 * cache without statically (or dynamically) loading the rest of
 * `test-helpers.ts`, which transitively imports the entire server app
 * (`../../index`) and every workspace dep it pulls in (e.g.
 * `@lobu/connector-sdk`). Gateway-only `bun:test` runs never need the
 * full app graph; this module is the leaf they touch instead.
 */

/**
 * Cache of initialized MCP sessions keyed by composite auth context.
 * Each entry stores the session ID returned by the server after
 * `initialize`.
 */
export const mcpSessions = new Map<string, string>();

/**
 * Clear cached MCP sessions (call between test suites if needed).
 */
export function clearMcpSessions(): void {
  mcpSessions.clear();
}
