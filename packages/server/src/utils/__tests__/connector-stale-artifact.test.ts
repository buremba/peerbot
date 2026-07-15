/**
 * Reproducer for the stale-compiled-connector-bundle outage (prod 2026-07-15,
 * run 634620): `connector_versions.compiled_code` is keyed only by
 * (connector_key, version) — nothing recorded WHICH compile configuration
 * (EXTERNAL_RUNTIME_DEPS / pipeline) produced the artifact. When `pino` was
 * removed from the externals list (#444) and the runtime image stopped
 * shipping it, artifacts compiled in the pino-external era kept executing
 * verbatim and crashed with ERR_MODULE_NOT_FOUND
 * ("Connector requires 'pino' but it's not installed in the runtime image").
 *
 * Contract under test: resolveConnectorCode must never hand out an artifact
 * whose compile-config fingerprint doesn't match the current pipeline — it
 * must recompile from the stored source (and persist the fresh artifact so
 * every replica sees it) or fall back to the bundled on-disk source.
 */
import {
  COMPILE_CONFIG_HASH,
  computeCompileConfigHash,
  EXTERNAL_RUNTIME_DEPS,
} from '@lobu/connector-worker/compile';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// A bundle from the "pino is external" era: pino left as a bare import that
// the current runtime image no longer ships.
const STALE_BUNDLE = [
  'import pino from "pino";',
  'export default class StaleEraConnector {',
  '  async sync() { return {}; }',
  '  async execute() { return {}; }',
  '}',
  '',
].join('\n');

// The connector's stored TypeScript source (connector_versions.source_code).
// Under the CURRENT compile config, pino-like pure-JS deps are bundled, so a
// recompile of this source yields a self-contained artifact.
const STORED_SOURCE = `
export default class StaleProbeConnector {
  definition = { key: 'zz.staleprobe', name: 'Stale Probe', version: '1.0.0' };
  marker(): string { return 'RECOMPILED_FROM_SOURCE_MARKER'; }
  async sync() { return { events: [], checkpoint: null }; }
  async execute() { return {}; }
}
`;

type LoggedQuery = { text: string; params: unknown[] };

const queries: LoggedQuery[] = [];
let storedSourceCode: string | null = STORED_SOURCE;

function fakeSql(strings: TemplateStringsArray, ...params: unknown[]): Promise<unknown[]> {
  const text = strings.join('?').replace(/\s+/g, ' ').trim();
  queries.push({ text, params });
  if (/SELECT source_code FROM connector_versions/i.test(text)) {
    return Promise.resolve(storedSourceCode === null ? [] : [{ source_code: storedSourceCode }]);
  }
  return Promise.resolve([]);
}

beforeEach(() => {
  queries.length = 0;
  storedSourceCode = STORED_SOURCE;
  vi.resetModules();
  vi.doMock('../../db/client', () => ({ getDb: () => fakeSql }));
});

