import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  LOBU_INTERACTION_RESOURCE_URI,
  MCP_APP_RESOURCE_ALIASES,
} from '../../mcp-app-resource-uris';
import {
  mcpAppAssetVersion,
  withAbsoluteAssetUrls,
} from '../../utils/mcp-app-bundle';

// Every alias as it resolved before this table was generated rather than
// hand-written, up to the v41 that was canonical then. An MCP host keeps
// requesting the resource id it first cached, so dropping one silently breaks
// that host forever — and *adding* one hands out an id we have never issued.
// Both directions are guarded below; a later URI bump only ever appends the
// version it retires, so it does not need an entry here.
const SHIPPED_ALIASES: ReadonlyArray<[string, 'embedded' | 'external']> = [
  ['ui://lobu/interaction/v1', 'embedded'],
  ['ui://lobu/interaction/v2', 'embedded'],
  ['ui://lobu/interaction/v3.html', 'external'],
  ['ui://lobu/interaction/v4.html', 'external'],
  ['ui://lobu/interaction/v5.html', 'external'],
  ['ui://lobu/interaction/v6.html', 'external'],
  ['ui://lobu/interaction/v7.html', 'embedded'],
  ['ui://lobu/interaction/v8.html', 'embedded'],
  ['ui://lobu/interaction/v9.html', 'embedded'],
  ['ui://lobu/interaction/v10.html', 'embedded'],
  ['ui://lobu/interaction/v11.html', 'embedded'],
  ['ui://lobu/interaction/v12.html', 'embedded'],
  ['ui://lobu/interaction/v13.html', 'embedded'],
  ['ui://lobu/interaction/v14.html', 'embedded'],
  ['ui://lobu/interaction/v15.html', 'embedded'],
  ['ui://lobu/interaction/v20.html', 'embedded'],
  ['ui://lobu/interaction/v21.html', 'embedded'],
  ['ui://lobu/interaction/v22.html', 'embedded'],
  ['ui://lobu/interaction/v23.html', 'embedded'],
  ['ui://lobu/interaction/v24.html', 'embedded'],
  ['ui://lobu/interaction/v25.html', 'embedded'],
  ['ui://lobu/interaction/v26.html', 'embedded'],
  ['ui://lobu/interaction/v27.html', 'embedded'],
  ['ui://lobu/interaction/v28.html', 'embedded'],
  ['ui://lobu/interaction/v29.html', 'embedded'],
  ['ui://lobu/interaction/v30.html', 'external'],
  ['ui://lobu/interaction/v31.html', 'external'],
  ['ui://lobu/interaction/v32.html', 'external'],
  ['ui://lobu/interaction/v33.html', 'external'],
  ['ui://lobu/interaction/v34.html', 'external'],
  ['ui://lobu/interaction/v35.html', 'external'],
  ['ui://lobu/interaction/v36.html', 'external'],
  ['ui://lobu/interaction/v37.html', 'external'],
  ['ui://lobu/interaction/v38.html', 'external'],
  ['ui://lobu/interaction/v39.html', 'external'],
  ['ui://lobu/interaction/v40.html', 'external'],
];

function currentCanonicalVersion(): number {
  // An unparseable URI would yield NaN, and `version < NaN` skips the loop
  // entirely — the alias assertion would silently stop covering later bumps.
  const matched = LOBU_INTERACTION_RESOURCE_URI.match(/\/v(\d+)\.html$/);
  if (!matched) {
    throw new Error(
      `unparseable canonical uri: ${LOBU_INTERACTION_RESOURCE_URI}`
    );
  }
  return Number(matched[1]);
}

describe('MCP App resource aliases', () => {
  test('keeps every shipped alias on the template it was issued with', () => {
    for (const [uri, template] of SHIPPED_ALIASES) {
      expect(MCP_APP_RESOURCE_ALIASES.get(uri)?.template).toBe(template);
    }
  });

  test('resolves the shipped set plus only the URIs later bumps retired', () => {
    const expected = new Set(SHIPPED_ALIASES.map(([uri]) => uri));
    // A bump appends exactly the URI it retires, so v41 through the version
    // before today's canonical one are the only ids that may have joined since.
    for (let version = 41; version < currentCanonicalVersion(); version += 1) {
      expected.add(`ui://lobu/interaction/v${version}.html`);
    }
    expect([...MCP_APP_RESOURCE_ALIASES.keys()].sort()).toEqual(
      [...expected].sort()
    );
  });

  test('points every alias at the current canonical template', () => {
    for (const [, alias] of MCP_APP_RESOURCE_ALIASES) {
      expect(alias.canonicalUri).toBe(LOBU_INTERACTION_RESOURCE_URI);
    }
  });

  test('leaves the never-shipped v16-v19 ids unresolvable', () => {
    for (const version of [16, 17, 18, 19]) {
      expect(
        MCP_APP_RESOURCE_ALIASES.has(`ui://lobu/interaction/v${version}.html`)
      ).toBe(false);
    }
  });

  test('does not alias the canonical uri to itself', () => {
    expect(MCP_APP_RESOURCE_ALIASES.has(LOBU_INTERACTION_RESOURCE_URI)).toBe(
      false
    );
  });
});

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
