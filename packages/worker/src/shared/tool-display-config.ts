/**
 * Shared tool display configuration for progress processors.
 * Maps tool names to emoji and description formatting.
 */

interface ToolDisplayEntry {
  emoji: string;
  action: string;
  getParam: (params: Record<string, unknown>) => string;
}

const TOOL_DISPLAY_CONFIG: Record<string, ToolDisplayEntry> = {
  Write: {
    emoji: "✏️",
    action: "Writing",
    getParam: (p) => `\`${p.file_path || ""}\``,
  },
  Edit: {
    emoji: "✏️",
    action: "Editing",
    getParam: (p) => `\`${p.file_path || ""}\``,
  },
  Bash: {
    emoji: "👾",
    action: "Running",
    getParam: (p) => {
      const cmd = String(p.command || p.description || "command");
      return `\`${cmd.length > 50 ? `${cmd.substring(0, 50)}...` : cmd}\``;
    },
  },
  Read: {
    emoji: "📖",
    action: "Reading",
    getParam: (p) => `\`${p.file_path || p.path || ""}\``,
  },
  Grep: {
    emoji: "🔍",
    action: "Searching",
    getParam: (p) => `\`${p.pattern || ""}\``,
  },
  Glob: {
    emoji: "🔍",
    action: "Finding",
    getParam: (p) => `\`${p.pattern || ""}\``,
  },
  TodoWrite: {
    emoji: "📝",
    action: "Updating task list",
    getParam: () => "",
  },
  WebFetch: {
    emoji: "🌐",
    action: "Fetching",
    getParam: (p) => `\`${p.url || ""}\``,
  },
  WebSearch: {
    emoji: "🔎",
    action: "Searching web",
    getParam: (p) => `\`${p.query || ""}\``,
  },
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
