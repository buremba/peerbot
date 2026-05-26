/**
 * Connector runtime parity self-check.
 *
 * One shared function run from BOTH entrypoints — the worker Docker image
 * (`bun src/bin.ts self-check`) and the built CLI (`lobu connector
 * runtime-self-check`) — so both assert the identical compile + default
 * `SubprocessExecutor` path. The only per-surface difference is the connector
 * source discovery roots (monorepo vs worker image vs npm-installed CLI).
 *
 * Why it exists: the worker image once shipped to prod missing `COPY
 * packages/core`, so `@lobu/connector-sdk`'s transitive `@lobu/core` import
 * dangled and every feed sync crashed — yet all CI was green, because CI builds
 * and pushes the image but never RUNS it. This gate runs the built artifact and
 * asserts its resolution/compile/execute graph holds. It touches no network, DB,
 * gateway, or OAuth, and passes under `docker run --network=none`.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createConnectorCompiler,
	EXTERNAL_RUNTIME_DEPS,
} from "../compile/index.js";
import type { ExecutorJob } from "../executor/interface.js";
import { executeCompiledConnector } from "../executor/runtime.js";

/**
 * Synthetic no-op connector, inline so the check is self-contained and ships
 * identically in the worker image (`src/`) and the published CLI (`dist/`). It
 * is not a real bundled connector (the catalog never scans it) and touches no
 * network/DB/filesystem, so it passes under `--network=none`.
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
	/** Which entrypoint ran the check — for log/parity-debugging only. */
	surface: "cli" | "worker" | "unknown";
	connectorSourceDir: string | null;
	connectorCount: number;
	checks: SelfCheckEntry[];
}

export interface SelfCheckOptions {
	/**
	 * Connector source discovery roots, highest priority first; the first
	 * existing one wins. Each surface passes its own layout. Defaults cover the
	 * monorepo + worker image.
	 */
	connectorSourceCandidates?: readonly string[];
	/** Label recorded on the result so logs say which entrypoint ran. */
	surface?: SelfCheckResult["surface"];
}

const HERE = fileURLToPath(new URL(".", import.meta.url));

// This module lives at `packages/connector-worker/{src,dist}/self-check/`, so
// `../../../connectors/...` reaches the bundled connectors from both the TS
// source and the built dist (and from `/app/...` in the worker image).
const DEFAULT_CONNECTOR_SOURCE_CANDIDATES: readonly string[] = [
	resolve(HERE, "../../../connectors/src"),
	resolve(HERE, "../../../connectors/dist"),
	// npm-installed CLI ships connector-worker + connectors side-by-side.
	resolve(HERE, "../connectors"),
	resolve(HERE, "connectors"),
	// Project-root fallbacks for custom runtimes.
	resolve(process.cwd(), "packages/connectors/src"),
	resolve(process.cwd(), "connectors"),
];

function firstExistingDir(candidates: readonly string[]): string | null {
	for (const dir of candidates) {
		if (existsSync(dir)) return dir;
	}
	return null;
}

const errMsg = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

/**
 * Write `content` to a temp file UNDER cwd, run `fn`, then remove it. Under cwd
 * (not the OS tmpdir) so the bundle's bare `@lobu/connector-sdk` import — left
 * externalized by the compiler — resolves via the runtime's `node_modules`,
 * the same reason `child-runner.ts` stages its module under cwd.
 */
async function withCwdTempFile<T>(
	ext: string,
	content: string,
	fn: (filePath: string) => Promise<T>,
): Promise<T> {
	const filePath = join(
		process.cwd(),
		`.lobu-self-check-${process.pid}-${randomBytes(8).toString("hex")}${ext}`,
	);
	await writeFile(filePath, content, {
		encoding: "utf-8",
		flag: "wx",
		mode: 0o600,
	});
	try {
		return await fn(filePath);
	} finally {
		await rm(filePath, { force: true });
	}
}

/**
 * One-level-deep scan mirroring the server catalog's `collectConnectorSourceFiles`:
 * top-level `*.ts` plus one subdir level, skipping `__tests__`, `_`-prefixed
 * dirs, and `.d.ts`. Non-connector files (index/util) carry no ConnectorRuntime
 * class and are dropped after compile.
 */
