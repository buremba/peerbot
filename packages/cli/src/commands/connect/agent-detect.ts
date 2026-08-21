import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ConnectTargetId } from "./install-targets.js";

export interface DetectedAgent {
  id: ConnectTargetId;
  name: string;
  detected: boolean;
  path: string | null;
  kind: "cli" | "app" | "manual";
}

interface AgentProbe {
  id: ConnectTargetId;
  name: string;
  kind: "cli" | "app" | "manual";
  detect: () => string | null;
}

function whichBinary(name: string): string | null {
  try {
    const command = process.platform === "win32" ? "where" : "which";
    return (
      execFileSync(command, [name], {
        encoding: "utf-8",
        timeout: 5000,
      })
        .trim()
        .split("\n")[0] ?? null
    );
  } catch {
    return null;
  }
}

function findApp(
  appPaths: Record<string, string[]>,
  binaryName?: string
): string | null {
  const candidates = appPaths[process.platform] ?? [];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return binaryName ? whichBinary(binaryName) : null;
}

const AGENT_PROBES: AgentProbe[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    kind: "cli",
    detect: () => whichBinary("claude"),
  },
  {
    id: "codex",
    name: "Codex",
    kind: "cli",
    detect: () => whichBinary("codex"),
  },
  {
    id: "opencode",
    name: "OpenCode",
    kind: "cli",
    detect: () => whichBinary("opencode"),
  },
  {
    id: "antigravity",
    name: "Antigravity CLI",
    kind: "cli",
    detect: () => whichBinary("agy"),
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "app",
    detect: () =>
      findApp(
        {
          darwin: ["/Applications/Cursor.app"],
          linux: ["/usr/share/cursor/cursor"],
        },
        "cursor"
      ),
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    kind: "manual",
    detect: () => null,
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    kind: "manual",
    detect: () => null,
  },
];

export function detectAgents(): DetectedAgent[] {
  return AGENT_PROBES.map((probe) => {
    const path = probe.detect();
    return {
      id: probe.id,
      name: probe.name,
      detected: path !== null,
      path,
      kind: probe.kind,
    };
  });
}
