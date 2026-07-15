/**
 * Egress transport for just-bash's built-in network commands (curl/wget).
 *
 * The gateway egress proxy is the single policy enforcement point for ALL
 * agent egress: global denylist → global allowlist → per-agent grant store →
 * LLM egress judge (see gateway/proxy/http-proxy.ts `checkDomainAccess`).
 * Spawned binaries already transit it via the HTTP_PROXY env forced into
 * their environment. just-bash's built-in curl/wget, however, fetch via the
 * JS runtime — which ignores HTTP_PROXY — so they would bypass every one of
 * those policies. This module closes that gap: it supplies the `fetch` for
 * just-bash's network commands and routes every request (including each
 * redirect hop) through the gateway proxy, making the JS shim just another
 * proxy client, identical in posture to native curl.
 *
 * Deliberately policy-free: no client-side domain matching, no SSRF guard,
 * no method filtering. Duplicating proxy policy here is how the layers drift
 * (a client-side allow-list once disagreed with the proxy on `*` semantics
 * and silently blocked all fetches). Fail-closed instead: without a proxy
 * configured there is no built-in network access at all. Every real
 * deployment — local and prod alike — runs workers with HTTP_PROXY set by
 * the DeploymentManager; the proxy URL is captured once at construction from
 * the worker's own env, so `export HTTP_PROXY=` inside bash cannot repoint
 * or clear it.
 *
 * ALL transport runs in one shared worker_thread, because the interpreter
 * thread is a hardened realm: just-bash's defense-in-depth box (which stays
 * fully ENABLED) monkey-patches this thread's JS globals during script
 * execution, and network internals construct `WeakRef`s mid-request — undici
 * on every fresh connection (lib/core/connect.js), Bun inside ReadableStream
 * reads — so any JS-level fetch here dies with "globalThis.WeakRef
 * constructor is blocked". (This is also why just-bash's own fetch stack was
 * broken in the embedded worker.) The worker thread's globals are never
 * patched. Inside it, the runtime picks its transport: Bun uses the native
 * fetch with the per-request `proxy` option (undici's client sockets are not
 * reliable under Bun); Node uses undici `request()` with a ProxyAgent
 * composed with the redirect interceptor. One worker is shared per process
 * (bash ops are re-created across conversations on warm deployments, so a
 * per-instance worker would accumulate threads), spawned eagerly at
 * bootstrap, kept unref'd so it never holds the process open, and ref'd
 * only while requests are in flight.
 */

import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { SecureFetch } from "just-bash";

/** Original timer functions, captured at module load — before any script
 * execution — because the defense-in-depth box patches the globalThis
 * bindings during exec and a lookup there would throw "setTimeout is
 * blocked". The captured references keep working. */
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;

const EGRESS_DEFAULT_TIMEOUT_MS = 30_000;
const EGRESS_MAX_TIMEOUT_MS = 120_000;
const EGRESS_MAX_REDIRECTS = 20;
/** Enforced while streaming inside the worker, so an oversized response is
 * aborted at the limit rather than buffered whole first. */
const EGRESS_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** just-bash's NetworkAccessDeniedError, passed in so this module never
 * imports just-bash at runtime (the bootstrap loads it lazily). Using the
 * real class keeps curl's exit code (7) and error text consistent. */
type NetworkAccessDeniedErrorCtor = new (url: string, reason?: string) => Error;

interface EgressRequest {
  id: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  proxyUrl: string;
  follow: boolean;
  timeoutMs: number;
}

interface EgressReply {
  id: number;
  error?: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  url?: string;
}

