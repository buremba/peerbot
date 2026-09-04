/**
 * Isolate Executor
 *
 * Runs a compiled pure-JS connector bundle inside a V8 isolate in the worker
 * process (`isolated-vm`), speaking the `SyncExecutor` contract: `ExecutorJob`
 * in, `ExecutorResult` out, SDK context calls mapped onto `ExecutionHooks`.
 * Unlike the forked child this replaced, the connector
 * gets no filesystem, no sockets and no module loader: every effect crosses
 * the boundary as a named host capability, so the host holds the network and
 * can enforce a domain allowlist and a body cap on `fetch`.
 *
 * The only executor (`executor/select.ts`);
 * a bundle that still requires a Node builtin is rejected before any isolate
 * work with `IsolateLaneIneligibleError`.
 */

import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import type { EventEnvelope } from '@lobu/connector-sdk';
import { ipFamily, isReservedIp, stripIpv6Brackets } from '@lobu/connector-sdk/ip-reachability';
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
import { RingBuffer, SubprocessError } from './interface.js';

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

/**
 * Names that never denote a public endpoint. This is defence in depth only:
 * any name can point at a private address, so the ENFORCING control is the
 * resolve-and-check in `hostFetch` / `socketOpen`, which runs on the resolved
 * addresses before a socket opens. Denying these by name just fails faster,
 * and without a DNS round trip.
 */
const INTERNAL_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.corp', '.lan', '.home'];

