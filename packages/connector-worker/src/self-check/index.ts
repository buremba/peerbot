/**
 * Connector runtime parity self-check.
 *
 * SHARED, SINGLE-SOURCE artifact/packaging self-check executed from BOTH the
 * built CLI runtime (`lobu connector runtime-self-check`) and the actual worker
 * Docker image (`bun src/bin.ts self-check`). The parity invariant is that both
 * entrypoints call THIS function — same checks, same `executeCompiledConnector`
 * (default `SubprocessExecutor`) path. The only permitted difference is the set
 * of connector-source discovery roots, since those are genuinely
 * environment-specific (monorepo `packages/connectors/src` vs the worker image's
 * `/app/packages/connectors/src` vs an npm-installed CLI's bundled
 * `dist/connectors`).
 *
 * ─── Why this exists (incident) ──────────────────────────────────────────────
 * The worker Docker image shipped to prod missing `COPY packages/core`, so
 * `@lobu/connector-sdk`'s transitive `@lobu/core` import dangled and every
 * connector feed sync crashed with `ENOENT reading
 * .../connector-sdk/node_modules/@lobu/core`. ALL CI was green because the
 * workspace tests resolve `@lobu/core` fine, and the image-build workflow builds
 * + pushes images but never RUNS them. (Fixed by a one-line COPY.) This gate
 * prevents that class of packaging/parity drift by RUNNING the built artifact
 * and asserting the resolution graph holds.
 *
 * ─── What it asserts (artifact/packaging facts ONLY) ─────────────────────────
 *   1. `@lobu/connector-sdk` resolves + imports.
 *   2. `@lobu/core` resolves + imports through the SAME runtime resolver — the
 *      exact dangling-symlink bug that broke prod.
 *   3. Every `EXTERNAL_RUNTIME_DEPS` package (playwright/patchright, sharp, jimp)
 *      is resolvable.
 *   4. The bundled connector source directory is present + discoverable.
 *   5. All discovered connector definitions instantiate, each has `key` / `name`
 *      / `version`, and keys are unique.
 *   6. A SYNTHETIC no-op connector compiles via the real `compileConnectorFromFile`
 *      path AND executes through `executeCompiledConnector` using the DEFAULT
 *      `SubprocessExecutor` (no custom executor) — proving compile + fork +
 *      child-runner + SDK-externalized-runtime-resolution all line up.
 *
 * ─── What it does NOT do ─────────────────────────────────────────────────────
 * No network, DB, gateway, OAuth. It asserts no event content, no checkpoint
 * semantics, and re-runs no business logic. It must pass under
 * `docker run --network=none`.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createConnectorCompiler,
  EXTERNAL_RUNTIME_DEPS,
} from '../compile/index.js';
import type { ExecutorJob } from '../executor/interface.js';
import { executeCompiledConnector } from '../executor/runtime.js';

/**
 * Synthetic no-op connector source, kept inline so the self-check is fully
 * self-contained: it ships identically in the worker image (runs from `src/`)
 * and the built/published CLI (runs from `dist/`) with no extra build copy of a
 * `.ts` fixture. It is NOT a real bundled connector — it lives nowhere the
 * catalog scans. It emits exactly one synthetic event and a deterministic
 * checkpoint and touches no network/DB/filesystem, so it passes under
 * `--network=none`. Compiled through the SAME `compileConnectorFromFile` path
 * (SDK externalized) and run through the DEFAULT `SubprocessExecutor`, it proves
 * compile + fork + child-runner + runtime SDK resolution all line up.
 */
const SYNTHETIC_CONNECTOR_SOURCE = `
import { ConnectorRuntime } from '@lobu/connector-sdk';

export default class SelfCheckNoopConnector extends ConnectorRuntime {
  definition = {
    key: 'self_check_noop',
    name: 'Self-Check No-Op',
    description: 'Synthetic connector for the connector-runtime self-check.',
    version: '0.0.0',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      noop: { key: 'noop', name: 'No-Op', description: 'Emits one synthetic event.', configSchema: { type: 'object', properties: {} }, eventKinds: {} },
    },
  };

  async sync() {
    return {
      events: [
        {
          origin_id: 'self-check-noop-1',
          semantic_type: 'observation',
          occurred_at: new Date(0),
          payload_text: 'self-check noop event',
        },
      ],
      checkpoint: { ran: true },
      metadata: { items_found: 1, items_skipped: 0 },
    };
  }
}
`;

