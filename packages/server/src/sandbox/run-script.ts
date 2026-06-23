/**
 * Compiles a TypeScript user-script via esbuild, runs it in a V8 isolate, and
 * bridges SDK calls back to the host. Caps: 1 MB output, 200 SDK calls,
 * 60s wall-clock. `client.org()` is stateless — each guest call carries
 * `orgPath` so the host re-walks org swaps without holding refs.
 */

import type { ClientSDK } from "./client-sdk";
import { METHOD_METADATA, type MethodAccess } from "./method-metadata";
import { enumerateSDKManifest, type SDKMode } from "./sdk-manifest";

export interface RunLimits {
	memoryMb?: number;
	timeoutMs?: number;
	sdkCallQuota?: number;
	outputBytes?: number;
}

export interface RunScriptOptions {
	source: string;
	context?: Record<string, unknown>;
	/**
	 * Preview mode for full-SDK scripts. Read calls still execute so scripts can
	 * inspect state, but write/external SDK calls are skipped and returned in
	 * `sideEffectPreview` instead of mutating state or reaching external systems.
	 */
	dryRun?: boolean;
	/**
	 * Either a pre-built SDK or a builder that receives the wall-clock
	 * AbortSignal so handlers can race their work against the timeout and
	 * unblock the awaiting caller (postgres connections aren't cancelled —
	 * see `ToolContext.abortSignal`). Prefer the builder form for sandbox MCP tools.
	 */
	sdk: ClientSDK | ((signal: AbortSignal) => ClientSDK);
	sdkMode?: SDKMode;
	/** Whether `client.org` is reachable inside the guest. Defaults to false. */
	allowCrossOrg?: boolean;
	limits?: RunLimits;
	/** Forwarded to the script entry point after `(ctx, client)`. */
	extraArgs?: unknown[];
}

interface LogEntry {
	level: "log" | "warn" | "error";
	message: string;
	data?: Record<string, unknown>;
	ts: number;
}

interface SdkCallTraceEntry {
	path: string;
	orgPath: string[];
	access: MethodAccess | "unknown";
	args: unknown[];
	skipped: boolean;
}

interface RunScriptResult {
	success: boolean;
	returnValue?: unknown;
	logs: LogEntry[];
	sdkCallTrace: SdkCallTraceEntry[];
	sideEffectPreview: SdkCallTraceEntry[];
	error?: {
		name: string;
		message: string;
		stack?: string;
		line?: number;
		column?: number;
	};
	durationMs: number;
	sdkCalls: number;
}

const DEFAULT_LIMITS: Required<RunLimits> = {
	memoryMb: 64,
	timeoutMs: 60_000,
	sdkCallQuota: 200,
	outputBytes: 1_048_576,
};
const MAX_TRACE_ARGS_BYTES = 8192;
const SENSITIVE_TRACE_KEY =
	/(api[_-]?key|apikey|auth[_-]?data|auth[_-]?values|authorization|cookie|credential|password|private[_-]?key|secret|token)/i;

function redactTraceValue(value: unknown, depth = 0): unknown {
	if (depth > 8) return "[truncated]";
	if (Array.isArray(value))
		return value.map((item) => redactTraceValue(item, depth + 1));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, child]) => [
			key,
			SENSITIVE_TRACE_KEY.test(key)
				? "[redacted]"
				: redactTraceValue(child, depth + 1),
		]),
	);
}

function traceArgs(args: unknown[]): unknown[] {
	const redacted = redactTraceValue(args) as unknown[];
	const json = JSON.stringify(redacted);
	if (Buffer.byteLength(json, "utf8") > MAX_TRACE_ARGS_BYTES) {
		return [{ truncated: true, bytes: Buffer.byteLength(json, "utf8") }];
	}
	return JSON.parse(json) as unknown[];
}

function clampNumber(
	value: number | undefined,
	fallback: number,
	min: number,
	max: number,
) {
	const n = Number.isFinite(value) ? value : fallback;
	return Math.max(min, Math.min(n ?? fallback, max));
}

