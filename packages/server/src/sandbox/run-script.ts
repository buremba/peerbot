/**
 * Compiles a TypeScript user-script via esbuild, runs it in a V8 isolate, and
 * bridges SDK calls back to the host. Output is budgeted per-purpose, not as
 * one combined counter: the return value is capped at 1 MB (truncated with a
 * `returnTruncated` report when exceeded, never a hard fail), console logs are
 * capped at 64 KB and dropped once full, and a 4 MB crossing guard bounds
 * host↔guest copies (SDK call envelopes + console crossing) as the DoS
 * backstop. Other caps: 200 SDK calls, 180s wall-clock max (device-bound
 * operations may wait up to ~155s), and 30s per `ctx.sleep()` call.
 * `client.org()` is stateless — each guest call carries
 * `orgPath` so the host re-walks org swaps without holding refs.
 */

import type { ClientSDK } from "./client-sdk";
import { ClientSdkActionError } from "./namespaces/action-call";
import { METHOD_METADATA, type MethodAccess } from "./method-metadata";
import type { ToolAccessLevel } from "../auth/tool-access";
import { enumerateSDKManifest, type SDKMode } from "./sdk-manifest";

export interface RunLimits {
	memoryMb?: number;
	timeoutMs?: number;
	sdkCallQuota?: number;
	/** Serialization cap for the script's return value. Values that exceed it are truncated, not failed. */
	outputBytes?: number;
	/** Cap for captured console logs; messages past it are dropped (never a failure). */
	logBytes?: number;
	/** DoS guard on host↔guest copies across SDK call envelopes and console output. */
	crossingBytes?: number;
}

/**
 * What the host dropped when a return value exceeded `outputBytes`. Returned
 * out-of-band so the truncated value itself stays shape-faithful (a truncated
 * array is still an array) and the agent can never mistake partial data for
 * complete output.
 */
export interface TruncatedValueInfo {
	total_bytes: number;
	kept_bytes: number;
	dropped_elements: number;
	dropped_keys: number;
	dropped_chars: number;
}

/**
 * Whether one SDK call is skipped-and-recorded rather than dispatched.
 *
 * Exported so the capture contract is pinned by a test against THIS expression
 * rather than a copy of it — a mirrored predicate in a test can never catch a
 * regression here.
 */
