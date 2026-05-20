/**
 * Free-port allocation for tests.
 *
 * Test harnesses used to pick a random high port and "fail loud on collision"
 * (embedded-postgres-backend.ts, proxy-hardening.test.ts). Under concurrent
 * `bun test` / vitest load that surfaces as intermittent `EADDRINUSE` — a pure
 * flake, not a real failure (issue #976). Asking the OS for a port (bind :0)
 * and retrying on collision shrinks the window to near-zero.
 */

import net from 'node:net';

/**
 * Bind `:0` on `host`, read the OS-assigned port, close, and return it. There
 * is an unavoidable TOCTOU gap between this close and the caller's own bind —
 * pair with `withFreePortRetry` when the caller needs a concrete port up front.
 */
export function getFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Run `fn` with an OS-assigned free port, retrying on `EADDRINUSE` with a fresh
 * port to cover the TOCTOU gap between selection and bind. Any other error
 * propagates immediately.
 */
export async function withFreePortRetry<T>(
  fn: (port: number) => Promise<T>,
  attempts = 5,
  host = '127.0.0.1',
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const port = await getFreePort(host);
    try {
      return await fn(port);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error('withFreePortRetry: exhausted attempts without binding');
}