function clampLimits(limits?: RunLimits): Required<RunLimits> {
	return {
		memoryMb: clampNumber(
			limits?.memoryMb,
			DEFAULT_LIMITS.memoryMb,
			8,
			DEFAULT_LIMITS.memoryMb,
		),
		timeoutMs: clampNumber(
			limits?.timeoutMs,
			DEFAULT_LIMITS.timeoutMs,
			1,
			DEFAULT_LIMITS.timeoutMs,
		),
		sdkCallQuota: clampNumber(
			limits?.sdkCallQuota,
			DEFAULT_LIMITS.sdkCallQuota,
			1,
			DEFAULT_LIMITS.sdkCallQuota,
		),
		outputBytes: clampNumber(
			limits?.outputBytes,
			DEFAULT_LIMITS.outputBytes,
			1024,
			DEFAULT_LIMITS.outputBytes,
		),
	};
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
				new Error(
					`TimeoutError: script exceeded ${timeoutMs}ms wall-clock budget`,
				),
			);
		}, timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function raceAgainstAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(
			signal.reason instanceof Error
				? signal.reason
				: new Error("AbortError: signal aborted"),
		);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(
				signal.reason instanceof Error
					? signal.reason
					: new Error("AbortError: signal aborted"),
			);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

type IsolatedVmRuntime = typeof import("isolated-vm");

function unwrapIsolatedVm(mod: unknown): IsolatedVmRuntime {
	const m = mod as IsolatedVmRuntime & {
		default?: IsolatedVmRuntime;
		"module.exports"?: IsolatedVmRuntime;
	};
	return m.default ?? m["module.exports"] ?? m;
}

async function loadIsolatedVm(): Promise<IsolatedVmRuntime | null> {
	// isolated-vm's native addon is ABI-bound per Node line. We ship two builds via
	// optionalDependencies: isolated-vm@6 (Node 22–24) and the aliased
	// `isolated-vm-next` = isolated-vm@7 (Node 26+). Node 25 is an EOL non-LTS line
	// upstream skipped (issue #553), so it has no build → no sandbox. Pick by Node
	// major and fail closed if the chosen build can't load (e.g. native build was
	// skipped on this platform) rather than taking down the MCP server.
	const nodeMajor = Number(process.versions.node?.split(".")[0] ?? 0);
	if (!Number.isFinite(nodeMajor)) return null;

	try {
		if (nodeMajor >= 22 && nodeMajor < 25) {
			return unwrapIsolatedVm(await import("isolated-vm"));
		}
		if (nodeMajor >= 26) {
			// Aliased to isolated-vm@7 in package.json optionalDependencies.
			return unwrapIsolatedVm(await import("isolated-vm-next"));
		}
		return null;
	} catch {
		return null;
	}
}

const GUEST_PREAMBLE = `
const ctx = JSON.parse(__ctx_json);
const __manifest = JSON.parse(__sdk_manifest_json);
const __namespaceMethods = __manifest.byNamespace;
const __topLevelKeys = new Set(__manifest.topLevel);
const __namespaceKeys = new Set(Object.keys(__namespaceMethods));

// Skip awaitable/coercion probes (\`then\`, \`toJSON\`, etc.) before they hit the
// host. Otherwise an accidental \`JSON.stringify(client.x)\` consumes quota.
function __isReservedKey(k) {
  return typeof k === 'symbol'
    || k === 'then' || k === 'catch' || k === 'finally'
    || k === 'inspect' || k === 'constructor' || k === '__proto__'
    || k === 'toJSON' || k === 'toString' || k === 'valueOf';
}

function __dispatchCall(path, orgPath) {
  return async (...args) => {
    const payload = JSON.stringify({ args, orgPath });
    const r = await __sdk_dispatch.apply(undefined, [path, payload], { result: { promise: true, copy: true } });
    return r === undefined ? undefined : JSON.parse(r);
  };
}

function __makeNamespaceProxy(ns, orgPath) {
  const methods = new Set(__namespaceMethods[ns] || []);
  return new Proxy({}, {
    get: (_, k) => __isReservedKey(k) || !methods.has(String(k))
      ? undefined
      : __dispatchCall(ns + '.' + String(k), orgPath),
    has: (_, k) => typeof k === 'string' && methods.has(k),
    ownKeys: () => Array.from(methods),
    getOwnPropertyDescriptor: (_, k) => typeof k === 'string' && methods.has(k)
      ? { enumerable: true, configurable: true, writable: false, value: undefined }
      : undefined,
  });
}

function __makeClient(orgPath) {
  const allKeys = new Set([...__topLevelKeys, ...__namespaceKeys]);
  return new Proxy({}, {
    get(_, key) {
      if (__isReservedKey(key)) return undefined;
      const k = String(key);
      if (k === 'org') return __topLevelKeys.has('org')
        ? (slug) => __makeClient([...orgPath, String(slug)])
        : undefined;
      if (__topLevelKeys.has(k)) return __dispatchCall(k, orgPath);
      if (__namespaceKeys.has(k)) return __makeNamespaceProxy(k, orgPath);
      return undefined;
    },
    has: (_, k) => typeof k === 'string' && allKeys.has(k),
    ownKeys: () => Array.from(allKeys),
    getOwnPropertyDescriptor: (_, k) => typeof k === 'string' && allKeys.has(k)
      ? { enumerable: true, configurable: true, writable: false, value: undefined }
      : undefined,
  });
}

const client = __makeClient([]);

const console = {
  log: (...a) => { try { __console_call.applySync(undefined, ['log', a.map(String).join(' ')]); } catch (e) {} },
  warn: (...a) => { try { __console_call.applySync(undefined, ['warn', a.map(String).join(' ')]); } catch (e) {} },
  error: (...a) => { try { __console_call.applySync(undefined, ['error', a.map(String).join(' ')]); } catch (e) {} },
};

const module = { exports: {} };
const exports = module.exports;
`;

