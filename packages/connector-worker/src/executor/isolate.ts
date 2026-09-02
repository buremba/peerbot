/**
 * Isolate Executor
 *
 * Runs a compiled pure-JS connector bundle inside a V8 isolate in the worker
 * process (`isolated-vm`), speaking the same `SyncExecutor` contract as
 * `SubprocessExecutor`: `ExecutorJob` in, `ExecutorResult` out, SDK context
 * calls mapped onto `ExecutionHooks`. Unlike the process lane the connector
 * gets no filesystem, no sockets and no module loader: every effect crosses
 * the boundary as a named host capability, so the host holds the network and
 * can enforce a domain allowlist and a body cap on `fetch`.
 *
 * Selected only for jobs that carry `lane: 'isolate'` (`executor/select.ts`);
 * a bundle that still requires a Node builtin is rejected before any isolate
 * work with `IsolateLaneIneligibleError`.
 */

import type { EventEnvelope } from '@lobu/connector-sdk';
import { IsolateHost, IsolateHostError, type IsolateTerminalState } from '../isolate/bridge.js';
import { assertIsolateEligible } from '../isolate/eligibility.js';
import type { IsolatedVm } from '../isolate/ivm-types.js';
import { isolatedVmUnavailableReason, loadIsolatedVm } from '../isolate/load.js';
import { buildConnectorConfig } from './connector-config.js';
import type {
  ExecutionHooks,
  ExecutionOptions,
  ExecutorJob,
  ExecutorResult,
  SyncExecutor,
} from './interface.js';
import { redactOutput } from './redact.js';
import { RingBuffer, SubprocessError } from './subprocess.js';

export type IsolateLogLevel = 'log' | 'info' | 'debug' | 'warn' | 'error';

export interface IsolateExecutorOptions {
  /** Wall-clock budget in ms (default 600000 = 10 minutes); `0` disables it. */
  timeoutMs: number;
  /** V8 heap limit in MB (default 512, matching the process lane's old space). */
  memoryMb: number;
  /** Cap on any single message crossing the boundary (default 16 MiB). */
  messageBytes: number;
  /** Cap on a fetched response body (default 16 MiB). */
  fetchBodyBytes: number;
  /** Cap on total console output forwarded per run (default 1 MiB). */
  logBytes: number;
  /**
   * Hosts the connector may fetch: exact host or any subdomain. Empty (the
   * default) closes egress: every fetch is denied before a request leaves the
   * host. There is no unrestricted mode. The gateway supplies the connector's
   * declared domains once the wire carries them; until then an isolate-lane
   * run has no network.
   */
  allowedDomains: readonly string[];
  /** Where redacted console lines go (default: the worker's stdout/stderr). */
  logSink: (level: IsolateLogLevel, line: string) => void;
}

const MIB = 1024 * 1024;

const DEFAULT_OPTIONS: IsolateExecutorOptions = {
  timeoutMs: 600_000,
  memoryMb: 512,
  messageBytes: 16 * MIB,
  fetchBodyBytes: 16 * MIB,
  logBytes: MIB,
  allowedDomains: [],
  logSink: (level, line) => {
    const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
    stream.write(`[isolate] ${line}\n`);
  },
};

const STREAM_TAIL_CAP_BYTES = 16 * 1024;
const MAX_REDIRECTS = 20;

/** Thrown when a job demands the isolate lane on a host that cannot run one. */
export class IsolateRuntimeUnavailableError extends Error {
  constructor(reason: string | null) {
    const runtime = typeof (process.versions as { bun?: string }).bun === 'string'
      ? `Bun ${process.versions.bun}`
      : `Node ${process.versions.node}`;
    super(
      `isolate lane required but isolated-vm is unavailable on this worker (${runtime})` +
        (reason ? `: ${reason}` : ': the native addon failed to load')
    );
    this.name = 'IsolateRuntimeUnavailableError';
  }
}

interface GuestErrorDescription {
  name?: string;
  message?: string;
  stack?: string;
  httpStatus?: number;
}

type GuestOutcome =
  | { ok: true; result: ExecutorResult }
  | { ok: false; error: GuestErrorDescription };

interface GuestFetchRequest {
  id: number;
  url: string;
  method: string;
  headers: [string, string][];
  redirect: 'follow' | 'manual' | 'error';
}