export interface SelfCheckEntry {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SelfCheckResult {
  ok: boolean;
  /** Which side ran the check — for log/parity-debugging only. */
  surface: 'cli' | 'worker' | 'unknown';
  connectorSourceDir: string | null;
  connectorCount: number;
  checks: SelfCheckEntry[];
}

export interface SelfCheckOptions {
  /**
   * Connector-source discovery roots, highest priority first. Each side passes
   * its own (worker image layout vs npm-installed CLI layout); the first
   * existing directory wins. When omitted, a default candidate list rooted at
   * this module's location is used (covers the monorepo + worker image).
   */
  connectorSourceCandidates?: readonly string[];
  /** Label recorded on the result so logs say which entrypoint ran. */
  surface?: SelfCheckResult['surface'];
}

const HERE = fileURLToPath(new URL('.', import.meta.url));

// Default connector-source discovery roots. Mirrors the worker-side resolver in
// `compile-connector.ts` (kept in sync deliberately — both find the bundled
// `packages/connectors/src`). This module lives at
// `packages/connector-worker/{src,dist}/self-check/`, so the same three-ups
// reach `packages/connectors/src` from both the TS source and the built dist
// (and from `/app/packages/connector-worker/dist/self-check/` in the worker
// image).
const DEFAULT_CONNECTOR_SOURCE_CANDIDATES: readonly string[] = [
  // Monorepo source + built dist + worker image:
  //   {src,dist}/self-check/ → ../../../connectors/src.
  resolve(HERE, '../../../connectors/src'),
  resolve(HERE, '../../../connectors/dist'),
  // Embedded CLI install (`npx @lobu/cli`): the bundled connector-worker code
  // and the connectors directory ship side-by-side under the CLI's dist.
  resolve(HERE, '../connectors'),
  resolve(HERE, 'connectors'),
  // Project-root fallbacks for custom runtimes.
  resolve(process.cwd(), 'packages/connectors/src'),
  resolve(process.cwd(), 'connectors'),
];

function firstExistingDir(candidates: readonly string[]): string | null {
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Write `content` to a temp file UNDER cwd, run `fn` against it, then remove it.
 * Under cwd (not the OS tmpdir) so the file's bare imports — chiefly the
 * externalized `@lobu/connector-sdk` left bare in the compiled bundle — resolve
 * via the runtime's local `node_modules`. This is the same reason
 * `child-runner.ts` writes the connector module under cwd. The random suffix
 * avoids collisions; the leading dot keeps it out of casual `ls`.
 */
async function withCwdTempFile<T>(
  ext: string,
  content: string,
  fn: (filePath: string) => Promise<T>
): Promise<T> {
  const filePath = join(
    process.cwd(),
    `.lobu-self-check-${process.pid}-${randomBytes(8).toString('hex')}${ext}`
  );
  await writeFile(filePath, content, {
    encoding: 'utf-8',
    flag: 'wx',
    mode: 0o600,
  });
  try {
    return await fn(filePath);
  } finally {
    await rm(filePath, { force: true });
  }
}

/**
 * One-level-deep scan for connector source files. Mirrors the server catalog's
 * `collectConnectorSourceFiles` so the self-check covers exactly the set the
 * runtime catalog would scan: top-level `*.ts` plus one subdir level (for
 * primitive groupings like `browser/*.ts`), skipping `__tests__`, `_`-prefixed
 * dirs, `.d.ts`, and the non-connector `index.ts` / utility files (those simply
 * carry no ConnectorRuntime class and are filtered out after compile).
 */
async function collectConnectorSourceFiles(dirPath: string): Promise<string[]> {
  const paths: string[] = [];
  const top = await readdir(dirPath, { withFileTypes: true });
  for (const entry of top.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = resolve(dirPath, entry.name);
    if (entry.isFile()) {
      if (extname(entry.name) !== '.ts' || entry.name.endsWith('.d.ts'))
        continue;
      paths.push(entryPath);
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name.startsWith('_')) continue;
      try {
        const sub = await readdir(entryPath, { withFileTypes: true });
        for (const s of sub.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!s.isFile()) continue;
          if (extname(s.name) !== '.ts' || s.name.endsWith('.d.ts')) continue;
          paths.push(resolve(entryPath, s.name));
        }
      } catch {
        // Subdir unreadable — skip; don't fail the whole scan.
      }
    }
  }
  return paths;
}

function findConnectorRuntimeClass(
  mod: Record<string, unknown>
): (new () => unknown) | null {
  const looksLikeConnector = (val: unknown): val is new () => unknown =>
    typeof val === 'function' &&
    // biome-ignore lint/suspicious/noExplicitAny: duck-typing the runtime contract
    !!(val as any).prototype?.sync &&
    // biome-ignore lint/suspicious/noExplicitAny: duck-typing the runtime contract
    !!(val as any).prototype?.execute;

  for (const val of Object.values(mod)) {
    if (looksLikeConnector(val)) return val;
  }
  if (looksLikeConnector((mod as { default?: unknown }).default)) {
    return (mod as { default: new () => unknown }).default;
  }
  return null;
}