async function collectConnectorSourceFiles(dirPath: string): Promise<string[]> {
	const paths: string[] = [];
	const isConnectorFile = (name: string) =>
		extname(name) === ".ts" && !name.endsWith(".d.ts");
	for (const entry of await readdir(dirPath, { withFileTypes: true })) {
		const entryPath = resolve(dirPath, entry.name);
		if (entry.isFile()) {
			if (isConnectorFile(entry.name)) paths.push(entryPath);
		} else if (
			entry.isDirectory() &&
			entry.name !== "__tests__" &&
			!entry.name.startsWith("_")
		) {
			// An unreadable connector subdir IS a packaging defect for a parity
			// gate, so let the readdir error propagate (caught by the enclosing
			// `connectors-instantiate` check) rather than silently skipping it.
			for (const sub of await readdir(entryPath, { withFileTypes: true })) {
				if (sub.isFile() && isConnectorFile(sub.name)) {
					paths.push(resolve(entryPath, sub.name));
				}
			}
		}
	}
	return paths.sort();
}

function findConnectorRuntimeClass(
	mod: Record<string, unknown>,
): (new () => unknown) | null {
	const looksLikeConnector = (val: unknown): val is new () => unknown =>
		typeof val === "function" &&
		// biome-ignore lint/suspicious/noExplicitAny: duck-typing the runtime contract
		!!(val as any).prototype?.sync &&
		// biome-ignore lint/suspicious/noExplicitAny: duck-typing the runtime contract
		!!(val as any).prototype?.execute;
	return (
		Object.values(mod).find(looksLikeConnector) ??
		(looksLikeConnector(mod.default) ? mod.default : null)
	);
}

interface DiscoveredConnector {
	sourcePath: string;
	key: string;
	name: string;
	version: string;
}

/**
 * Compile a connector, import the resulting bundle, and read its `definition`.
 * Importing a runtime-compiled bundle is inherently dynamic — the same pattern
 * `child-runner.ts` uses, not a new lazy-load codepath. Returns `null` for
 * files carrying no ConnectorRuntime class (index/util files).
 */
async function instantiateConnector(
	sourcePath: string,
	compile: (filePath: string) => Promise<string>,
): Promise<DiscoveredConnector | null> {
	const compiled = await compile(sourcePath);
	return withCwdTempFile(".mjs", compiled, async (tmpFile) => {
		const mod = (await import(pathToFileURL(tmpFile).href)) as Record<
			string,
			unknown
		>;
		const RuntimeClass = findConnectorRuntimeClass(mod);
		if (!RuntimeClass) return null;
		const { definition: def } = new RuntimeClass() as {
			definition?: Record<string, unknown>;
		};
		if (!def || typeof def !== "object") {
			throw new Error("ConnectorRuntime class exposes no `definition`.");
		}
		for (const field of ["key", "name", "version"] as const) {
			if (typeof def[field] !== "string" || !def[field]) {
				throw new Error(`definition.${field} is missing.`);
			}
		}
		return {
			sourcePath,
			key: def.key as string,
			name: def.name as string,
			version: def.version as string,
		};
	});
}

/**
 * Compile and run the synthetic connector through the real compile + default
 * `SubprocessExecutor` path (the exact fork-isolated path prod uses). Throws on
 * any failure so the caller records a failed check.
 */
async function runSyntheticConnector(
	compile: (filePath: string) => Promise<string>,
): Promise<void> {
	// esbuild needs a file entry, so stage the inline source in a temp `.ts`.
	const compiled = await withCwdTempFile(
		".ts",
		SYNTHETIC_CONNECTOR_SOURCE,
		compile,
	);
	const job: ExecutorJob = {
		mode: "sync",
		feedKey: "noop",
		config: {},
		checkpoint: null,
		entityIds: [],
		credentials: null,
		sessionState: null,
		env: {}, // hermetic child: no inherited host secrets
	};

	let eventCount = 0;
	// No custom executor — defaults to the real SubprocessExecutor.
	const result = await executeCompiledConnector({
		compiledCode: compiled,
		job,
		hooks: {
			onEventChunk: (events) => {
				eventCount += events.length;
			},
		},
	});

	if (result.mode !== "sync") {
		throw new Error(`Expected sync result, got mode=${result.mode}.`);
	}
	if (eventCount < 1) {
		throw new Error(
			"Ran but emitted no events — compile/subprocess event stream is broken.",
		);
	}
}

/**
 * Run the shared connector-runtime parity self-check. Each assertion is
 * recorded as a `{ ok }` entry rather than thrown; the top-level `ok` is the
 * AND of all of them.
 */
