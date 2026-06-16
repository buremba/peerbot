/**
 * Bearer-authenticated `fetch` for worker → gateway calls. Centralizes the
 * boilerplate every call hand-rolls: the `Authorization: Bearer` header, a
 * JSON `Content-Type` when a body is sent, and an `AbortSignal.timeout(...)`
 * so a stalled gateway can't wedge the turn.
 *
 * `request()` returns the raw `Response` and does NOT throw on non-2xx — every
 * caller branches on status (404 = no snapshot, 409 = race win, timeout =
 * best-effort fallback) or wants its own error message, so status handling
 * stays at the call site.
 */

export interface GatewayRequestInit {
  method?: string;
  /** Serialized request body. JSON content-type is set automatically. */
  body?: string;
  /** Extra headers merged on top of auth + content-type (per-request wins). */
  headers?: Record<string, string>;
  /** Abort budget in milliseconds. Ignored when an explicit `signal` is set. */
  timeoutMs?: number;
  /** Pre-built abort signal (e.g. a long-lived stream controller). */
  signal?: AbortSignal;
}

export function createGatewayClient(config: {
  baseUrl: string;
  token: string;
  /** Override `fetch` (tests / capability probing). Defaults to global fetch. */
  fetchFn?: typeof fetch;
}): { request(path: string, init?: GatewayRequestInit): Promise<Response> } {
  const fetchFn = config.fetchFn ?? fetch;

  function request(
    path: string,
    init: GatewayRequestInit = {}
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.token}`,
      ...(init.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...init.headers,
    };
    return fetchFn(`${config.baseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body,
      signal:
        init.signal ??
        (init.timeoutMs !== undefined
          ? AbortSignal.timeout(init.timeoutMs)
          : undefined),
    });
  }

  return { request };
}