interface HostFetchReply {
  status: number;
  statusText: string;
  url: string;
  redirected: boolean;
  headers: [string, string][];
  body: Uint8Array;
}

/** What `probe()` learns from loading a bundle without running a job. */
export interface IsolateProbeResult {
  /** `definition.key` of the exported ConnectorRuntime, when it exposes one. */
  connectorKey: string | null;
  /** Peak heap after module init and construction, in bytes. */
  heapUsedBytes: number | null;
  loadMs: number;
}

/**
 * Guest-side port of `child-runner.ts`'s `executeConnectorRuntime`: same
 * mode dispatch, same context shapes, same result and error envelopes. Runs
 * after the prelude and the connector bundle in one script; its final
 * expression is the promise the host awaits.
 */
const GUEST_RUNNER = String.raw`
(async function () {
  var H = globalThis.__lobuHost;
  var job = JSON.parse(__job_json);
  var mergedConfig = JSON.parse(__config_json);
  var EVENT_CHUNK_SIZE = 100;

  function isConnectorRuntimeClass(val) {
    return typeof val === 'function' && !!(val.prototype && val.prototype.sync) && !!(val.prototype && val.prototype.execute);
  }
  function findRuntimeClass(mod) {
    if (!mod || typeof mod !== 'object') return null;
    var values = Object.values(mod);
    for (var i = 0; i < values.length; i++) if (isConnectorRuntimeClass(values[i])) return values[i];
    if (isConnectorRuntimeClass(mod.default)) return mod.default;
    return null;
  }

  function chromeDispatcher() {
    return {
      dispatch: function (actionKey, actionInput) {
        return H.async('dispatchChromeAction', String(actionKey), JSON.stringify(actionInput === undefined ? {} : actionInput)).then(function (json) {
          return json ? JSON.parse(json) : {};
        });
      }
    };
  }

  function withDispatcher(sessionState) {
    var out = Object.assign({}, sessionState || {});
    out.chrome_dispatcher = chromeDispatcher();
    return out;
  }

  async function emitEvents(events) {
    for (var index = 0; index < events.length; index += EVENT_CHUNK_SIZE) {
      await H.async('emitEvents', JSON.stringify(events.slice(index, index + EVENT_CHUNK_SIZE)));
    }
  }

  async function updateCheckpoint(checkpoint) {
    await H.async('updateCheckpoint', JSON.stringify(checkpoint === undefined ? null : checkpoint));
  }

  async function executeConnectorRuntime(instance) {
    if (job.mode === 'authenticate') {
      var authController = new AbortController();
      var authResult = await instance.authenticate({
        config: job.config,
        previousCredentials: job.previousCredentials,
        emit: async function (artifact) {
          await H.async('emitAuthArtifact', JSON.stringify(artifact === undefined ? {} : artifact));
        },
        awaitSignal: function (name, options) {
          var timeoutMs = options && typeof options.timeoutMs === 'number' ? options.timeoutMs : null;
          return H.async('awaitAuthSignal', String(name), timeoutMs).then(function (json) { return json ? JSON.parse(json) : {}; });
        },
        signal: authController.signal
      });
      if (!authResult || !authResult.credentials) throw new Error('authenticate() returned no credentials');
      return { mode: 'authenticate', auth: { credentials: authResult.credentials, metadata: authResult.metadata } };
    }

    if (job.mode === 'action') {
      var actionResult = await instance.execute({
        actionKey: job.actionKey,
        input: job.actionInput,
        sessionState: withDispatcher(job.sessionState),
        credentials: job.credentials,
        config: mergedConfig
      });
      if (!actionResult || !actionResult.success) {
        throw new Error((actionResult && actionResult.error) || ("Action '" + job.actionKey + "' failed"));
      }
      return { mode: 'action', output: actionResult.output || {} };
    }

    if (job.mode === 'webhook_register') {
      var registration = await instance.registerWebhook({
        config: mergedConfig, credentials: job.credentials, sessionState: job.sessionState, callbackUrl: job.callbackUrl
      });
      if (!registration || !registration.externalId) throw new Error('registerWebhook() returned no externalId');
      var webhookScheme = (instance.definition && instance.definition.webhook) || null;
      return { mode: 'webhook_register', registration: registration, webhookScheme: webhookScheme };
    }

    if (job.mode === 'webhook_unregister') {
      await instance.unregisterWebhook({
        config: mergedConfig, credentials: job.credentials, sessionState: job.sessionState, externalId: job.externalId
      });
      return { mode: 'webhook_unregister' };
    }

    if (job.mode === 'query') {
      var queryResult = await instance.query({
        query: job.query, config: mergedConfig, credentials: job.credentials, sessionState: job.sessionState,
        limit: job.limit, offset: job.offset, sort: job.sort
      });
      return { mode: 'query', rows: (queryResult && queryResult.rows) || [], columns: queryResult && queryResult.columns, total: queryResult && queryResult.total };
    }

    if (job.mode === 'read') {
      var readResult = await instance.read({
        feedId: job.feedId === null ? undefined : job.feedId, feedKey: job.feedKey, query: job.query, cursor: job.cursor,
        config: mergedConfig, credentials: job.credentials, sessionState: job.sessionState,
        limit: job.limit, offset: job.offset, sort: job.sort
      });
      return {
        mode: 'read', rows: (readResult && readResult.rows) || [], columns: readResult && readResult.columns,
        total: readResult && readResult.total, nextCursor: readResult && readResult.nextCursor, hasMore: readResult && readResult.hasMore
      };
    }

    var syncResult = await instance.sync({
      feedKey: job.feedKey,
      feedId: job.feedId,
      config: mergedConfig,
      checkpoint: job.checkpoint,
      credentials: job.credentials,
      entityIds: job.entityIds,
      sessionState: withDispatcher(job.sessionState),
      emitEvents: emitEvents,
      updateCheckpoint: updateCheckpoint
    });
    var trailingEvents = syncResult && Array.isArray(syncResult.events) ? syncResult.events : [];
    await emitEvents(trailingEvents);
    var meta = (syncResult && syncResult.metadata) || {};
    return {
      mode: 'sync',
      checkpoint: syncResult && syncResult.checkpoint !== undefined ? syncResult.checkpoint : null,
      auth_update: syncResult && syncResult.auth_update !== undefined ? syncResult.auth_update : null,
      metadata: Object.assign({
        items_found: typeof meta.items_found === 'number' ? meta.items_found : trailingEvents.length,
        items_skipped: typeof meta.items_skipped === 'number' ? meta.items_skipped : 0
      }, meta)
    };
  }

  try {
    var RuntimeClass = findRuntimeClass(module.exports);
    if (!RuntimeClass) throw new Error('No ConnectorRuntime class found. Expected a class with sync() and execute() methods.');
    var instance = new RuntimeClass();
    var result = await executeConnectorRuntime(instance);
    return JSON.stringify({ ok: true, result: result });
  } catch (error) {
    return JSON.stringify({ ok: false, error: H.describeError(error) });
  }
})()
`;