interface DiscoveredConnector {
  sourcePath: string;
  key: string;
  name: string;
  version: string;
}

/**
 * Compile a connector source file, import the resulting bundle in-process, and
 * read its `definition`. Importing a runtime-compiled bundle string is
 * inherently dynamic — this is the SAME established pattern the executor's
 * `child-runner.ts` uses (`await import(pathToFileURL(tmpFile))`), not a new
 * dynamic-import codepath introduced for this check. Returns `null` for files
 * that carry no ConnectorRuntime class (index/util files).
 */
async function instantiateConnector(
  sourcePath: string,
  compile: (filePath: string) => Promise<string>
): Promise<DiscoveredConnector | null> {
  const compiled = await compile(sourcePath);
  return withCwdTempFile('.mjs', compiled, async (tmpFile) => {
    // Inherent dynamic import of a runtime-compiled bundle — see doc comment.
    const mod = (await import(pathToFileURL(tmpFile).href)) as Record<
      string,
      unknown
    >;
    const RuntimeClass = findConnectorRuntimeClass(mod);
    if (!RuntimeClass) return null;
    const instance = new RuntimeClass() as {
      definition?: Record<string, unknown>;
    };
    const def = instance.definition;
    if (!def || typeof def !== 'object') {
      throw new Error('ConnectorRuntime class exposes no `definition`.');
    }
    const key = typeof def.key === 'string' ? def.key : '';
    const name = typeof def.name === 'string' ? def.name : '';
    const version = typeof def.version === 'string' ? def.version : '';
    if (!key) throw new Error('definition.key is missing.');
    if (!name) throw new Error('definition.name is missing.');
    if (!version) throw new Error('definition.version is missing.');
    return { sourcePath, key, name, version };
  });
}

/**
 * Run the synthetic no-op connector through the real compile + default
 * `SubprocessExecutor` path. Returns nothing on success; throws on any failure
 * so the caller records a failed check.
 */
async function runSyntheticConnector(
  compile: (filePath: string) => Promise<string>
): Promise<void> {
  // Compile the inline synthetic source through the real `compileConnectorFromFile`
  // path (esbuild entry must be a file, so stage it in a temp `.ts` under cwd).
  const compiled = await withCwdTempFile(
    '.ts',
    SYNTHETIC_CONNECTOR_SOURCE,
    (fixturePath) => compile(fixturePath)
  );

  const job: ExecutorJob = {
    mode: 'sync',
    feedKey: 'noop',
    config: {},
    checkpoint: null,
    entityIds: [],
    credentials: null,
    sessionState: null,
    // Empty env — the fixture needs nothing, and an empty env keeps the child
    // hermetic (no inherited host secrets, consistent with --network=none).
    env: {},
  };

  let eventCount = 0;
  // No custom executor — `executeCompiledConnector` defaults to the real
  // `SubprocessExecutor`, the exact fork-isolated path prod uses.
  const result = await executeCompiledConnector({
    compiledCode: compiled,
    job,
    hooks: {
      onEventChunk: (events) => {
        eventCount += events.length;
      },
    },
  });

  if (result.mode !== 'sync') {
    throw new Error(
      `Expected sync result from synthetic connector, got mode=${result.mode}.`
    );
  }
  if (eventCount < 1) {
    throw new Error(
      'Synthetic connector ran but emitted no events — the compile/subprocess event stream is broken.'
    );
  }
}

/**
 * Execute the shared connector-runtime parity self-check. Never throws on a
 * failed assertion — failures are recorded as `{ ok: false }` entries and the
 * top-level `ok` is the AND of every check. (It can still throw on a truly
 * unexpected internal error, which the caller treats as a failure too.)
 */
