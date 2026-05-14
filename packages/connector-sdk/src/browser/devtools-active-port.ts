/**
 * Read Chrome's `DevToolsActivePort` file (two lines: port + WS path) to
 * discover a live CDP endpoint. Works for both Chrome M144's chrome://
 * inspect toggle and the classic `--remote-debugging-port=<n>` launch
 * flag — both write the same file. The constructed `ws://127.0.0.1:
 * <port><path>` is a standard CDP WebSocket; Playwright's
 * `chromium.connectOverCDP(wsUrl)` attaches directly.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DevToolsActivePort {
  port: number;
  wsPath: string;
  wsUrl: string;
}

/**
 * Read and parse `<userDataRoot>/DevToolsActivePort`. Returns null if the
 * file is missing or malformed (e.g. Chrome hasn't been launched with
 * remote debugging enabled in this profile).
 */
export async function readDevToolsActivePort(
  userDataRoot: string
): Promise<DevToolsActivePort | null> {
  const path = join(userDataRoot, 'DevToolsActivePort');
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return null;
  }
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const port = Number(lines[0]);
  const wsPath = lines[1]!;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  if (!wsPath.startsWith('/')) return null;
  return {
    port,
    wsPath,
    wsUrl: `ws://127.0.0.1:${port}${wsPath}`,
  };
}