export function isSkippedUnderDryRun(args: {
	dryRun?: boolean;
	dryRunDispatchPaths?: readonly string[];
	access: string;
	path: string;
}): boolean {
	if (args.dryRun !== true) return false;
	if (args.access === "read") return false;
	return !args.dryRunDispatchPaths?.includes(args.path);
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
	 * SDK paths that still DISPATCH under {@link dryRun}, because the handler
	 * behind them is itself capture-aware and refuses its own writes.
	 *
	 * This exists for exactly one case: an eval replay is told to finalize via
	 * `client.behaviors.completeWindow`, and the blanket skip would swallow that
	 * call — leaving the run with no window, so it gets nudged into a second
	 * full replay and then failed with "finished without calling run_sdk". The
	 * handler needs to RUN so it can record the extraction and answer
	 * `captured: true`; it reads the same `executionMode` off its ToolContext
	 * and writes nothing.
	 *
	 * Deliberately NOT populated for an agent-requested `dry_run: true` — there
	 * the agent asked for a preview and skipping is the correct answer.
	 */
	dryRunDispatchPaths?: readonly string[];
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
	/** Caller access tier — filters the dispatch manifest (defaults to read). */
	maxAccessLevel?: ToolAccessLevel;
	limits?: RunLimits;
	/** Forwarded to the script entry point after `(ctx, client)`. */
	extraArgs?: unknown[];
	/**
	 * When set, the module is loaded but its default handler is NOT invoked;
	 * instead `returnValue` is the named export, serialized via JSON (drops
	 * non-enumerable TypeBox symbols, leaving plain JSON Schema). Used to read a
	 * reaction's exported `input` contract. Runs strictly LESS guest code than a
	 * normal run (top-level only, no handler), so it adds no attack surface.
	 */
	extractExport?: string;
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
	/** Present when the return value exceeded `outputBytes` and was truncated. */
	returnTruncated?: TruncatedValueInfo;
	logs: LogEntry[];
	sdkCallTrace: SdkCallTraceEntry[];
	sideEffectPreview: SdkCallTraceEntry[];
	error?: {
		name: string;
		message: string;
		details?: unknown;
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
	logBytes: 65_536,
	crossingBytes: 4_194_304,
};
/** Device action waits allow 60s queue + 95s post-claim; sandbox must outlive that. */
export const MAX_SCRIPT_TIMEOUT_MS = 180_000;
export const MAX_SLEEP_MS = 30_000;
const MAX_TRACE_ARGS_BYTES = 8192;
const MAX_ERROR_DETAILS_BYTES = 16_384;
const SENSITIVE_TRACE_KEY =
	/(api[_-]?key|apikey|auth[_-]?data|auth[_-]?values|authorization|cookie|credential|password|private[_-]?key|secret|token)/i;

function redactTraceValue(
	value: unknown,
	depth = 0,
	ancestors = new WeakSet<object>(),
): unknown {
	if (depth > 8) return "[truncated]";
	if (typeof value === "bigint") return value.toString();
	if (!value || typeof value !== "object") return value;
	if (ancestors.has(value)) return "[circular]";
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((item) => redactTraceValue(item, depth + 1, ancestors));
		}
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, child]) => [
				key,
				SENSITIVE_TRACE_KEY.test(key)
					? "[redacted]"
					: redactTraceValue(child, depth + 1, ancestors),
			]),
		);
	} finally {
		ancestors.delete(value);
	}
}

function traceArgs(args: unknown[]): unknown[] {
	const redacted = redactTraceValue(args) as unknown[];
	const json = JSON.stringify(redacted);
	if (Buffer.byteLength(json, "utf8") > MAX_TRACE_ARGS_BYTES) {
		return [{ truncated: true, bytes: Buffer.byteLength(json, "utf8") }];
	}
	return JSON.parse(json) as unknown[];
}

export function safeErrorDetails(value: unknown): unknown {
	try {
		const redacted = redactTraceValue(value);
		const json = JSON.stringify(redacted);
		if (typeof json !== "string") {
			return {
				truncated: true,
				message: "Structured SDK error details were not JSON-serializable.",
			};
		}
		if (Buffer.byteLength(json, "utf8") <= MAX_ERROR_DETAILS_BYTES) {
			return redacted;
		}
		return {
			truncated: true,
			bytes: Buffer.byteLength(json, "utf8"),
			message: "Structured SDK error details exceeded the transport limit.",
		};
	} catch {
		return {
			truncated: true,
			message: "Structured SDK error details could not be serialized safely.",
		};
	}
}

const TRUNCATE_SUFFIX = "\u2026 [truncated]";
/** Reserved for the result envelope wrapping a return value (`ok`, marker keys). */
const ENVELOPE_OVERHEAD_BYTES = 128;
const MAX_TRUNCATE_DEPTH = 200;
const SKIP = Symbol("truncate.skip");

function jsonBytes(value: unknown): number {
	const json = JSON.stringify(value);
	return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

/** Bytes of `value` as a JSON string literal, excluding the wrapping quotes. */
function serializedStringBytes(value: string): number {
	return jsonBytes(value) - 2;
}

/**
 * Longest prefix of `value` whose JSON-serialized byte size fits `maxBytes`
 * (not raw bytes — escaped characters such as `\n` or `"` serialize larger),
 * without splitting a UTF-16 surrogate pair.
 */
function truncateStringToBytes(value: string, maxBytes: number): string {
	if (serializedStringBytes(value) <= maxBytes) return value;
	let lo = 0;
	let hi = value.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (serializedStringBytes(value.slice(0, mid)) <= maxBytes) lo = mid;
		else hi = mid - 1;
	}
	if (lo > 0 && lo < value.length) {
		const c = value.charCodeAt(lo - 1);
		if (c >= 0xd800 && c <= 0xdbff) lo -= 1; // don't split a surrogate pair
	}
	return value.slice(0, lo);
}

