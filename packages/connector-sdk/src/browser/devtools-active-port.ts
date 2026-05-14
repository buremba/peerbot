/**
 * Discover the CDP WebSocket endpoint of a Chrome instance using its
 * `DevToolsActivePort` file.
 *
 * Why this exists: Chrome M144 added an `Allow remote debugging for this
 * browser instance` toggle at `chrome://inspect/#remote-debugging`. When
 * the user flips it on, Chrome starts a CDP server *internally* — no
 * `--remote-debugging-port` flag, nothing visible in `ps`, and crucially
 * **no HTTP `/json/version` discovery endpoint** (security: it's
 * deliberately closed off so unrelated local processes can't enumerate
 * targets). Instead, Chrome writes a two-line file into the user-data
 * root:
 *
 *   <userDataRoot>/DevToolsActivePort
 *   ┌────────────────────────────────────────────┐
 *   │ 51697                                      │  ← port
 *   │ /devtools/browser/f7fbc71c-bf97-401f-b...  │  ← WS path
 *   └────────────────────────────────────────────┘
 *
 * Concatenated → `ws://127.0.0.1:<port><path>` is a standard CDP
 * WebSocket endpoint that Playwright's `chromium.connectOverCDP(wsUrl)`
 * attaches to directly. From there it's plain CDP — `Network.setCookie`,
 * `Page.navigate`, the works. The user may see a one-time approval
 * dialog on first connection per Chrome session; on subsequent attaches
 * within the same Chrome the approval sticks.
 *
 * This also covers the classic `--remote-debugging-port=<n>` path — when
 * Chrome is launched with that flag, it writes the same file (plus serves
 * the HTTP discovery endpoints). Either way, reading DevToolsActivePort
 * is the most reliable single discovery path.
 *
 * On Linux/Windows the file lives in the same place (relative to the
 * user-data root). The keychain issues don't apply on those platforms,
 * so the file-based discovery is just a nice-to-have there; on macOS
 * it's the only way to find an M144-toggle Chrome.
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
