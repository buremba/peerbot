/**
 * Isolate-lane eligibility for connector code.
 *
 * Bundles the connector SDK root and every bundled connector with the exact
 * esbuild options the isolate lane uses (`ISOLATE_LANE_BUILD_OPTIONS`), then:
 *
 *  1. asserts the SDK root pulls in no Node builtin and none of `@lobu/core`'s
 *     heavy graph (winston, Sentry, OpenTelemetry) — the property that makes a
 *     connector bundle loadable inside a V8 isolate at all;
 *  2. pins which bundled connectors need a real process, by the Node builtins
 *     their own bundle imports — adding `node:fs` to an isolate-eligible
 *     connector fails here instead of at a tenant's first run;
 *  3. loads every isolate-eligible connector in a real `isolated-vm` context
 *     and checks its default export came out the other side.
 *
 * Runs under Node (vitest); like `run-script-runtime.test.ts` it FAILS rather
 * than skips when `isolated-vm` cannot load, because a silent skip is exactly
 * how the runtime lane would rot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile, type Plugin } from "esbuild";
import { describe, expect, it } from "vitest";
import { ISOLATE_LANE_BUILD_OPTIONS } from "../../../utils/compiler-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(HERE, "../../../../..");
const SDK_DIR = join(PACKAGES_DIR, "connector-sdk");
const CONNECTORS_DIR = join(PACKAGES_DIR, "connectors/src");

/**
 * Bundled connectors whose own imports need a Node process. Keyed by
 * connector file stem; values are the builtins the bundle still imports.
 * A new entry here is a deliberate decision to keep that connector off the
 * isolate lane, so it must be edited by hand, never regenerated.
 */
const PROCESS_LANE_CONNECTORS: Record<string, string[]> = {
	// Webhook signature verification (HMAC) — a host `sign` capability or the
	// lease tier would lift these onto the isolate lane later.
	github: ["crypto"],
	jira: ["crypto"],
	linear: ["crypto"],
	// Spawns local commands by design.
	os_shell: ["child_process", "fs", "os", "path"],
	// Raw TCP to a database; governed by db-egress-guard, never isolate-runnable.
	postgres: ["crypto", "dns", "fs", "net", "os", "perf_hooks", "stream", "tls"],
};

const BUILTINS = new Set(builtinModules);
function isNodeBuiltin(spec: string): boolean {
	return spec.startsWith("node:") || BUILTINS.has(spec);
}

/**
 * Resolve `@lobu/connector-sdk` (root and every `exports` subpath) to its
 * TypeScript source, so a stale `dist` can neither hide nor invent a builtin.
 */
function sdkSourcePlugin(): Plugin {
	const pkg = JSON.parse(readFileSync(join(SDK_DIR, "package.json"), "utf8")) as {
		exports: Record<string, unknown>;
	};
	const map = new Map<string, string>();
	for (const [key, value] of Object.entries(pkg.exports)) {
		const target =
			typeof value === "string"
				? value
				: ((value as { import?: string | { default?: string }; default?: string }).import ??
					(value as { default?: string }).default);
		const file = typeof target === "string" ? target : target?.default;
		if (!file) continue;
		const src = file.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts");
		map.set(key === "." ? "@lobu/connector-sdk" : `@lobu/connector-sdk/${key.slice(2)}`, join(SDK_DIR, src));
	}
	return {
		name: "sdk-source",
		setup(b) {
			b.onResolve({ filter: /^@lobu\/connector-sdk(\/.*)?$/ }, (args) => {
				const hit = map.get(args.path);
				if (!hit) return { errors: [{ text: `Unknown @lobu/connector-sdk subpath: ${args.path}` }] };
				return { path: hit };
			});
		},
	};
}

interface BundleReport {
	code: string;
	bytes: number;
	inputs: string[];
	builtins: Map<string, string[]>;
}

async function bundle(entry: string): Promise<BundleReport> {
	const result = await build({
		...ISOLATE_LANE_BUILD_OPTIONS,
		entryPoints: [entry],
		bundle: true,
		write: false,
		metafile: true,
		logLevel: "silent",
		absWorkingDir: PACKAGES_DIR,
		plugins: [sdkSourcePlugin()],
	});
	const metafile = result.metafile as Metafile;
	const builtins = new Map<string, string[]>();
	for (const [input, meta] of Object.entries(metafile.inputs)) {
		for (const imp of meta.imports) {
			if (imp.external && isNodeBuiltin(imp.path)) {
				const key = imp.path.replace(/^node:/, "");
				builtins.set(key, [...(builtins.get(key) ?? []), input]);
			}
		}
	}
	const code = result.outputFiles[0]?.text ?? "";
	return { code, bytes: Buffer.byteLength(code), inputs: Object.keys(metafile.inputs), builtins };
}