describe('resolveConnectorCode compile-config staleness', () => {
  test('artifact compiled under a different externals config is NOT executed verbatim — recompiled from stored source and persisted', async () => {
    const { resolveConnectorCode } = await import('../ensure-connector-installed');

    // Same stored row prod hands the resolver today: a compiled artifact from
    // the old-externals era (legacy rows have compile_config_hash NULL).
    // 'zz.staleprobe' has no bundled source on disk, so the ONLY valid escape
    // hatch is recompiling connector_versions.source_code.
    const code = await resolveConnectorCode('zz.staleprobe', {
      version: '1.0.0',
      compiled_code: STALE_BUNDLE,
      compile_config_hash: null,
    });

    // The stale artifact imports pino as a bare specifier — executing it is the
    // prod outage. The resolver must return a recompile of the stored source.
    expect(code).not.toContain('from "pino"');
    expect(code).toContain('RECOMPILED_FROM_SOURCE_MARKER');

    // The fresh artifact must be persisted with the current fingerprint
    // (Postgres-mediated self-heal — every replica converges).
    const update = queries.find((q) => /UPDATE connector_versions/i.test(q.text));
    expect(update).toBeDefined();
    expect(update!.params).toContain(COMPILE_CONFIG_HASH);
  });

  test('artifact with the current compile-config fingerprint is returned verbatim, no recompile', async () => {
    const { resolveConnectorCode } = await import('../ensure-connector-installed');

    const code = await resolveConnectorCode('zz.staleprobe', {
      version: '1.0.0',
      compiled_code: STALE_BUNDLE,
      compile_config_hash: COMPILE_CONFIG_HASH,
    });

    expect(code).toBe(STALE_BUNDLE);
    expect(queries).toHaveLength(0);
  });

  test('normalizing a PRE-COMPILED upload is idempotent — no duplicate __createRequire shim (sdk-e2e regression)', async () => {
    // A `compiled: true` upload (lobu apply, device reconcile) stores the
    // artifact itself in source_code with a NULL fingerprint, so first
    // resolution recompiles THAT artifact. The compile must strip its own CJS
    // shim banner before re-adding it — the double declaration is exactly the
    // "Identifier '__createRequire' has already been declared" sdk-e2e failure.
    const { compileConnectorSource } = await import('../connector-compiler');
    const precompiled = await compileConnectorSource(STORED_SOURCE);
    storedSourceCode = precompiled.compiledCode;

    const { resolveConnectorCode } = await import('../ensure-connector-installed');
    const code = await resolveConnectorCode('zz.staleprobe', {
      version: '1.0.0',
      compiled_code: precompiled.compiledCode,
      compile_config_hash: null,
    });

    const shimDeclarations = code.match(/createRequire as __createRequire/g) ?? [];
    expect(shimDeclarations).toHaveLength(1);
    expect(code).toContain('RECOMPILED_FROM_SOURCE_MARKER');
  });

  test('stale artifact with no stored source and no bundled file fails loudly instead of executing', async () => {
    const { resolveConnectorCode } = await import('../ensure-connector-installed');
    storedSourceCode = null;

    await expect(
      resolveConnectorCode('zz.staleprobe', {
        version: '1.0.0',
        compiled_code: STALE_BUNDLE,
        compile_config_hash: 'fingerprint-of-a-previous-pipeline',
      })
    ).rejects.toThrow(/predates the current compile configuration/);
  });

  test('changing the externals list changes the fingerprint (the invalidation trigger)', () => {
    // The pino-era config would have carried a different fingerprint, so its
    // artifacts can never be mistaken for current ones.
    const pinoEra = computeCompileConfigHash([...EXTERNAL_RUNTIME_DEPS, 'pino']);
    expect(pinoEra).not.toBe(COMPILE_CONFIG_HASH);
  });
});

describe('install-time compile-config provenance', () => {
  // A pre-compiled artifact from an OLDER client (e.g. a CLI whose externals
  // list still had pino): the server pipeline never compiled it, so it must
  // NOT be attested with the current fingerprint — otherwise it would reach
  // the resolver fast path and ship its stale bare imports to workers.
  const PRE_COMPILED_UPLOAD = [
    'import { createRequire as __createRequire } from "module"; const require = __createRequire(import.meta.url);',
    'export default class OldCliConnector {',
    "  definition = { key: 'zz.oldcli', name: 'Old CLI Probe', version: '1.0.0' };",
    '  async sync() { return { events: [], checkpoint: null }; }',
    '  async execute() { return {}; }',
    '}',
    '',
  ].join('\n');

  const TS_SOURCE = `
export default class FreshInstallConnector {
  definition = { key: 'zz.freshinstall', name: 'Fresh Install Probe', version: '1.0.0' };
  async sync() { return { events: [], checkpoint: null }; }
  async execute() { return {}; }
}
`;

  test('compiled:true uploads are stored WITHOUT the current fingerprint (normalized on first resolution)', async () => {
    const { resolveConnectorInstallSource } = await import('../connector-definition-install');

    const resolved = await resolveConnectorInstallSource({
      sourceCode: PRE_COMPILED_UPLOAD,
      compiled: true,
    });

    expect(resolved.compiledCode).toBe(PRE_COMPILED_UPLOAD);
    expect(resolved.compileConfigHash).toBeNull();
  });

  test('pipeline-compiled installs are stamped with the current fingerprint', async () => {
    const { resolveConnectorInstallSource } = await import('../connector-definition-install');

    const resolved = await resolveConnectorInstallSource({ sourceCode: TS_SOURCE });

    expect(resolved.compileConfigHash).toBe(COMPILE_CONFIG_HASH);
  });
});
