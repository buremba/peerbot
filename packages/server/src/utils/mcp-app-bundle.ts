import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate + read a built MCP App bundle (a self-contained `ui://` iframe payload
 * produced by owletto's `build:mcp-apps`, e.g.
 * `packages/owletto/dist-mcp-apps/<appDir>/index.html`).
 *
 * Path resolution mirrors `resolveWebDistDirectory` in `index.ts` (the owletto
 * SPA dist locator): `WEB_DIST_DIR` override first, then `APP_ROOT` and `cwd`
 * siblings. `WEB_DIST_DIR` points at the owletto `dist` dir, so the MCP bundle
 * lives one level up under `dist-mcp-apps/`.
 */

// packages/server dir (mirror of APP_ROOT in index.ts).
const APP_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function bundleCandidates(appDir: string): string[] {
  const rel = path.join('dist-mcp-apps', appDir, 'index.html');
  const webDist = process.env.WEB_DIST_DIR?.trim();
  return [
    webDist ? path.join(webDist, '..', rel) : undefined,
    path.resolve(APP_ROOT, 'packages/owletto', rel),
    path.resolve(APP_ROOT, '../owletto', rel),
    path.resolve(process.cwd(), 'packages/owletto', rel),
    path.resolve(process.cwd(), '../owletto', rel),
  ].filter((p): p is string => typeof p === 'string');
}

// Cache the resolved HTML per app dir — the bundle is immutable at runtime, so
// don't hit disk on every `resources/read`. Only successful reads are cached: a
// miss is NOT memoized, so a bundle built after the first request (e.g. a dev
// server that hasn't run `build:mcp-apps` yet) recovers on the next request
// instead of serving 404 until the pod restarts. Every interactive interaction
// now depends on this one bundle, so a sticky miss would break all of them.
const bundleCache = new Map<string, string>();

/** Read a built MCP App bundle's HTML. Returns null when no build is present. */
export async function readMcpAppBundle(appDir: string): Promise<string | null> {
  const cached = bundleCache.get(appDir);
  if (cached !== undefined) return cached;
  for (const candidate of bundleCandidates(appDir)) {
    try {
      await stat(candidate);
      const html = await readFile(candidate, 'utf8');
      bundleCache.set(appDir, html);
      return html;
    } catch {
      // candidate absent — try the next
    }
  }
  return null;
}
