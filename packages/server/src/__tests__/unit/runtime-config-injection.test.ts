import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { injectRuntimeConfig } from '../../public-pages';
import { __resetPublicOriginCachesForTests } from '../../utils/public-origin';

const TEMPLATE = '<html><head><title>Lobu</title></head><body><div id="root"></div></body></html>';

function readInjectedZone(html: string): string | null {
  const match = html.match(/window\.__LOBU_RUNTIME_CONFIG__=(\{.*?\});/);
  if (!match?.[1]) throw new Error(`no runtime config injected into: ${html}`);
  // Undo the script-context escaping applied by serializeForScript.
  const decoded = match[1]
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\u0026/g, '&');
  return (JSON.parse(decoded) as { subdomainZone: string | null }).subdomainZone;
}

describe('injectRuntimeConfig', () => {
  const originalCookieDomain = process.env.AUTH_COOKIE_DOMAIN;
  const originalGatewayUrl = process.env.PUBLIC_GATEWAY_URL;

  beforeEach(() => {
    delete process.env.AUTH_COOKIE_DOMAIN;
    delete process.env.PUBLIC_GATEWAY_URL;
    // PUBLIC_GATEWAY_URL is memoized on first read. Without this reset the
    // env assignments below are silently ignored once an earlier test has
    // populated the cache, and the assertions pass for the wrong reason.
    __resetPublicOriginCachesForTests();
  });

  afterEach(() => {
    if (originalCookieDomain === undefined) delete process.env.AUTH_COOKIE_DOMAIN;
    else process.env.AUTH_COOKIE_DOMAIN = originalCookieDomain;
    if (originalGatewayUrl === undefined) delete process.env.PUBLIC_GATEWAY_URL;
    else process.env.PUBLIC_GATEWAY_URL = originalGatewayUrl;
  });

  // lobu#2183: an unconfigured self-host must declare NO zone, so the SPA stays
  // on path-based /{org} routing instead of guessing one from the hostname.
  it('declares a null zone when nothing is configured', () => {
    expect(readInjectedZone(injectRuntimeConfig(TEMPLATE))).toBeNull();
  });

  it('declares the AUTH_COOKIE_DOMAIN zone when set', () => {
    process.env.AUTH_COOKIE_DOMAIN = '.lobu.ai';
    __resetPublicOriginCachesForTests();
    expect(readInjectedZone(injectRuntimeConfig(TEMPLATE))).toBe('lobu.ai');
  });

  // A path-based self-host still sets PUBLIC_GATEWAY_URL. Deriving the zone
  // from it would re-enable per-org subdomains nobody asked for — the same
  // class of bug as the old hostname heuristic (lobu#2183).
  it('does not enable subdomains from PUBLIC_GATEWAY_URL alone', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
    __resetPublicOriginCachesForTests();
    expect(readInjectedZone(injectRuntimeConfig(TEMPLATE))).toBeNull();
  });

  // Vite emits the app bundle INSIDE <head>, so injecting at `</head>` lands
  // after it. Assert against a head-script shell — the toy body-only template
  // passed while the real dist/index.html did not.
  it('injects before an app bundle that lives in the head', () => {
    const viteShell =
      '<html><head><meta charset="utf-8" />' +
      '<script type="module" crossorigin src="/assets/index-abc.js"></script>' +
      '</head><body><div id="root"></div></body></html>';
    const html = injectRuntimeConfig(viteShell);
    expect(html.indexOf('__LOBU_RUNTIME_CONFIG__')).toBeLessThan(
      html.indexOf('type="module"')
    );
  });

  it('still injects into a template with no head', () => {
    expect(readInjectedZone(injectRuntimeConfig('<div id="root"></div>'))).toBeNull();
  });

  it('never emits a zone that breaks out of the script tag', () => {
    process.env.AUTH_COOKIE_DOMAIN = '</script><script>alert(1)//';
    const html = injectRuntimeConfig(TEMPLATE);
    expect(html).not.toContain('<script>alert(1)');
    expect(readInjectedZone(html)).toBeNull();
  });
});
