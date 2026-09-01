import { describe, expect, test } from 'bun:test';
import type { Plugin } from 'esbuild';
import { compileSource, SourceCompileError } from '../compiler-core';

/**
 * #2043 — dependency restrictions must apply only to real module declarations
 * parsed from the source AST. Dependency-like text inside strings, template
 * literals, comments, or Markdown bodies is data and must never fail
 * compilation; real forbidden imports must still be rejected with a source
 * location.
 */

const CONFIG = {
  tmpPrefix: '.test-compile-',
  label: 'ExecuteCompiler',
  buildOptions: {
    format: 'cjs' as const,
    target: 'esnext' as const,
    platform: 'node' as const,
    external: [],
  },
};

async function compileOk(source: string): Promise<string> {
  const { compiledCode } = await compileSource(source, CONFIG);
  return compiledCode;
}

async function compileErr(source: string): Promise<string> {
  try {
    await compileSource(source, CONFIG);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected compilation to fail');
}

describe('compileSource import validation (#2043)', () => {
  test('marks source diagnostics but not esbuild output failures', async () => {
    await expect(compileSource('export default = ;', CONFIG)).rejects.toBeInstanceOf(
      SourceCompileError
    );

    const outputFailure = compileSource('export default 1;', {
      ...CONFIG,
      buildOptions: { ...CONFIG.buildOptions, outfile: process.cwd() },
    });
    await expect(outputFailure).rejects.not.toBeInstanceOf(SourceCompileError);
  });

  test('does not mark located plugin infrastructure failures as source errors', async () => {
    const brokenPlugin: Plugin = {
      name: 'broken-test-plugin',
      setup(build) {
        build.onResolve({ filter: /^broken$/ }, () => {
          throw new Error('plugin infrastructure failed');
        });
      },
    };
    const pluginFailure = compileSource(`import value from 'broken'; export default value;`, {
      ...CONFIG,
      buildOptions: { ...CONFIG.buildOptions, plugins: [brokenPlugin] },
    });

    await expect(pluginFailure).rejects.not.toBeInstanceOf(SourceCompileError);
  });

  test('rejects a real relative import with a source location', async () => {
    const message = await compileErr(
      `import { sleep } from './scraper-utils.ts';\nexport default sleep;`
    );
    expect(message).toContain('Unsupported import "./scraper-utils.ts"');
    expect(message).toContain('source.ts:1:22');
  });

  test('rejects parent-relative, alias, and absolute imports', async () => {
    expect(await compileErr(`import x from '../lib/x.ts';\nexport default x;`)).toContain(
      'Unsupported import "../lib/x.ts"'
    );
    expect(await compileErr(`import x from '@/lib/x.ts';\nexport default x;`)).toContain(
      'Unsupported import "@/lib/x.ts"'
    );
    expect(await compileErr(`import x from '/etc/config.json';\nexport default x;`)).toContain(
      'Unsupported import "/etc/config.json"'
    );
  });

  test('rejects real side-effect and dynamic relative imports', async () => {
    expect(await compileErr(`import './side-effect.ts';\nexport default 1;`)).toContain(
      'Unsupported import "./side-effect.ts"'
    );
    expect(
      await compileErr(`export default async () => (await import('./lazy.ts')).default;`)
    ).toContain('Unsupported import "./lazy.ts"');
  });

  test('accepts dependency-like text inside single- and double-quoted strings', async () => {
    await compileOk(
      `const a = "import { sleep } from './scraper-utils.ts';";\n` +
        `const b = 'relative dependency on scraper-utils.ts is unsupported';\n` +
        `export default { a, b };`
    );
  });

  test('accepts dependency-like text inside template literals (incl. multiline)', async () => {
    await compileOk(
      'const t = `line one\nimport { delay } from "../scraper-utils.ts";\nline three`;\n' +
        'export default t;'
    );
  });

  test('accepts dependency-like text inside line and block comments', async () => {
    await compileOk(
      `// import { x } from './not-real.ts';\n` +
        `/* import y from '../also-not-real.ts'; */\n` +
        `export default 1;`
    );
  });

  test('accepts escaped quotes around dependency-like text', async () => {
    await compileOk(
      `const s = 'it\\'s fine: import z from "./z.ts"';\n` +
        `const d = "escaped \\" then import w from './w.ts'";\n` +
        `export default { s, d };`
    );
  });

  test('accepts Markdown bodies with import examples carried in strings', async () => {
    await compileOk(
      'const issueBody = "## Bug\\n' +
        '```ts\\n' +
        "import { sleep } from './scraper-utils.ts';\\n" +
        '```\\n' +
        'ConnectorCompiler rejects relative connector dependencies.";\n' +
        'export default issueBody;'
    );
  });

  test('does not rewrite npm: specifiers appearing inside string data', async () => {
    const compiled = await compileOk(
      `const pkg = "npm:left-pad@1.3.0";\nexport default pkg;`
    );
    expect(compiled).toContain('npm:left-pad@1.3.0');
  });

  test('rejects a real npm: import of a non-installed package', async () => {
    const message = await compileErr(
      `import missing from 'npm:this-package-does-not-exist-lobu@1.0.0';\nexport default missing;`
    );
    expect(message).toContain('Could not resolve');
  });
});

/**
 * The SDK is mapped by an onResolve plugin, not an esbuild `alias`. `alias`
 * substitutes by PREFIX, so pointing it at the package's entry FILE turned any
 * subpath into a path *under* that file (`.../dist/index.js/ip-reachability`).
 * Subpaths also cannot go through `require.resolve`: the SDK is
 * `"type": "module"` and its subpath exports declare only an `import`
 * condition, so the CJS resolver skips them.
 */
describe('connector SDK resolution', () => {
  test('resolves the SDK root', async () => {
    const code = await compileOk(
      "import { validatePublicUrl } from '@lobu/connector-sdk';\nexport default () => validatePublicUrl;"
    );
    expect(code.length).toBeGreaterThan(0);
  });

  test('resolves the `lobu` alias to the same package', async () => {
    const code = await compileOk(
      "import { validatePublicUrl } from 'lobu';\nexport default () => validatePublicUrl;"
    );
    expect(code.length).toBeGreaterThan(0);
  });

  test('resolves an SDK subpath export', async () => {
    const code = await compileOk(
      "import { isReservedIp } from '@lobu/connector-sdk/ip-reachability';\nexport default () => isReservedIp('127.0.0.1');"
    );
    // Bundled, not left as a bare import, and genuinely the classifier module.
    // Assert on values that survive bundling: esbuild folds the hex hextet
    // literals to decimal and strips comments.
    expect(code).not.toContain('@lobu/connector-sdk/ip-reachability');
    expect(code).toContain('RESERVED_IPV4_RANGES');
    expect(code).toContain('169.254.0.0');
  });

  test('reports an unknown SDK subpath instead of emitting a broken path', async () => {
    const message = await compileErr(
      "import x from '@lobu/connector-sdk/not-a-real-subpath';\nexport default () => x;"
    );
    expect(message).toContain('Cannot resolve');
    expect(message).not.toContain('dist/index.js/not-a-real-subpath');
  });
});