/** Runs in a pristine worker thread — globals unpatched, so WeakRef-using
 * network internals are safe. Dependency-free except undici (Node branch
 * only), resolved via an absolute path handed in from the parent. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { STATUS_CODES } = require("node:http");
const MAX_BYTES = ${EGRESS_MAX_RESPONSE_BYTES};
const isBun = typeof Bun !== "undefined";

// Node transport: undici request() + ProxyAgent composed with the redirect
// interceptor. Loaded lazily so the Bun branch never touches undici.
let undici = null;
const dispatchers = new Map();
function forProxy(proxyUrl) {
  if (!undici) undici = require(workerData.undiciPath);
  let d = dispatchers.get(proxyUrl);
  if (!d) {
    // proxyTunnel:false sends plaintext HTTP as absolute-form requests so the
    // gateway sees method + full path (matching native curl's posture and
    // Bun's behavior); HTTPS still uses CONNECT as it must.
    const plain = new undici.ProxyAgent({ uri: proxyUrl, proxyTunnel: false });
    d = {
      plain,
      following: plain.compose(
        undici.interceptors.redirect({ maxRedirections: ${EGRESS_MAX_REDIRECTS} })
      ),
    };
    dispatchers.set(proxyUrl, d);
  }
  return d;
}

async function bunFetch(msg) {
  // Redirects are followed MANUALLY: Bun's redirect:"follow" drops the
  // per-request proxy option on subsequent hops, so a redirect would escape
  // the gateway. The manual loop re-dispatches every hop through the proxy.
  let currentUrl = msg.url;
  let method = msg.method;
  let reqHeaders = msg.headers;
  let reqBody = msg.body;
  for (let hop = 0; hop <= ${EGRESS_MAX_REDIRECTS}; hop++) {
    const resp = await fetch(currentUrl, {
      // connection:close on every hop — Bun's proxied keep-alive is broken
      // (a second request on a reused proxied connection never completes),
      // so force a fresh connection per request.
      method,
      headers: { ...(reqHeaders || {}), connection: "close" },
      body: reqBody,
      redirect: "manual",
      signal: AbortSignal.timeout(msg.timeoutMs),
      proxy: msg.proxyUrl,
    });
    const location = resp.headers.get("location");
    if (msg.follow && resp.status >= 300 && resp.status < 400 && location) {
      const next = new URL(location, currentUrl);
      if (
        resp.status === 303 ||
        ((resp.status === 301 || resp.status === 302) &&
          method !== "GET" && method !== "HEAD")
      ) {
        method = "GET";
        reqBody = undefined;
      }
      if (next.origin !== new URL(currentUrl).origin) {
        // Never forward credential headers across origins.
        const stripped = {};
        for (const [key, value] of Object.entries(reqHeaders || {})) {
          const lower = key.toLowerCase();
          if (lower !== "authorization" && lower !== "cookie") {
            stripped[key] = value;
          }
        }
        reqHeaders = stripped;
      }
      if (resp.body) await resp.body.cancel();
      currentUrl = next.href;
      continue;
    }
    const reader = resp.body ? resp.body.getReader() : null;
    const chunks = [];
    let total = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error("Response too large (max " + MAX_BYTES + " bytes)");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const headers = {};
    resp.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      status: resp.status,
      statusText: resp.statusText,
      headers,
      body,
      url: currentUrl,
    };
  }
  throw new Error("Too many redirects (max ${EGRESS_MAX_REDIRECTS})");
}

async function nodeFetch(msg) {
  const agents = forProxy(msg.proxyUrl);
  const res = await undici.request(msg.url, {
    dispatcher: msg.follow ? agents.following : agents.plain,
    method: msg.method,
    headers: msg.headers,
    body: msg.body,
    signal: AbortSignal.timeout(msg.timeoutMs),
  });
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_BYTES) {
      res.body.destroy();
      throw new Error("Response too large (max " + MAX_BYTES + " bytes)");
    }
    chunks.push(chunk);
  }
  const headers = {};
  for (const [key, value] of Object.entries(res.headers)) {
    headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  // The redirect interceptor records the hop history; its last entry is the
  // effective URL.
  const history = res.context && res.context.history;
  const last = history && history.length ? history[history.length - 1] : null;
  return {
    status: res.statusCode,
    statusText: STATUS_CODES[res.statusCode] || "",
    headers,
    body: Buffer.concat(chunks, total),
    url: last ? String(last) : msg.url,
  };
}

parentPort.on("message", async (msg) => {
  try {
    const result = await (isBun ? bunFetch(msg) : nodeFetch(msg));
    parentPort.postMessage({ id: msg.id, ...result });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: String((e && e.message) || e) });
  }
});
`;

// ── Shared egress worker (module-level singleton) ───────────────────────────

let egressWorker: Worker | null = null;

/** Test-only: the live worker handle, for lifecycle regression tests
 * (worker death → replacement → stale events must not poison it). */