/** Loads the bundle, constructs the runtime and reports its definition key. */
const GUEST_PROBE = String.raw`
(function () {
  var H = globalThis.__lobuHost;
  try {
    var mod = module.exports;
    var def = mod && typeof mod === 'object' ? mod.default : undefined;
    var values = mod && typeof mod === 'object' ? Object.values(mod) : [];
    var RuntimeClass = null;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (typeof v === 'function' && v.prototype && v.prototype.sync && v.prototype.execute) { RuntimeClass = v; break; }
    }
    if (!RuntimeClass && typeof def === 'function' && def.prototype && def.prototype.sync && def.prototype.execute) RuntimeClass = def;
    if (!RuntimeClass) throw new Error('No ConnectorRuntime class found. Expected a class with sync() and execute() methods.');
    var instance = new RuntimeClass();
    var key = instance && instance.definition && typeof instance.definition.key === 'string' ? instance.definition.key : null;
    return JSON.stringify({ ok: true, connectorKey: key });
  } catch (error) {
    return JSON.stringify({ ok: false, error: H.describeError(error) });
  }
})()
`;

function jsonLiteral(value: unknown): string {
  // A JSON string literal is a valid JS string literal once U+2028/U+2029 are escaped.
  return JSON.stringify(JSON.stringify(value)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function parseGuestJson(value: unknown, what: string): unknown {
  if (typeof value !== 'string') throw new Error(`${what}: expected a JSON string from the guest, got ${typeof value}`);
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${what}: guest returned malformed JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
}

/** IPv4 dotted quads and bracketed IPv6 literals never match as "subdomains". */
function isIpLiteral(host: string): boolean {
  return host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host);
}

function hostAllowed(hostname: string, allowedDomains: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (isIpLiteral(host)) return allowedDomains.includes(host);
  return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Request headers that must not follow a redirect to another origin. */
const CROSS_ORIGIN_SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

/** Same text the guest `fetch` uses, so both rejections read alike. */
const UNSUPPORTED_SCHEME_MESSAGE = 'fetch failed: only http: and https: URLs are supported on the isolate lane';

export class IsolateExecutor implements SyncExecutor {
  private readonly options: IsolateExecutorOptions;

  constructor(options?: Partial<IsolateExecutorOptions>) {
    const merged: IsolateExecutorOptions = {
      ...DEFAULT_OPTIONS,
      ...Object.fromEntries(Object.entries(options ?? {}).filter(([, v]) => v !== undefined)),
    };
    if (!Number.isFinite(merged.timeoutMs) || merged.timeoutMs < 0) {
      throw new RangeError(`timeoutMs must be a non-negative number, got ${String(merged.timeoutMs)}`);
    }
    if (!Number.isFinite(merged.memoryMb) || merged.memoryMb < 8) {
      throw new RangeError(`memoryMb must be at least 8, got ${String(merged.memoryMb)}`);
    }
    if (!Number.isFinite(merged.messageBytes) || merged.messageBytes < 1024) {
      throw new RangeError(`messageBytes must be at least 1024, got ${String(merged.messageBytes)}`);
    }
    if (!Number.isFinite(merged.fetchBodyBytes) || merged.fetchBodyBytes < 1024) {
      throw new RangeError(`fetchBodyBytes must be at least 1024, got ${String(merged.fetchBodyBytes)}`);
    }
    if (!Number.isFinite(merged.logBytes) || merged.logBytes < 1024) {
      throw new RangeError(`logBytes must be at least 1024, got ${String(merged.logBytes)}`);
    }
    const domains = merged.allowedDomains.map(normalizeDomain);
    if (domains.some((d) => d.length === 0)) {
      throw new RangeError('allowedDomains entries must be hosts; pass an empty list to close egress');
    }
    merged.allowedDomains = domains;
    this.options = merged;
  }

  private async requireIsolatedVm(): Promise<IsolatedVm> {
    const ivm = await loadIsolatedVm();
    if (!ivm) throw new IsolateRuntimeUnavailableError(isolatedVmUnavailableReason());
    return ivm;
  }

  /**
   * Load the bundle in an isolate without running a job: module init plus
   * `new RuntimeClass()`. Rejects with `IsolateLaneIneligibleError` before any
   * isolate work when the bundle still requires a Node builtin.
   */
  async probe(compiledCode: string): Promise<IsolateProbeResult> {
    assertIsolateEligible(compiledCode);
    const ivm = await this.requireIsolatedVm();
    const started = Date.now();
    const host = await IsolateHost.create({
      ivm,
      memoryMb: this.options.memoryMb,
      messageBytes: this.options.messageBytes,
      env: {},
      sync: { log: () => undefined, fatal: () => undefined, fetchAbort: () => undefined },
      async: {},
    });
    try {
      const raw = await host.run(`${compiledCode}\n${GUEST_PROBE}`, { timeoutMs: this.options.timeoutMs || 60_000 });
      const outcome = parseGuestJson(raw, 'probe') as { ok: boolean; connectorKey?: string | null; error?: GuestErrorDescription };
      if (!outcome.ok) {
        const error = new Error(redactOutput(outcome.error?.message ?? 'connector bundle failed to load'));
        error.name = outcome.error?.name ? redactOutput(String(outcome.error.name)) : 'Error';
        throw error;
      }
      const heap = host.heapStatistics();
      return { connectorKey: outcome.connectorKey ?? null, heapUsedBytes: heap?.used_heap_size ?? null, loadMs: Date.now() - started };
    } finally {
      host.dispose();
    }
  }

  async execute(
    compiledCode: string,
    job: ExecutorJob,
    hooks?: ExecutionHooks,
    options?: ExecutionOptions
  ): Promise<ExecutorResult> {
    const nixPackages = options?.nixPackages ?? [];
    if (nixPackages.length > 0) {
      throw new Error(
        `This connector declares native packages [${nixPackages.join(', ')}], which the isolate lane cannot provide; route it to the process lane.`
      );
    }
    assertIsolateEligible(compiledCode);
    const ivm = await this.requireIsolatedVm();

    const tail = new RingBuffer(STREAM_TAIL_CAP_BYTES);
    let logBytesUsed = 0;
    let logTruncated = false;
    let hookFailure: unknown = null;
    let guestFatal: GuestErrorDescription | null = null;
    // Hook invocations run one at a time, in arrival order, as the process
    // lane's IPC task chain does.
    let processingChain: Promise<void> = Promise.resolve();
    const runAbort = new AbortController();
    const pendingSleeps = new Set<ReturnType<typeof setTimeout>>();
    const inflightFetches = new Map<number, AbortController>();
    let host: IsolateHost | null = null;

    const terminate = (state: IsolateTerminalState) => {
      runAbort.abort();
      for (const timer of pendingSleeps) clearTimeout(timer);
      pendingSleeps.clear();
      for (const controller of inflightFetches.values()) controller.abort();
      inflightFetches.clear();
      host?.terminate(state);
    };

    const queueHook = (task: () => Promise<void> | void): Promise<void> => {
      const next = processingChain.then(async () => {
        await task();
      });
      // Keep the chain alive after a failure so later calls still see the
      // terminal state instead of re-running against a torn-down host.
      processingChain = next.catch(() => undefined);
      next.catch((error: unknown) => {
        if (hookFailure === null) hookFailure = error;
        terminate({ name: 'HookFailure', message: error instanceof Error ? error.message : String(error) });
      });
      return next;
    };

    const log = (level: unknown, text: unknown) => {
      const line = typeof text === 'string' ? text : String(text);
      const lvl: IsolateLogLevel =
        level === 'warn' || level === 'error' || level === 'info' || level === 'debug' ? level : 'log';
      tail.append(`${line}\n`);
      if (logTruncated) return undefined;
      const bytes = Buffer.byteLength(line, 'utf8');
      if (logBytesUsed + bytes > this.options.logBytes) {
        logTruncated = true;
        this.options.logSink('warn', `[console output truncated: exceeded ${this.options.logBytes} bytes]`);
        return undefined;
      }
      logBytesUsed += bytes;
      this.options.logSink(lvl, redactOutput(line));
      return undefined;
    };

    const fetchCapability = async (request: unknown, body: unknown): Promise<HostFetchReply> => {
      const req = request as GuestFetchRequest;
      if (!req || typeof req !== 'object' || typeof req.url !== 'string' || typeof req.id !== 'number') {
        throw new TypeError('fetch: malformed request from guest');
      }
      const controller = new AbortController();
      inflightFetches.set(req.id, controller);
      const onRunAbort = () => controller.abort();
      runAbort.signal.addEventListener('abort', onRunAbort, { once: true });
      try {
        return await this.hostFetch(req, body, controller.signal);
      } finally {
        runAbort.signal.removeEventListener('abort', onRunAbort);
        inflightFetches.delete(req.id);
      }
    };

    const mergedConfig = job.mode === 'authenticate' ? job.config : buildConnectorConfig(job);

    host = await IsolateHost.create({
      ivm,
      memoryMb: this.options.memoryMb,
      messageBytes: this.options.messageBytes,
      env: job.env,
      sync: {
        log,
        fatal: (description: unknown) => {
          const desc = (description ?? {}) as GuestErrorDescription;
          if (!guestFatal) guestFatal = desc;
          terminate({ name: 'UncaughtException', message: desc.message ?? 'uncaught exception in the connector' });
          return undefined;
        },
        fetchAbort: (id: unknown) => {
          if (typeof id === 'number') inflightFetches.get(id)?.abort();
          return undefined;
        },
      },
      async: {
        sleep: (ms: unknown) => {
          const delay = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.min(ms, 2_147_483_647) : 0;
          return new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              pendingSleeps.delete(timer);
              resolve();
            }, delay);
            pendingSleeps.add(timer);
          });
        },
        emitEvents: async (json: unknown) => {
          const parsed = parseGuestJson(json, 'emitEvents');
          const events: EventEnvelope[] = Array.isArray(parsed) ? (parsed as EventEnvelope[]) : [];
          await queueHook(async () => {
            await hooks?.onEventChunk?.(events);
          });
          return undefined;
        },
        updateCheckpoint: async (json: unknown) => {
          const parsed = parseGuestJson(json, 'updateCheckpoint');
          const checkpoint = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
          await queueHook(async () => {
            await hooks?.onCheckpointUpdate?.(checkpoint);
          });
          return undefined;
        },
        emitAuthArtifact: async (json: unknown) => {
          const parsed = parseGuestJson(json, 'emitAuthArtifact');
          const artifact = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
          await queueHook(async () => {
            await hooks?.onAuthArtifact?.(artifact);
          });
          return undefined;
        },
        awaitAuthSignal: async (name: unknown, timeoutMs: unknown) => {
          if (!hooks?.onAwaitAuthSignal) throw new Error('awaitSignal is not supported in this context');
          const signal = await hooks.onAwaitAuthSignal(String(name), {
            timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
          });
          return JSON.stringify(signal ?? {});
        },
        dispatchChromeAction: async (actionKey: unknown, inputJson: unknown) => {
          if (!hooks?.onChromeDispatch) {
            throw new Error('chrome_dispatcher is not available in this execution context (no onChromeDispatch hook)');
          }
          const parsed = parseGuestJson(inputJson, 'dispatchChromeAction');
          const input = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
          const output = await hooks.onChromeDispatch(String(actionKey), input);
          return JSON.stringify(output ?? {});
        },
        fetch: fetchCapability,
      },
    });

    const redactedTail = () => redactOutput(tail.toString());
    const withTail = (prefix: string) => {
      const t = redactedTail();
      return t ? `${prefix}\n[console]\n${t}` : prefix;
    };

    try {
      const source = `var __job_json = ${jsonLiteral(job)};\nvar __config_json = ${jsonLiteral(mergedConfig)};\n${compiledCode}\n${GUEST_RUNNER}`;
      let raw: unknown;
      try {
        raw = await host.run(source, { timeoutMs: this.options.timeoutMs });
      } catch (error) {
        if (hookFailure !== null) throw hookFailure;
        if (guestFatal) throw this.guestError(guestFatal, redactedTail());
        if (error instanceof IsolateHostError) {
          if (error.kind === 'timeout') {
            throw new SubprocessError(withTail(`Feed execution timed out after ${this.options.timeoutMs}ms`), {
              exitCode: null,
              exitSignal: null,
              outputTail: redactedTail(),
              exitReason: 'timeout',
            });
          }
          if (error.kind === 'memory') {
            throw new SubprocessError(withTail(`Isolate out of memory (limit ${this.options.memoryMb} MB)`), {
              exitCode: null,
              exitSignal: null,
              outputTail: redactedTail(),
              exitReason: 'oom',
            });
          }
          throw new SubprocessError(withTail(error.message), {
            exitCode: null,
            exitSignal: null,
            outputTail: redactedTail(),
            exitReason: 'crash',
          }, { cause: error });
        }
        // The guest threw during module init, before the runner could catch it.
        throw this.guestError(
          error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) },
          redactedTail()
        );
      }
      // Wait for hooks the guest fired without awaiting (or whose promise the
      // guest dropped) before reporting the result, as the process lane does.
      await processingChain;
      if (hookFailure !== null) throw hookFailure;
      const outcome = parseGuestJson(raw, 'result') as GuestOutcome;
      if (!outcome || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
        throw new Error('result: guest returned a malformed outcome envelope');
      }
      if (!outcome.ok) throw this.guestError(outcome.error ?? {}, redactedTail());
      if (!outcome.result || outcome.result.mode !== job.mode) {
        throw new Error(`result: expected mode '${job.mode}', got '${String(outcome.result?.mode)}'`);
      }
      return outcome.result;
    } finally {
      runAbort.abort();
      for (const timer of pendingSleeps) clearTimeout(timer);
      pendingSleeps.clear();
      host.dispose();
    }
  }

  /** Same shape `SubprocessExecutor` produces for a child `{type:'error'}` message. */
  private guestError(description: GuestErrorDescription, outputTail: string): SubprocessError {
    const rawMessage = description.message ?? 'Connector reported error';
    const error = new SubprocessError(redactOutput(String(rawMessage)), {
      exitCode: null,
      exitSignal: null,
      outputTail,
      exitReason: 'error_message',
      httpStatus:
        typeof description.httpStatus === 'number' && description.httpStatus >= 100 && description.httpStatus < 600
          ? description.httpStatus
          : undefined,
    });
    error.name = description.name ? redactOutput(String(description.name)) : 'SubprocessError';
    if (description.stack) error.stack = redactOutput(String(description.stack));
    return error;
  }

  private async hostFetch(request: GuestFetchRequest, body: unknown, signal: AbortSignal): Promise<HostFetchReply> {
    let url = new URL(request.url);
    // The guest `fetch` rejects other schemes, but `__lobuHost.async('fetch')`
    // is reachable from guest code directly, and a `data:` URL has no host for
    // the allowlist to judge: Node's fetch would resolve it locally.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError(UNSUPPORTED_SCHEME_MESSAGE);
    }
    let method = request.method;
    let headers = new Headers(request.headers);
    let requestBody: Uint8Array | null =
      body instanceof Uint8Array ? body : body instanceof ArrayBuffer ? new Uint8Array(body) : null;
    const redirectMode = request.redirect;
    let redirected = false;

    for (let hop = 0; ; hop++) {
      if (!hostAllowed(url.hostname, this.options.allowedDomains)) {
        const closed =
          this.options.allowedDomains.length === 0 ? ' (egress is closed: no domains were supplied for this run)' : '';
        const denied = new Error(`fetch to ${url.hostname} is not in the connector's allowed domains${closed}`);
        denied.name = 'EgressDenied';
        throw denied;
      }
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: requestBody ? new Uint8Array(requestBody) : undefined,
          signal,
          redirect: 'manual',
        });
      } catch (error) {
        if (signal.aborted) {
          const aborted = new Error('This operation was aborted');
          aborted.name = 'AbortError';
          throw aborted;
        }
        const cause = (error as { cause?: unknown }).cause;
        const failed = new TypeError(`fetch failed${cause instanceof Error ? `: ${cause.message}` : ''}`);
        throw failed;
      }
      const location = response.headers.get('location');
      const isRedirect = response.status >= 300 && response.status <= 399 && location !== null;
      if (isRedirect && redirectMode === 'follow') {
        await response.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) throw new TypeError('fetch failed: redirect count exceeded');
        const next = new URL(location, url);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new TypeError('fetch failed: redirect to a non-http(s) URL');
        }
        if (next.origin !== url.origin) {
          headers = new Headers(headers);
          for (const name of CROSS_ORIGIN_SENSITIVE_HEADERS) headers.delete(name);
        }
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET';
          requestBody = null;
          headers = new Headers(headers);
          for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) {
            headers.delete(name);
          }
        }
        url = next;
        redirected = true;
        continue;
      }
      if (isRedirect && redirectMode === 'error') {
        await response.body?.cancel().catch(() => undefined);
        throw new TypeError('fetch failed: unexpected redirect');
      }
      const bytes = await this.readBodyCapped(response, signal);
      return {
        status: response.status,
        statusText: response.statusText,
        url: url.href,
        redirected,
        headers: [...response.headers.entries()],
        body: bytes,
      };
    }
  }

  private async readBodyCapped(response: Response, signal: AbortSignal): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array(0);
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > this.options.fetchBodyBytes) {
          await reader.cancel().catch(() => undefined);
          const capped = new Error(`fetch response body exceeded the ${this.options.fetchBodyBytes}-byte cap for ${response.url}`);
          capped.name = 'FetchBodyLimitExceeded';
          throw capped;
        }
        chunks.push(value);
        if (signal.aborted) {
          await reader.cancel().catch(() => undefined);
          const aborted = new Error('This operation was aborted');
          aborted.name = 'AbortError';
          throw aborted;
        }
      }
    } finally {
      reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}
