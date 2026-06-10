/**
 * Shared tool display configuration for progress processors.
 * Maps tool names to emoji.
 */

interface ToolDisplayEntry {
  emoji: string;
}

const TOOL_DISPLAY_CONFIG: Record<string, ToolDisplayEntry> = {
  Write: { emoji: "✏️" },
  Edit: { emoji: "✏️" },
  Bash: { emoji: "👾" },
  Read: { emoji: "📖" },
  Grep: { emoji: "🔍" },
  Glob: { emoji: "🔍" },
  TodoWrite: { emoji: "📝" },
  WebFetch: { emoji: "🌐" },
  WebSearch: { emoji: "🔎" },
};

/**
 * Look up tool display config, case-insensitively.
 * OpenClaw uses lowercase tool names (bash, read, write, etc.)
 * while some agents use PascalCase (Bash, Read, Write, etc.).
 */
export function getToolDisplayConfig(
  toolName: string
): ToolDisplayEntry | undefined {
  return (
    TOOL_DISPLAY_CONFIG[toolName] ??
    TOOL_DISPLAY_CONFIG[toolName.charAt(0).toUpperCase() + toolName.slice(1)]
  );
}
