import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate + read a built MCP App artifact produced by owletto's
 * `build:mcp-apps`, e.g.
 * `packages/owletto/dist-mcp-apps/<appDir>/index.html`).
 *
 * Path resolution mirrors `resolveWebDistDirectory` in `index.ts` (the owletto
 * SPA dist locator): `WEB_DIST_DIR` override first, then `APP_ROOT` and `cwd`
 * siblings. `WEB_DIST_DIR` points at the owletto `dist` dir, so the MCP bundle
 * lives one level up under `dist-mcp-apps/`.
 */

// packages/server dir (mirror of APP_ROOT in index.ts).
const APP_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SAFE_BUNDLE_FILENAME = /^(?:index|legacy-v2)\.html$/;
const SAFE_ASSET_PATH = /^assets\/[A-Za-z0-9._-]+\.(?:css|js)$/;

function bundleFileCandidates(appDir: string, filename: string): string[] {
  const rel = path.join('dist-mcp-apps', appDir, filename);
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
const assetCache = new Map<string, Uint8Array>();

/** Read a built MCP App bundle's HTML. Returns null when no build is present. */
export async function readMcpAppBundle(
  appDir: string,
  filename = 'index.html'
): Promise<string | null> {
  if (!SAFE_BUNDLE_FILENAME.test(filename)) return null;
  const cacheKey = `${appDir}/${filename}`;
  const cached = bundleCache.get(cacheKey);
  if (cached !== undefined) return cached;
  for (const candidate of bundleFileCandidates(appDir, filename)) {
    try {
      await stat(candidate);
      const html = await readFile(candidate, 'utf8');
      bundleCache.set(cacheKey, html);
      return html;
    } catch {
      // candidate absent — try the next
    }
  }
  return null;
}

/** Read one stable JS/CSS asset staged for the second rollout phase. */
export async function readMcpAppAsset(
  appDir: string,
  assetPath: string
): Promise<Uint8Array | null> {
  if (!SAFE_ASSET_PATH.test(assetPath)) return null;
  const cacheKey = `${appDir}/${assetPath}`;
  const cached = assetCache.get(cacheKey);
  if (cached !== undefined) return cached;
  for (const candidate of bundleFileCandidates(appDir, assetPath)) {
    try {
      await stat(candidate);
      const asset = await readFile(candidate);
      assetCache.set(cacheKey, asset);
      return asset;
    } catch {
      // candidate absent — try the next
    }
  }
  return null;
}