interface TruncState {
	budget: number;
	used: number;
	droppedElements: number;
	droppedKeys: number;
	droppedChars: number;
}

/**
 * Greedy bounded serializer: keep as much top-level structure as fits, then
 * report what was dropped. A kept entry that itself overflows (nested array,
 * object, string) is recursed into and truncated in place; `SKIP` marks a
 * value that could not be kept at all. `state.used` never exceeds `state.budget`.
 */
function encodeWithinBudget(value: unknown, state: TruncState, depth: number): unknown {
	const full = jsonBytes(value);
	if (state.used + full <= state.budget) {
		state.used += full;
		return value;
	}
	if (depth >= MAX_TRUNCATE_DEPTH) {
		dropAtomic(value, state);
		return SKIP;
	}
	if (Array.isArray(value)) {
		if (state.used + 2 > state.budget) {
			state.droppedElements += value.length;
			return SKIP;
		}
		state.used += 2; // brackets
		const out: unknown[] = [];
		for (const item of value) {
			const sep = out.length > 0 ? 1 : 0;
			if (state.used + sep + 2 > state.budget) break;
			state.used += sep;
			const encoded = encodeWithinBudget(item, state, depth + 1);
			if (encoded === SKIP) break;
			out.push(encoded);
		}
		state.droppedElements += value.length - out.length;
		return out;
	}
	if (value !== null && typeof value === "object") {
		if (state.used + 2 > state.budget) {
			state.droppedKeys += Object.keys(value).length;
			return SKIP;
		}
		state.used += 2; // braces
		const out: Record<string, unknown> = {};
		const entries = Object.entries(value as Record<string, unknown>);
		let kept = 0;
		for (const [key, child] of entries) {
			const sep = kept > 0 ? 1 : 0;
			const keyCost = jsonBytes(key);
			if (state.used + sep + keyCost + 2 > state.budget) break;
			state.used += sep + keyCost + 1; // comma + key + colon
			const encoded = encodeWithinBudget(child, state, depth + 1);
			if (encoded === SKIP) break;
			out[key] = encoded;
			kept++;
		}
		state.droppedKeys += entries.length - kept;
		return out;
	}
	if (typeof value === "string") {
		const suffixBytes = jsonBytes(TRUNCATE_SUFFIX);
		const avail = state.budget - state.used - suffixBytes;
		if (avail <= 0) {
			state.droppedChars += value.length;
			return SKIP;
		}
		const kept = truncateStringToBytes(value, avail);
		state.droppedChars += value.length - kept.length;
		const out = kept + TRUNCATE_SUFFIX;
		state.used += jsonBytes(out);
		return out;
	}
	dropAtomic(value, state);
	return SKIP;
}

function dropAtomic(value: unknown, state: TruncState): void {
	if (typeof value === "string") state.droppedChars += value.length;
	else if (Array.isArray(value)) state.droppedElements += value.length;
	else if (value !== null && typeof value === "object")
		state.droppedKeys += Object.keys(value).length;
}

/**
 * Truncate a return value to fit `budgetBytes`, preserving as much structure
 * as possible. Only called when the serialized value already exceeds the
 * budget, so `meta` always reports dropped content.
 */