export async function runConnectorRuntimeSelfCheck(
	opts?: SelfCheckOptions,
): Promise<SelfCheckResult> {
	const checks: SelfCheckEntry[] = [];
	const require_ = createRequire(import.meta.url);

	// Run `fn` (sync or async); record ok with its returned detail, or the error.
	const check = async (
		name: string,
		fn: () => unknown | Promise<unknown>,
	): Promise<void> => {
		try {
			const detail = await fn();
			checks.push({
				name,
				ok: true,
				detail: typeof detail === "string" ? detail : "ok",
			});
		} catch (err) {
			checks.push({ name, ok: false, detail: errMsg(err) });
		}
	};

	// @lobu/core is anchored at the SDK (the way the SDK consumes it) to reproduce
	// the exact prod edge that dangled: `.../connector-sdk/node_modules/@lobu/core`.
	// Anchoring at connector-worker would only resolve in the hoisted dev
	// workspace and falsely fail in the isolated-linker image. The `import(...)`
	// probes are intentional runtime-resolution checks, not lazy module loads.
	const sdkRequire = () =>
		createRequire(require_.resolve("@lobu/connector-sdk"));
	await check("resolve:@lobu/connector-sdk", () =>
		require_.resolve("@lobu/connector-sdk"),
	);
	await check(
		"import:@lobu/connector-sdk",
		() => import("@lobu/connector-sdk"),
	);
	await check("resolve:@lobu/core", () => sdkRequire().resolve("@lobu/core"));
	await check(
		"import:@lobu/core",
		() => import(pathToFileURL(sdkRequire().resolve("@lobu/core")).href),
	);

	// External runtime deps (native binaries + Playwright) must be installed
	// wherever compiled connectors execute. `child-runner` stages the bundle UNDER cwd, so the
	// bundle's bare imports of these externalized deps resolve from cwd's
	// node_modules — not connector-worker's. Anchor the probe the same way (a
	// require rooted at a cwd module path; the file need not exist for `.resolve`)
	// so the check fails exactly where a real connector would, instead of falsely
	// passing off connector-worker's hoisted dev tree.
	const cwdRequire = createRequire(
		pathToFileURL(join(process.cwd(), "self-check-resolver.mjs")).href,
	);
	for (const dep of EXTERNAL_RUNTIME_DEPS) {
		await check(`resolve:${dep}`, () => cwdRequire.resolve(dep));
	}

	const candidates =
		opts?.connectorSourceCandidates ?? DEFAULT_CONNECTOR_SOURCE_CANDIDATES;
	const connectorSourceDir = firstExistingDir(candidates);
	await check("connector-source-dir", () => {
		if (!connectorSourceDir) {
			throw new Error(
				`No connector source directory found. Tried: ${candidates.join(", ")}.`,
			);
		}
	});

	// One compiler instance (mtime-LRU cache) across every connector + fixture.
	const { compileConnectorFromFile } = createConnectorCompiler();

	// Discover, compile, and instantiate every connector; then assert key uniqueness.
	const discovered: DiscoveredConnector[] = [];
	await check("connectors-instantiate", async () => {
		if (!connectorSourceDir) throw new Error("No connector source directory.");
		for (const file of await collectConnectorSourceFiles(connectorSourceDir)) {
			const conn = await instantiateConnector(file, compileConnectorFromFile);
			if (conn) discovered.push(conn);
		}
		if (discovered.length === 0) {
			throw new Error(
				`No connector definitions discovered under ${connectorSourceDir}.`,
			);
		}
		return `${discovered.length} connectors instantiated with key/name/version.`;
	});
	await check("connector-keys-unique", () => {
		const seen = new Map<string, string>();
		const dupes: string[] = [];
		for (const c of discovered) {
			const prev = seen.get(c.key);
			if (prev) dupes.push(`${c.key} (${prev} + ${c.sourcePath})`);
			else seen.set(c.key, c.sourcePath);
		}
		if (dupes.length)
			throw new Error(`Duplicate connector keys: ${dupes.join("; ")}.`);
		return `${seen.size} unique keys.`;
	});

	// Synthetic connector compiles + runs through the DEFAULT SubprocessExecutor.
	await check("synthetic-connector-subprocess-execute", async () => {
		await runSyntheticConnector(compileConnectorFromFile);
		return "compiled + executed via default SubprocessExecutor; emitted >=1 event.";
	});

	return {
		ok: checks.every((c) => c.ok),
		surface: opts?.surface ?? "unknown",
		connectorSourceDir,
		connectorCount: discovered.length,
		checks,
	};
}

/** Pretty-print a self-check result to stderr (human-readable mode). */
export function printSelfCheckResult(result: SelfCheckResult): void {
	const lines = [
		`connector runtime self-check (${result.surface}): ${result.ok ? "PASS" : "FAIL"}`,
	];
	if (result.connectorSourceDir) {
		lines.push(
			`  connector source: ${result.connectorSourceDir} (${result.connectorCount} connectors)`,
		);
	}
	for (const c of result.checks) {
		lines.push(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
	}
	process.stderr.write(`${lines.join("\n")}\n`);
}
