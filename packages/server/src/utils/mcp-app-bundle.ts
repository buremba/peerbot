import { createHash } from 'node:crypto';
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
const ORIGIN_PLACEHOLDER = '__LOBU_MCP_APP_ORIGIN__';
const SAFE_ASSET_PATH = /^assets\/[A-Za-z0-9._-]+\.(?:css|js)$/;

// Shared by the template read and the asset reads below, so it stays keyed by
// a path relative to the app's dist dir.
function bundleFileCandidates(appDir: string, relPath: string): string[] {
  const rel = path.join('dist-mcp-apps', appDir, relPath);
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
const assetCache = new Map<string, McpAppAsset>();

const HEAD_OPEN = /<head(?:\s[^>]*)?>/i;
const HEAD_CLOSE = /<\/head\s*>/i;
// `src="./assets/app.js?v=…"` / `href="assets/app.css?v=…"`, either spelling.
const RELATIVE_ASSET_URL = /(\s(?:src|href)=")(?:\.\/)?(assets\/[^"]*)(")/gi;

/** One built asset plus the content digest its template URL pins it by. */
export interface McpAppAsset {
  bytes: Uint8Array;
  version: string;
}

/**
 * The `?v=` owletto stamps onto each asset URL: the first 16 hex characters of
 * the content's SHA-256 (`scripts/version-mcp-app-assets.mjs`). Recomputing it
 * here is what lets the asset route tell "the build this caller was served" from
 * "whatever build this replica happens to be running".
 */
export function mcpAppAssetVersion(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/**
 * Rewrite the template's relative asset URLs to absolute ones on our origin.
 *
 * A `<base href>` would express the same thing in one tag, and used to. It does
 * not survive an MCP host: Claude renders the app inside a sandbox document
 * served with `base-uri 'self'` (measured — the host honours `resourceDomains`
 * and `connectDomains` from `_meta.ui.csp` but never `baseUriDomains`), so the
 * browser drops the `<base>` element and every relative URL resolves against
 * the sandbox origin instead of ours. Those requests 404 on the host, no
 * request ever reaches us to explain it, and the widget paints blank.
 *
 * Absolute URLs need only `script-src`/`style-src` to name our origin, which is
 * exactly what `resourceDomains` buys, so they work on every host a `<base>`
 * worked on and on Claude besides.
 *
 * Rewriting is scoped to the `<head>` element on purpose: the pattern also
 * matches attribute-shaped text inside an inline script or a comment elsewhere
 * in the document, and rewriting that would corrupt it.
 */
export function withAbsoluteAssetUrls(html: string, assetBase: string): string {
  const headOpen = HEAD_OPEN.exec(html);
  if (!headOpen) return html;
  const headStart = headOpen.index + headOpen[0].length;
  const rest = html.slice(headStart);
  const headClose = HEAD_CLOSE.exec(rest);
  const headEnd = headClose ? headClose.index : rest.length;
  // A quote in the origin would otherwise close the attribute and let the rest
  // of it be read as markup.
  const base = assetBase.replaceAll('"', '%22');
  const head = rest
    .slice(0, headEnd)
    .replace(
      RELATIVE_ASSET_URL,
      (_match, lead: string, assetPath: string, tail: string) =>
        `${lead}${base}${assetPath}${tail}`
    );
  return `${html.slice(0, headStart)}${head}${rest.slice(headEnd)}`;
}

/** Read a built MCP App bundle's HTML. Returns null when no build is present. */
async function readMcpAppBundle(appDir: string): Promise<string | null> {
  const cached = bundleCache.get(appDir);
  if (cached !== undefined) return cached;
  for (const candidate of bundleFileCandidates(appDir, 'index.html')) {
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

/**
 * Render the current external-asset template for a remote MCP host. The raw
 * HTML stays cached per app dir; request-specific origins are stamped only
 * after the cache read so one tenant/request cannot contaminate another.
 */
export async function renderMcpAppTemplate(
  appDir: string,
  publicOrigin: string
): Promise<string | null> {
  const html = await readMcpAppBundle(appDir);
  if (html == null) return null;

  const assetBase = `${publicOrigin}/mcp-apps/${encodeURIComponent(appDir)}/`;
  return withAbsoluteAssetUrls(html, assetBase).replaceAll(
    ORIGIN_PLACEHOLDER,
    publicOrigin
  );
}

/**
 * Read one stable JS/CSS asset staged for the second rollout phase, together
 * with the content digest its template URL pins it by.
 */
export async function readMcpAppAsset(
  appDir: string,
  assetPath: string
): Promise<McpAppAsset | null> {
  if (!SAFE_ASSET_PATH.test(assetPath)) return null;
  const cacheKey = `${appDir}/${assetPath}`;
  const cached = assetCache.get(cacheKey);
  if (cached !== undefined) return cached;
  for (const candidate of bundleFileCandidates(appDir, assetPath)) {
    try {
      await stat(candidate);
      const bytes = await readFile(candidate);
      const asset: McpAppAsset = {
        bytes,
        version: mcpAppAssetVersion(bytes),
      };
      assetCache.set(cacheKey, asset);
      return asset;
    } catch {
      // candidate absent — try the next
    }
  }
  return null;
}
