import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  mcpAppAssetVersion,
  withAbsoluteAssetUrls,
} from '../../utils/mcp-app-bundle';

describe('mcpAppAssetVersion', () => {
  // Must stay byte-identical to owletto's scripts/version-mcp-app-assets.mjs,
  // which is what stamps `?v=` onto the template's asset URLs.
  test('matches the digest owletto stamps onto asset urls', () => {
    const bytes = new TextEncoder().encode('body { color: red }');
    expect(mcpAppAssetVersion(bytes)).toBe(
      createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    );
    expect(mcpAppAssetVersion(bytes)).toMatch(/^[a-f0-9]{16}$/);
  });

  test('separates builds that differ by a single byte', () => {
    const encoder = new TextEncoder();
    expect(mcpAppAssetVersion(encoder.encode('a'))).not.toBe(
      mcpAppAssetVersion(encoder.encode('b'))
    );
  });
});

describe('withAbsoluteAssetUrls', () => {
  const base = 'https://app.lobu.ai/mcp-apps/interaction/';
  const doc = (head: string, body = '') =>
    `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

  test('rewrites the head asset urls onto our origin', () => {
    const html = withAbsoluteAssetUrls(
      doc(
        '<script defer src="./assets/app.js?v=0123456789abcdef"></script>' +
          '<link rel="stylesheet" crossorigin href="./assets/app.css?v=fedcba9876543210">'
      ),
      base
    );
    expect(html).toContain(`src="${base}assets/app.js?v=0123456789abcdef"`);
    expect(html).toContain(`href="${base}assets/app.css?v=fedcba9876543210"`);
  });

  test('leaves no relative asset url behind', () => {
    // The whole point: one unrewritten reference resolves against the MCP
    // host's sandbox origin, 404s there, and paints a blank widget with no
    // request arriving here to explain it.
    const html = withAbsoluteAssetUrls(
      doc('<script defer src="./assets/app.js?v=0123456789abcdef"></script>'),
      base
    );
    expect(html).not.toMatch(/(?:src|href)="(?:\.\/)?assets\//);
  });

  test('rewrites a reference written without the leading ./', () => {
    const html = withAbsoluteAssetUrls(
      doc('<script defer src="assets/app.js?v=0123456789abcdef"></script>'),
      base
    );
    expect(html).toContain(`src="${base}assets/app.js?v=0123456789abcdef"`);
  });

  test('emits no base element', () => {
    // A <base href> expressed the same intent and is what this replaced. Claude
    // serves the app sandbox with `base-uri 'self'`, so the element is dropped
    // and every relative URL resolves against the host instead of us.
    const html = withAbsoluteAssetUrls(
      doc('<script defer src="./assets/app.js?v=0123456789abcdef"></script>'),
      base
    );
    expect(html).not.toContain('<base');
  });

  test('leaves attribute-shaped text in the body alone', () => {
    // Rewriting past </head> would corrupt an inline script that happens to
    // contain the same attribute shape in a string.
    const body = '<script>const tpl = \'<img src="./assets/app.js">\';</script>';
    const html = withAbsoluteAssetUrls(
      doc('<title>x</title>', body),
      base
    );
    expect(html).toContain(body);
  });

  test('bounds the head at a close tag written with trailing space', () => {
    // If `</head >` is not recognised the "head" runs to the end of the
    // document and body text gets rewritten with it.
    const body = '<img src="./assets/app.js">';
    const html = withAbsoluteAssetUrls(
      `<!doctype html><html><head><title>x</title></head ><body>${body}</body></html>`,
      base
    );
    expect(html).toContain(body);
  });

  test('honours a head opened with attributes', () => {
    const html = withAbsoluteAssetUrls(
      '<!doctype html><html><head data-build="7">' +
        '<script defer src="./assets/app.js?v=0123456789abcdef"></script></head></html>',
      base
    );
    expect(html).toContain(`src="${base}assets/app.js?v=0123456789abcdef"`);
  });

  test('never emits an unescaped quote into a rewritten url', () => {
    const html = withAbsoluteAssetUrls(
      doc('<script defer src="./assets/app.js"></script>'),
      'https://evil"onload="x/'
    );
    expect(html).toContain('src="https://evil%22onload=%22x/assets/app.js"');
  });

  test('returns the document untouched when it has no head at all', () => {
    const source = '<div>fragment</div>';
    expect(withAbsoluteAssetUrls(source, base)).toBe(source);
  });
});