const GUEST_RUNNER = `
(async () => {
  const __entry = module.exports.default
    ?? (typeof module.exports === 'function' ? module.exports : null);
  if (typeof __entry !== 'function') {
    throw new Error('Script must \`export default\` an async function');
  }
  const __extra = JSON.parse(__extra_args_json);
  const __result = await __entry(ctx, client, ...__extra);
  return __result === undefined ? null : JSON.stringify(__result);
})()
`;

export async function runScript(
	options: RunScriptOptions,
): Promise<RunScriptResult> {
	const started = Date.now();
	const limits = clampLimits(options.limits);
	const sdkMode: SDKMode = options.sdkMode ?? "full";
	const allowCrossOrg = options.allowCrossOrg ?? false;
	const manifest = enumerateSDKManifest(sdkMode, { allowCrossOrg });

	// Host-side mirror of the manifest's dispatchable paths. `__sdk_dispatch` is a
	// guest-visible global, so a malicious script can call it with an un-manifested
	// method directly — the guest-side Proxy filter is the friendly path, this is
	// the security backstop. `org` is a guest-side construct (re-walks `orgPath`),
	// never a dispatch path, so it isn't in this set.
	const allowedDispatchPaths = new Set<string>(["log", "query"]);
	for (const [ns, methods] of Object.entries(manifest.byNamespace)) {
		for (const method of methods) allowedDispatchPaths.add(`${ns}.${method}`);
	}
	const FORBIDDEN_ORG_SLUGS = new Set([
		"__proto__",
		"constructor",
		"prototype",
	]);

	// Wall-clock timeout. Each dispatch races the abort signal so the script
	// returns promptly; upstream DB/HTTP itself doesn't cancel today.
	const abortController = new AbortController();
	const abortTimer = setTimeout(() => {
		abortController.abort(
			new Error(
				`TimeoutError: script exceeded ${limits.timeoutMs}ms wall-clock budget`,
			),
		);
	}, limits.timeoutMs);

	// Resolve the SDK lazily so callers that pass a builder receive the
	// wall-clock signal — opted-in handlers race their work against it to
	// unblock the awaiting caller on timeout.
	const baseSdk: ClientSDK =
		typeof options.sdk === "function"
			? options.sdk(abortController.signal)
			: options.sdk;

	const logs: LogEntry[] = [];
	const sdkCallTrace: SdkCallTraceEntry[] = [];
	const sideEffectPreview: SdkCallTraceEntry[] = [];
	let sdkCalls = 0;
	let outputBytes = 0;

	const ivm = await loadIsolatedVm();
	if (!ivm) {
		clearTimeout(abortTimer);
		return {
			success: false,
			logs: [],
			error: {
				name: "RuntimeUnavailable",
				message:
					"isolated-vm is not installed for this platform. Install with `bun install` on a supported Node version (22–24 with prebuilt binaries, or any version with python3 + build-essential available).",
			},
			durationMs: Date.now() - started,
			sdkCalls: 0,
			sdkCallTrace,
			sideEffectPreview,
		};
	}

	let compiled: string;
	try {
		const { compileSource } = await import("../utils/compiler-core");
		const result = await compileSource(options.source, {
			tmpPrefix: ".execute-compile-",
			label: "ExecuteCompiler",
			buildOptions: {
				format: "cjs",
				target: "esnext",
				platform: "node",
				external: [],
			},
		});
		compiled = result.compiledCode;
	} catch (err) {
		clearTimeout(abortTimer);
		const e = err as Error & {
			errors?: Array<{ location?: { line?: number; column?: number } }>;
		};
		const loc = e.errors?.[0]?.location;
		return {
			success: false,
			logs,
			error: {
				name: "CompileError",
				message: e.message,
				line: loc?.line,
				column: loc?.column,
			},
			durationMs: Date.now() - started,
			sdkCalls: 0,
			sdkCallTrace,
			sideEffectPreview,
		};
	}

	let isolate: import("isolated-vm").Isolate | null = null;
	try {
		isolate = new ivm.Isolate({ memoryLimit: limits.memoryMb });
		const context = await isolate.createContext();
		const jail = context.global;
		await jail.set("global", jail.derefInto());

		await jail.set(
			"__sdk_dispatch",
			new ivm.Reference(async (path: string, payloadJson: string) => {
				sdkCalls++;
				if (sdkCalls > limits.sdkCallQuota) {
					throw new Error(
						`QuotaExceeded: SDK call quota of ${limits.sdkCallQuota} reached`,
					);
				}
				if (abortController.signal.aborted) {
					throw new Error(
						`TimeoutError: script exceeded ${limits.timeoutMs}ms wall-clock budget`,
					);
				}

				const { args, orgPath } = JSON.parse(payloadJson) as {
					args: unknown[];
					orgPath: string[];
				};

				// Re-enforce the manifest on the host: reject any method the manifest
				// wouldn't advertise, regardless of run mode (dry-run only skips writes
				// for the modes that have it — it is not an authorization gate).
				if (!allowedDispatchPaths.has(path)) {
					throw new Error(`Unknown SDK method: '${path}'`);
				}
				// Cross-org access is gated here too, not just by the manifest omitting
				// `org` from `topLevel`.
				if (!allowCrossOrg && orgPath.length > 0) {
					throw new Error(
						"CrossOrgAccessDenied: cross-org access is not available here.",
					);
				}

				let target: ClientSDK = baseSdk;
				for (const slug of orgPath) {
					if (
						typeof slug !== "string" ||
						FORBIDDEN_ORG_SLUGS.has(slug) ||
						!Object.hasOwn(target, "org")
					) {
						throw new Error(`Invalid org slug: '${String(slug)}'`);
					}
					target = await target.org(slug);
				}

				const dispatchPromise: Promise<unknown> = (async () => {
					if (path === "log") {
						target.log(
							args[0] as string,
							args[1] as Record<string, unknown> | undefined,
						);
						sdkCallTrace.push({
							path,
							orgPath,
							access: METHOD_METADATA[path]?.access ?? "unknown",
							args: traceArgs(args),
							skipped: false,
						});
						return undefined;
					}
					if (path === "query") {
						sdkCallTrace.push({
							path,
							orgPath,
							access: METHOD_METADATA[path]?.access ?? "unknown",
							args: traceArgs(args),
							skipped: false,
						});
						return target.query(args[0] as string);
					}
					const [ns, method] = path.split(".");
					// `__sdk_dispatch` is a guest-visible global, so a malicious script
					// could call it directly with an inherited path like `entities.constructor`.
					// Restrict to own enumerable namespaces and own methods; the guest-side
					// manifest filter is the friendly path, this is the security backstop.
					if (!ns || !method || !Object.hasOwn(target, ns)) {
						throw new Error(`Unknown SDK namespace: '${ns}'`);
					}
					const namespace = (
						target as unknown as Record<
							string,
							Record<string, (...a: unknown[]) => unknown>
						>
					)[ns];
					if (
						!namespace ||
						typeof namespace !== "object" ||
						!Object.hasOwn(namespace, method) ||
						typeof namespace[method] !== "function"
					) {
						throw new Error(`Unknown SDK method: '${path}'`);
					}
					const access = METHOD_METADATA[path]?.access ?? "unknown";
					// Belt-and-suspenders: in read mode the guest-side manifest already
					// drops non-read methods, but enforce it here too so a future
					// namespace refactor (e.g. class instances) can't silently re-expose
					// the write surface to a read-only script.
					if (sdkMode === "read" && access !== "read") {
						throw new Error(
							`Forbidden: SDK method '${path}' is not allowed in read mode`,
						);
					}
					const trace: SdkCallTraceEntry = {
						path,
						orgPath,
						access,
						args: traceArgs(args),
						skipped: options.dryRun === true && access !== "read",
					};
					sdkCallTrace.push(trace);
					if (trace.skipped) {
						sideEffectPreview.push(trace);
						return { dry_run: true, skipped_call: path, access };
					}
					return namespace[method](...args);
				})();

				const result = await raceAgainstAbort(
					dispatchPromise,
					abortController.signal,
				);
				if (result === undefined) return undefined;
				const json = JSON.stringify(result);
				outputBytes += Buffer.byteLength(json, "utf8");
				if (outputBytes > limits.outputBytes) {
					throw new Error(
						`OutputSizeExceeded: combined output exceeded ${limits.outputBytes} bytes`,
					);
				}
				return json;
			}),
		);

		await jail.set(
			"__console_call",
			new ivm.Reference((level: "log" | "warn" | "error", message: string) => {
				outputBytes += Buffer.byteLength(message, "utf8");
				if (outputBytes > limits.outputBytes) return;
				logs.push({ level, message, ts: Date.now() });
			}),
		);

		await jail.set("__ctx_json", JSON.stringify(options.context ?? {}));
		await jail.set(
			"__extra_args_json",
			JSON.stringify(options.extraArgs ?? []),
		);
		await jail.set("__sdk_manifest_json", JSON.stringify(manifest));

		const script = await isolate.compileScript(
			`${GUEST_PREAMBLE}\n${compiled}\n${GUEST_RUNNER}`,
		);
		const returnJson = (await withTimeout(
			script.run(context, {
				timeout: limits.timeoutMs,
				promise: true,
				copy: true,
			}) as Promise<string | null>,
			limits.timeoutMs,
		)) as string | null;
		if (returnJson) {
			outputBytes += Buffer.byteLength(returnJson, "utf8");
			if (outputBytes > limits.outputBytes) {
				throw new Error(
					`OutputSizeExceeded: combined output exceeded ${limits.outputBytes} bytes (paginate or filter the script's return value)`,
				);
			}
		}
		const returnValue = returnJson ? JSON.parse(returnJson) : null;

		return {
			success: true,
			returnValue,
			logs,
			durationMs: Date.now() - started,
			sdkCalls,
			sdkCallTrace,
			sideEffectPreview,
		};
	} catch (err) {
		const e = err as Error;
		const isTimeout = /script execution timed out|TimeoutError/i.test(
			e.message,
		);
		const isQuota = /QuotaExceeded/.test(e.message);
		const isOversize = /OutputSizeExceeded/.test(e.message);
		const isOom = /memory|allocation|isolate was disposed/i.test(e.message);
		const name = isTimeout
			? "TimeoutError"
			: isQuota
				? "QuotaExceeded"
				: isOversize
					? "OutputSizeExceeded"
					: isOom
						? "OutOfMemory"
						: "ScriptError";
		return {
			success: false,
			logs,
			error: { name, message: e.message, stack: e.stack },
			durationMs: Date.now() - started,
			sdkCalls,
			sdkCallTrace,
			sideEffectPreview,
		};
	} finally {
		clearTimeout(abortTimer);
		if (isolate && !isolate.isDisposed) {
			isolate.dispose();
		}
	}
}
