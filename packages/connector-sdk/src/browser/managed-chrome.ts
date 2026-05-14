/**
 * Launch a top-level Chrome instance against a managed --user-data-dir and
 * expose CDP for connector attach.
 *
 * Why this exists: on macOS, when Playwright spawns Chrome as a child of
 * Node, macOS's TCC denies the child access to Chrome's Keychain entry —
 * cookies stay encrypted as gibberish. The fix is to launch Chrome as a
 * *top-level* macOS app via `open -na`, so it owns its own TCC identity.
 * The connector then attaches over CDP.
 *
 * Important: this is only safe against **blank** managed profiles that have
 * never been signed into a Google account. If we did this against a copy of
 * the user's main Chrome profile, Google's session-conflict heuristic would
 * see two simultaneous Chrome sessions for one account and force-log out
 * the user's real Chrome. The blank-profile rule keeps Google's auth layer
 * out of the picture entirely — the cookies that matter live on a
 * per-Lobu-Chrome basis, freshly logged in by the user inside that Chrome.
 *
 * Non-macOS platforms: this helper is a no-op and the original
 * launchPersistentContext path handles things directly.
 */

import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { sdkLogger } from '../logger.js';
import { fetchCdpVersionInfo } from './cdp.js';

const execFileAsync = promisify(execFile);

export interface ManagedChromeHandle {
  /** http://127.0.0.1:<port> — feed to chromium.connectOverCDP(...). */
  cdpUrl: string;
  /** Closes the managed Chrome process. Best-effort. */
  close: () => Promise<void>;
}

/**
 * Returns true on macOS — the only platform that needs this NSWorkspace
 * indirection. Linux/Windows can launch Chrome directly as a child without
 * losing keychain access.
 */
export function shouldUseManagedChromeShim(): boolean {
  return process.platform === 'darwin';
}

/** Allocate a free TCP port by binding to 0 + reading what the OS assigned. */
async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Could not allocate a free port')));
      }
    });
    srv.on('error', reject);
  });
}

async function waitForCdp(cdpUrl: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const info = await fetchCdpVersionInfo(cdpUrl);
      if (info?.webSocketDebuggerUrl) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Managed Chrome did not become CDP-reachable at ${cdpUrl} within ${timeoutMs}ms${lastErr ? `: ${String(lastErr)}` : ''}`
  );
}

/**
 * Launch Chrome.app top-level against `userDataDir` with a fresh debug
 * port. Returns the CDP URL once `/json/version` is reachable. Caller is
 * responsible for `handle.close()` to tear the Chrome window down.
 *
 * Implementation notes:
 *  - `open -na "Google Chrome"`: `-n` forces a new instance even when the
 *    user's normal Chrome is running; `-a` names the app. We tried `-gja`
 *    (launch hidden) — it silently no-ops, presumably because `-j`/`-g`
 *    don't compose with `-n`. A visible window per sync is the trade-off,
 *    and a useful signal that something is happening.
 *  - `open` returns immediately with no PID. We find the Chrome process at
 *    shutdown by grepping `ps` for our exact `--user-data-dir=… --remote-
 *    debugging-port=…` argv combo. Disambiguates against any other
 *    managed Chromes the user may have running.
 *  - The profile dir **must be blank** (never signed into Google). Copying
 *    the user's main profile here causes Google to log out their real
 *    Chrome — see file-level comment.
 */
export async function launchManagedChromeDarwin(opts: {
  userDataDir: string;
  startUrl?: string;
}): Promise<ManagedChromeHandle> {
  if (process.platform !== 'darwin') {
    throw new Error('launchManagedChromeDarwin is macOS-only');
  }
  const port = await findFreePort();
  const cdpUrl = `http://127.0.0.1:${port}`;

  const args = [
    '-na',
    'Google Chrome',
    '--args',
    `--user-data-dir=${opts.userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    opts.startUrl ?? 'about:blank',
  ];

  sdkLogger.info(
    { port, userDataDir: opts.userDataDir },
    '[ManagedChrome] Launching top-level Chrome for CDP attach'
  );
  spawn('open', args, { stdio: 'ignore', detached: true }).unref();

  await waitForCdp(cdpUrl);
  sdkLogger.info({ cdpUrl }, '[ManagedChrome] CDP endpoint ready');

  const close = async (): Promise<void> => {
    try {
      const { stdout } = await execFileAsync('ps', ['-axo', 'pid,command']);
      const needle = `--user-data-dir=${opts.userDataDir} --remote-debugging-port=${port}`;
      for (const line of stdout.split('\n')) {
        if (!line.includes(needle)) continue;
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (Number.isFinite(pid)) {
          try {
            process.kill(pid, 'SIGTERM');
            sdkLogger.info({ pid, port }, '[ManagedChrome] Sent SIGTERM');
          } catch {
            /* process already gone */
          }
        }
      }
    } catch (err) {
      sdkLogger.info(
        { err: (err as Error).message },
        '[ManagedChrome] ps lookup failed; managed Chrome may need manual close'
      );
    }
  };

  return { cdpUrl, close };
}