export function getEgressWorkerForTests(): Worker | null {
  return egressWorker;
}
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (reply: EgressReply) => void; reject: (err: Error) => void }
>();

function settle(id: number): void {
  pending.delete(id);
  if (pending.size === 0) egressWorker?.unref();
}

function ensureWorker(): Worker {
  if (egressWorker) return egressWorker;
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      undiciPath: createRequire(__filename).resolve("undici"),
    },
  });
  worker.unref();
  worker.on("message", (reply: EgressReply) => {
    const entry = pending.get(reply.id);
    if (!entry) return;
    settle(reply.id);
    if (reply.error !== undefined) {
      entry.reject(new Error(reply.error));
    } else {
      entry.resolve(reply);
    }
  });
  // Idempotent per worker, and only for the CURRENT worker: 'error' is
  // typically followed by 'exit', and by then a replacement worker may
  // already own new pending entries — a stale worker's second event must
  // not reject those or null out the healthy replacement.
  let failed = false;
  const failAll = (err: Error): void => {
    if (failed) return;
    failed = true;
    if (egressWorker !== worker) return;
    egressWorker = null;
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(err);
    }
  };
  worker.on("error", (err) => failAll(err));
  worker.on("exit", () => failAll(new Error("egress worker exited")));
  egressWorker = worker;
  return worker;
}

function dispatch(req: Omit<EgressRequest, "id">): Promise<EgressReply> {
  const worker = ensureWorker();
  const id = nextId++;
  return new Promise<EgressReply>((resolve, reject) => {
    // Grace period past the in-worker abort so a wedged worker can't hang
    // the interpreter forever.
    const guard = realSetTimeout(() => {
      settle(id);
      reject(new Error("egress request timed out"));
    }, req.timeoutMs + 5_000);
    guard.unref();
    pending.set(id, {
      resolve: (reply) => {
        realClearTimeout(guard);
        resolve(reply);
      },
      reject: (err) => {
        realClearTimeout(guard);
        reject(err);
      },
    });
    worker.ref();
    worker.postMessage({ ...req, id });
  });
}

function toHeaderRecord(
  headers: Headers | Record<string, string> | undefined
): Record<string, string> {
  if (!headers) return {};
  if (typeof (headers as Headers).forEach === "function") {
    const record: Record<string, string> = {};
    (headers as Headers).forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  return headers as Record<string, string>;
}

export function buildEgressFetch(
  NetworkAccessDeniedError: NetworkAccessDeniedErrorCtor
): SecureFetch {
  // Captured once from the worker's own env (bash scripts only ever see a
  // scrubbed copy, so agents cannot repoint the proxy).
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const httpsProxy =
    process.env.HTTPS_PROXY || process.env.https_proxy || httpProxy;

  // Spawn the shared worker eagerly: bootstrap runs outside the
  // script-execution window, where thread creation is still allowed.
  if (httpProxy || httpsProxy) ensureWorker();

  return async (url, options = {}) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new NetworkAccessDeniedError(url, "invalid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new NetworkAccessDeniedError(
        url,
        `unsupported scheme: ${parsed.protocol}`
      );
    }
    const proxyUrl = parsed.protocol === "https:" ? httpsProxy : httpProxy;
    if (!proxyUrl) {
      throw new NetworkAccessDeniedError(
        url,
        "gateway egress proxy not configured (HTTP_PROXY unset)"
      );
    }

    const reply = await dispatch({
      url,
      method: options.method || "GET",
      headers: toHeaderRecord(options.headers),
      body: options.body,
      proxyUrl,
      follow: options.followRedirects !== false,
      timeoutMs: Math.min(
        options.timeoutMs ?? EGRESS_DEFAULT_TIMEOUT_MS,
        EGRESS_MAX_TIMEOUT_MS
      ),
    });
    return {
      status: reply.status ?? 0,
      statusText: reply.statusText ?? "",
      headers: reply.headers ?? {},
      body: reply.body ?? new Uint8Array(0),
      url: reply.url ?? url,
    };
  };
}
