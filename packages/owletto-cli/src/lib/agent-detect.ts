import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface DetectedAgent {
  id: string;
  name: string;
  detected: boolean;
  path: string | null;
  kind: 'cli' | 'app' | 'manual';
}

interface AgentProbe {
  id: string;
  name: string;
  kind: 'cli' | 'app' | 'manual';
  detect: () => string | null;
}

function whichBinary(name: string): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    return execFileSync(cmd, [name], { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

function findApp(appPaths: Record<string, string[]>, binaryName?: string): string | null {
  const platform = process.platform as string;
  const candidates = appPaths[platform] || [];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return binaryName ? whichBinary(binaryName) : null;
}

const AGENT_PROBES: AgentProbe[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    kind: 'cli',
    detect: () => whichBinary('claude'),
  },
  {
    id: 'codex',
    name: 'Codex',
    kind: 'cli',
    detect: () => whichBinary('codex'),
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    kind: 'cli',
    detect: () => whichBinary('gemini'),
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    kind: 'cli',
    detect: () => whichBinary('openclaw'),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    kind: 'app',
    detect: () =>
      findApp(
        {
          darwin: ['/Applications/Cursor.app'],
          linux: ['/usr/share/cursor/cursor'],
        },
        'cursor'
      ),
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    kind: 'manual',
    detect: () => null,
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    kind: 'manual',
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
