/**
 * Build the tool-name list handed to pi's `createAgentSession({ tools })`.
 *
 * pi (0.73.x+) treats this list as BOTH the initial active set AND a hard
 * allowlist (`allowedToolNames = options.tools`; agent-session filters every
 * registered/custom tool whose name isn't in it). It therefore MUST include the
 * customTool names (ask_user, MCP tools, memory, plugins, image/audio) — passing
 * only the base built-in names silently drops every customTool before the model
 * sees it, leaving agents with just read/write/edit/bash/grep/find/ls.
 *
 * Kept as a tiny pure function so the base+custom union is unit-testable without
 * standing up a full session.
 */
export function activeToolNames(
  baseTools: ReadonlyArray<{ name: string }>,
  customTools: ReadonlyArray<{ name: string }>
): string[] {
  return [
    ...baseTools.map((tool) => tool.name),
    ...customTools.map((tool) => tool.name),
  ];
}