function listBundledConnectors(): string[] {
	return readdirSync(CONNECTORS_DIR)
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
		.filter((f) => /export default (class|defineConnector)/.test(readFileSync(join(CONNECTORS_DIR, f), "utf8")))
		.sort();
}

type IsolatedVm = typeof import("isolated-vm");
async function loadIsolatedVm(): Promise<IsolatedVm> {
	const major = Number(process.versions.node.split(".")[0]);
	// Two ABI builds ship as optionalDependencies; see sandbox/run-script.ts.
	const mod = major >= 26 ? await import("isolated-vm-next") : await import("isolated-vm");
	return ((mod as { default?: IsolatedVm }).default ?? mod) as IsolatedVm;
}

/**
 * The guest gets exactly what a bare isolate host must provide for module
 * init: a CJS shell, a `require` that fails closed, and the handful of globals
 * pure-JS dependencies touch while loading (timers, console, process.env).
 * Anything else missing surfaces as a ReferenceError and fails the test.
 */
const GUEST_PREAMBLE = `
var module = { exports: {} }; var exports = module.exports;
function require(spec) { throw new Error('node builtin required at load: ' + spec); }
var console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
var setTimeout = function () { return 1; }; var clearTimeout = function () {};
var setInterval = function () { return 1; }; var clearInterval = function () {};
var queueMicrotask = function (fn) { Promise.resolve().then(fn); };
var process = { env: {} };
`;
const GUEST_RUNNER = `
(function () {
  var def = module.exports.default;
  return JSON.stringify({ kind: def === null ? 'null' : typeof def, isClass: typeof def === 'function' && /^class\\b/.test(Function.prototype.toString.call(def)) });
})()`;

async function loadInIsolate(ivm: IsolatedVm, code: string): Promise<{ kind: string; isClass: boolean }> {
	const isolate = new ivm.Isolate({ memoryLimit: 256 });
	try {
		const context = await isolate.createContext();
		await context.global.set("global", context.global.derefInto());
		const script = await isolate.compileScript(`${GUEST_PREAMBLE}\n${code}\n${GUEST_RUNNER}`);
		const out = (await script.run(context, { timeout: 10_000, copy: true })) as string;
		return JSON.parse(out);
	} finally {
		isolate.dispose();
	}
}

const HEAVY_INPUT = /(^|\/)(winston|@sentry|@opentelemetry|@grpc)(\/|$)|packages\/core\/dist\/(index|logger|sentry|credentials)\.js$/;

describe("connector isolate lane", () => {
	it("SDK root bundles without Node builtins or @lobu/core's heavy graph", async () => {
		const report = await bundle(join(SDK_DIR, "src/index.ts"));
		expect(Object.fromEntries(report.builtins)).toEqual({});
		expect(report.inputs.filter((p) => HEAVY_INPUT.test(p))).toEqual([]);
		// 340 KB today; the cap trips long before core's 3 MB graph creeps back.
		expect(report.bytes).toBeLessThan(1_000_000);
	});

	it("pins which bundled connectors need a Node process", async () => {
		const files = listBundledConnectors();
		expect(files.length).toBeGreaterThan(20);
		const actual: Record<string, string[]> = {};
		for (const file of files) {
			const report = await bundle(join(CONNECTORS_DIR, file));
			if (report.builtins.size > 0) actual[file.replace(/\.ts$/, "")] = [...report.builtins.keys()].sort();
		}
		expect(actual).toEqual(PROCESS_LANE_CONNECTORS);
	});

	it("loads every isolate-eligible bundled connector in a V8 isolate", async () => {
		const ivm = await loadIsolatedVm();
		const all = listBundledConnectors();
		const eligible = all.filter((f) => !(f.replace(/\.ts$/, "") in PROCESS_LANE_CONNECTORS));
		// Every pinned process-lane entry must name a real connector file.
		expect(eligible.length).toBe(all.length - Object.keys(PROCESS_LANE_CONNECTORS).length);
		expect(eligible.length).toBeGreaterThan(15);
		for (const file of eligible) {
			const report = await bundle(join(CONNECTORS_DIR, file));
			let loaded: { kind: string; isClass: boolean };
			try {
				loaded = await loadInIsolate(ivm, report.code);
			} catch (error) {
				throw new Error(`${file} failed to load in an isolate: ${error instanceof Error ? error.message : String(error)}`);
			}
			expect(loaded.kind, `${file} default export`).toMatch(/^(function|object)$/);
		}
	});
});
