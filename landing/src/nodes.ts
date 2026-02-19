import type { NodePosition } from "./types";

// Layout: hub-spoke with Gateway in center
// Slack on the left, Sandbox on the right, MCP top-right, LLM bottom-right
export const NODES: NodePosition[] = [
  {
    id: "slack",
    label: "Slack",
    sublabel: "User Interface",
    x: 120,
    y: 260,
    icon: "slack",
  },
  {
    id: "gateway",
    label: "Gateway",
    sublabel: "Lobu Gateway",
    x: 400,
    y: 260,
    icon: "gateway",
  },
  {
    id: "sandbox",
    label: "Sandbox",
    sublabel: "Isolated Container",
    x: 680,
    y: 260,
    icon: "sandbox",
  },
  {
    id: "mcp",
    label: "MCP Server",
    sublabel: "External Service",
    x: 400,
    y: 80,
    icon: "mcp",
  },
  {
    id: "llm",
    label: "LLM API",
    sublabel: "Claude / OpenAI",
    x: 400,
    y: 440,
    icon: "llm",
  },
];

// Connection lines between nodes
export const CONNECTIONS: Array<{ from: string; to: string }> = [
  { from: "slack", to: "gateway" },
  { from: "gateway", to: "sandbox" },
  { from: "gateway", to: "mcp" },
  { from: "gateway", to: "llm" },
];
