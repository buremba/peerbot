/**
 * Compiles a TypeScript user-script via esbuild, runs it in a V8 isolate, and
 * bridges SDK calls back to the host. Caps: 1 MB output, 200 SDK calls,
 * 60s wall-clock. `client.org()` is stateless — each guest call carries
 * `orgPath` so the host re-walks org swaps without holding refs.
 */

import type { ClientSDK } from "./client-sdk";
import { type SDKMode, enumerateSDKManifest } from "./sdk-manifest";

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

export interface LogEntry {
  level: "log" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
  ts: number;
}

export interface RunScriptResult {
  success: boolean;
  returnValue?: unknown;
  logs: LogEntry[];
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

function clampNumber(value: number | undefined, fallback: number, min: number, max: number) {
  const n = Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(n ?? fallback, max));
}

function clampLimits(limits?: RunLimits): Required<RunLimits> {
  return {
    memoryMb: clampNumber(limits?.memoryMb, DEFAULT_LIMITS.memoryMb, 8, DEFAULT_LIMITS.memoryMb),
    timeoutMs: clampNumber(limits?.timeoutMs, DEFAULT_LIMITS.timeoutMs, 1, DEFAULT_LIMITS.timeoutMs),
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
      reject(new Error(`TimeoutError: script exceeded ${timeoutMs}ms wall-clock budget`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function raceAgainstAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error("AbortError: signal aborted"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("AbortError: signal aborted"),
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

async function loadIsolatedVm(): Promise<IsolatedVmRuntime | null> {
  // Node 25 imports the native addon but crashes on isolate construction;
  // fail closed rather than taking down the MCP server.
  const nodeMajor = Number(process.versions.node?.split(".")[0] ?? 0);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 22 || nodeMajor >= 25) {
    return null;
  }

  try {
    const mod = (await import("isolated-vm")) as unknown as IsolatedVmRuntime & {
      default?: IsolatedVmRuntime;
      "module.exports"?: IsolatedVmRuntime;
    };
    return mod.default ?? mod["module.exports"] ?? mod;
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
  const manifest = enumerateSDKManifest(sdkMode, {
    allowCrossOrg: options.allowCrossOrg ?? false,
  });

  // Wall-clock timeout. Each dispatch races the abort signal so the script
  // returns promptly; upstream DB/HTTP itself doesn't cancel today.
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => {
    abortController.abort(
      new Error(`TimeoutError: script exceeded ${limits.timeoutMs}ms wall-clock budget`),
    );
  }, limits.timeoutMs);

  // Resolve the SDK lazily so callers that pass a builder receive the
  // wall-clock signal — opted-in handlers race their work against it to
  // unblock the awaiting caller on timeout.
  const baseSdk: ClientSDK =
    typeof options.sdk === "function" ? options.sdk(abortController.signal) : options.sdk;

  const logs: LogEntry[] = [];
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
    const e = err as Error & { errors?: Array<{ location?: { line?: number; column?: number } }> };
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
          throw new Error(`QuotaExceeded: SDK call quota of ${limits.sdkCallQuota} reached`);
        }
        if (abortController.signal.aborted) {
          throw new Error(`TimeoutError: script exceeded ${limits.timeoutMs}ms wall-clock budget`);
        }

        const { args, orgPath } = JSON.parse(payloadJson) as {
          args: unknown[];
          orgPath: string[];
        };

        let target: ClientSDK = baseSdk;
        for (const slug of orgPath) target = await target.org(slug);

        const dispatchPromise: Promise<unknown> = (async () => {
          if (path === "log") {
            target.log(args[0] as string, args[1] as Record<string, unknown> | undefined);
            return undefined;
          }
          if (path === "query") return target.query(args[0] as string);
          const [ns, method] = path.split(".");
          // `__sdk_dispatch` is a guest-visible global, so a malicious script
          // could call it directly with an inherited path like `entities.constructor`.
          // Restrict to own enumerable namespaces and own methods; the guest-side
          // manifest filter is the friendly path, this is the security backstop.
          if (!ns || !method || !Object.prototype.hasOwnProperty.call(target, ns)) {
            throw new Error(`Unknown SDK namespace: '${ns}'`);
          }
          const namespace = (target as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[ns];
          if (
            !namespace ||
            typeof namespace !== "object" ||
            !Object.prototype.hasOwnProperty.call(namespace, method) ||
            typeof namespace[method] !== "function"
          ) {
            throw new Error(`Unknown SDK method: '${path}'`);
          }
          return namespace[method](...args);
        })();

        const result = await raceAgainstAbort(dispatchPromise, abortController.signal);
        if (result === undefined) return undefined;
        const json = JSON.stringify(result);
        outputBytes += Buffer.byteLength(json, "utf8");
        if (outputBytes > limits.outputBytes) {
          throw new Error(`OutputSizeExceeded: combined output exceeded ${limits.outputBytes} bytes`);
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
    await jail.set("__extra_args_json", JSON.stringify(options.extraArgs ?? []));
    await jail.set("__sdk_manifest_json", JSON.stringify(manifest));

    const script = await isolate.compileScript(`${GUEST_PREAMBLE}\n${compiled}\n${GUEST_RUNNER}`);
    const returnJson = (await withTimeout(
      script.run(context, { timeout: limits.timeoutMs, promise: true, copy: true }) as Promise<string | null>,
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
    };
  } catch (err) {
    const e = err as Error;
    const isTimeout = /script execution timed out|TimeoutError/i.test(e.message);
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
    };
  } finally {
    clearTimeout(abortTimer);
    if (isolate && !isolate.isDisposed) {
      isolate.dispose();
    }
  }
}

export function getDefaultLimits(): Required<RunLimits> {
  return { ...DEFAULT_LIMITS };
}