function truncateJsonValue(
	value: unknown,
	budgetBytes: number,
): { value: unknown; meta: TruncatedValueInfo } {
	const totalBytes = jsonBytes(value);
	const state: TruncState = {
		budget: budgetBytes,
		used: 0,
		droppedElements: 0,
		droppedKeys: 0,
		droppedChars: 0,
	};
	let out = encodeWithinBudget(value, state, 0);
	if (out === SKIP) out = { __lobu_truncated: true };
	if (jsonBytes(out) > budgetBytes) {
		// Never emit more than the budget promised, even on a walker bug.
		out = { __lobu_truncated: true, total_bytes: totalBytes };
	}
	return {
		value: out,
		meta: {
			total_bytes: totalBytes,
			kept_bytes: Math.min(state.used, totalBytes),
			dropped_elements: state.droppedElements,
			dropped_keys: state.droppedKeys,
			dropped_chars: state.droppedChars,
		},
	};
}

function classifyRuntimeError(error: {
	name?: string;
	message?: string;
	stack?: string;
	details?: unknown;
}): NonNullable<RunScriptResult["error"]> {
	const message = error.message ?? "Script execution failed";
	// Expected user-input errors (bad SDK args, business-rule failures) must NOT
	// leak a server-bundle stack to the client — the message already carries the
	// actionable "Invalid arguments for client.x.y: …" guidance, and the full
	// stack stays in server logs/observability. An unexpected ScriptError keeps
	// its stack (a genuine bug the developer needs to trace).
	const isExpectedUserError =
		error.name === "ClientSdkActionError" ||
		error.name === "ToolUserError" ||
		/^Invalid arguments for /.test(message);
	if (error.name === "ClientSdkActionError") {
		return {
			name: "ClientSdkActionError",
			message,
			...(error.details === undefined ? {} : { details: error.details }),
		};
	}
	if (isExpectedUserError) {
		return { name: "ValidationError", message };
	}

	const isTimeout = /script execution timed out|TimeoutError/i.test(message);
	const isQuota = /QuotaExceeded/.test(message);
	const isSleepLimit = /SleepLimitExceeded/.test(message);
	const isInvalidSleep = /InvalidSleepDuration/.test(message);
	const isOversize = /OutputSizeExceeded/.test(message);
	const isOom = /memory|allocation|isolate was disposed/i.test(message);
	const name = isTimeout
		? "TimeoutError"
		: isQuota
			? "QuotaExceeded"
			: isSleepLimit
				? "SleepLimitExceeded"
				: isInvalidSleep
					? "InvalidSleepDuration"
					: isOversize
						? "OutputSizeExceeded"
						: isOom
							? "OutOfMemory"
							: "ScriptError";
	return {
		name,
		message,
		...(error.stack ? { stack: error.stack } : {}),
	};
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
			MAX_SCRIPT_TIMEOUT_MS,
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
		logBytes: clampNumber(
			limits?.logBytes,
			DEFAULT_LIMITS.logBytes,
			1024,
			DEFAULT_LIMITS.logBytes,
		),
		crossingBytes: clampNumber(
			limits?.crossingBytes,
			DEFAULT_LIMITS.crossingBytes,
			65_536,
			DEFAULT_LIMITS.crossingBytes,
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

export function sleepAgainstAbort(ms: number, signal: AbortSignal): Promise<void> {
	if (!Number.isFinite(ms) || !Number.isInteger(ms) || ms < 0) {
		return Promise.reject(
			new Error("InvalidSleepDuration: ctx.sleep(ms) requires a non-negative integer"),
		);
	}
	if (ms > MAX_SLEEP_MS) {
		return Promise.reject(
			new Error(
				`SleepLimitExceeded: ctx.sleep(ms) allows at most ${MAX_SLEEP_MS}ms per call`,
			),
		);
	}
	if (signal.aborted) {
		return Promise.reject(
			signal.reason instanceof Error
				? signal.reason
				: new Error("AbortError: signal aborted"),
		);
	}
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(
				signal.reason instanceof Error
					? signal.reason
					: new Error("AbortError: signal aborted"),
			);
		};
		signal.addEventListener("abort", onAbort, { once: true });
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
const __ctxData = JSON.parse(__ctx_json);
const ctx = Object.freeze({
  ...__ctxData,
  sleep: async (ms) => __sleep.apply(undefined, [ms], { result: { promise: true, copy: true } }),
});
const __manifest = JSON.parse(__sdk_manifest_json);
const __namespaceMethods = __manifest.byNamespace;
const __topLevelKeys = new Set(__manifest.topLevel);
const __namespaceKeys = new Set(Object.keys(__namespaceMethods));
// Namespaces that EXIST in the SDK but are hidden by the current mode/tier
// (e.g. \`agents\` when running below admin). Accessing one should throw a
// structured "not available in this mode" error, not return undefined and fail
// later with the opaque "Cannot read properties of undefined (reading 'list')".
const __hiddenNamespaceKeys = new Set(
  (__manifest.allNamespaces || []).filter((ns) => !__namespaceKeys.has(ns))
);

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
    if (r === undefined) return undefined;
    const envelope = JSON.parse(r);
    if (!envelope || envelope.__lobu_sdk_dispatch !== 1) {
      throw new Error('InvalidSDKDispatchEnvelope');
    }
    if (!envelope.ok) {
      const error = new Error(envelope.error?.message || 'ClientSDK call failed');
      error.name = envelope.error?.name || 'ClientSdkActionError';
      if (envelope.error?.details !== undefined) error.details = envelope.error.details;
      throw error;
    }
    return envelope.has_value ? envelope.value : undefined;
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

// A namespace known to the SDK but filtered out of THIS mode. Every method
// access returns a thunk that throws the same structured error the host would,
// so discovery (search_sdk) and runtime agree instead of the guest hitting an
// undefined property. Mirrors the client.org stub pattern above.
function __makeHiddenNamespaceProxy(ns) {
  const err = () => {
    throw new Error('NamespaceNotAvailable: the \\'' + ns + '\\' namespace is not available in this SDK mode (read-only or restricted tier). Re-run with a session that has the required access, or use a namespace listed by search_sdk in this mode.');
  };
  return new Proxy({}, {
    get: (_, k) => __isReservedKey(k) ? undefined : err,
    has: () => true,
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  });
}

function __makeClient(orgPath) {
  const allKeys = new Set([...__topLevelKeys, ...__namespaceKeys, ...__hiddenNamespaceKeys]);
  return new Proxy({}, {
    get(_, key) {
      if (__isReservedKey(key)) return undefined;
      const k = String(key);
      // client.org is advertised by search_sdk with a "Throws
      // CrossOrgAccessDenied on scoped/PAT endpoints" note. When cross-org is
      // unavailable the manifest omits it from __topLevelKeys -- but returning
      // undefined makes client.org('x') fail with the opaque
      // "client.org is not a function", contradicting the docs. Return a stub
      // that throws the SAME structured error the host path raises, so
      // discovery and runtime agree. (This block lives inside a template
      // literal; keep it free of backticks and dollar-brace sequences.)
      if (k === 'org') return __topLevelKeys.has('org')
        ? (slug) => __makeClient([...orgPath, String(slug)])
        : () => { throw new Error('CrossOrgAccessDenied: cross-org access is not available on this connection. Use the unscoped /mcp endpoint with an OAuth session, or reconnect to the target workspace.'); };
      if (__topLevelKeys.has(k)) return __dispatchCall(k, orgPath);
      if (__namespaceKeys.has(k)) return __makeNamespaceProxy(k, orgPath);
      if (__hiddenNamespaceKeys.has(k)) return __makeHiddenNamespaceProxy(k);
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
  try {
  const __entry = module.exports.default
    ?? (typeof module.exports === 'function' ? module.exports : null);
  if (typeof __entry !== 'function') {
    throw new Error('Script must \`export default\` an async function');
  }
  const __extra = JSON.parse(__extra_args_json);
  const __result = await __entry(ctx, client, ...__extra);
    return JSON.stringify({
      __lobu_script_result: 1,
      ok: true,
      value: __result === undefined ? null : __result,
    });
  } catch (error) {
    return JSON.stringify({
      __lobu_script_result: 1,
      ok: false,
      error: {
        name: error?.name || 'Error',
        message: error?.message || String(error),
        stack: error?.stack,
        ...(error?.details === undefined ? {} : { details: error.details }),
      },
    });
  }
})()
`;

// Read a named export instead of invoking the handler — the module top-level
// runs (constructing exports), then we serialize the requested export. `__name`
// is host-injected via jail, never interpolated into source.
const EXTRACT_RUNNER = `
(async () => {
  const __v = module.exports[__extract_name];
  return __v === undefined || __v === null ? null : JSON.stringify(__v);
})()
`;

export async function runScript(
	options: RunScriptOptions,
): Promise<RunScriptResult> {
	const started = Date.now();
	const limits = clampLimits(options.limits);
	const sdkMode: SDKMode = options.sdkMode ?? "full";
	const allowCrossOrg = options.allowCrossOrg ?? false;
	const manifest = enumerateSDKManifest(sdkMode, {
		allowCrossOrg,
		maxAccessLevel: options.maxAccessLevel,
	});

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
	// Internal host↔guest copy guard (SDK call envelopes + console crossing).
	// Distinct from the agent-facing return-value cap: this bounds what the host
	// copies, not what the caller receives.
	let crossingBytes = 0;
	let crossingOversize = false;
	// Captured console budget. Logs are diagnostics: once full they drop, they
	// never fail a run.
	let logBytesUsed = 0;
	let logFull = false;

	const crossingOversizeError = () =>
		new Error(
			`OutputSizeExceeded: script output exceeded the ${limits.crossingBytes}-byte crossing budget (SDK call results and console output)`,
		);

	/** Charge an SDK call envelope against the crossing guard. */
	function chargeCrossing(json: string): void {
		crossingBytes += Buffer.byteLength(json, "utf8");
		if (crossingBytes > limits.crossingBytes) {
			crossingOversize = true;
			throw crossingOversizeError();
		}
	}

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
				// Latch off once the crossing budget is saturated: don't run any
				// more SDK work (DB/HTTP), just surface the oversize failure.
				if (crossingOversize) {
					throw crossingOversizeError();
				}
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
						skipped: isSkippedUnderDryRun({
							dryRun: options.dryRun,
							dryRunDispatchPaths: options.dryRunDispatchPaths,
							access,
							path,
						}),
					};
					sdkCallTrace.push(trace);
					if (trace.skipped) {
						sideEffectPreview.push(trace);
						return { dry_run: true, skipped_call: path, access };
					}
					return namespace[method](...args);
				})();

				let result: unknown;
				try {
					result = await raceAgainstAbort(
						dispatchPromise,
						abortController.signal,
					);
				} catch (error) {
					if (error instanceof ClientSdkActionError) {
						const json = JSON.stringify({
							__lobu_sdk_dispatch: 1,
							ok: false,
							error: {
								name: error.name,
								message: error.message,
								details: safeErrorDetails(error.result),
							},
						});
						chargeCrossing(json);
						return json;
					}
					throw error;
				}
				const json = JSON.stringify({
					__lobu_sdk_dispatch: 1,
					ok: true,
					has_value: result !== undefined,
					...(result === undefined ? {} : { value: result }),
				});
				chargeCrossing(json);
				return json;
			}),
		);

		await jail.set(
			"__console_call",
			new ivm.Reference((level: "log" | "warn" | "error", message: string) => {
				// Once saturated, stop processing console calls entirely. The
				// crossing guard can't throw here (the guest console swallows host
				// errors), so saturation surfaces at the next dispatch entry check
				// or at the final return via `crossingOversize`.
				if (crossingOversize) return;
				crossingBytes += Buffer.byteLength(message, "utf8");
				if (crossingBytes > limits.crossingBytes) {
					crossingOversize = true;
					return;
				}
				if (logFull) return;
				const bytes = Buffer.byteLength(message, "utf8");
				if (logBytesUsed + bytes > limits.logBytes) {
					logFull = true;
					logs.push({
						level: "warn",
						message: `[console output truncated: exceeded ${limits.logBytes} bytes]`,
						ts: Date.now(),
					});
					return;
				}
				logBytesUsed += bytes;
				logs.push({ level, message, ts: Date.now() });
			}),
		);

		await jail.set(
			"__sleep",
			new ivm.Reference(async (ms: number) => {
				await sleepAgainstAbort(ms, abortController.signal);
			}),
		);

		await jail.set("__ctx_json", JSON.stringify(options.context ?? {}));
		await jail.set(
			"__extra_args_json",
			JSON.stringify(options.extraArgs ?? []),
		);
		await jail.set("__sdk_manifest_json", JSON.stringify(manifest));
		if (options.extractExport) {
			await jail.set("__extract_name", options.extractExport);
		}

		const script = await isolate.compileScript(
			`${GUEST_PREAMBLE}\n${compiled}\n${options.extractExport ? EXTRACT_RUNNER : GUEST_RUNNER}`,
		);
		const returnJson = (await withTimeout(
			script.run(context, {
				timeout: limits.timeoutMs,
				promise: true,
				copy: true,
			}) as Promise<string | null>,
			limits.timeoutMs,
		)) as string | null;
		if (crossingOversize) {
			throw crossingOversizeError();
		}
		if (returnJson) {
			const envelopeBytes = Buffer.byteLength(returnJson, "utf8");
			// `extractExport` reads a JSON Schema; a partially-cut schema would
			// parse as a valid-but-wrong contract, so that path keeps hard-fail.
			// Interactive return values are truncated below instead.
			if (options.extractExport && envelopeBytes > limits.outputBytes) {
				throw new Error(
					`OutputSizeExceeded: extracted export exceeded ${limits.outputBytes} bytes`,
				);
			}
		}
		const parsedResult = returnJson ? JSON.parse(returnJson) : null;
		if (!options.extractExport) {
			if (
				!parsedResult ||
				typeof parsedResult !== "object" ||
				parsedResult.__lobu_script_result !== 1
			) {
				throw new Error("InvalidScriptResultEnvelope");
			}
			if (parsedResult.ok !== true) {
				const scriptError = parsedResult.error as
					| {
							name?: string;
							message?: string;
							stack?: string;
							details?: unknown;
					  }
					| undefined;
				return {
					success: false,
					logs,
					error: classifyRuntimeError(scriptError ?? {}),
					durationMs: Date.now() - started,
					sdkCalls,
					sdkCallTrace,
					sideEffectPreview,
				};
			}
		}
		const returnValue = options.extractExport
			? parsedResult
			: parsedResult.value;

		// Interactive return values truncate to fit instead of failing the run:
		// the agent works with partial data and is told exactly what was dropped.
		let returnTruncated: TruncatedValueInfo | undefined;
		let finalReturnValue = returnValue;
		if (
			!options.extractExport &&
			jsonBytes(returnValue) > limits.outputBytes - ENVELOPE_OVERHEAD_BYTES
		) {
			const truncated = truncateJsonValue(
				returnValue,
				Math.max(1, limits.outputBytes - ENVELOPE_OVERHEAD_BYTES),
			);
			finalReturnValue = truncated.value;
			returnTruncated = truncated.meta;
		}

		return {
			success: true,
			returnValue: finalReturnValue,
			...(returnTruncated ? { returnTruncated } : {}),
			logs,
			durationMs: Date.now() - started,
			sdkCalls,
			sdkCallTrace,
			sideEffectPreview,
		};
	} catch (err) {
		const e = err as Error;
		return {
			success: false,
			logs,
			error: classifyRuntimeError(e),
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