function isInternalHostname(host: string): boolean {
  return host === 'localhost' || INTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Whether a run may reach `hostname`.
 *
 * An EMPTY `allowedDomains` means the public internet, not "closed". The
 * process lane this replaced had no allowlist at all, so closing egress by
 * default would take every connector offline rather than preserve a boundary
 * that never existed; reserved address space stays denied either way. A
 * NON-EMPTY list is a genuine restriction: only those domains and their
 * subdomains, and still never reserved space.
 */
export function hostAllowed(hostname: string, allowedDomains: readonly string[]): boolean {
  const host = stripIpv6Brackets(hostname.toLowerCase().replace(/\.$/, ''));
  // An EXACT entry is always honoured, reserved or not: naming `127.0.0.1` or
  // an internal hostname is how a self-hosted install reaches its own database
  // and how the fixture suites reach their loopback servers. Reserved space is
  // denied only when nothing named it — so an empty list can never reach the
  // metadata endpoint, and `['spotify.com']` cannot either.
  if (allowedDomains.includes(host)) return true;
  if (ipFamily(host) !== 0) return !isReservedIp(host) && allowedDomains.length === 0;
  if (isInternalHostname(host)) return false;
  if (allowedDomains.length === 0) return true;
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

  async execute(
    compiledCode: string,
    job: ExecutorJob,
    hooks?: ExecutionHooks,
    options?: ExecutionOptions
  ): Promise<ExecutorResult> {
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

    interface ActiveSocket {
      id: number;
      sock: net.Socket;
      chunks: string[];
      pendingReads: Array<(res: { data: string | null; done: boolean; error?: string }) => void>;
      closed: boolean;
      closeError: string | null;
    }
    let nextSocketId = 1;
    const activeSockets = new Map<number, ActiveSocket>();
    const closeAllSockets = () => {
      for (const active of activeSockets.values()) {
        try {
          active.closed = true;
          active.sock.destroy();
          while (active.pendingReads.length > 0) {
            const r = active.pendingReads.shift()!;
            r({ data: null, done: true });
          }
        } catch {
          // ignore
        }
      }
      activeSockets.clear();
    };

    const attachSocketListeners = (sock: net.Socket, active: ActiveSocket) => {
      sock.on('data', (buf: Buffer) => {
        const b64 = buf.toString('base64');
        if (active.pendingReads.length > 0) {
          const r = active.pendingReads.shift()!;
          r({ data: b64, done: false });
        } else {
          active.chunks.push(b64);
        }
      });
      sock.on('end', () => {
        active.closed = true;
        while (active.pendingReads.length > 0) {
          const r = active.pendingReads.shift()!;
          r({ data: null, done: true });
        }
      });
      sock.on('error', (err: Error) => {
        active.closed = true;
        active.closeError = err.message;
        while (active.pendingReads.length > 0) {
          const r = active.pendingReads.shift()!;
          r({ data: null, done: true, error: err.message });
        }
      });
    };

    const terminate = (state: IsolateTerminalState) => {
      runAbort.abort();
      for (const timer of pendingSleeps) clearTimeout(timer);
      pendingSleeps.clear();
      for (const controller of inflightFetches.values()) controller.abort();
      inflightFetches.clear();
      closeAllSockets();
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
          const keyStr = String(actionKey);
          let timer: NodeJS.Timeout | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(
                new Error(
                  `chrome_dispatcher.dispatch('${keyStr}') exceeded 120000ms; IPC may be wedged`
                )
              );
            }, 120_000);
          });
          try {
            const output = await Promise.race([
              hooks.onChromeDispatch(keyStr, input),
              timeoutPromise,
            ]);
            return JSON.stringify(output ?? {});
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
        fetch: fetchCapability,
        socketOpen: async (hostParam: unknown, portParam: unknown, optionsJson: unknown) => {
          const rawHost = String(hostParam);
          const hostname = stripIpv6Brackets(rawHost);
          const port = typeof portParam === 'number' ? portParam : parseInt(String(portParam), 10);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid port: ${portParam}`);
          }
          const options = (optionsJson ? parseGuestJson(optionsJson, 'socketOpen') : {}) as {
            secureTransport?: 'off' | 'on' | 'starttls';
          };

          const mergedConfig = buildConnectorConfig(job);
          const policy =
            ((job.env?.LOBU_DB_EGRESS_POLICY as string) ||
              (mergedConfig.LOBU_DB_EGRESS_POLICY as string) ||
              'block-private');
          const allowHostsRaw = String(
            job.env?.LOBU_DB_EGRESS_ALLOW_HOSTS ||
              mergedConfig.LOBU_DB_EGRESS_ALLOW_HOSTS ||
              ''
          );
          const allowHosts = allowHostsRaw
            .split(',')
            .map((h) => h.trim())
            .filter(Boolean);

          let targetIp: string;
          if (isReservedIp(hostname)) {
            if (policy === 'block-private' && !allowHosts.includes(hostname)) {
              throw new Error(`EgressDenied: socket to ${hostname} is blocked under policy ${policy}`);
            }
            targetIp = hostname;
          } else {
            const addresses = await dns.promises.lookup(hostname, { all: true });
            if (!addresses || addresses.length === 0) {
              throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
            }
            if (policy === 'block-private' && !allowHosts.includes(hostname)) {
              for (const a of addresses) {
                if (isReservedIp(a.address)) {
                  throw new Error(
                    `EgressDenied: socket to ${hostname} (${a.address}) is blocked under policy ${policy}`
                  );
                }
              }
            }
            targetIp = addresses[0].address;
          }

          const id = nextSocketId++;
          let sock: net.Socket;
          const isTls = options?.secureTransport === 'on';

          if (isTls) {
            sock = tls.connect({
              host: targetIp,
              port,
              servername: hostname,
            });
          } else {
            sock = net.createConnection({
              host: targetIp,
              port,
            });
          }

          const active: ActiveSocket = {
            id,
            sock,
            chunks: [],
            pendingReads: [],
            closed: false,
            closeError: null,
          };
          activeSockets.set(id, active);

          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              sock.destroy();
              activeSockets.delete(id);
              reject(new Error(`Connection to ${hostname}:${port} timed out`));
            }, 10000);

            const onConnect = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve();
            };
            const onError = (err: Error) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              activeSockets.delete(id);
              reject(err);
            };

            if (isTls) {
              sock.once('secureConnect', onConnect);
            } else {
              sock.once('connect', onConnect);
            }
            sock.once('error', onError);
          });

          attachSocketListeners(sock!, active);
          return id;
        },
        socketRead: async (idParam: unknown) => {
          const active = activeSockets.get(Number(idParam));
          if (!active) return { data: null, done: true };
          if (active.chunks.length > 0) {
            return { data: active.chunks.shift()!, done: false };
          }
          if (active.closed) {
            return { data: null, done: true, error: active.closeError ?? undefined };
          }
          return await new Promise<{ data: string | null; done: boolean; error?: string }>((resolve) => {
            active.pendingReads.push(resolve);
          });
        },
        socketWrite: async (idParam: unknown, base64Data: unknown) => {
          const active = activeSockets.get(Number(idParam));
          if (!active || active.closed) throw new Error('Socket is closed');
          const buf = Buffer.from(String(base64Data), 'base64');
          await new Promise<void>((resolve, reject) => {
            active.sock.write(buf, (err) => (err ? reject(err) : resolve()));
          });
          return true;
        },
        socketClose: async (idParam: unknown) => {
          const active = activeSockets.get(Number(idParam));
          if (active) {
            active.closed = true;
            active.sock.destroy();
            while (active.pendingReads.length > 0) {
              const r = active.pendingReads.shift()!;
              r({ data: null, done: true });
            }
            activeSockets.delete(Number(idParam));
          }
          return true;
        },
        socketStartTls: async (idParam: unknown, optionsJson: unknown) => {
          const active = activeSockets.get(Number(idParam));
          if (!active || active.closed) throw new Error('Socket is closed');
          const opts = (optionsJson ? parseGuestJson(optionsJson, 'socketStartTls') : {}) as {
            servername?: string;
          };
          const oldSock = active.sock;
          oldSock.removeAllListeners('data');
          oldSock.removeAllListeners('end');
          oldSock.removeAllListeners('error');

          return await new Promise<boolean>((resolve, reject) => {
            const tlsSock = tls.connect({
              socket: oldSock,
              servername: opts?.servername,
            });
            tlsSock.once('secureConnect', () => {
              active.sock = tlsSock;
              attachSocketListeners(tlsSock, active);
              resolve(true);
            });
            tlsSock.once('error', reject);
          });
        },
      },
    });

    const redactedTail = () => redactOutput(tail.toString());
    const withTail = (prefix: string) => {
      const t = redactedTail();
      return t ? `${prefix}\n[console]\n${t}` : prefix;
    };

    let executableCode = compiledCode;
    if (/\bexport\s+(?:default\s+|{[^}]+})/.test(executableCode)) {
      executableCode = executableCode
        .replace(/\bexport\s+default\s+([^;]+);?/g, 'module.exports.default = $1;')
        .replace(/\bexport\s*{\s*([^}]+)\s*};?/g, (_, names) => {
          const parts = names.split(',').map((n: string) => {
            const [orig, alias] = n.trim().split(/\s+as\s+/);
            return `module.exports.${alias || orig} = ${orig};`;
          });
          return parts.join('\n');
        });
    }

    try {
      const source = `var __job_json = ${jsonLiteral(job)};\nvar __config_json = ${jsonLiteral(mergedConfig)};\n${executableCode}\n${GUEST_RUNNER}`;
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
      // guest dropped) before reporting the result.
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
      closeAllSockets();
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
        const scope =
          this.options.allowedDomains.length === 0
            ? ' (reserved and internal hosts are never reachable)'
            : ` (this run may reach: ${this.options.allowedDomains.join(', ')})`;
        const denied = new Error(`fetch to ${url.hostname} is not permitted${scope}`);
        denied.name = 'EgressDenied';
        throw denied;
      }
      // The ENFORCING half of the check: a public-looking name may resolve
      // into reserved space, and with an empty allowlist `hostAllowed` admits
      // every name, so this is the only thing standing between a connector and
      // the metadata endpoint. A lookup that FAILS must deny rather than fall
      // through — swallowing it handed the decision to `fetch`'s own resolver,
      // which resolves independently and may answer differently.
      if (ipFamily(stripIpv6Brackets(url.hostname)) === 0) {
        let addresses: Array<{ address: string }>;
        try {
          addresses = await dns.promises.lookup(url.hostname, { all: true });
        } catch (err) {
          const denied = new Error(
            `fetch to ${url.hostname} is blocked: its address could not be resolved (${(err as Error).message})`
          );
          denied.name = 'EgressDenied';
          throw denied;
        }
        for (const a of addresses) {
          if (isReservedIp(a.address) && !this.options.allowedDomains.includes(a.address)) {
            const denied = new Error(
              `fetch to ${url.hostname} (${a.address}) is blocked: resolved to a private or reserved IP address`
            );
            denied.name = 'EgressDenied';
            throw denied;
          }
        }
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