export async function runConnectorRuntimeSelfCheck(
  opts?: SelfCheckOptions
): Promise<SelfCheckResult> {
  const checks: SelfCheckEntry[] = [];
  const require_ = createRequire(import.meta.url);

  const record = (name: string, fn: () => void): void => {
    try {
      fn();
      checks.push({ name, ok: true, detail: 'ok' });
    } catch (err) {
      checks.push({
        name,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // 1 + 2: the resolution graph that broke prod. Resolve AND import each so a
  // dangling symlink (resolvable path, missing target) is caught too.
  record('resolve:@lobu/connector-sdk', () => {
    require_.resolve('@lobu/connector-sdk');
  });
  await (async () => {
    try {
      await import('@lobu/connector-sdk');
      checks.push({
        name: 'import:@lobu/connector-sdk',
        ok: true,
        detail: 'ok',
      });
    } catch (err) {
      checks.push({
        name: 'import:@lobu/connector-sdk',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  // @lobu/core is consumed by @lobu/connector-sdk (logger/retry), NOT by
  // connector-worker directly (it's not in connector-worker's deps). Resolve it
  // ANCHORED AT THE SDK — the way the SDK does — to reproduce the exact prod
  // edge that dangled: `.../connector-sdk/node_modules/@lobu/core`. Anchoring at
  // connector-worker here would be a non-contract that only resolves in the
  // hoisted dev workspace and falsely fails in the isolated-linker image.
  record('resolve:@lobu/core', () => {
    const sdkRequire = createRequire(require_.resolve('@lobu/connector-sdk'));
    sdkRequire.resolve('@lobu/core');
  });
  await (async () => {
    try {
      const sdkRequire = createRequire(require_.resolve('@lobu/connector-sdk'));
      const corePath = sdkRequire.resolve('@lobu/core');
      await import(pathToFileURL(corePath).href);
      checks.push({ name: 'import:@lobu/core', ok: true, detail: 'ok' });
    } catch (err) {
      checks.push({
        name: 'import:@lobu/core',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  // 3: external runtime deps (native binaries + Playwright) must be installed
  // in any runtime that executes compiled connectors.
  for (const dep of EXTERNAL_RUNTIME_DEPS) {
    record(`resolve:${dep}`, () => {
      require_.resolve(dep);
    });
  }

  // 4: bundled connector source directory present + discoverable.
  const candidates =
    opts?.connectorSourceCandidates ?? DEFAULT_CONNECTOR_SOURCE_CANDIDATES;
  const connectorSourceDir = firstExistingDir(candidates);
  record('connector-source-dir', () => {
    if (!connectorSourceDir) {
      throw new Error(
        `No connector source directory found. Tried: ${candidates.join(', ')}.`
      );
    }
  });

  // Use one compiler instance (mtime-LRU cache) across every connector + the
  // fixture, exactly like the runtime catalog does.
  const { compileConnectorFromFile } = createConnectorCompiler();

  // 5: discover, compile, instantiate every connector; assert metadata + key
  // uniqueness.
  let discovered: DiscoveredConnector[] = [];
  if (connectorSourceDir) {
    try {
      const files = await collectConnectorSourceFiles(connectorSourceDir);
      const results: DiscoveredConnector[] = [];
      for (const file of files) {
        const conn = await instantiateConnector(file, compileConnectorFromFile);
        if (conn) results.push(conn);
      }
      discovered = results;

      if (discovered.length === 0) {
        checks.push({
          name: 'connectors-instantiate',
          ok: false,
          detail: `No connector definitions discovered under ${connectorSourceDir}.`,
        });
      } else {
        checks.push({
          name: 'connectors-instantiate',
          ok: true,
          detail: `${discovered.length} connectors instantiated with key/name/version.`,
        });

        const seen = new Map<string, string>();
        const dupes: string[] = [];
        for (const c of discovered) {
          const prev = seen.get(c.key);
          if (prev) dupes.push(`${c.key} (${prev} + ${c.sourcePath})`);
          else seen.set(c.key, c.sourcePath);
        }
        checks.push(
          dupes.length === 0
            ? {
                name: 'connector-keys-unique',
                ok: true,
                detail: `${seen.size} unique keys.`,
              }
            : {
                name: 'connector-keys-unique',
                ok: false,
                detail: `Duplicate connector keys: ${dupes.join('; ')}.`,
              }
        );
      }
    } catch (err) {
      checks.push({
        name: 'connectors-instantiate',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 6: synthetic connector compiles + runs through the DEFAULT SubprocessExecutor.
  try {
    await runSyntheticConnector(compileConnectorFromFile);
    checks.push({
      name: 'synthetic-connector-subprocess-execute',
      ok: true,
      detail:
        'compiled + executed via default SubprocessExecutor; emitted >=1 event.',
    });
  } catch (err) {
    checks.push({
      name: 'synthetic-connector-subprocess-execute',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const ok = checks.every((c) => c.ok);
  return {
    ok,
    surface: opts?.surface ?? 'unknown',
    connectorSourceDir,
    connectorCount: discovered.length,
    checks,
  };
}

/** Pretty-print a self-check result to stderr (human-readable mode). */
export function printSelfCheckResult(result: SelfCheckResult): void {
  const lines: string[] = [];
  lines.push(
    `connector runtime self-check (${result.surface}): ${result.ok ? 'PASS' : 'FAIL'}`
  );
  if (result.connectorSourceDir) {
    lines.push(
      `  connector source: ${result.connectorSourceDir} (${result.connectorCount} connectors)`
    );
  }
  for (const c of result.checks) {
    lines.push(`  ${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}
